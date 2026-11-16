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
  diffuseHeading,
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
  /**
   * Height of a typical stair riser, metres. Building codes allow about
   * 0.15–0.19 m. This is the app's general knowledge about stairs, not a value
   * read from the simulation (which happens to build its stairs to the same
   * figure, STAIR_RISER_M).
   */
  typicalRiserM: 0.17,
  /**
   * Classifier: more than this many steps per metre climbed means stairs.
   *
   * Lifts and escalators climb with no steps (0 steps/m); stairs take one step
   * per riser (~5.9 steps/m). Half of the stairs figure is the natural boundary.
   * It used to be 1 step/m, which sat so close to zero that the few steps of
   * walking leaking in when the arrival time is estimated late (2.3 s late in
   * the worst case seen: 4 steps over a 3.7 m climb, 1.08 steps/m) turned an
   * escalator ride into "stairs".
   */
  stairsStepsPerMetre: 0.5 / 0.17,
  /**
   * Height gained per step above which a step counts as CLIMBING rather than
   * walking, metres: half a typical riser, midway between flat walking (0 m)
   * and stairs (0.17 m). Measured over the rate window, the per-step climb has
   * a standard deviation of ~0.03 m when walking on the flat and ~0.06 m on
   * stairs, so flat walking crosses this line on ~0.6% of ticks and stairs fall
   * short of it on ~9%.
   */
  climbPerStepM: 0.17 / 2,
  /**
   * Window for the "stopped" test during a STAIR climb, seconds.
   *
   * Stairs climb at ~0.15 m/s, and over a 2 s window the rate estimate's noise
   * is 0.055 m/s (measured), so a stair climb read below the 0.08 m/s
   * "stopped" line on 10% of ticks and was regularly confirmed mid-flight: 98
   * of 100 simulated two-floor stair descents were split into two one-floor
   * changes. Measured noise on a 0.15 m/s climb, by window: 5 s 0.029 m/s,
   * 8 s 0.021 m/s, 10 s 0.018 m/s — it falls more slowly than 1/window because
   * the weather drift is a random walk. Eight seconds is the shortest window
   * that puts the stopped line over three standard deviations away (199 of 200
   * two-floor descents confirmed once). It costs about three seconds of
   * latency, so it is only used once the steps already say "stairs"; lift and
   * escalator rides keep the 2 s window.
   */
  stairsRateWindowS: 8,
  /**
   * How long a transition must sit still, short of any whole floor, before it
   * is treated as a remnant and absorbed (see updateFloorDetector), seconds.
   * Deliberately long: a remnant stays still for as long as the user keeps
   * walking on the flat, so waiting costs nothing, while a genuine climb
   * almost never looks still for ten seconds. With the 1 s settle hold
   * instead, noisy dips early in stair climbs were absorbed and 14 of 200
   * simulated one-floor stair climbs went undetected.
   */
  remnantHoldS: 10,
};

/** Stride length the phone's step counter ASSUMES, in metres. */
export const STRIDE_M = 0.72;

/**
 * The building's stairs, as the HARDWARE simulation sees them: one step per
 * 0.17 m riser, in an enclosed dog-leg stair core of two flights per storey
 * that run in opposite directions along the corridor axis. The core is a few
 * metres long, small next to the corridors, so the walk keeps the shopper at
 * the connector's (x, y) — but the phone in their hand still points along
 * each flight, which is what its compass reports.
 */
export const STAIR_RISER_M = 0.17;
export const STAIR_FLIGHTS_PER_STOREY = 2;

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
 * Every route includes right-angle turns on purpose: heading error is what makes
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
  stairs: {
    // Leaving after lunch: from the food court down the stairs, two floors, to
    // the car park. The only route that climbs on foot, so it is the one that
    // exercises the stairs classifier and the barometer gate on dead reckoning
    // (a step counter reports every stair step as a stride). Waypoints are the
    // Food Court and Parking Zone D door nodes from floorplan.js, joined along
    // the corridor centrelines (y = 20, x = 30).
    id: 'stairs',
    label: 'Food court → Parking Zone D',
    summary: 'Level 2, stairs down two floors, car park',
    bootstrapAnchorId: 'qr-6',
    waypoints: [
      { x: 9.5, y: 23.5, level: 2, note: 'Food Court' },
      { x: 9.5, y: 20, level: 2, note: 'Level 2 west concourse' },
      { x: 30, y: 20, level: 2, note: 'Level 2 atrium' },
      { x: 30, y: 31, level: 2, note: 'Stairs (Level 2)' },
      { x: 30, y: 31, level: 0, note: 'Stairs (Level P)', via: 'stairs' },
      { x: 30, y: 20, level: 0, note: 'Car park crossing' },
      { x: 50.5, y: 20, level: 0, note: 'Car park east concourse' },
      { x: 50.5, y: 23.5, level: 0, note: 'Parking Zone D' },
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
  // Outside the food court: the stairs walk starts here, 1.5 m from the code.
  { id: 'qr-6', level: 2, x: 9.5, y: 22, label: 'Food court directory' },
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
    // On stairs the phone faces along the flight being climbed: the first
    // flight runs north up the corridor axis, the next back south, and so on.
    let heading = 0;
    if (leg.connectorType === 'stairs') {
      const flights =
        Math.round((Math.abs(leg.toElevationM - leg.fromElevationM) / FLOOR_HEIGHT_M) * STAIR_FLIGHTS_PER_STOREY) || 1;
      const flight = Math.min(flights - 1, Math.floor(climb * flights));
      heading = flight % 2 === 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    return {
      x: leg.from.x,
      y: leg.from.y,
      // The level changes at the END of the ride, not the start — so the
      // estimate gets a genuine chance to be caught on the wrong floor.
      level: u >= 1 ? leg.to.level : leg.from.level,
      elevationM: leg.fromElevationM + (leg.toElevationM - leg.fromElevationM) * climb,
      heading,
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
  let history = [...prev.history, { t, h: relativeHeightM, steps: stepCount }].filter(
    (p) => p.t >= t - cfg.historyS - 1e-9,
  );
  const rateOver = (windowS) => {
    const start = history.find((p) => p.t >= t - windowS - 1e-9) ?? history[0];
    return {
      start,
      rate: t > start.t ? (relativeHeightM - start.h) / (t - start.t) : 0,
      full: t - history[0].t >= windowS - 1e-6,
    };
  };
  const short = rateOver(cfg.rateWindowS);
  const rateMps = short.rate;

  // Is the user climbing on foot RIGHT NOW? Height gained per step over the
  // rate window. This is what lets dead reckoning ignore stair steps (see
  // stepFusion): the barometer, not the step counter, knows the step went up.
  const windowSteps = stepCount - short.start.steps;
  const climbPerStepM = windowSteps >= 1 ? (relativeHeightM - short.start.h) / windowSteps : 0;
  const climbing = short.full && windowSteps >= 1 && Math.abs(climbPerStepM) > cfg.climbPerStepM;

  let transition = prev.transition;
  if (!transition && Math.abs(relativeHeightM) > cfg.startThresholdM) {
    transition = { startT: t, startSteps: stepCount };
  }

  // Does the transition under way look like stairs so far? Same steps-per-metre
  // rule as the classifier, applied to the climb up to now.
  const stairClimb =
    !!transition &&
    (stepCount - transition.startSteps) /
      Math.max(0.5, Math.abs(relativeHeightM) - cfg.startThresholdM) >
      cfg.stairsStepsPerMetre;

  // Stairs are slow enough that the 2 s rate is too noisy to call "stopped"
  // reliably; use the longer window once the steps say this is a stair climb.
  const settleWindowS = stairClimb ? cfg.stairsRateWindowS : cfg.rateWindowS;
  const settle = settleWindowS === cfg.rateWindowS ? short : rateOver(settleWindowS);
  const speed = Math.abs(settle.rate);
  // Hysteresis: once still, you stay still until clearly moving again. The gap
  // exists to ride out noise in the rate, and that noise shrinks in proportion
  // to the window, so the gap does too. (Left at full width, the 0.15 m/s
  // "moving again" line sat exactly at stair-climbing speed, so one noisy dip
  // could hold a stair climb "still" long enough to confirm it mid-flight.)
  const hysteresisM =
    (cfg.movingRateMps - cfg.settledRateMps) * (cfg.rateWindowS / settleWindowS);
  const wasStill = prev.settledSince !== null && prev.settledSince !== undefined;
  const still =
    settle.full && speed < cfg.settledRateMps + (wasStill ? hysteresisM : 0);

  let settledSince = still ? (prev.settledSince ?? t) : null;
  let confirmed = null;

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
      climbPerStepM: 0,
      climbing: false,
      stairClimb: false,
      history: [{ t, h: 0, steps: stepCount }],
      settledSince: null,
      transition: null,
      confirmed,
    };
  }

  // A transition that never got near a whole floor and has stopped (a ramp, a
  // pressure gust from a door) is abandoned.
  if (transition && still && Math.abs(relativeHeightM) < cfg.startThresholdM) transition = null;

  // A transition that has stopped above the start threshold but no more than
  // (1 − confirmFraction) of a storey up is a REMNANT, not a floor change: the
  // last metre of a ride whose floor change was confirmed a moment early (a
  // noisy dip in the rate can do that mid-escalator). Left open it never
  // confirms, never abandons, blocks drift tracking and — worse — keeps the
  // step gate below holding back ordinary walking. Absorb it: re-anchor here.
  // The bound is exactly the shortfall a confirmed floor can have, so a genuine
  // climb paused at a landing above it is never mistaken for a remnant — and
  // one paused below it still has enough height left to confirm.
  if (
    transition &&
    !nearWholeFloor &&
    settledSince !== null &&
    t - settledSince >= cfg.remnantHoldS &&
    Math.abs(relativeHeightM) <= (1 - cfg.confirmFraction) * FLOOR_HEIGHT_M
  ) {
    transition = null;
    referenceHpa = smoothedHpa;
    relativeHeightM = 0;
    history = [{ t, h: 0, steps: stepCount }];
    settledSince = null;
  }

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
    /** Height gained per step over the rate window, metres (0 with no steps). */
    climbPerStepM,
    /** The steps in the rate window are climbing, not walking. */
    climbing,
    /** A transition is under way and its steps-per-metre say stairs. */
    stairClimb: stairClimb && !!transition,
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
    /**
     * Steps NOT propagated as horizontal travel because the barometer showed
     * the user climbing (barometer-gated dead reckoning), and whether this
     * tick's steps were held back. Both come from the app's own barometer.
     */
    gatedStepCount: 0,
    stepsGated: false,
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
      rateMps: 0,
      climbPerStepM: 0,
      climbing: false,
      stairClimb: false,
      history: [{ t: 0, h: 0, steps: 0 }],
      settledSince: null,
      transition: null,
    },
    /** The app's floor when the current climb began (null when none is under way yet). */
    baroFromLevel: null,
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
 * @param {{dr:boolean, qr:boolean, wifi:boolean, mapMatch:boolean, baro?:boolean, baroGate?:boolean}} layers
 *   `baroGate` (default on whenever `baro` is on): hold back steps the
 *   barometer shows to be climbing. Set it to false to see stairs drag the dot.
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

  // Climbing stairs is stepping too: one step per riser, even though the
  // shopper covers no horizontal distance. A phone's step counter cannot tell a
  // stair step from a walking step, so it reports each one as a full stride
  // along the compass heading — exactly the mistake real pedestrian dead
  // reckoning makes on stairs. The software has to catch it (see the gate
  // below); the hardware does not.
  const onStairs = s.truth.riding && s.truth.connectorType === 'stairs';
  const steps =
    walkedM > 0
      ? walkedM / STRIDE_M
      : onStairs
        ? Math.abs(s.truth.elevationM - (prevTruth.elevationM ?? s.truth.elevationM)) / STAIR_RISER_M
        : 0;

  if (steps > 0) {
    s.stepCount += steps;

    // The compass error random-walks: this is the thing that makes unaided dead
    // reckoning hopeless over distance.
    s.compassError =
      state.compassError + gaussian(s.rng) * SENSOR_ERROR.compassDriftPerStep * Math.sqrt(steps);

    measuredHeading =
      s.truth.heading + s.compassError + gaussian(s.rng) * SENSOR_ERROR.compassNoise;
    // Steps × the assumed stride. (When walking that is the distance walked,
    // so it is written that way to keep the walking arithmetic bit-identical.)
    measuredMetres =
      (walkedM > 0 ? walkedM : steps * STRIDE_M) *
      SENSOR_ERROR.strideScaleBias *
      (1 + gaussian(s.rng) * SENSOR_ERROR.strideNoise * Math.sqrt(steps));
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

  // ---- The app reads its barometer ---------------------------------------
  //
  // Every tick (the reading is free), and BEFORE dead reckoning, because dead
  // reckoning now asks it whether this tick's steps went up or along. Whether
  // a confirmed floor change is acted on is decided further down.
  s.baro = updateFloorDetector(state.baro, s.pressureHpa, s.t, dt, s.stepCount);
  // Remember which floor the app believed it was on when a climb began: the
  // barometer measures height change from there, so a confirmed change is
  // applied from there (see applyFloorTransition's `fromLevel`).
  if (s.baro.transition && !state.baro?.transition) s.baroFromLevel = state.est.level;

  // ---- Barometer-gated dead reckoning ------------------------------------
  //
  // A step taken while the barometer shows the user climbing on foot is a
  // stair step, not a stride, so it is not propagated as horizontal travel.
  // Uses only the app's own barometer reading — height gained per step, and
  // whether a stair-like floor change is still moving — never the true
  // elevation. (A stair climb that has gone still is over: those steps are the
  // walk away from the stairs.) Gated steps are still logged: if the floor
  // change is later confirmed with an arrival time BEFORE them, they were
  // walking after all and are replayed with the rest.
  const gateOn = !!layers.baro && layers.baroGate !== false;
  const stairClimbMoving = s.baro.stairClimb && s.baro.settledSince === null;
  const stepIsVertical =
    gateOn && measuredHeading !== null && (s.baro.climbing || stairClimbMoving);
  s.stepsGated = stepIsVertical;
  s.gatedStepCount = (state.gatedStepCount ?? 0) + (stepIsVertical ? steps : 0);

  // A short log of what dead reckoning measured, so a floor change confirmed a
  // few seconds late can replay the walking done since the user actually
  // stepped off (see the barometer block below). `applied` records whether the
  // step actually moved the particles.
  s.drLog = (state.drLog ?? []).filter((e) => e.t >= s.t - 12);
  if (measuredHeading !== null) {
    s.drLog = [
      ...s.drLog,
      { t: s.t, heading: measuredHeading, metres: measuredMetres, applied: !stepIsVertical },
    ];
  }

  let particles = state.particles;

  // ---- Layer 2: dead reckoning = the filter's prediction step -------------
  let moved = null;
  if (layers.dr && measuredHeading !== null && !stepIsVertical) {
    const result = propagate(particles, measuredHeading, measuredMetres, s.rng);
    particles = result.particles;
    moved = result.moved;
  } else if (layers.dr && stepIsVertical) {
    // Held-back stair steps move nobody, but the compass model still ages by
    // them (see diffuseHeading).
    particles = diffuseHeading(particles, steps, s.rng);
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

  // ---- Barometer: act on a confirmed floor change -------------------------
  //
  // The detector ran above; a confirmed change only ACTS on the particles when
  // the barometer layer is on — so the UI can compare with and without it.
  const detected = s.baro.confirmed;
  if (detected && layers.baro) {
    // Each particle is judged from where IT thinks the user was when they
    // arrived, not from where it is now: confirmation comes a few seconds after
    // arrival, and by then the user has walked metres away from the connector.
    // Undo each particle's own dead-reckoning since arrival (using its own
    // compass and stride hypotheses), run the transition there, then replay.
    // Only steps that were actually applied are undone; gated ones never moved
    // the particles.
    const sinceArrival = layers.dr
      ? s.drLog.filter((e) => e.t > detected.arrivalT && e.applied !== false)
      : [];
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
        fromLevel: s.baroFromLevel ?? undefined,
      },
      s.rng,
    );
    particles = replenish(result.particles, s.rng, PF_CONFIG.count);

    // The cloud is now at the connector — where the user was when they ARRIVED,
    // a couple of seconds ago. Replay the steps taken since, through the same
    // prediction and map-matching operations, so the cloud catches up with
    // where they are now instead of being dragged back to the escalator. Steps
    // the barometer gate held back are replayed too if they came after the
    // arrival: they were the first strides off the stairs, not stair steps.
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

    const way = detected.floors > 0 ? 'up' : 'down';
    const n = Math.abs(detected.floors);

    // No floor the cloud holds has a connector that could make this trip, so
    // the particles came back unchanged. Say so honestly rather than count,
    // log and flash a floor change that never happened; Wi-Fi re-localisation
    // remains the safety net.
    if (result.applied === false) {
      pushEvent(
        s,
        'baro',
        `Pressure says ${way} ${n} floor${n > 1 ? 's' : ''}, but no connector could take any current hypothesis there — floor left unchanged; waiting for Wi-Fi to re-localise`,
      );
    } else {
    s.floorChangeCount += 1;
    const used = CONNECTORS.find((c) => c.id === result.connectorId);
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
      // The rebuilt cloud sits where the user is NOW, so every logged step is
      // already reflected in it — including steps the barometer gate held
      // back. Mark them applied, so that a floor change confirmed after this
      // undoes them all when it works back to the arrival point.
      s.drLog = markLogApplied(s.drLog);
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
    // The cloud is now where the user IS, as after a Wi-Fi re-localisation.
    drLog: markLogApplied(state.drLog),
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
    drLog: markLogApplied(state.drLog),
    flash: { text: 'Position set manually', t: state.t },
    events: state.events,
  };
  s.currentError = dist(s.truth, s.est);
  s.wrongFloor = s.est.level !== s.truth.level;
  pushEvent(s, 'manual', 'User tapped their own position');
  return s;
}

/**
 * After the cloud is rebuilt at the user's CURRENT position (Wi-Fi
 * re-localisation, QR scan, manual tap), every logged step is reflected in it,
 * including steps the barometer gate held back.
 */
function markLogApplied(log) {
  return (log ?? []).map((e) => (e.applied === false ? { ...e, applied: true } : e));
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
