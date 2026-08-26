/**
 * Short-walk AP calibration for Tab 2.
 *
 * Instead of surveying every radio-map point, a technician records all APs at
 * twenty known corridor stops. A coarse-to-fine nonlinear search estimates AP
 * floor/position; then a small least-squares fit estimates the global path-loss
 * exponent and wall attenuation from the same measurements.
 */

import { countWallsCrossed, dist } from '../floorplan/geometry.js';
import { MAP_MODEL, makeRng, observeVector, predictRssi } from './wifi.js';

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

  const firstPass = trueAps.map((ap, apIndex) =>
    estimateOneAp(ap.id, apIndex, levels, stops, observations, wallsByLevel, MAP_MODEL),
  );
  const fitted = fitGlobalParameters(firstPass, stops, observations, wallsByLevel, MAP_MODEL);
  const estimatedAps = trueAps.map((ap, apIndex) =>
    estimateOneAp(ap.id, apIndex, levels, stops, observations, wallsByLevel, fitted),
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
    estimatedWalkMinutes: stops.length * 0.4,
    buildMs: performance.now() - t0,
    bestCase: true,
  };
}

function estimateOneAp(id, apIndex, levels, stops, observations, wallsByLevel, model) {
  const coarse = levels.flatMap((level) =>
    walkableGrid(level, 1.5).map((point) => ({ ...point, level: level.level })),
  );
  let best = scoreCandidates(coarse, id, apIndex, stops, observations, wallsByLevel, model);

  const refinement = [];
  for (let dx = -1.5; dx <= 1.5; dx += 0.25) {
    for (let dy = -1.5; dy <= 1.5; dy += 0.25) {
      refinement.push({ x: best.x + dx, y: best.y + dy, level: best.level });
    }
  }
  best = scoreCandidates(refinement, id, apIndex, stops, observations, wallsByLevel, model);
  return { id, x: best.x, y: best.y, level: best.level };
}

function scoreCandidates(candidates, id, apIndex, stops, observations, wallsByLevel, model) {
  let winner = { ...candidates[0], score: Infinity };
  for (const candidate of candidates) {
    const ap = { id, ...candidate };
    let score = 0;
    for (let i = 0; i < stops.length; i++) {
      const predicted = predictRssi(stops[i], stops[i].level, ap, wallsByLevel, model);
      const delta = observations[i][apIndex] - predicted;
      score += delta * delta;
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
