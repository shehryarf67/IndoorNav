/**
 * Performance guards — and, more importantly, proofs that the optimisations
 * changed the speed and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, ALL_APS } from '../src/floorplan/floorplan.js';
import { countWallsCrossed, segmentsIntersect } from '../src/floorplan/geometry.js';
import { MAP_MODEL, makeRng, predictRssi } from '../src/lib/wifi.js';
import { runApCalibration } from '../src/lib/apCalibration.js';

/** The original definition: one segmentsIntersect call per wall. */
function referenceWallCount(a, b, walls) {
  return walls.filter((w) => segmentsIntersect(a, b, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }))
    .length;
}

test('the allocation-free wall counter agrees exactly with the reference definition', () => {
  const rng = makeRng(11);
  for (let k = 0; k < 50_000; k++) {
    const level = LEVELS[k % LEVELS.length];
    // A quarter of the points are snapped to whole metres, which lands them on
    // wall endpoints and collinear with walls — the degenerate cases where a
    // rewrite is most likely to disagree.
    const snap = k % 4 === 0 ? Math.round : (v) => v;
    const a = { x: snap(rng() * 60), y: snap(rng() * 40) };
    const b = { x: snap(rng() * 60), y: snap(rng() * 40) };
    assert.equal(countWallsCrossed(a, b, level.walls), referenceWallCount(a, b, level.walls));
  }
});

test('AP calibration is fast and does not slow down when run repeatedly', () => {
  // It runs in the browser when the presenter clicks "calibrate", so a slow run
  // freezes the tab. Before the geometry cache and the allocation-free wall
  // counter this took ~19 s on three floors, and degraded to ~4x slower on
  // repeated runs as the JIT gave up specialising the hot path.
  const times = [];
  let first = null;
  for (let k = 0; k < 4; k++) {
    const t0 = performance.now();
    const result = runApCalibration(LEVELS, ALL_APS, MAP_MODEL, 4401);
    times.push(performance.now() - t0);
    if (!first) first = result;
    else {
      // Deterministic: every repeat must give exactly the same answer.
      assert.deepEqual(result.estimatedAps, first.estimatedAps);
    }
  }
  const worst = Math.max(...times);
  assert.ok(worst < 3000, `calibration runs took ${times.map((t) => t.toFixed(0)).join(', ')} ms`);
});

test('predictRssi is unchanged by the rssiFromParts refactor', () => {
  // Spot values computed from the formula by hand, so a future edit to the
  // shared formula cannot slip through unnoticed.
  const ap = { id: 'X', x: 0, y: 0, level: 1 };
  const walls = new Map([[1, []], [2, []]]);
  const tenMetres = predictRssi({ x: 10, y: 0 }, 1, ap, walls, MAP_MODEL);
  assert.ok(Math.abs(tenMetres - (MAP_MODEL.p0 - 10 * MAP_MODEL.n)) < 1e-9);
  const upstairs = predictRssi({ x: 10, y: 0 }, 2, ap, walls, MAP_MODEL);
  assert.ok(Math.abs(tenMetres - upstairs - MAP_MODEL.floorLossDb) < 1e-9);
});
