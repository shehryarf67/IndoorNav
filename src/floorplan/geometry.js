/**
 * geometry.js — pure 2D geometry helpers shared by all three prototypes.
 *
 * Everything in MallNav is expressed in METRES in a single building coordinate
 * system, with x growing to the right and y growing DOWNWARD. We chose
 * y-downward deliberately: it matches SVG's native coordinate system, so
 * rendering is a plain multiply by a scale factor with no axis flipping. Any
 * place we talk about "north" we mean smaller y (toward the top of the screen).
 *
 * No React, no DOM, no side effects in this file — it is the maths layer, and
 * it is unit-testable on its own.
 */

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x1: number, y1: number, x2: number, y2: number, type?: string }} Segment */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/** Euclidean distance between two points, in metres. */
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Squared distance — use inside hot loops to skip the square root. */
export function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Is a point inside an axis-aligned rectangle (inclusive of the border)? */
export function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Is a point inside ANY of the given rectangles? Used for the walkability test. */
export function pointInAnyRect(p, rects) {
  for (const r of rects) if (pointInRect(p, r)) return true;
  return false;
}

/** Centre point of a rectangle. */
export function rectCentre(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Clamp a point into the nearest position inside a rectangle.
 * This is the primitive behind Tab 3's "map matching": if the estimated
 * position drifts into a shop, we push it back to the closest legal spot.
 */
export function clampToRect(p, r) {
  return {
    x: Math.min(Math.max(p.x, r.x), r.x + r.w),
    y: Math.min(Math.max(p.y, r.y), r.y + r.h),
  };
}

/**
 * Snap a point to the closest point inside any of the given rectangles.
 * Returns the original point untouched if it is already inside one.
 */
export function snapToRects(p, rects) {
  if (pointInAnyRect(p, rects)) return p;
  let best = p;
  let bestD = Infinity;
  for (const r of rects) {
    const c = clampToRect(p, r);
    const d = dist2(p, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Closest point on the line SEGMENT ab to point p, plus the parameter t in
 * [0,1] describing how far along the segment it lies. Used to project shop
 * doors onto corridor centrelines when building the navigation graph.
 */
export function closestPointOnSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { point: { ...a }, t: 0 };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.min(1, Math.max(0, t));
  return { point: { x: a.x + t * abx, y: a.y + t * aby }, t };
}

/** Sign of the cross product (b-a) x (c-a): >0 counter-clockwise, <0 clockwise. */
function orientation(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : -1;
}

/**
 * Do the open segments p1p2 and p3p4 properly cross?
 *
 * We use the strict version (no collinear / touching-endpoint cases counted)
 * on purpose. In Tab 2 we count how many walls a radio ray punches through, and
 * a ray that merely grazes a wall corner should not be charged 6.5 dB of loss.
 */
export function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/**
 * How many of the given wall segments does the straight line from `a` to `b`
 * pass through?
 *
 * This single number is the heart of the propagation model in Tab 2: it is the
 * `walls_crossed` term in
 *     RSSI = P0 - 10*n*log10(d) - walls_crossed*wall_loss + noise
 * and it is the reason the signal falls off a cliff at every storefront, which
 * in turn is the reason geometric trilateration fails indoors.
 *
 * @param {Point} a
 * @param {Point} b
 * @param {Segment[]} walls
 * @returns {number} count of walls crossed
 */
export function countWallsCrossed(a, b, walls) {
  let n = 0;
  for (const w of walls) {
    if (segmentsIntersect(a, b, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) n++;
  }
  return n;
}

/** Length of a wall segment, in metres. */
export function segmentLength(s) {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/** Linear interpolation between two points. */
export function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Round a number to `dp` decimal places (for tidy on-screen readouts). */
export function round(v, dp = 1) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
