/**
 * Short-walk AP calibration for Tab 2.
 *
 * Instead of surveying every radio-map point, a technician records all APs at
 * STOPS_PER_LEVEL (10) known corridor stops per level — 30 in this three-level
 * mall. A coarse-to-fine nonlinear search estimates AP
 * floor/position; then a small least-squares fit estimates the global path-loss
 * exponent and wall attenuation from the same measurements.
 */

import { countWallsCrossed, dist } from '../floorplan/geometry.js';
import {
  MAP_MODEL,
  makeRng,
  observeVector,
  rssiFromParts,
  deterministicApOffset,
  correlatedFading,
} from './wifi.js';

const STOPS_PER_LEVEL = 10;
const AVERAGED_SCANS = 8;

export function buildCalibrationStops(levels, perLevel = STOPS_PER_LEVEL) {
  return levels.flatMap((level) => {
    const candidates = walkableGrid(level, 1.5);
    const selected = [
      candidates.reduce((best, p) => (p.x < best.x ? p : best), candidates[0]),
    ];
    while (selected.length < perLevel) {
      let best = candidates[0];
      let bestD = -Infinity;
      for (const candidate of candidates) {
        const nearest = Math.min(...selected.map((point) => dist(point, candidate)));
        if (nearest > bestD) {
          bestD = nearest;
          best = candidate;
        }
      }
      selected.push(best);
    }
    return selected.map((point, index) => ({ ...point, level: level.level, id: `L${level.level}-S${index + 1}` }));
  });
}

export function runApCalibration(levels, trueAps, realityModel = MAP_MODEL, seed = 4401) {
  const t0 = performance.now();
  const rng = makeRng(seed);
  const wallsByLevel = new Map(levels.map((level) => [level.level, level.walls]));
  const stops = buildCalibrationStops(levels);
  const observations = stops.map((stop) => {
    const sums = new Float64Array(trueAps.length);
    for (let scan = 0; scan < AVERAGED_SCANS; scan++) {
      const vector = observeVector(stop, stop.level, trueAps, wallsByLevel, realityModel, rng);
      for (let i = 0; i < vector.length; i++) sums[i] += vector[i];
    }
    return Float64Array.from(sums, (value) => value / AVERAGED_SCANS);
  });

  // The coarse search grid and its stop-to-candidate geometry are identical for
  // every AP and for both passes, so they are built exactly once (see
  // buildGeometryCache for why this is the expensive part).
  const coarse = levels.flatMap((level) =>
    walkableGrid(level, 1.5).map((point) => ({ ...point, level: level.level })),
  );
  const cache = buildGeometryCache(coarse, stops, wallsByLevel);

  const firstPass = trueAps.map((ap, apIndex) =>
    estimateOneAp(ap.id, apIndex, cache, stops, observations, wallsByLevel, MAP_MODEL),
  );
  const fitted = fitGlobalParameters(firstPass, stops, observations, wallsByLevel, MAP_MODEL);
  const estimatedAps = trueAps.map((ap, apIndex) =>
    estimateOneAp(ap.id, apIndex, cache, stops, observations, wallsByLevel, fitted),
  );

  const estimates = estimatedAps.map((estimated, index) => {
    const truth = trueAps[index];
    return {
      id: truth.id,
      truth,
      estimated,
      errorM: dist(truth, estimated),
      floorCorrect: truth.level === estimated.level,
    };
  });

  return {
    stops,
    observations,
    estimatedAps,
    estimates,
    fittedModel: fitted,
    meanErrorM: estimates.reduce((sum, item) => sum + item.errorM, 0) / estimates.length,
    floorAccuracy: estimates.filter((item) => item.floorCorrect).length / estimates.length,
    measurementCount: stops.length * trueAps.length,
    averagedScans: AVERAGED_SCANS,
    // 0.4 min per stop is an ASSUMED walking-plus-scanning time (a short walk
    // between spread-out stops plus AVERAGED_SCANS scans), chosen, not measured.
    // It only sizes the effort comparison shown on screen; nothing depends on it.
    estimatedWalkMinutes: stops.length * 0.4,
    buildMs: performance.now() - t0,
    bestCase: true,
  };
}

/**
 * Precompute the geometry between every coarse candidate AP position and every
 * calibration stop: log-distance, walls crossed, floors crossed.
 *
 * WHY: wall counting dominates the cost of calibration. The coarse search scores
 * ~960 candidate positions against 30 stops, for each of 18 APs, twice — about a
 * million predictions, each intersecting a line against ~80 wall segments. But
 * the number of walls between a stop and a candidate position depends only on
 * the building, not on which AP is being fitted or on the model parameters. So
 * it is computed once here (~29k wall counts) and every later score becomes
 * pure arithmetic.
 *
 * The cached formula below must stay identical to `predictRssi` in wifi.js; the
 * test suite checks that the optimised calibration reproduces the unoptimised
 * result exactly.
 */
function buildGeometryCache(candidates, stops, wallsByLevel) {
  const size = candidates.length * stops.length;
  const logD = new Float64Array(size);
  const walls = new Float64Array(size);
  const floors = new Float64Array(size);
  candidates.forEach((candidate, c) => {
    stops.forEach((stop, i) => {
      const k = c * stops.length + i;
      logD[k] = Math.log10(Math.max(1, dist(stop, candidate)));
      walls[k] = countWallsCrossed(stop, candidate, wallsByLevel.get(stop.level) ?? []);
      floors[k] = Math.abs(candidate.level - stop.level);
    });
  });
  return { candidates, logD, walls, floors, stopCount: stops.length };
}

/**
 * Terms that depend on the AP and the stop but never on the candidate position
 * (the per-AP transmit offset and the spatially-correlated fading). Evaluated
 * once per stop per fit, rather than once per (candidate, stop) pair.
 */
function perStopTerms(id, stops, model) {
  const apOffset = deterministicApOffset(id) * (model.apOffsetScaleDb ?? 0);
  return stops.map((stop) => ({
    apOffset,
    fading: correlatedFading(stop, stop.level, id, model.fadingAmplitudeDb ?? 0),
  }));
}

/**
 * Best coarse candidate for one AP, scored from the geometry cache.
 *
 * A score is a sum of squares, so it only ever grows. Once a candidate's partial
 * score reaches the best complete score so far it cannot win, and the rest of
 * its stops are skipped. Ties still go to the earliest candidate (strict `<`),
 * so this changes the speed and nothing else.
 */
function scoreCached(cache, id, apIndex, stops, observations, model) {
  const terms = perStopTerms(id, stops, model);
  const { candidates, logD, walls, floors, stopCount } = cache;
  let winner = { ...candidates[0], score: Infinity };
  for (let c = 0; c < candidates.length; c++) {
    let score = 0;
    const base = c * stopCount;
    for (let i = 0; i < stopCount; i++) {
      const k = base + i;
      const predicted = rssiFromParts(
        logD[k],
        walls[k],
        floors[k],
        terms[i].apOffset,
        terms[i].fading,
        model,
      );
      const delta = observations[i][apIndex] - predicted;
      score += delta * delta;
      if (score >= winner.score) break;
    }
    if (score < winner.score) winner = { ...candidates[c], score };
  }
  return winner;
}

function estimateOneAp(id, apIndex, cache, stops, observations, wallsByLevel, model) {
  let best = scoreCached(cache, id, apIndex, stops, observations, model);

  const refinement = [];
  for (let dx = -1.5; dx <= 1.5; dx += 0.25) {
    for (let dy = -1.5; dy <= 1.5; dy += 0.25) {
      refinement.push({ x: best.x + dx, y: best.y + dy, level: best.level });
    }
  }
  best = scoreCandidates(refinement, id, apIndex, stops, observations, wallsByLevel, model);
  return { id, x: best.x, y: best.y, level: best.level };
}

/**
 * Fine refinement around the coarse winner. These candidates are different for
 * every AP, so there is nothing to cache — instead, wall crossings are counted
 * lazily and the same early exit skips them for any candidate already beaten.
 */
function scoreCandidates(candidates, id, apIndex, stops, observations, wallsByLevel, model) {
  const terms = perStopTerms(id, stops, model);
  let winner = { ...candidates[0], score: Infinity };
  for (const candidate of candidates) {
    let score = 0;
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const predicted = rssiFromParts(
        Math.log10(Math.max(1, dist(stop, candidate))),
        countWallsCrossed(stop, candidate, wallsByLevel.get(stop.level) ?? []),
        Math.abs(candidate.level - stop.level),
        terms[i].apOffset,
        terms[i].fading,
        model,
      );
      const delta = observations[i][apIndex] - predicted;
      score += delta * delta;
      if (score >= winner.score) break;
    }
    if (score < winner.score) winner = { ...candidate, score };
  }
  return winner;
}

function fitGlobalParameters(aps, stops, observations, wallsByLevel, base) {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let apIndex = 0; apIndex < aps.length; apIndex++) {
    const ap = aps[apIndex];
    for (let stopIndex = 0; stopIndex < stops.length; stopIndex++) {
      const stop = stops[stopIndex];
      const rssi = observations[stopIndex][apIndex];
      if (rssi <= base.floorDbm + 1) continue;
      const distance = Math.max(1, dist(stop, ap));
      const floors = Math.abs(stop.level - ap.level);
      const walls = countWallsCrossed(stop, ap, wallsByLevel.get(stop.level) ?? []);
      const x1 = 10 * Math.log10(distance);
      const x2 = walls;
      const y = base.p0 - floors * base.floorLossDb - rssi;
      a11 += x1 * x1;
      a12 += x1 * x2;
      a22 += x2 * x2;
      b1 += x1 * y;
      b2 += x2 * y;
    }
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return { ...base };
  const n = clamp((b1 * a22 - b2 * a12) / det, 2, 4);
  const wallLossDb = clamp((a11 * b2 - a12 * b1) / det, 2, 12);
  return { ...base, n, wallLossDb };
}

function walkableGrid(level, spacing) {
  const points = [];
  for (const rect of level.corridors) {
    for (let x = rect.x + spacing / 2; x < rect.x + rect.w; x += spacing) {
      for (let y = rect.y + spacing / 2; y < rect.y + rect.h; y += spacing) {
        if (!points.some((point) => dist(point, { x, y }) < 1e-6)) points.push({ x, y });
      }
    }
  }
  return points;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Kept exported for deterministic unit tests of the fitting path.
export const CALIBRATION_CONFIG = Object.freeze({
  stopsPerLevel: STOPS_PER_LEVEL,
  averagedScans: AVERAGED_SCANS,
});
