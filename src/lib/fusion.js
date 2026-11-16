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
import { isWalkable, getLevel, CONNECTORS, FLOOR_HEIGHT_M } from '../floorplan/floorplan.js';
import { observeVector, knnFingerprint, gaussian, makeRng, MAP_MODEL } from './wifi.js';
import {
  PF_CONFIG,
  initParticlesAt,
  initParticlesLost,
  propagate,
  applyMapConstraint,
  replenish,
  applyWifi,
  applyFloorTransition,
  buildRadioMapIndex,
  summariseParticles,
} from './particleFilter.js';

/** Walking speed of the simulated shopper, in metres per second. */
export const WALK_SPEED = 1.3;

/**
 * Fallback ride time, used only if a route names no connector. Normally a ride
 * takes the connector's own `waitS + secondsPerFloor × floors`, so the walk, the
 * router and the barometer all agree on how long a floor change takes. (An
 * earlier version hard-coded 14 s here while the escalator's data said 22 s.)
 */
export const RIDE_SECONDS = 14;

/**
 * THE BAROMETER — the hardware model.
 *
 * Air pressure falls by about 0.12 hPa per metre climbed near ground level, so
 * one 4.5 m storey is ~0.54 hPa. Phone barometers (Android `TYPE_PRESSURE`,
 * iOS `CMAltimeter`) resolve better than 0.1 hPa, so a floor change is clearly
 * visible. Absolute pressure, however, is useless: weather moves it by several
 * hPa a day and air-handling units and opening doors push it around too. So the
 * detector below only ever uses RELATIVE change, and re-anchors itself on every
 * floor it settles on.
 */
export const BAROMETER = {
  /** Pressure at the ground floor today, hPa. Arbitrary — only differences matter. */
  baseHpa: 1013.25,
  /** Pressure change per metre of height, hPa (negative: higher = lower pressure). */
  hpaPerMetre: -0.12,
  /** Sensor noise per 0.1 s sample, hPa — typical of a phone MEMS barometer. */
  noiseHpa: 0.04,
  /**
   * Weather and HVAC drift, as a random walk in hPa per √second. Over a minute
   * this wanders ~0.05 hPa — about 0.4 m of apparent height, which is why the
   * detector re-anchors rather than trusting a fixed reference.
   */
  driftHpaPerSqrtS: 0.006,
};

/**
 * THE FLOOR-CHANGE DETECTOR — the software that reads the barometer.
 *
 * A floor change is CONFIRMED only when the height has moved by most of a storey
 * AND has stopped moving. Requiring both is deliberate: triggering on height
 * alone would switch floors halfway up the escalator, leaving the app on the new
 * floor for the second half of a ride you have not finished.
 */
export const FLOOR_DETECTOR = {
  /** Smoothing time constant for the pressure signal, seconds. */
  smoothingS: 1.0,
  /** Fraction of a storey the height must change before a floor change counts. */
  confirmFraction: 0.65,
  /** Height change that marks the START of a transition, metres. */
  startThresholdM: 0.8,
  /** Vertical speed below which the user counts as having stopped, m/s. */
  settledRateMps: 0.08,
  /**
   * Vertical speed above which they count as moving again, m/s. The gap between
   * this and settledRateMps is hysteresis: barometer noise makes the speed
   * estimate flicker around a single threshold, which kept resetting the settle
   * timer and delayed confirmation to ~6 s after arrival.
   */
  movingRateMps: 0.15,
  /** Window over which vertical speed is measured, seconds. */
  rateWindowS: 2,
  /** How long the height must stay settled before confirming, seconds. */
  settleHoldS: 1,
  /** How much history is kept for looking back to the arrival time, seconds. */
  historyS: 10,
  /** Height within this of its final value counts as arrived, metres. */
  arrivalToleranceM: 0.25,
  /**
   * While standing still on a floor, the reference slowly follows the reading,
   * cancelling weather drift. Slow enough that a real ride (10–60 s) can never
   * be mistaken for drift.
   */
  driftTrackingS: 60,
  /** Classifier: vertical speed above this means a lift rather than an escalator. */
  liftSpeedMps: 0.32,
  /** Classifier: more than this many steps per metre climbed means stairs. */
  stairsStepsPerMetre: 1,
};

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
// The walking routes
// ---------------------------------------------------------------------------

/**
 * The scenarios the simulated shopper can walk.
 *
 * A level change is two consecutive waypoints at the same (x, y) on different
 * floors, with `via` naming the connector ridden. The ride then takes that
 * connector's own time, so the walk, the router and the barometer all agree.
 *
 * Both routes include right-angle turns on purpose: heading error is what makes
 * dead reckoning drift, and corners are also what let map matching correct it —
 * straight-line routes would misrepresent both.
 */
export const WALK_ROUTES = {
  entrance: {
    id: 'entrance',
    label: 'Front entrance → Metro Shoes',
    summary: 'Ground floor, up-escalator, Level 2',
    bootstrapAnchorId: 'qr-1',
    waypoints: [
      { x: 3, y: 20, level: 1, note: 'West entrance' },
      { x: 30, y: 20, level: 1, note: 'Central atrium' },
      { x: 28.2, y: 9, level: 1, note: 'Up-escalator (Level 1)' },
      { x: 28.2, y: 9, level: 2, note: 'Up-escalator (Level 2)', via: 'escalator-up' },
      { x: 30, y: 20, level: 2, note: 'Level 2 atrium' },
      { x: 44.83, y: 20, level: 2, note: 'East concourse' },
      { x: 44.83, y: 15.5, level: 2, note: 'Metro Shoes' },
    ],
  },
  carpark: {
    // The arrival most visitors to a suburban mall actually make: park in the
    // basement, take the lift two floors, walk to the cinema. It exercises what
    // the escalator walk cannot — a lift (no steps, fast vertical speed), a
    // two-floor ride, and the deliberately sparse car-park Wi-Fi.
    id: 'carpark',
    label: 'Car park → Cinepax Cinema',
    summary: 'Basement, lift up two floors, Level 2',
    bootstrapAnchorId: 'qr-p1',
    waypoints: [
      { x: 9.5, y: 23.5, level: 0, note: 'Parked in Zone C' },
      { x: 9.5, y: 20, level: 0, note: 'Car park concourse' },
      { x: 50, y: 20, level: 0, note: 'Lift lobby (P)' },
      { x: 50, y: 20, level: 2, note: 'Lift lobby (L2)', via: 'lift' },
      { x: 6.23, y: 20, level: 2, note: 'Level 2 west concourse' },
      { x: 6.23, y: 16.5, level: 2, note: 'Cinepax Cinema' },
    ],
  },
};

/** The default walk. Kept as an export because older code imports it. */
export const WALK_ROUTE = WALK_ROUTES.entrance.waypoints;

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
  { id: 'qr-p1', level: 0, x: 9.5, y: 22, label: 'Car park pay station' },
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
export function buildWalkPlan(route = WALK_ROUTES.entrance, speed = WALK_SPEED) {
  // Accept a bare waypoint array too, for older callers.
  const routeObj = Array.isArray(route) ? { ...WALK_ROUTES.entrance, waypoints: route } : route;
  const waypoints = routeObj.waypoints;
  const legs = [];
  let t = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    const isRide = from.level !== to.level;
    const length = isRide ? 0 : dist(from, to);

    let duration = length / speed;
    let waitS = 0;
    let connector = null;
    if (isRide) {
      connector = CONNECTORS.find((c) => c.id === (to.via ?? from.via)) ?? null;
      const floors = Math.abs(getLevel(to.level).ordinal - getLevel(from.level).ordinal);
      waitS = connector ? connector.waitS : 0;
      duration = connector ? waitS + connector.secondsPerFloor * floors : RIDE_SECONDS;
    }

    legs.push({
      from,
      to,
      isRide,
      length,
      waitS,
      connectorId: connector?.id ?? null,
      connectorType: connector?.type ?? null,
      fromElevationM: getLevel(from.level).elevationM,
      toElevationM: getLevel(to.level).elevationM,
      tStart: t,
      tEnd: t + duration,
      // Heading in the SVG frame (y grows downward).
      heading: isRide ? 0 : Math.atan2(to.y - from.y, to.x - from.x),
    });
    t += duration;
  }

  return {
    route: routeObj,
    legs,
    totalSeconds: t,
    totalMetres: legs.reduce((s, l) => s + l.length, 0),
    floorChanges: legs.filter((l) => l.isRide).length,
  };
}

/**
 * Where is the shopper at time `t`?
 *
 * Returns elevation as well as floor: during a ride the shopper is genuinely
 * BETWEEN floors, and the barometer has to be able to see that continuous
 * climb. A lift ride is a wait at constant height, then a steady rise.
 */
export function samplePlan(plan, t) {
  const clamped = Math.min(t, plan.totalSeconds);
  const leg = plan.legs.find((l) => clamped >= l.tStart && clamped <= l.tEnd) ?? plan.legs.at(-1);
  const span = leg.tEnd - leg.tStart || 1;
  const u = Math.min(1, Math.max(0, (clamped - leg.tStart) / span));

  if (leg.isRide) {
    const elapsed = clamped - leg.tStart;
    const travel = span - leg.waitS;
    const climb = travel > 0 ? Math.min(1, Math.max(0, (elapsed - leg.waitS) / travel)) : 1;
    return {
      x: leg.from.x,
      y: leg.from.y,
      // The level changes at the END of the ride, not the start — so the
      // estimate gets a genuine chance to be caught on the wrong floor.
      level: u >= 1 ? leg.to.level : leg.from.level,
      elevationM: leg.fromElevationM + (leg.toElevationM - leg.fromElevationM) * climb,
      heading: 0,
      riding: true,
      connectorType: leg.connectorType,
      finished: clamped >= plan.totalSeconds,
    };
  }

  const p = lerpPoint(leg.from, leg.to, u);
  return {
    x: p.x,
    y: p.y,
    level: leg.from.level,
    elevationM: leg.fromElevationM,
    heading: leg.heading,
    riding: false,
    connectorType: null,
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
    ordinalByLevel: new Map(levels.map((l) => [l.level, l.ordinal ?? l.level])),
    levelByOrdinal: new Map(levels.map((l) => [l.ordinal ?? l.level, l.level])),
    radioMapIndex: buildRadioMapIndex(radioMap),
  };
}

/**
 * Read one barometer sample and decide whether a floor change has completed.
 *
 * Pure function of the previous detector state, so it is easy to test and to
 * reason about. Returns the new state; `confirmed` is set on exactly the tick a
 * floor change is confirmed, and null otherwise.
 *
 * The sequence for a ride is:
 *   1. height leaves the reference by more than `startThresholdM` — a
 *      transition has STARTED; remember when, and the step count;
 *   2. height keeps moving while the escalator / lift / stairs climbs;
 *   3. height has moved by most of a storey AND has stopped moving for
 *      `settleHoldS` — CONFIRM, classify, and re-anchor the reference here.
 *
 * Confirmation necessarily comes a couple of seconds AFTER arrival (you cannot
 * know someone has stopped climbing until they have been still for a moment).
 * So the detector also looks back through its history for when the height
 * actually reached its final value, and reports that as `arrivalT`. Two things
 * depend on it: the classifier must only look at the climb itself (steps taken
 * after stepping off an escalator are walking, not climbing), and the fusion
 * step replays the movement made since arrival rather than snapping the user
 * back to the escalator they have already walked away from.
 */
export function updateFloorDetector(prevState, pressureHpa, t, dt, stepCount) {
  const cfg = FLOOR_DETECTOR;
  // No detector state yet (e.g. a simulation state created before this field
  // existed): start fresh, anchored on the current reading, rather than crash.
  const prev = prevState ?? {
    referenceHpa: pressureHpa,
    smoothedHpa: pressureHpa,
    history: [{ t, h: 0, steps: stepCount }],
    settledSince: null,
    transition: null,
  };
  const alpha = dt / (cfg.smoothingS + dt);
  const smoothedHpa = prev.smoothedHpa + alpha * (pressureHpa - prev.smoothedHpa);

  let referenceHpa = prev.referenceHpa;
  const heightOf = (hpa) => (hpa - referenceHpa) / BAROMETER.hpaPerMetre;
  let relativeHeightM = heightOf(smoothedHpa);

  // Recent history of smoothed height and step count: the rate window for
  // detecting "stopped", plus enough extra to look back for the arrival time.
  const history = [...prev.history, { t, h: relativeHeightM, steps: stepCount }].filter(
    (p) => p.t >= t - cfg.historyS - 1e-9,
  );
  const windowStart = history.find((p) => p.t >= t - cfg.rateWindowS - 1e-9) ?? history[0];
  const rateMps = t > windowStart.t ? (relativeHeightM - windowStart.h) / (t - windowStart.t) : 0;
  const windowFull = t - history[0].t >= cfg.rateWindowS - 1e-6;
  const speed = Math.abs(rateMps);
  // Hysteresis: once still, you stay still until clearly moving again.
  const wasStill = prev.settledSince !== null && prev.settledSince !== undefined;
  const still = windowFull && speed < (wasStill ? cfg.movingRateMps : cfg.settledRateMps);

  let transition = prev.transition;
  let settledSince = still ? (prev.settledSince ?? t) : null;
  let confirmed = null;

  if (!transition && Math.abs(relativeHeightM) > cfg.startThresholdM) {
    transition = { startT: t, startSteps: stepCount };
  }

  const floors = Math.round(relativeHeightM / FLOOR_HEIGHT_M);
  const nearWholeFloor =
    floors !== 0 && Math.abs(relativeHeightM) >= cfg.confirmFraction * FLOOR_HEIGHT_M;

  if (transition && nearWholeFloor && settledSince !== null && t - settledSince >= cfg.settleHoldS) {
    // Look back for arrival: the last sample still clearly short of the final
    // height marks the end of the climb.
    let arrival = history[0];
    for (let i = history.length - 1; i >= 0; i--) {
      if (Math.abs(history[i].h - relativeHeightM) > cfg.arrivalToleranceM) {
        arrival = history[Math.min(history.length - 1, i + 1)];
        break;
      }
    }
    const climbDurationS = Math.max(1, arrival.t - transition.startT);
    // Climbed height measured from the 0.8 m start threshold, to match the
    // duration it is divided by.
    const climbedM = Math.max(0.5, Math.abs(relativeHeightM) - cfg.startThresholdM);
    const climbSteps = Math.max(0, arrival.steps - transition.startSteps);
    const type =
      climbSteps / climbedM > cfg.stairsStepsPerMetre
        ? 'stairs'
        : climbedM / climbDurationS > cfg.liftSpeedMps
          ? 'lift'
          : 'escalator';
    confirmed = {
      floors,
      type,
      arrivalT: arrival.t,
      climbDurationS,
      verticalSpeedMps: climbedM / climbDurationS,
      climbSteps,
    };

    // Re-anchor on the new floor. This also wipes out any weather drift
    // accumulated so far — one of the reasons relative pressure works.
    referenceHpa = smoothedHpa;
    return {
      referenceHpa,
      smoothedHpa,
      relativeHeightM: 0,
      rateMps: 0,
      history: [{ t, h: 0, steps: stepCount }],
      settledSince: null,
      transition: null,
      confirmed,
    };
  }

  // A transition that never got near a whole floor and has stopped (a ramp, a
  // pressure gust from a door) is abandoned.
  if (transition && still && Math.abs(relativeHeightM) < cfg.startThresholdM) transition = null;

  // Standing still with no transition under way: let the reference follow the
  // reading very slowly, cancelling weather drift.
  if (!transition && Math.abs(relativeHeightM) < cfg.startThresholdM) {
    referenceHpa += (dt / (cfg.driftTrackingS + dt)) * (smoothedHpa - referenceHpa);
    relativeHeightM = heightOf(smoothedHpa);
  }

  return {
    referenceHpa,
    smoothedHpa,
    relativeHeightM,
    rateMps,
    history,
    settledSince,
    transition,
    confirmed,
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
  const anchor =
    QR_ANCHORS.find((a) => a.id === plan.route?.bootstrapAnchorId) ?? QR_ANCHORS[0];

  const particles = bootstrapped
    ? initParticlesAt(anchor, anchor.level, rng)
    : ctx
      ? initParticlesLost(ctx.levels, rng)
      : initParticlesAt(truth, truth.level, rng);

  // The first pressure reading becomes the reference. Only CHANGES from it are
  // ever used, because absolute pressure is dominated by the weather.
  const firstPressure = BAROMETER.baseHpa + BAROMETER.hpaPerMetre * truth.elevationM;

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
    /**
     * When the next Wi-Fi scan result arrives. Scans come on the OS's schedule,
     * not the app's, so the phase is random. An earlier version deferred any scan
     * that fell during a ride to the first moment after it — which made floor
     * changes look instantly detected, purely by luck of scheduling.
     */
    scanPhase: rng(),
    nextScanT: null,
    scanCount: 0,
    wastedScanCount: 0,
    relocalizeCount: 0,
    survivedFraction: 1,

    /** Barometer hardware state (the truth the sensor sees). */
    pressureDriftHpa: 0,
    pressureHpa: firstPressure,
    /** Floor-change detector state (what the app works out from the readings). */
    baro: {
      referenceHpa: firstPressure,
      smoothedHpa: firstPressure,
      relativeHeightM: 0,
      history: [{ t: 0, h: 0, steps: 0 }],
      settledSince: null,
      transition: null,
    },
    floorChangeCount: 0,
    /** Detected floor changes, for the UI: when, how many floors, which way, how. */
    floorChanges: [],

    /** Evaluation: time from arriving on a new floor to the app agreeing. */
    pendingFloorChangeT: null,
    floorChangeLatencies: [],

    scannedAnchorIds: bootstrapped ? [anchor.id] : [],
    /** How many QR codes the user has had to scan. Fewer is better. */
    qrScanCount: bootstrapped ? 1 : 0,
    qrInRange: null,

    events: bootstrapped
      ? [{ type: 'qr', text: `Scanned "${anchor.label}" to start navigating`, t: 0 }]
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
      ? `${anchor.label} QR scan (the one scan)`
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

  // Climbing stairs is stepping, even though no horizontal distance is covered:
  // ~0.17 m per riser. The floor-change classifier uses this to tell stairs from
  // an escalator. (Deliberately NOT fed to dead reckoning — real step counters
  // make exactly that mistake on stairs, and modelling it is future work.)
  if (s.truth.riding && s.truth.connectorType === 'stairs') {
    s.stepCount += Math.abs(s.truth.elevationM - (prevTruth.elevationM ?? 0)) / 0.17;
  }

  // The barometer: pressure from true height, plus wandering weather/HVAC drift,
  // plus sensor noise averaged over the tick's samples.
  s.pressureDriftHpa =
    (state.pressureDriftHpa ?? 0) + gaussian(s.rng) * BAROMETER.driftHpaPerSqrtS * Math.sqrt(dt);
  const samplesThisTick = Math.max(1, dt / 0.1);
  s.pressureHpa =
    BAROMETER.baseHpa +
    BAROMETER.hpaPerMetre * s.truth.elevationM +
    s.pressureDriftHpa +
    (gaussian(s.rng) * BAROMETER.noiseHpa) / Math.sqrt(samplesThisTick);

  // A short log of what dead reckoning measured, so a floor change confirmed a
  // few seconds late can replay the walking done since the user actually
  // stepped off (see the barometer block below).
  s.drLog = (state.drLog ?? []).filter((e) => e.t >= s.t - 12);
  if (measuredHeading !== null) {
    s.drLog = [...s.drLog, { t: s.t, heading: measuredHeading, metres: measuredMetres }];
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

  // ---- Barometer: detect floor changes from relative pressure -------------
  //
  // Runs every tick (the reading is free), but only ACTS on the particles when
  // the barometer layer is on — so the UI can compare with and without it.
  s.baro = updateFloorDetector(state.baro, s.pressureHpa, s.t, dt, s.stepCount);
  const detected = s.baro.confirmed;
  if (detected && layers.baro) {
    // Each particle is judged from where IT thinks the user was when they
    // arrived, not from where it is now: confirmation comes a few seconds after
    // arrival, and by then the user has walked metres away from the connector.
    // Undo each particle's own dead-reckoning since arrival (using its own
    // compass and stride hypotheses), run the transition there, then replay.
    const sinceArrival = layers.dr ? s.drLog.filter((e) => e.t > detected.arrivalT) : [];
    const atArrival = particles.map((p) => {
      let x = p.x;
      let y = p.y;
      for (const e of sinceArrival) {
        x -= Math.cos(e.heading + p.ho) * e.metres * p.ss;
        y -= Math.sin(e.heading + p.ho) * e.metres * p.ss;
      }
      return { ...p, x, y };
    });
    const result = applyFloorTransition(
      atArrival,
      {
        deltaFloors: detected.floors,
        typeHint: detected.type,
        connectors: CONNECTORS,
        ordinalByLevel: ctx.ordinalByLevel,
        levelByOrdinal: ctx.levelByOrdinal,
        spreadM: state.spreadM ?? 3,
      },
      s.rng,
    );
    particles = replenish(result.particles, s.rng, PF_CONFIG.count);

    // The cloud is now at the connector — where the user was when they ARRIVED,
    // a couple of seconds ago. Replay the steps taken since, through the same
    // prediction and map-matching operations, so the cloud catches up with
    // where they are now instead of being dragged back to the escalator.
    let replayed = 0;
    if (layers.dr) {
      for (const entry of s.drLog) {
        if (entry.t <= detected.arrivalT) continue;
        const step = propagate(particles, entry.heading, entry.metres, s.rng);
        particles = step.particles;
        if (layers.mapMatch) {
          const kept = applyMapConstraint(particles, step.moved, ctx.levelsById);
          if (kept.survived > 0) particles = replenish(kept.particles, s.rng, PF_CONFIG.count);
        }
        replayed += entry.metres;
      }
    }

    s.floorChangeCount += 1;
    const used = CONNECTORS.find((c) => c.id === result.connectorId);
    const way = detected.floors > 0 ? 'up' : 'down';
    const n = Math.abs(detected.floors);
    s.floorChanges = [
      ...s.floorChanges,
      { t: s.t, floors: detected.floors, type: detected.type, connectorId: result.connectorId },
    ];
    s.lastCorrection = `Barometer: ${way} ${n} floor${n > 1 ? 's' : ''}${used ? ` via ${used.label.toLowerCase()}` : ''}`;
    s.flash = { text: `Floor change detected — ${way} ${n} floor${n > 1 ? 's' : ''}`, t: s.t };
    pushEvent(
      s,
      'baro',
      result.fallback
        ? `Pressure says ${way} ${n} floor${n > 1 ? 's' : ''} (${detected.type}), but no hypothesis was near a connector — spread the cloud over every connector that could have done it`
        : `Pressure says ${way} ${n} floor${n > 1 ? 's' : ''}, looks like ${detected.type}. ${result.survived} of ${state.particles.length} hypotheses were near a connector that could do that; moved there, then replayed the ${replayed.toFixed(1)} m walked since arriving`,
    );
  }

  // ---- Layer 3: Wi-Fi = the filter's correction step ----------------------
  //
  // Scan results arrive on the operating system's schedule, not the app's. A
  // scan that lands mid-ride is wasted: the phone is between floors and its
  // reading matches neither. The next one is a full interval later.
  if (s.nextScanT === null || s.nextScanT === undefined) s.nextScanT = (s.scanPhase ?? 0) * wifiIntervalS;
  // If the presenter shortens the interval mid-walk, don't wait out the old one.
  // (Guarded: before the first scan lastWifiT is -Infinity, and min() with that
  // would make every walk scan at exactly t = 0, 30, 60… — erasing the random
  // phase and with it the honesty of the latency measurement.)
  if (Number.isFinite(s.lastWifiT)) {
    s.nextScanT = Math.min(s.nextScanT, s.lastWifiT + wifiIntervalS);
  }
  const scanDue = s.t >= s.nextScanT;
  if (scanDue) {
    s.lastWifiT = s.t;
    s.nextScanT = s.t + wifiIntervalS;
  }
  if (layers.wifi && scanDue && s.truth.riding) {
    s.wastedScanCount = (state.wastedScanCount ?? 0) + 1;
    pushEvent(s, 'wifi', 'Wi-Fi scan arrived mid-ride — between floors, so unusable');
  }
  if (layers.wifi && scanDue && !s.truth.riding) {
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

  // Floor-change latency: from the moment the shopper actually arrives on a new
  // floor to the first moment the app agrees. The headline Phase 2 metric.
  if (s.truth.level !== prevTruth.level) s.pendingFloorChangeT = s.t;
  if (s.pendingFloorChangeT !== null && s.pendingFloorChangeT !== undefined && !s.wrongFloor) {
    s.floorChangeLatencies = [...(state.floorChangeLatencies ?? []), s.t - s.pendingFloorChangeT];
    s.pendingFloorChangeT = null;
  }
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
