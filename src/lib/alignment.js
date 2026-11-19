/**
 * alignment.js — fitting separately-drawn floor plans into one coordinate frame.
 *
 * WHY THIS EXISTS
 * ---------------
 * A real mall supplies one drawing per floor, each scanned or exported on its
 * own: a different origin, a different scale (1:200 here, 1:250 there), and a
 * few degrees of rotation. Everything multi-floor in MallNav assumes the floors
 * are stacked exactly — a lift is joined to itself on the floor above, the
 * barometer moves the user through a connector to the SAME (x, y) upstairs, and
 * Wi-Fi bleed between floors is predicted from distances. Misaligned plans would
 * break all three. Today a person lines the drawings up by hand; this module
 * does it from a handful of anchor points.
 *
 * THE METHOD
 * ----------
 * Pick features that are vertically continuous — lift shafts, stair cores,
 * structural columns, the building's outer corners — and find them on each
 * drawing. Then solve for the similarity transform (scale, rotation,
 * translation: 4 numbers) that best maps one floor's anchors onto the
 * reference floor's, in the least-squares sense. This is the classic
 * Procrustes / Umeyama solution and has a closed form — no iteration.
 *
 * Two pairs determine the transform EXACTLY, which means they also give no way
 * to tell whether it is right. Every pair beyond two is redundancy: the leftover
 * disagreement (the residual) measures the quality of the fit, and a pair that
 * disagrees far more than the rest is almost certainly a mis-click, which is
 * dropped and the fit repeated.
 */

import { makeRng, gaussian } from './wifi.js';
import { CONNECTORS, BUILDING, CORRIDOR_AXES } from '../floorplan/floorplan.js';

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ scale: number, theta: number, tx: number, ty: number }} Similarity */

/** Apply a similarity transform: p' = scale · R(theta) · p + t. */
export function applySimilarity(T, p) {
  const c = Math.cos(T.theta);
  const s = Math.sin(T.theta);
  return {
    x: T.scale * (c * p.x - s * p.y) + T.tx,
    y: T.scale * (s * p.x + c * p.y) + T.ty,
  };
}

/** The inverse transform, so drawings can be generated FROM the true frame. */
export function invertSimilarity(T) {
  const scale = 1 / T.scale;
  const theta = -T.theta;
  // t' = -(1/s) R(-theta) t
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    scale,
    theta,
    tx: -scale * (c * T.tx - s * T.ty),
    ty: -scale * (s * T.tx + c * T.ty),
  };
}

/**
 * Least-squares similarity transform mapping `src[i]` onto `dst[i]`.
 *
 * Closed form: centre both point sets on their centroids, then the rotation
 * angle and scale fall straight out of two sums. With centred source (x, y)
 * and destination (X, Y):
 *
 *     a = Σ (x·X + y·Y)        b = Σ (x·Y − y·X)
 *     theta = atan2(b, a)      scale = √(a² + b²) / Σ (x² + y²)
 *
 * and the translation carries the rotated, scaled source centroid onto the
 * destination centroid.
 *
 * @param {Point[]} src anchors as drawn on the floor being aligned
 * @param {Point[]} dst the same anchors on the reference floor
 * @returns {Similarity & { residuals: number[], rmsM: number }}
 */
export function fitSimilarity(src, dst) {
  if (src.length !== dst.length) throw new Error('anchor lists must pair up');
  if (src.length < 2) throw new Error('at least two anchor pairs are needed');

  const n = src.length;
  const ms = { x: 0, y: 0 };
  const md = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    ms.x += src[i].x / n;
    ms.y += src[i].y / n;
    md.x += dst[i].x / n;
    md.y += dst[i].y / n;
  }

  let a = 0;
  let b = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i].x - ms.x;
    const y = src[i].y - ms.y;
    const X = dst[i].x - md.x;
    const Y = dst[i].y - md.y;
    a += x * X + y * Y;
    b += x * Y - y * X;
    norm += x * x + y * y;
  }
  if (norm < 1e-12) throw new Error('anchors are all at one point — cannot fit');

  const theta = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / norm;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const T = {
    scale,
    theta,
    tx: md.x - scale * (c * ms.x - s * ms.y),
    ty: md.y - scale * (s * ms.x + c * ms.y),
  };

  const residuals = src.map((p, i) => {
    const q = applySimilarity(T, p);
    return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
  });
  const rmsM = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / n);
  return { ...T, residuals, rmsM };
}

/** Minimum residual (m) before a pair can be called a mis-click at all. */
const OUTLIER_FLOOR_M = 0.75;
/**
 * How many times the clean fit's RMS disagreement a pair's leave-one-out error
 * must exceed to be dropped. Chosen by measurement: the false-rejection rate on
 * clean, correctly clicked anchors across 1,000 seeds per floor (see the tests).
 */
const OUTLIER_FACTOR = 5;

/**
 * How badly each pair is predicted by a fit made WITHOUT it (metres).
 *
 * Why leave-one-out rather than the ordinary residual: least squares pulls the
 * fit towards every point, and hardest towards points far from the others (a
 * building corner, say). A mis-clicked anchor in such a position drags the
 * whole alignment towards itself, which shrinks its OWN residual and spreads
 * the error onto the good anchors — so it no longer stands out. This is the
 * classic "masking" problem, and it really happened here: a mis-clicked corner
 * on the car park, which has only ten anchors, slipped through the
 * ordinary-residual test. A fit that excludes a point cannot be pulled by it.
 * With about ten anchors this is ten tiny closed-form fits — free.
 */
function leaveOneOutResiduals(pairs) {
  return pairs.map((pair, i) => {
    const others = pairs.filter((_, j) => j !== i);
    const fit = fitSimilarity(
      others.map((p) => p.src),
      others.map((p) => p.dst),
    );
    const q = applySimilarity(fit, pair.src);
    return Math.hypot(q.x - pair.dst.x, q.y - pair.dst.y);
  });
}

/**
 * Fit, then repeatedly drop the single worst pair if it is a clear outlier, and
 * refit. Stops when nothing stands out or when only three pairs would remain —
 * below that there is no redundancy left to judge outliers by.
 *
 * Why this rule: a correctly clicked anchor disagrees by roughly the clicking
 * precision (tens of centimetres); a pair matched to the wrong feature is off by
 * metres. "Far above the typical disagreement, and above an absolute floor"
 * separates the two without needing to know the clicking precision in advance.
 * Disagreement is measured leave-one-out (see above) so a mis-click cannot hide.
 *
 * @param {{ id: string, src: Point, dst: Point }[]} pairs
 */
export function fitRobust(pairs) {
  let kept = [...pairs];
  const rejected = [];

  while (kept.length > 3) {
    const loo = leaveOneOutResiduals(kept);
    let worst = 0;
    for (let i = 1; i < loo.length; i++) {
      if (loo[i] > loo[worst]) worst = i;
    }
    const r = loo[worst];

    // The yardstick is how well the OTHER anchors agree among themselves, from
    // a fit that excludes the suspect. Not the median of the leave-one-out
    // errors: a mis-click sits inside every other leave-one-out fit and inflates
    // them all, raising its own bar. On the car park (ten anchors, few on the
    // east side) a 6 m mis-clicked corner scored 5.83 m against a contaminated
    // bar of 5.91 m and slipped through.
    const others = kept.filter((_, i) => i !== worst);
    const baseline = fitSimilarity(
      others.map((p) => p.src),
      others.map((p) => p.dst),
    ).rmsM;
    if (r < OUTLIER_FLOOR_M || r < OUTLIER_FACTOR * baseline) break;
    rejected.push({ ...kept[worst], residualM: r });
    kept = kept.filter((_, i) => i !== worst);
  }

  const fit = fitSimilarity(
    kept.map((p) => p.src),
    kept.map((p) => p.dst),
  );

  return {
    transform: { scale: fit.scale, theta: fit.theta, tx: fit.tx, ty: fit.ty },
    rmsM: fit.rmsM,
    kept: kept.map((p, i) => ({ ...p, residualM: fit.residuals[i] })),
    rejected,
  };
}

// ---------------------------------------------------------------------------
// The anchors, and the simulated "as-supplied" drawings
// ---------------------------------------------------------------------------

/**
 * Vertically continuous features present on a floor, in true building metres.
 *
 * Connectors are only anchors on floors they serve (the car park has no
 * escalator). The four columns at the corridor crossing and the four corners of
 * the building shell run through every floor — which matters most for the car
 * park, whose two connectors alone would fit the transform exactly but leave no
 * redundancy to check it with.
 */
export function anchorsForLevel(level) {
  const half = 4; // corridor half-width
  const { hY } = CORRIDOR_AXES;
  const { vX } = CORRIDOR_AXES;
  const anchors = CONNECTORS.filter((c) => c.servesLevels.includes(level)).map((c) => ({
    id: c.id,
    label: c.shortLabel ?? c.label,
    kind: 'connector',
    x: c.x,
    y: c.y,
  }));
  const columns = [
    [vX - half, hY - half],
    [vX + half, hY - half],
    [vX - half, hY + half],
    [vX + half, hY + half],
  ].map(([x, y], i) => ({ id: `column-${i + 1}`, label: `Column ${i + 1}`, kind: 'column', x, y }));
  const W = BUILDING.widthM;
  const H = BUILDING.heightM;
  const corners = [
    [1, 1],
    [W - 1, 1],
    [W - 1, H - 1],
    [1, H - 1],
  ].map(([x, y], i) => ({ id: `corner-${i + 1}`, label: `Corner ${i + 1}`, kind: 'corner', x, y }));
  return [...anchors, ...columns, ...corners];
}

/**
 * How each floor's drawing was "supplied": the transform from true building
 * metres into that drawing's own units. Chosen to look like real-world
 * variation — a different scale (1:250 vs 1:200 => 0.8), a few degrees of
 * rotation from a skewed scan, and an origin somewhere else entirely.
 *
 * Level 1 is the REFERENCE: its drawing has already been scaled to metres from
 * its printed scale bar, so it defines the shared frame. Every other floor is
 * aligned to it. (Absolute scale has to come from somewhere; alignment can only
 * make floors agree with each other.)
 */
export const SUPPLIED_DRAWINGS = {
  0: { scale: 1.25, theta: (4 * Math.PI) / 180, tx: -6, ty: -5, note: 'Car park: 1:160 scan, rotated 4°' },
  1: { scale: 1, theta: 0, tx: 0, ty: 0, note: 'Ground floor: reference, scaled from its scale bar' },
  2: { scale: 0.8, theta: (-3 * Math.PI) / 180, tx: 9, ty: 6, note: 'Level 2: 1:250 export, rotated −3°' },
};

/** Standard deviation of where a person clicks an anchor, in true metres. */
export const CLICK_NOISE_M = 0.15;

/**
 * Simulate what a person would click on each floor's drawing: every anchor,
 * mapped into that drawing's units, with clicking noise — and optionally one
 * anchor matched to the wrong feature (a 6 m mis-click), to show the fit
 * catching it.
 *
 * Returns pairs of (as clicked on this floor's drawing, as clicked on the
 * reference drawing). Only anchors present on BOTH floors can be paired.
 */
export function simulateClicks(level, { seed = 1, misclick = false } = {}) {
  const rng = makeRng(seed + level * 101);
  const toDrawing = SUPPLIED_DRAWINGS[level];
  const refIds = new Set(anchorsForLevel(1).map((a) => a.id));
  const shared = anchorsForLevel(level).filter((a) => refIds.has(a.id));

  const noisy = (p) => ({
    x: p.x + gaussian(rng) * CLICK_NOISE_M,
    y: p.y + gaussian(rng) * CLICK_NOISE_M,
  });

  return shared.map((a, i) => {
    let truePoint = { x: a.x, y: a.y };
    // The mis-click: the person matches this anchor to the wrong feature.
    if (misclick && i === shared.length - 3) truePoint = { x: a.x + 6, y: a.y - 1.5 };
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      misclicked: misclick && i === shared.length - 3,
      src: applySimilarity(toDrawing, noisy(truePoint)),
      dst: noisy({ x: a.x, y: a.y }),
    };
  });
}

/** Map a level's wall segments into its supplied drawing's units. */
export function wallsAsDrawn(level, walls) {
  const T = SUPPLIED_DRAWINGS[level];
  return walls.map((w) => {
    const a = applySimilarity(T, { x: w.x1, y: w.y1 });
    const b = applySimilarity(T, { x: w.x2, y: w.y2 });
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, type: w.type };
  });
}

/**
 * Evaluation only: how far the fitted alignment puts every wall endpoint of the
 * floor from where it truly is. Uses the TRUE drawing transform, which a real
 * deployment would never know — hence "simulation only" wherever it is shown.
 */
export function alignmentErrorM(level, walls, fitted) {
  const toDrawing = SUPPLIED_DRAWINGS[level];
  const errors = [];
  for (const w of walls) {
    for (const p of [
      { x: w.x1, y: w.y1 },
      { x: w.x2, y: w.y2 },
    ]) {
      const back = applySimilarity(fitted, applySimilarity(toDrawing, p));
      errors.push(Math.hypot(back.x - p.x, back.y - p.y));
    }
  }
  errors.sort((x, y) => x - y);
  return {
    meanM: errors.reduce((s, e) => s + e, 0) / errors.length,
    maxM: errors[errors.length - 1],
  };
}
