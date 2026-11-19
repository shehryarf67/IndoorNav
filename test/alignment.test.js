/** Floor-plan alignment: the least-squares fit and its outlier rejection. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getLevel } from '../src/floorplan/floorplan.js';
import {
  applySimilarity,
  invertSimilarity,
  fitSimilarity,
  fitRobust,
  simulateClicks,
  alignmentErrorM,
  SUPPLIED_DRAWINGS,
} from '../src/lib/alignment.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test('noise-free anchors recover the transform exactly', () => {
  const T = { scale: 1.25, theta: 0.07, tx: -6, ty: -5 };
  const truth = [{ x: 1, y: 1 }, { x: 59, y: 1 }, { x: 30, y: 20 }, { x: 5, y: 33 }];
  const fit = fitSimilarity(truth.map((p) => applySimilarity(T, p)), truth);
  const inv = invertSimilarity(T);
  close(fit.scale, inv.scale, 1e-9, 'scale');
  close(fit.theta, inv.theta, 1e-9, 'rotation');
  close(fit.tx, inv.tx, 1e-9, 'tx');
  close(fit.ty, inv.ty, 1e-9, 'ty');
  assert.ok(fit.rmsM < 1e-9);
});

test('fewer than two pairs, or all-identical points, are refused rather than guessed', () => {
  assert.throws(() => fitSimilarity([{ x: 0, y: 0 }], [{ x: 0, y: 0 }]));
  assert.throws(() =>
    fitSimilarity([{ x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: 2, y: 2 }, { x: 3, y: 3 }]),
  );
});

/** Pairs with anchor k displaced by `metres` on the drawing being aligned. */
function withMisclick(level, seed, k, metres) {
  const T = SUPPLIED_DRAWINGS[level];
  return simulateClicks(level, { seed }).map((p, i) =>
    i !== k
      ? p
      : { ...p, src: applySimilarity(T, { x: p.dst.x + metres * 0.8, y: p.dst.y - metres * 0.6 }) },
  );
}

test('clean clicks: every floor aligns to within 0.6 m everywhere, rarely rejecting a good anchor', () => {
  // Measured over 1,000 seeds per floor during development: worst point 0.56 m,
  // false rejections 0.3% (car park) / 0.1% (Level 2). A false rejection costs no
  // accuracy — nine or more good anchors remain — so the bound below is on error.
  for (const level of [0, 2]) {
    let falseRejections = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const fit = fitRobust(simulateClicks(level, { seed }));
      falseRejections += fit.rejected.length;
      const err = alignmentErrorM(level, getLevel(level).walls, fit.transform);
      assert.ok(err.maxM < 0.6, `L${level} seed ${seed}: worst wall point ${err.maxM.toFixed(2)} m`);
    }
    assert.ok(falseRejections <= 2, `L${level}: ${falseRejections} good anchors rejected in 200 runs`);
  }
});

test('a large mis-click on ANY anchor is caught, and never distorts the floor beyond 0.6 m', () => {
  // Every anchor position, not just a convenient one: corners far from the rest
  // are exactly where least squares hides an outlier (the "masking" problem).
  for (const level of [0, 2]) {
    const n = simulateClicks(level, { seed: 1 }).length;
    let caught = 0;
    let trials = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (let k = 0; k < n; k++) {
        const pairs = withMisclick(level, seed, k, 6);
        const fit = fitRobust(pairs);
        trials++;
        if (fit.rejected.some((r) => r.id === pairs[k].id)) caught++;
        const err = alignmentErrorM(level, getLevel(level).walls, fit.transform);
        assert.ok(err.maxM < 0.6, `L${level} seed ${seed} anchor ${pairs[k].id}: ${err.maxM.toFixed(2)} m`);
      }
    }
    assert.ok(caught / trials >= 0.98, `L${level}: caught ${caught}/${trials}`);
  }
});

test('the built-in demo mis-click is rejected on both floors', () => {
  for (const level of [0, 2]) {
    for (let seed = 1; seed <= 20; seed++) {
      const pairs = simulateClicks(level, { seed, misclick: true });
      const bad = pairs.find((p) => p.misclicked);
      assert.ok(fitRobust(pairs).rejected.some((r) => r.id === bad.id), `L${level} seed ${seed}`);
    }
  }
});

test('with only three anchors no outlier rejection is attempted — there is no redundancy to judge by', () => {
  const pairs = withMisclick(2, 1, 0, 6).slice(0, 3);
  assert.equal(fitRobust(pairs).rejected.length, 0);
});

test('inverting a transform and applying both is the identity', () => {
  const T = { scale: 0.8, theta: -0.05, tx: 9, ty: 6 };
  const p = { x: 12.3, y: 27.9 };
  const back = applySimilarity(invertSimilarity(T), applySimilarity(T, p));
  close(back.x, p.x, 1e-9, 'x');
  close(back.y, p.y, 1e-9, 'y');
});

test('without outlier rejection the same mis-click visibly distorts the floor', () => {
  // Guards the reason fitRobust exists: a plain fit that keeps the bad pair.
  const pairs = simulateClicks(2, { seed: 1, misclick: true });
  const plain = fitSimilarity(pairs.map((p) => p.src), pairs.map((p) => p.dst));
  const err = alignmentErrorM(2, getLevel(2).walls, plain);
  assert.ok(err.maxM > 0.5, `plain fit worst error only ${err.maxM.toFixed(2)} m`);
});
