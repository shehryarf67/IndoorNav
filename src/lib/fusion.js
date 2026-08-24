/**
 * fusion.js — the positioning "confidence ladder".
 *
 * THE IDEA
 * --------
 * No single indoor positioning method is trustworthy on its own. Each one has a
 * different failure mode, and crucially they fail in DIFFERENT situations, so
 * layering them by confidence gives a position that is far better than any of
 * them alone:
 *
 *   1. QR anchors        — exact truth, but only at the moment you scan one.
 *   2. Dead reckoning    — smooth and instant, but drifts without bound.
 *   3. Wi-Fi fingerprint — bounded error (~2 m), but noisy and only every few
 *                          seconds, so it cannot drive a smooth blue dot alone.
 *   4. Map matching      — knows nothing about where you are, but knows where
 *                          you CANNOT be: inside a wall.
 *   5. Manual selection  — the always-works fallback: the user taps their spot.
 *
 * Read that list as a ladder of confidence: the highest-confidence source that
 * is currently available wins, and the lower rungs fill in the gaps between.
 * This module implements exactly that, one simulation tick at a time.
 */

import { dist, snapToRects, lerpPoint } from '../floorplan/geometry.js';
import { getLevel } from '../floorplan/floorplan.js';
import {
  observeVector,
  knnFingerprint,
  gaussian,
  makeRng,
  MAP_MODEL,
} from './wifi.js';

/** Walking speed of the simulated shopper, in metres per second. */
export const WALK_SPEED = 1.3;

/** Seconds spent riding the escalator between levels. */
export const RIDE_SECONDS = 14;

/** Average stride length, in metres — what a phone's step counter assumes. */
export const STRIDE_M = 0.72;

/** How often a Wi-Fi fix arrives, in seconds. Real scans are this slow. */
export const WIFI_INTERVAL_S = 4;

/**
 * How hard a Wi-Fi fix pulls the estimate. Not 1.0 on purpose: a fix is noisy,
 * so snapping straight onto it would make the blue dot jitter visibly every few
 * seconds. Blending part of the way is a crude but real complementary filter.
 */
export const WIFI_GAIN = 0.45;

/** How close you must pass to a QR anchor for it to be considered scanned. */
export const QR_RADIUS_M = 1.8;

/** Dead-reckoning error model — the numbers that make the dot drift. */
export const DR_ERROR = {
  /** Systematic stride-length error: this phone thinks your stride is 6% long. */
  strideScaleBias: 1.06,
  /** Random per-step stride error (fraction of a stride, 1 sigma). */
  strideNoise: 0.07,
  /**
   * Gyro/compass drift, radians added to the heading estimate per step as a
   * random walk. Small per step, unbounded over time — which is precisely the
   * problem with dead reckoning and the thing this demo has to show.
   *
   * Calibrated so unaided dead reckoning accumulates roughly 15–25% of distance
   * travelled as error over this 68 m route. That is the right order for a
   * phone's MEMS gyro and magnetometer indoors, where steel structure and
   * escalator motors distort the compass badly.
   */
  headingDriftPerStep: 0.065,
  /** Random per-step heading noise, radians. */
  headingNoise: 0.06,
};

// ---------------------------------------------------------------------------
// The walking route
// ---------------------------------------------------------------------------

/**
 * The route the simulated shopper walks: in at the west entrance, along the main
 * concourse, up the escalator, then to Metro Shoes on Level 2.
 *
 * Two right-angle turns on Level 1 and one on Level 2 are deliberate — heading
 * error is what makes dead reckoning drift, so a route with turns shows the
 * failure honestly, where a straight line would flatter it.
 */
export const WALK_ROUTE = [
  { x: 3, y: 20, level: 1, note: 'West entrance' },
  { x: 30, y: 20, level: 1, note: 'Central atrium' },
  { x: 30, y: 9, level: 1, note: 'Escalator (Level 1)' },
  { x: 30, y: 9, level: 2, note: 'Escalator (Level 2)' }, // level change = ride
  { x: 30, y: 20, level: 2, note: 'Level 2 atrium' },
  { x: 44.83, y: 20, level: 2, note: 'East concourse' },
  { x: 44.83, y: 15.5, level: 2, note: 'Metro Shoes' },
];

/**
 * Printed QR codes on pillars and doorways. Scanning one is the only source in
 * the whole system that gives exact truth — which is why they are placed where
 * Tab 2's error map showed accuracy is weakest.
 */
export const QR_ANCHORS = [
  { id: 'qr-1', level: 1, x: 5, y: 20, label: 'West entrance' },
  { id: 'qr-2', level: 1, x: 17, y: 20, label: 'Concourse pillar' },
  { id: 'qr-3', level: 1, x: 30, y: 20, label: 'Central atrium' },
  { id: 'qr-4', level: 2, x: 30, y: 20, label: 'Level 2 atrium' },
  { id: 'qr-5', level: 2, x: 44.83, y: 20, label: 'East pillar' },
];

/**
 * Turn the waypoint list into timed legs.
 *
 * Walking legs get a duration derived from their length; a level change becomes
 * a fixed-duration "ride" leg with no horizontal movement. Working in TIME
 * rather than distance means the escalator — where you travel no horizontal
 * distance but plenty of seconds pass — needs no special case anywhere else.
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
      // Heading in the SVG frame (y grows downward). Only meaningful for walks.
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

/**
 * Where is the shopper at time `t`?
 *
 * During a ride the position is held at the escalator and the level flips only
 * when the ride completes — so the estimate has a genuine chance to be caught
 * out on the wrong floor, which is the point.
 */
export function samplePlan(plan, t) {
  const clamped = Math.min(t, plan.totalSeconds);
  const leg = plan.legs.find((l) => clamped >= l.tStart && clamped <= l.tEnd) ?? plan.legs.at(-1);
  const span = leg.tEnd - leg.tStart || 1;
  const u = Math.min(1, Math.max(0, (clamped - leg.tStart) / span));

  if (leg.isRide) {
    return {
      x: leg.from.x,
      y: leg.from.y,
      // The level changes at the END of the ride, not the start.
      level: u >= 1 ? leg.to.level : leg.from.level,
      heading: 0,
      riding: true,
      rideProgress: u,
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
    rideProgress: 0,
    finished: clamped >= plan.totalSeconds,
  };
}

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

/**
 * Fresh simulation state, positioned at the start of the route.
 * The estimate begins exactly on truth: every method needs somewhere to start,
 * and in the real app that initial fix comes from the entrance QR code.
 */
export function initFusionState(plan, seed = 7) {
  const truth = samplePlan(plan, 0);
  return {
    t: 0,
    truth,
    est: { x: truth.x, y: truth.y, level: truth.level },
    /** Accumulated heading error of the dead-reckoning estimate, radians. */
    headingBias: 0,
    /** Metres of stride travelled since the last correction — the drift budget. */
    metresSinceFix: 0,
    stepCount: 0,
    lastWifiT: -Infinity,
    scannedAnchorIds: [],
    /** Recent events, newest first, for the on-screen activity log. */
    events: [],
    /** Flash message shown briefly over the map. */
    flash: null,
    trueTrail: [{ x: truth.x, y: truth.y, level: truth.level }],
    estTrail: [{ x: truth.x, y: truth.y, level: truth.level }],
    errorSum: 0,
    errorCount: 0,
    maxError: 0,
    currentError: 0,
    wrongFloor: false,
    lastCorrection: 'Initial fix (entrance QR)',
    rng: makeRng(seed),
    finished: false,
  };
}

/**
 * Advance the simulation by `dt` seconds.
 *
 * The layers are applied in ascending order of confidence, so a
 * higher-confidence source always overwrites what a lower one just did:
 *
 *   dead reckoning  ->  Wi-Fi fingerprint  ->  QR anchor  ->  map matching
 *
 * Map matching runs last because it is a constraint rather than a measurement:
 * whatever the other layers concluded, the answer still has to be somewhere a
 * person could physically stand.
 *
 * @param {object} state previous state (not mutated)
 * @param {number} dt seconds to advance
 * @param {object} plan from buildWalkPlan
 * @param {{dr:boolean, qr:boolean, wifi:boolean, mapMatch:boolean}} layers
 * @param {object} ctx { radioMap, aps, levels }
 */
export function stepFusion(state, dt, plan, layers, ctx) {
  const s = { ...state, est: { ...state.est }, events: state.events };
  const prevTruth = state.truth;

  s.t = Math.min(state.t + dt, plan.totalSeconds);
  s.truth = samplePlan(plan, s.t);
  s.finished = s.truth.finished;

  const walkedM = s.truth.riding || prevTruth.riding ? 0 : dist(prevTruth, s.truth);

  // ---- Layer 2: dead reckoning ------------------------------------------
  //
  // A phone counts steps and reads a heading; it does not measure position. So
  // the estimate is built by repeatedly adding "one stride in the direction I
  // think I am facing" — and every error in stride length or heading is
  // permanent, because there is nothing to correct against. That is why the
  // error grows without bound and why this layer alone is never enough.
  if (layers.dr && walkedM > 0) {
    const steps = walkedM / STRIDE_M;
    s.stepCount += steps;
    s.metresSinceFix += walkedM;

    // Heading error random-walks: a gyro's bias integrates over time.
    s.headingBias += gaussian(s.rng) * DR_ERROR.headingDriftPerStep * Math.sqrt(steps);
    const heading =
      s.truth.heading + s.headingBias + gaussian(s.rng) * DR_ERROR.headingNoise;

    const strideError = 1 + gaussian(s.rng) * DR_ERROR.strideNoise * Math.sqrt(steps);
    const travelled = walkedM * DR_ERROR.strideScaleBias * strideError;

    s.est.x += Math.cos(heading) * travelled;
    s.est.y += Math.sin(heading) * travelled;
    // Note what dead reckoning CANNOT do: a step counter has no idea you just
    // rode an escalator, so the level is never updated here.
  }

  // ---- Layer 3: Wi-Fi fingerprinting ------------------------------------
  //
  // Bounded error, but arrives only every few seconds and is noisy. So it is
  // used as a correction that pulls the estimate back, not as the estimate
  // itself — this is a crude complementary filter.
  if (layers.wifi && ctx.radioMap && s.t - s.lastWifiT >= WIFI_INTERVAL_S && !s.truth.riding) {
    s.lastWifiT = s.t;
    const obs = observeVector(
      s.truth,
      s.truth.level,
      ctx.aps,
      ctx.radioMap.wallsByLevel,
      MAP_MODEL,
      s.rng,
    );
    const fix = knnFingerprint(obs, ctx.radioMap);
    if (fix) {
      const blended = lerpPoint(s.est, fix, WIFI_GAIN);
      s.est.x = blended.x;
      s.est.y = blended.y;
      // Wi-Fi CAN resolve the floor, because APs on the other level are ~15 dB
      // weaker. This is what rescues the estimate after the escalator.
      s.est.level = fix.level;
      // A correction shrinks the drift budget but does not clear it: the fix
      // itself has ~2 m of error, so some uncertainty always remains.
      s.metresSinceFix *= 0.35;
      s.headingBias *= 0.7;
      s.lastCorrection = `Wi-Fi fix (±${dist(s.truth, fix).toFixed(1)} m)`;
      pushEvent(s, 'wifi', `Wi-Fi fix — pulled ${(WIFI_GAIN * 100).toFixed(0)}% toward match`);
    }
  }

  // ---- Layer 1 (highest confidence): QR anchors --------------------------
  //
  // A printed code encodes its own exact coordinates, so scanning one is ground
  // truth. Drift resets to zero. This is the cheapest possible infrastructure —
  // a sticker on a pillar — and the most accurate thing in the whole system.
  if (layers.qr) {
    for (const anchor of QR_ANCHORS) {
      if (anchor.level !== s.truth.level) continue;
      if (s.scannedAnchorIds.includes(anchor.id)) continue;
      if (dist(s.truth, anchor) > QR_RADIUS_M) continue;

      s.est.x = anchor.x;
      s.est.y = anchor.y;
      s.est.level = anchor.level;
      s.headingBias = 0;
      s.metresSinceFix = 0;
      s.scannedAnchorIds = [...s.scannedAnchorIds, anchor.id];
      s.flash = { text: `QR scanned — position corrected (${anchor.label})`, t: s.t };
      s.lastCorrection = `QR anchor: ${anchor.label}`;
      pushEvent(s, 'qr', `QR "${anchor.label}" scanned — drift reset to zero`);
      break;
    }
  }

  // ---- Layer 4: map matching --------------------------------------------
  //
  // This layer knows nothing about where you are. It only knows where you
  // cannot be — inside a wall or behind a shop counter — so it projects the
  // estimate back to the nearest legal position. Cheap, and it is what stops
  // the blue dot from walking through walls.
  if (layers.mapMatch) {
    const corridors = getLevel(s.est.level).corridors;
    const snapped = snapToRects(s.est, corridors);
    if (snapped !== s.est) {
      s.est.x = snapped.x;
      s.est.y = snapped.y;
    }
  }

  // ---- Bookkeeping -------------------------------------------------------
  s.wrongFloor = s.est.level !== s.truth.level;
  s.currentError = dist(s.truth, s.est);
  s.errorSum += s.currentError;
  s.errorCount += 1;
  s.maxError = Math.max(s.maxError, s.currentError);

  // Trails, thinned so they stay cheap to render over a 60-second walk.
  s.trueTrail = appendTrail(state.trueTrail, s.truth);
  s.estTrail = appendTrail(state.estTrail, s.est);

  // Expire the flash message after a couple of seconds.
  if (s.flash && s.t - s.flash.t > 2.2) s.flash = null;

  return s;
}

/** Add a point to a trail, skipping points too close to the last one. */
function appendTrail(trail, p) {
  const last = trail[trail.length - 1];
  if (last && last.level === p.level && dist(last, p) < 0.4) return trail;
  return [...trail, { x: p.x, y: p.y, level: p.level }];
}

/** Prepend an event to the activity log, keeping it short. */
function pushEvent(s, type, text) {
  s.events = [{ type, text, t: s.t }, ...s.events].slice(0, 8);
}

/**
 * Qualitative confidence label for the current error.
 * Expressed in product terms, because "1.4 m" means nothing to a panel but
 * "we can name the shop you're standing outside" does.
 */
export function confidenceLabel(errorM, wrongFloor) {
  if (wrongFloor) return { text: 'Wrong floor', tone: 'bad' };
  if (errorM < 2) return { text: 'High — shop-level', tone: 'good' };
  if (errorM < 5) return { text: 'Good — turn-by-turn works', tone: 'good' };
  if (errorM < 10) return { text: 'Degraded', tone: 'warn' };
  return { text: 'Lost', tone: 'bad' };
}

/** True if no positioning layer is switched on at all. */
export function noLayersActive(layers) {
  return !layers.dr && !layers.qr && !layers.wifi && !layers.mapMatch;
}
