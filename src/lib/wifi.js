/**
 * wifi.js — the Wi-Fi positioning engine.
 *
 * This is a JavaScript port of the Python simulation: radio-map generation, a
 * log-distance-plus-wall-loss propagation model, weighted k-nearest-neighbour
 * fingerprinting, least-squares trilateration, and the model-mismatch
 * experiment. Everything runs client-side; building the radio map and running a
 * full batch evaluation each finish in well under a second (Tab 2 shows the
 * measured times).
 *
 * THE PROPAGATION MODEL
 * ---------------------
 *      RSSI(point, AP) = P0 - 10*n*log10(d) - walls_crossed*wall_loss
 *                        - floors_crossed*floor_loss + noise
 *
 *   P0        reference power at 1 m (dBm)
 *   n         path-loss exponent — how fast signal decays with distance
 *   d         straight-line distance from point to AP (metres)
 *   walls_crossed  number of wall segments the straight line punches through
 *   floors_crossed number of floor slabs between the receiver and the AP
 *   noise     zero-mean Gaussian, representing multipath and receiver noise
 *
 * The `walls_crossed` term is the whole story of this tab. It is why two points
 * the same distance from an access point can differ by over 25 dB in this
 * building (four walls' worth; Tab 2 measures it live on the heatmap), and why
 * the intuitive geometric method (trilateration) collapses indoors while
 * pattern-matching (fingerprinting) does not.
 *
 * TWO MODELS, DELIBERATELY
 * ------------------------
 * We keep the model used to BUILD the radio map separate from the model used to
 * SIMULATE reality. In the real world you never know the true propagation
 * parameters — you assume some, predict a map from them, and the building
 * behaves differently. Keeping the two apart is what lets the mismatch sliders
 * degrade accuracy honestly instead of cheating.
 */

import { countWallsCrossed, dist } from '../floorplan/geometry.js';

// ---------------------------------------------------------------------------
// Model parameters
// ---------------------------------------------------------------------------

/**
 * The assumptions the radio map is built on. These are the defaults from the
 * Python simulation, and they are what a deployment engineer would put in
 * before ever visiting the site.
 */
export const MAP_MODEL = Object.freeze({
  p0: -40, // dBm at 1 m
  n: 2.8, // path-loss exponent (2.0 = free space; 2.8 = cluttered indoor)
  wallLossDb: 6.5, // attenuation per wall crossed
  floorLossDb: 15, // attenuation per floor slab crossed
  crowdOffsetDb: 0, // uniform extra absorption (bodies, stock, humidity)
  noiseSigmaDb: 3.5, // std. dev. of measurement noise
  apOffsetScaleDb: 0, // per-AP hardware/antenna variation; reality-only stressor
  fadingAmplitudeDb: 0, // spatially correlated multipath field; reality-only stressor
  floorDbm: -100, // receiver sensitivity floor — nothing is heard below this
});

/** Number of neighbours used by the kNN fingerprint matcher. */
export const KNN_K = 4;

/** Reference-point spacing of the radio map grid, in metres. */
export const DEFAULT_SPACING_M = 1.5;

/** Minutes a human surveyor takes per reference point (walk there, stand, log). */
export const SURVEY_MINUTES_PER_POINT = 1.5;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * Seeded pseudo-random generator (mulberry32).
 *
 * Reproducibility matters for a defence: the presenter must be able to press
 * "Run 400 random tests" twice and get the same table, and the panel must be
 * able to trust that the numbers were not re-rolled until they looked good.
 */
export function makeRng(seed = 12345) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via the Box–Muller transform. */
export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

/**
 * Predicted (noise-free) RSSI at a point from one access point.
 *
 * Note on the cross-floor case: wall crossings are counted on the RECEIVER's
 * level and a flat `floorLossDb` is charged per slab. The signal does of course
 * also traverse the transmitter's floor, but modelling that properly would need
 * a 3D ray and would not change the qualitative result — an AP one floor away is
 * heard, but much more weakly. This approximation is stated rather than hidden.
 *
 * @param {{x:number,y:number}} point receiver position, metres
 * @param {number} level receiver's floor level
 * @param {{x:number,y:number,level:number}} ap
 * @param {Map<number, object[]>} wallsByLevel level -> wall segment array
 * @param {typeof MAP_MODEL} model
 * @returns {number} RSSI in dBm, clipped at the receiver's sensitivity floor
 */
export function predictRssi(point, level, ap, wallsByLevel, model) {
  // Distance is clamped at 1 m: log10 of anything smaller blows up, and you
  // cannot physically be closer than about a metre to a ceiling-mounted AP.
  const d = Math.max(1, dist(point, ap));
  const walls = countWallsCrossed(point, ap, wallsByLevel.get(level) ?? []);
  const floors = Math.abs((ap.level ?? level) - level);
  const apOffset = deterministicApOffset(ap.id) * (model.apOffsetScaleDb ?? 0);
  const fading = correlatedFading(point, level, ap.id, model.fadingAmplitudeDb ?? 0);

  return rssiFromParts(Math.log10(d), walls, floors, apOffset, fading, model);
}

/**
 * The propagation formula itself, from precomputed geometry.
 *
 * Split out of `predictRssi` so that code which caches the expensive geometric
 * terms (log-distance and wall counts — see apCalibration.js) evaluates EXACTLY
 * the same arithmetic, in the same order, and therefore gets bit-identical
 * results. Keep this the single place the formula is written down.
 */
export function rssiFromParts(log10D, walls, floors, apOffset, fading, model) {
  const rssi =
    model.p0 -
    10 * model.n * log10D -
    walls * model.wallLossDb -
    floors * model.floorLossDb -
    model.crowdOffsetDb +
    apOffset +
    fading;

  return Math.max(model.floorDbm, rssi);
}

/** Stable value in [-1, 1] representing AP-specific transmit/antenna variation. */
export function deterministicApOffset(apId) {
  let hash = 2166136261;
  for (const char of String(apId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967295) * 2 - 1;
}

/**
 * A smooth, deterministic field that changes over space but not between runs.
 * It approximates building-specific multipath that a distance/wall formula
 * cannot express, without pretending to be a full electromagnetic simulator.
 */
export function correlatedFading(point, level, apId, amplitudeDb) {
  if (!amplitudeDb) return 0;
  const seed = deterministicApOffset(`${apId}:${level}`) * Math.PI;
  const a = Math.sin(point.x / 7 + seed) * Math.cos(point.y / 6 - seed * 0.7);
  const b = Math.sin((point.x + point.y) / 11 - seed * 1.3);
  return amplitudeDb * (0.7 * a + 0.3 * b);
}

/**
 * The full signal vector at a point: one predicted RSSI per access point, in a
 * fixed AP order. This vector IS the "fingerprint" of that location.
 */
export function signalVector(point, level, aps, wallsByLevel, model) {
  const v = new Float64Array(aps.length);
  for (let i = 0; i < aps.length; i++) {
    v[i] = predictRssi(point, level, aps[i], wallsByLevel, model);
  }
  return v;
}

/**
 * A simulated live measurement: the same physics, plus Gaussian noise per AP.
 *
 * This is what a phone would actually report. The radio map holds noise-free
 * predictions; the observation is noisy. That asymmetry is the realistic case
 * and is the reason positioning has error at all.
 */
export function observeVector(point, level, aps, wallsByLevel, model, rng) {
  const v = new Float64Array(aps.length);
  for (let i = 0; i < aps.length; i++) {
    const clean = predictRssi(point, level, aps[i], wallsByLevel, model);
    // Only add noise to APs that are actually audible. An AP pinned at the
    // sensitivity floor is "not heard", and noise should not resurrect it.
    v[i] =
      clean <= model.floorDbm
        ? model.floorDbm
        : Math.max(model.floorDbm, clean + gaussian(rng) * model.noiseSigmaDb);
  }
  return v;
}

// ---------------------------------------------------------------------------
// The radio map (fingerprint database)
// ---------------------------------------------------------------------------

/**
 * Build the radio map: a grid of reference points across the walkable area, each
 * storing the predicted signal vector from every access point in the building.
 *
 * THIS IS THE SECOND AUTOMATION CONTRIBUTION. Conventionally this database is
 * produced by a "site survey": a person walks to every grid point with a laptop
 * and records the Wi-Fi for ~1.5 minutes. For this mall that is several hundred
 * points per level, i.e. days of labour, and it must be repeated whenever the AP layout
 * changes. Here it is PREDICTED from the floor plan in milliseconds.
 *
 * @param {object[]} levels level objects from floorplan.js
 * @param {object[]} aps every AP in the building (all levels)
 * @param {number} spacing grid spacing in metres
 * @param {typeof MAP_MODEL} model the assumed propagation model
 */
export function buildRadioMap(levels, aps, spacing = DEFAULT_SPACING_M, model = MAP_MODEL) {
  const t0 = performance.now();

  const wallsByLevel = new Map(levels.map((l) => [l.level, l.walls]));
  const points = [];
  const vectors = [];

  for (const level of levels) {
    // Walk a regular grid over each corridor rectangle. Offsetting by half a
    // spacing keeps reference points off the walls, where a survey would never
    // stand anyway.
    for (const rect of level.corridors) {
      for (let x = rect.x + spacing / 2; x < rect.x + rect.w; x += spacing) {
        for (let y = rect.y + spacing / 2; y < rect.y + rect.h; y += spacing) {
          // The two corridors overlap at the crossing; skip duplicates so the
          // reference-point count we report is honest.
          if (points.some((p) => p.level === level.level && Math.hypot(p.x - x, p.y - y) < 1e-6)) {
            continue;
          }
          const p = { x, y, level: level.level };
          points.push(p);
          vectors.push(signalVector(p, level.level, aps, wallsByLevel, model));
        }
      }
    }
  }

  const buildMs = performance.now() - t0;

  return {
    points,
    vectors,
    aps,
    spacing,
    model,
    wallsByLevel,
    buildMs,
    /** Human-survey equivalent, the comparison this contribution rests on. */
    surveyMinutes: points.length * SURVEY_MINUTES_PER_POINT,
  };
}

// ---------------------------------------------------------------------------
// METHOD 1 — Fingerprinting (weighted k-nearest neighbours)
// ---------------------------------------------------------------------------

/**
 * Estimate position by pattern matching.
 *
 * We treat each location's signal vector as a point in "signal space", with one
 * dimension per access point in the building (every level, not just the user's). To locate a phone, we find the k
 * reference points whose stored signal vectors are closest to what the phone
 * just heard, then average their real-world coordinates, weighting each by
 * 1/(signal distance) so a closer match counts for more.
 *
 * Crucially this makes NO geometric assumption. It never converts signal to
 * distance, so it never has to model what walls do — the walls are already
 * baked into both the stored patterns and the observation. That is precisely
 * why it survives indoors where trilateration does not.
 *
 * @param {Float64Array} obs observed signal vector
 * @param {object} radioMap result of buildRadioMap
 * @param {number} k neighbours to blend
 */
export function knnFingerprint(obs, radioMap, k = KNN_K) {
  const { points, vectors } = radioMap;
  if (points.length === 0) return null;

  // Euclidean distance in signal space (dB), for every reference point.
  const scored = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const ref = vectors[i];
    let sum = 0;
    for (let j = 0; j < obs.length; j++) {
      const diff = obs[j] - ref[j];
      sum += diff * diff;
    }
    scored[i] = { i, d: Math.sqrt(sum) };
  }

  scored.sort((a, b) => a.d - b.d);
  const neighbours = scored.slice(0, Math.min(k, scored.length));

  // Inverse-distance weighting. The epsilon guards against a perfect match
  // (signal distance 0) producing an infinite weight.
  let wSum = 0;
  let x = 0;
  let y = 0;
  const floorVotes = new Map();

  for (const nb of neighbours) {
    const w = 1 / (nb.d + 1e-6);
    const p = points[nb.i];
    x += p.x * w;
    y += p.y * w;
    wSum += w;
    floorVotes.set(p.level, (floorVotes.get(p.level) ?? 0) + w);
  }

  // The floor is decided by a weighted vote, not by averaging — there is no
  // such place as "level 1.5", so blending levels would be meaningless.
  let level = neighbours[0] ? points[neighbours[0].i].level : 1;
  let bestVote = -Infinity;
  for (const [lvl, vote] of floorVotes) {
    if (vote > bestVote) {
      bestVote = vote;
      level = lvl;
    }
  }

  return {
    x: x / wSum,
    y: y / wSum,
    level,
    /** The matched reference points, so the UI can show what it locked onto. */
    neighbours: neighbours.map((nb) => ({ ...points[nb.i], signalDistance: nb.d })),
  };
}

// ---------------------------------------------------------------------------
// METHOD 2 — Trilateration (RSSI -> distance -> least squares)
// ---------------------------------------------------------------------------

/**
 * Invert the path-loss model to turn a signal strength into a distance estimate.
 *
 *      d = 10 ^ ((P0 - RSSI) / (10 * n))
 *
 * Note what is MISSING: there is no wall term. That is not an oversight in our
 * implementation — it is the fundamental problem with the method. To subtract
 * wall loss you would need to already know where you are, which is the thing you
 * are trying to find out. So every wall between the phone and the AP is silently
 * misread as extra distance. Six walls at 6.5 dB is 39 dB of loss, which with
 * n = 2.8 this formula reports as roughly 25x further away than the phone really
 * is (10^(39 / 28) ≈ 24.7).
 */
export function rssiToDistance(rssi, model) {
  return 10 ** ((model.p0 - rssi) / (10 * model.n));
}

/**
 * Estimate position geometrically from distance estimates, by least squares.
 *
 * With ranges r_i to known AP positions (x_i, y_i), each AP gives a circle
 *      (x - x_i)^2 + (y - y_i)^2 = r_i^2
 * Subtracting one reference equation from the others cancels the quadratic
 * terms and leaves a linear system A·[x y]^T = b, which we solve via the 2x2
 * normal equations. This is the textbook approach and works well outdoors with
 * GPS pseudoranges.
 *
 * Trilateration is inherently 2D here and has no way to determine which floor
 * the phone is on — another honest weakness worth showing to the panel.
 *
 * @param {Float64Array} obs observed signal vector
 * @param {object[]} aps access points, same order as obs
 * @param {typeof MAP_MODEL} model model used to invert RSSI to distance
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds building footprint
 * @param {number} useStrongest how many of the loudest APs to use
 */
export function trilaterate(obs, aps, model, bounds, useStrongest = 5) {
  // Use the loudest APs. Weak readings are the least reliable — the distance
  // formula is exponential, so an error of a few dB on a faint AP translates
  // into tens of metres.
  const ranked = aps
    .map((ap, i) => ({ ap, rssi: obs[i] }))
    .filter((r) => r.rssi > model.floorDbm)
    .sort((a, b) => b.rssi - a.rssi)
    .slice(0, useStrongest);

  if (ranked.length < 3) return null;

  const ranges = ranked.map((r) => rssiToDistance(r.rssi, model));
  const ref = ranked[ranked.length - 1];
  const refR = ranges[ranges.length - 1];

  // Build the linearised system.
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;

  for (let i = 0; i < ranked.length - 1; i++) {
    const { ap } = ranked[i];
    const r = ranges[i];
    const ax = 2 * (ref.ap.x - ap.x);
    const ay = 2 * (ref.ap.y - ap.y);
    const bi =
      r * r - refR * refR - ap.x * ap.x - ap.y * ap.y + ref.ap.x * ref.ap.x + ref.ap.y * ref.ap.y;

    // Accumulate A^T A and A^T b directly — cheaper and clearer than building
    // the matrices and multiplying them.
    a11 += ax * ax;
    a12 += ax * ay;
    a22 += ay * ay;
    b1 += ax * bi;
    b2 += ay * bi;
  }

  const det = a11 * a22 - a12 * a12;
  // A near-zero determinant means the chosen APs are nearly collinear, so the
  // geometry is degenerate and no unique solution exists. This happens often in
  // this building, because the APs sit in straight lines along the corridors —
  // itself a real-world reason trilateration struggles in malls.
  if (Math.abs(det) < 1e-9) return null;

  let x = (b1 * a22 - b2 * a12) / det;
  let y = (a11 * b2 - a12 * b1) / det;

  // Constrain the answer to the building. Without this the solution regularly
  // lands hundreds of metres outside, which would make the comparison look
  // unfairly bad — so we give trilateration this help and it still loses.
  x = Math.min(Math.max(x, bounds.minX), bounds.maxX);
  y = Math.min(Math.max(y, bounds.minY), bounds.maxY);

  return { x, y, usedAps: ranked.map((r) => r.ap.id), ranges };
}

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate both methods over many random positions and summarise the results.
 *
 * Reporting mean, median and 90th percentile together is deliberate: a mean can
 * be dragged around by a handful of catastrophic outliers, and for a navigation
 * product what actually matters is "how often is it good enough", which is what
 * the within-3 m and within-5 m percentages answer.
 *
 * @param {object} radioMap
 * @param {object[]} levels
 * @param {number} trials number of random test positions
 * @param {typeof MAP_MODEL} realityModel the model used to simulate readings —
 *   may deliberately differ from the one the radio map was built with
 * @param {number} seed RNG seed, for reproducible results
 */
export function evaluateBatch(
  radioMap,
  levels,
  trials,
  realityModel,
  seed = 2026,
  realityAps = radioMap.aps,
) {
  const rng = makeRng(seed);
  const { aps, wallsByLevel } = radioMap;
  const bounds = buildingBounds(levels);

  const results = [];

  for (let t = 0; t < trials; t++) {
    // Sample a uniformly random walkable point on a random level.
    const level = levels[Math.floor(rng() * levels.length)];
    const truth = randomWalkablePoint(level, rng);

    const obs = observeVector(truth, level.level, realityAps, wallsByLevel, realityModel, rng);

    const fp = knnFingerprint(obs, radioMap);
    const tri = trilaterate(obs, aps, radioMap.model, bounds);

    results.push({
      truth: { ...truth, level: level.level },
      fpError: fp ? dist(truth, fp) : null,
      fpLevelCorrect: fp ? fp.level === level.level : false,
      triError: tri ? dist(truth, tri) : null,
      fp,
      tri,
    });
  }

  return {
    trials,
    results,
    fingerprint: summarise(results.map((r) => r.fpError)),
    trilateration: summarise(results.map((r) => r.triError)),
    /** Fraction of tests where fingerprinting picked the right floor. */
    floorAccuracy:
      results.filter((r) => r.fpLevelCorrect).length / Math.max(1, results.length),
    /** Trilateration cannot determine floor at all — stated, not measured. */
    triFloorCapable: false,
  };
}

/** Mean / median / p90 / within-3 m / within-5 m for a list of errors. */
export function summarise(errors) {
  const clean = errors.filter((e) => e !== null && Number.isFinite(e));
  if (clean.length === 0) {
    return { n: 0, mean: NaN, median: NaN, p90: NaN, within3: 0, within5: 0, max: NaN };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: clean.length,
    mean: clean.reduce((s, e) => s + e, 0) / clean.length,
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    within3: clean.filter((e) => e <= 3).length / clean.length,
    within5: clean.filter((e) => e <= 5).length / clean.length,
    /** Number of tests the method could not produce an answer for at all. */
    failures: errors.length - clean.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The building footprint, used to constrain the trilateration solution. */
export function buildingBounds(levels) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of levels) {
    for (const r of l.corridors) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * A uniformly random point in a level's walkable area.
 * Rectangles are chosen in proportion to their area, otherwise the short
 * corridor would be over-sampled and the statistics would be biased.
 */
export function randomWalkablePoint(level, rng) {
  const rects = level.corridors;
  const total = rects.reduce((s, r) => s + r.w * r.h, 0);
  let pick = rng() * total;
  for (const r of rects) {
    const area = r.w * r.h;
    if (pick <= area) {
      return { x: r.x + rng() * r.w, y: r.y + rng() * r.h };
    }
    pick -= area;
  }
  const r = rects[0];
  return { x: r.x + rng() * r.w, y: r.y + rng() * r.h };
}
