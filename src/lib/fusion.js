/**
 * fusion.js — the positioning "confidence ladder".
 *
 * THE IDEA
 * --------
 * No single indoor positioning method is trustworthy on its own. Each has a
 * different failure mode, and crucially they fail in DIFFERENT situations, so
 * layering them gives a position far better than any alone:
 *
 *   1. QR anchors        — exact truth, but only when the user chooses to scan.
 *   2. Dead reckoning    — smooth and instant, but drifts without bound and
 *                          cannot feel a floor change.
 *   3. Wi-Fi fingerprint — bounded error, but slow (see WIFI_SCAN_PRESETS) and
 *                          noisy, so it cannot drive a smooth dot alone.
 *   4. Map matching      — knows nothing about where you are, but knows where
 *                          you CANNOT be.
 *   5. Manual selection  — the always-works fallback: the user taps their spot.
 *
 * HOW THEY ARE COMBINED
 * ---------------------
 * Not by averaging. The estimator is a particle filter (see particleFilter.js),
 * and each layer above corresponds to one operation on the particle cloud:
 *
 *   dead reckoning  ->  propagate every particle by its own error hypothesis
 *   map matching    ->  delete particles that walked through a wall
 *   Wi-Fi           ->  re-weight particles by fingerprint likelihood, resample
 *   QR scan         ->  collapse the whole cloud onto a known point
 *
 * That is both how it is genuinely done in practice and why map matching is
 * powerful rather than cosmetic: deleting impossible particles is deleting wrong
 * hypotheses about the compass, so the floor plan corrects drift ALONG a
 * corridor as well as across it.
 *
 * WHAT IS SIMULATED VS ESTIMATED
 * ------------------------------
 * `SENSOR_ERROR` below describes the REAL errors of the phone's sensors. The
 * filter never sees those numbers — it only sees the corrupted measurements and
 * has to work out the rest. Keeping that boundary strict is what makes the
 * demonstration meaningful instead of circular.
 */

import { dist, snapToRects, lerpPoint } from '../floorplan/geometry.js';
import { isWalkable } from '../floorplan/floorplan.js';
import { observeVector, knnFingerprint, gaussian, makeRng, MAP_MODEL } from './wifi.js';
import {
  PF_CONFIG,
  initParticlesAt,
  initParticlesLost,
  propagate,
  applyMapConstraint,
  replenish,
  applyWifi,
  buildRadioMapIndex,
  summariseParticles,
} from './particleFilter.js';

/** Walking speed of the simulated shopper, in metres per second. */
export const WALK_SPEED = 1.3;

/** Seconds spent riding the escalator between levels. */
export const RIDE_SECONDS = 14;

/** Stride length the phone's step counter ASSUMES, in metres. */
export const STRIDE_M = 0.72;

/**
 * THE REAL SENSOR ERRORS — the ground truth of how bad the hardware is.
 *
 * These generate the corrupted measurements the filter consumes; the filter is
 * never given them. Values are the literature-typical range for a mid-range
 * phone walking indoors, chosen so that UNAIDED dead reckoning accumulates
 * roughly 8–12% of distance travelled as error. Published pedestrian dead
 * reckoning on phone-grade sensors sits at about 5–15%, so this is mid-range
 * rather than chosen to make a point.
 */
export const SENSOR_ERROR = {
  /**
   * Random-walk drift of the compass error, radians per √step. A magnetometer
   * indoors is pulled around by structural steel, lift motors and escalators;
   * the error wanders rather than staying fixed.
   */
  compassDriftPerStep: 0.045,
  /** Instantaneous compass noise, radians. */
  compassNoise: 0.05,
  /** The step counter's stride estimate is 5% long — a systematic error. */
  strideScaleBias: 1.05,
  /** Random per-step stride variation (fraction of a stride). */
  strideNoise: 0.06,
};

/**
 * How often a Wi-Fi scan result arrives.
 *
 * THIS IS A REAL PLATFORM CONSTRAINT, not a tuning knob. Since Android 9, a
 * foreground app is throttled to 4 scans per 2-minute window — about one every
 * 30 seconds. Demos of indoor positioning routinely assume a scan every second
 * or two, which quietly hides how far the phone must travel on dead reckoning
 * alone between corrections. The default here is the throttled figure; the
 * faster option corresponds to a development device with throttling disabled.
 */
export const WIFI_SCAN_PRESETS = [
  { id: 'android', label: '30 s', seconds: 30, note: 'Android 9+ throttled (realistic)' },
  { id: 'dev', label: '4 s', seconds: 4, note: 'throttling disabled (dev device)' },
];

/** Default scan interval, in seconds. The realistic one. */
export const DEFAULT_WIFI_INTERVAL_S = 30;

/** How close you must be to a QR code for the camera to read it. */
export const QR_RADIUS_M = 1.8;

// ---------------------------------------------------------------------------
// The walking route
// ---------------------------------------------------------------------------

/**
 * The route the simulated shopper walks: in at the west entrance, along the main
 * concourse, up the escalator, then to Metro Shoes on Level 2.
 *
 * Two right-angle turns on Level 1 and one on Level 2 are deliberate. Heading
 * error is what makes dead reckoning drift, and corners are also what let map
 * matching correct it — a straight-line route would misrepresent both.
 */
export const WALK_ROUTE = [
  { x: 3, y: 20, level: 1, note: 'West entrance' },
  { x: 30, y: 20, level: 1, note: 'Central atrium' },
  { x: 28.2, y: 9, level: 1, note: 'Up-escalator (Level 1)' },
  { x: 28.2, y: 9, level: 2, note: 'Up-escalator (Level 2)' }, // level change = ride
  { x: 30, y: 20, level: 2, note: 'Level 2 atrium' },
  { x: 44.83, y: 20, level: 2, note: 'East concourse' },
  { x: 44.83, y: 15.5, level: 2, note: 'Metro Shoes' },
];

/**
 * Printed QR codes on pillars and doorways. Scanning one is the only source in
 * the system that gives exact truth.
 *
 * The first entry is the entrance directory board — the one code a user scans as
 * a matter of course, because it is where they pick their destination. The rest
 * exist purely as recovery points if the dot goes wrong.
 */
export const QR_ANCHORS = [
  { id: 'qr-1', level: 1, x: 5, y: 20, label: 'Entrance directory board' },
  { id: 'qr-2', level: 1, x: 17, y: 20, label: 'Concourse pillar' },
  { id: 'qr-3', level: 1, x: 30, y: 20, label: 'Central atrium' },
  { id: 'qr-4', level: 2, x: 30, y: 20, label: 'Level 2 atrium' },
  { id: 'qr-5', level: 2, x: 44.83, y: 20, label: 'East pillar' },
];

/**
 * Turn the waypoint list into timed legs.
 *
 * Walking legs get a duration from their length; a level change becomes a
 * fixed-duration "ride" with no horizontal movement. Working in TIME rather than
 * distance means the escalator — no distance covered, plenty of seconds passing —
 * needs no special case anywhere else.
 */
export function buildWalkPlan(waypoints = WALK_ROUTE, speed = WALK_SPEED) {
  const legs = [];
  let t = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    const isRide = from.level !== to.level;
    const length = isRide ? 0 : dist(from, to);
    const duration = isRide ? RIDE_SECONDS : length / speed;

    legs.push({
      from,
      to,
      isRide,
      length,
      tStart: t,
      tEnd: t + duration,
      // Heading in the SVG frame (y grows downward).
      heading: isRide ? 0 : Math.atan2(to.y - from.y, to.x - from.x),
    });
    t += duration;
  }

  return {
    legs,
    totalSeconds: t,
    totalMetres: legs.reduce((s, l) => s + l.length, 0),
  };
}

/** Where is the shopper at time `t`? */
export function samplePlan(plan, t) {
  const clamped = Math.min(t, plan.totalSeconds);
  const leg = plan.legs.find((l) => clamped >= l.tStart && clamped <= l.tEnd) ?? plan.legs.at(-1);
  const span = leg.tEnd - leg.tStart || 1;
  const u = Math.min(1, Math.max(0, (clamped - leg.tStart) / span));

  if (leg.isRide) {
    return {
      x: leg.from.x,
      y: leg.from.y,
      // The level changes at the END of the ride, not the start — so the
      // estimate gets a genuine chance to be caught on the wrong floor.
      level: u >= 1 ? leg.to.level : leg.from.level,
      heading: 0,
      riding: true,
      finished: clamped >= plan.totalSeconds,
    };
  }

  const p = lerpPoint(leg.from, leg.to, u);
  return {
    x: p.x,
    y: p.y,
    level: leg.from.level,
    heading: leg.heading,
    riding: false,
    finished: clamped >= plan.totalSeconds,
  };
}

// ---------------------------------------------------------------------------
// Simulation context and state
// ---------------------------------------------------------------------------

/**
 * Precompute everything the filter needs that does not change during a walk.
 * The radio-map index in particular is expensive to build and constant.
 */
export function buildFusionContext(radioMap, aps, levels) {
  return {
    radioMap,
    aps,
    levels,
    levelsById: new Map(levels.map((l) => [l.level, l])),
    radioMapIndex: buildRadioMapIndex(radioMap),
  };
}

/**
 * Fresh simulation state at the start of the route.
 *
 * With QR available, the user scans the entrance directory board and the cloud
 * starts pinned there — the natural single scan, since that is where they choose
 * a destination. Without it the cloud starts spread across every walkable metre
 * of the building, which is the honest representation of knowing nothing, and
 * makes the value of that one scan immediately visible.
 */
export function initFusionState(plan, seed = 7, layers = { qr: true }, ctx = null) {
  const rng = makeRng(seed);
  const truth = samplePlan(plan, 0);
  const bootstrapped = !!layers.qr;

  const particles = bootstrapped
    ? initParticlesAt(QR_ANCHORS[0], QR_ANCHORS[0].level, rng)
    : ctx
      ? initParticlesLost(ctx.levels, rng)
      : initParticlesAt(truth, truth.level, rng);

  const summary = summariseParticles(particles);
  const sensorHypotheses = summariseSensorHypotheses(particles);

  return {
    t: 0,
    truth,
    particles,
    est: { x: summary.x, y: summary.y, level: summary.level },
    /** The app's OWN uncertainty, from the particle spread. Never ground truth. */
    spreadM: summary.spreadM,
    floorConfidence: summary.floorConfidence,
    modeShare: summary.modeShare,
    learnedHeadingCorrectionRad: sensorHypotheses.headingCorrectionRad,
    learnedStrideScale: sensorHypotheses.strideScale,

    /**
     * The true compass error — a property of the hardware, not of the estimate.
     * The filter never reads this; it only sees headings corrupted by it.
     */
    compassError: 0,

    stepCount: 0,
    lastWifiT: -Infinity,
    scanCount: 0,
    relocalizeCount: 0,
    survivedFraction: 1,

    scannedAnchorIds: bootstrapped ? [QR_ANCHORS[0].id] : [],
    /** How many QR codes the user has had to scan. Fewer is better. */
    qrScanCount: bootstrapped ? 1 : 0,
    qrInRange: null,

    events: bootstrapped
      ? [{ type: 'qr', text: `Scanned "${QR_ANCHORS[0].label}" to start navigating`, t: 0 }]
      : [{ type: 'wifi', text: 'No entrance scan — position unknown, cloud spread building-wide', t: 0 }],
    flash: null,

    trueTrail: [{ x: truth.x, y: truth.y, level: truth.level }],
    estTrail: [{ x: summary.x, y: summary.y, level: summary.level }],

    errorSum: 0,
    errorCount: 0,
    maxError: 0,
    /**
     * HORIZONTAL error in metres, for EVALUATION only. Reported separately from
     * the floor decision, matching Tab 2's convention: a 2-D error figure plus a
     * floor-detection rate. Being sub-metre accurate on the wrong level is not
     * sub-metre accuracy, and one blended number would hide that.
     */
    currentError: 0,
    confidenceTrail: [{ t: 0, spreadM: summary.spreadM, errorM: 0, floorCorrect: true }],
    wrongFloor: false,
    floorCorrectCount: 0,
    /**
     * Ticks where the reported position was NOT on walkable floor — i.e. the
     * blue dot was inside a wall or a shop unit.
     *
     * This is a fair self-diagnostic rather than a peek at ground truth: the app
     * holds the floor plan, so it can always check whether its own answer is
     * somewhere a person could stand. It is the tab's thesis reduced to one
     * number.
     */
    wallViolationCount: 0,

    lastCorrection: bootstrapped
      ? 'Entrance QR scan (the one scan)'
      : 'Nothing yet — no bootstrap fix',
    rng,
    finished: false,
  };
}

/**
 * Advance the simulation by `dt` seconds.
 *
 * @param {object} state previous state (not mutated)
 * @param {number} dt seconds to advance
 * @param {object} plan from buildWalkPlan
 * @param {{dr:boolean, qr:boolean, wifi:boolean, mapMatch:boolean}} layers
 * @param {object} ctx from buildFusionContext
 * @param {number} wifiIntervalS scan interval in seconds
 */
export function stepFusion(state, dt, plan, layers, ctx, wifiIntervalS = DEFAULT_WIFI_INTERVAL_S) {
  const s = { ...state, events: state.events };
  const prevTruth = state.truth;

  s.t = Math.min(state.t + dt, plan.totalSeconds);
  s.truth = samplePlan(plan, s.t);
  s.finished = s.truth.finished;

  const walkedM = s.truth.riding || prevTruth.riding ? 0 : dist(prevTruth, s.truth);

  // ---- Simulate the sensors ----------------------------------------------
  //
  // This block is the phone's hardware, not its software. It produces the two
  // corrupted numbers the filter is allowed to see.
  let measuredHeading = null;
  let measuredMetres = 0;

  if (walkedM > 0) {
    const steps = walkedM / STRIDE_M;
    s.stepCount += steps;

    // The compass error random-walks: this is the thing that makes unaided dead
    // reckoning hopeless over distance.
    s.compassError =
      state.compassError + gaussian(s.rng) * SENSOR_ERROR.compassDriftPerStep * Math.sqrt(steps);

    measuredHeading =
      s.truth.heading + s.compassError + gaussian(s.rng) * SENSOR_ERROR.compassNoise;
    measuredMetres =
      walkedM *
      SENSOR_ERROR.strideScaleBias *
      (1 + gaussian(s.rng) * SENSOR_ERROR.strideNoise * Math.sqrt(steps));
  }

  let particles = state.particles;

  // ---- Layer 2: dead reckoning = the filter's prediction step -------------
  let moved = null;
  if (layers.dr && measuredHeading !== null) {
    const result = propagate(particles, measuredHeading, measuredMetres, s.rng);
    particles = result.particles;
    moved = result.moved;
  }

  // ---- Layer 4: map matching = delete the impossible ----------------------
  //
  // Runs immediately after prediction, because a particle's legality is a
  // property of the move it just made.
  if (layers.mapMatch && moved) {
    const constrained = applyMapConstraint(particles, moved, ctx.levelsById);

    if (constrained.survived === 0) {
      // Everything died. Rather than let the filter collapse, snap the cloud
      // back into legal space and carry on with high uncertainty. In a real
      // product this is the moment you would prompt the user to re-scan.
      const level = ctx.levelsById.get(particles[0]?.level) ?? ctx.levels[0];
      particles = particles.map((p) => ({ ...p, ...snapToRects(p, level.corridors) }));
      pushEvent(s, 'wifi', 'Map matching rejected every hypothesis — confidence lost');
    } else {
      particles = replenish(constrained.particles, s.rng, PF_CONFIG.count);
    }
    s.survivedFraction = constrained.survived / PF_CONFIG.count;
  } else {
    s.survivedFraction = 1;
  }

  // ---- Layer 3: Wi-Fi = the filter's correction step ----------------------
  if (layers.wifi && s.t - s.lastWifiT >= wifiIntervalS && !s.truth.riding) {
    s.lastWifiT = s.t;
    s.scanCount += 1;

    const obs = observeVector(
      s.truth,
      s.truth.level,
      ctx.aps,
      ctx.radioMap.wallsByLevel,
      MAP_MODEL,
      s.rng,
    );

    const result = applyWifi(particles, obs, ctx.radioMap, ctx.radioMapIndex, s.rng);
    particles = result.particles;

    if (result.relocalized) {
      s.relocalizeCount += 1;
      s.lastCorrection = 'Wi-Fi re-localisation (was lost)';
      pushEvent(
        s,
        'wifi',
        `Lost — no hypothesis matched (best off by ${result.bestResidualDb.toFixed(0)} dB). Re-localised from the radio map.`,
      );
    } else {
      s.lastCorrection = `Wi-Fi scan (residual ${result.bestResidualDb.toFixed(1)} dB)`;
      pushEvent(s, 'wifi', `Wi-Fi scan — cloud re-weighted and resampled`);
    }
  }

  // ---- Layer 1: QR anchors are USER-TRIGGERED ----------------------------
  //
  // Scanning is a deliberate act: take the phone out, open the camera, aim it.
  // Nobody does that five times on the way to a shop. So this layer never fires
  // on proximity — a tick only records whether a code is within reach, so the
  // interface can offer the option. The scan itself is `scanQrCode()`.
  s.qrInRange = null;
  if (layers.qr && !s.truth.riding) {
    for (const anchor of QR_ANCHORS) {
      if (anchor.level !== s.truth.level) continue;
      if (dist(s.truth, anchor) <= QR_RADIUS_M) {
        s.qrInRange = anchor;
        break;
      }
    }
  }

  // ---- Read the answer out of the cloud ----------------------------------
  s.particles = particles;
  const summary = summariseParticles(particles);
  if (summary) {
    s.est = { x: summary.x, y: summary.y, level: summary.level };
    s.spreadM = summary.spreadM;
    s.floorConfidence = summary.floorConfidence;
    s.modeShare = summary.modeShare;
    const sensorHypotheses = summariseSensorHypotheses(particles);
    s.learnedHeadingCorrectionRad = sensorHypotheses.headingCorrectionRad;
    s.learnedStrideScale = sensorHypotheses.strideScale;
  }

  // ---- Bookkeeping --------------------------------------------------------
  //
  // Most of this is EVALUATION: it compares against the true position, which a
  // real app can never see, and exists only so we can grade ourselves.
  //
  // The one exception is the wall-violation count at the end. The app holds the
  // floor plan, so it can always check whether its own answer is somewhere a
  // person could actually stand — that is a fair self-diagnostic, not a peek at
  // the truth.
  s.wrongFloor = s.est.level !== s.truth.level;
  s.currentError = dist(s.truth, s.est);
  s.errorSum += s.currentError;
  s.errorCount += 1;
  s.maxError = Math.max(s.maxError, s.currentError);
  if (!s.wrongFloor) s.floorCorrectCount = (state.floorCorrectCount ?? 0) + 1;
  if (!isWalkable(s.est.level, s.est)) {
    s.wallViolationCount = (state.wallViolationCount ?? 0) + 1;
  }

  s.confidenceTrail = [
    ...(state.confidenceTrail ?? []),
    {
      t: s.t,
      spreadM: s.spreadM,
      errorM: s.currentError,
      floorCorrect: !s.wrongFloor,
    },
  ].slice(-900);

  s.trueTrail = appendTrail(state.trueTrail, s.truth);
  s.estTrail = appendTrail(state.estTrail, s.est);

  if (s.flash && s.t - s.flash.t > 2.2) s.flash = null;

  return s;
}

/**
 * Scan a QR code — a deliberate action, collapsing the whole cloud onto a known
 * point. This is the recovery path: the user sees the dot somewhere they plainly
 * are not, and fixes it.
 */
export function scanQrCode(state, layers) {
  if (!layers.qr) return state;

  const anchor = state.qrInRange;

  // A failed attempt is worth showing: it is what happens when someone tries to
  // recover mid-corridor with no code on any nearby pillar.
  if (!anchor) {
    const miss = { ...state, events: state.events };
    miss.flash = { text: 'No QR code within reach', t: state.t };
    pushEvent(miss, 'qr', 'Scan attempted — no QR code within reach');
    return miss;
  }

  const particles = initParticlesAt(anchor, anchor.level, state.rng);
  const summary = summariseParticles(particles);

  const s = {
    ...state,
    particles,
    est: { x: summary.x, y: summary.y, level: summary.level },
    spreadM: summary.spreadM,
    floorConfidence: summary.floorConfidence,
    modeShare: summary.modeShare,
    // The compass hypotheses are rebuilt from scratch by initParticlesAt, but
    // the hardware's actual error is untouched — scanning a code does not
    // recalibrate a magnetometer.
    qrScanCount: state.qrScanCount + 1,
    scannedAnchorIds: state.scannedAnchorIds.includes(anchor.id)
      ? state.scannedAnchorIds
      : [...state.scannedAnchorIds, anchor.id],
    lastCorrection: `QR re-scan: ${anchor.label}`,
    flash: { text: `QR scanned — position corrected (${anchor.label})`, t: state.t },
    events: state.events,
  };

  // Note the residual does not go to zero. The code encodes ITS OWN
  // coordinates, so scanning places you where the code is; whatever gap remains
  // is how far you are standing from it, bounded by QR_RADIUS_M. Snapping to the
  // true position would overstate what a QR anchor delivers.
  s.currentError = dist(s.truth, s.est);
  s.wrongFloor = s.est.level !== s.truth.level;
  s.estTrail = [...state.estTrail, { x: s.est.x, y: s.est.y, level: s.est.level }];
  pushEvent(s, 'qr', `QR "${anchor.label}" re-scanned — cloud collapsed onto a known point`);

  return s;
}

/** Manual selection — the always-works fallback. */
export function setManualPosition(state, point, level) {
  const particles = initParticlesAt(point, level, state.rng);
  const summary = summariseParticles(particles);
  const s = {
    ...state,
    particles,
    est: { x: summary.x, y: summary.y, level: summary.level },
    spreadM: summary.spreadM,
    floorConfidence: summary.floorConfidence,
    modeShare: summary.modeShare,
    lastCorrection: 'Manual selection by user',
    flash: { text: 'Position set manually', t: state.t },
    events: state.events,
  };
  s.currentError = dist(s.truth, s.est);
  s.wrongFloor = s.est.level !== s.truth.level;
  pushEvent(s, 'manual', 'User tapped their own position');
  return s;
}

/** Add a point to a trail, skipping points too close to the last one. */
function appendTrail(trail, p) {
  const last = trail[trail.length - 1];
  if (last && last.level === p.level && dist(last, p) < 0.4) return trail;
  return [...trail, { x: p.x, y: p.y, level: p.level }];
}

/** Weighted sensor-error hypotheses carried by the particle cloud itself. */
function summariseSensorHypotheses(particles) {
  const totalW = particles.reduce((sum, p) => sum + p.w, 0) || 1;
  return {
    headingCorrectionRad: particles.reduce((sum, p) => sum + p.ho * p.w, 0) / totalW,
    strideScale: particles.reduce((sum, p) => sum + p.ss * p.w, 0) / totalW,
  };
}

/** Prepend an event to the activity log, keeping it short. */
function pushEvent(s, type, text) {
  s.events = [{ type, text, t: s.t }, ...s.events].slice(0, 8);
}

/**
 * Qualitative confidence label, derived from the filter's OWN uncertainty —
 * not from the true error, which a real app cannot know.
 *
 * Expressed in product terms, because "1.4 m" means nothing to a panel but "we
 * can name the shop you are standing outside" does.
 */
export function confidenceLabel(spreadM, floorConfidence) {
  if (floorConfidence < 0.7) return { text: 'Unsure which floor', tone: 'bad' };
  if (spreadM < 2) return { text: 'High — shop-level', tone: 'good' };
  if (spreadM < 5) return { text: 'Good — turn-by-turn works', tone: 'good' };
  if (spreadM < 10) return { text: 'Degraded', tone: 'warn' };
  return { text: 'Lost', tone: 'bad' };
}

/** True if no positioning layer is switched on at all. */
export function noLayersActive(layers) {
  return !layers.dr && !layers.qr && !layers.wifi && !layers.mapMatch;
}

/** Re-exported so the tab can show a single-shot fingerprint fix if wanted. */
export { knnFingerprint };
