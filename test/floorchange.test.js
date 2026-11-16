/**
 * Floor-change detection: the barometer detector, the connector-constrained
 * floor transition, and the end-to-end behaviour on both walking routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, ALL_APS, CONNECTORS, FLOOR_HEIGHT_M } from '../src/floorplan/floorplan.js';
import { buildRadioMap, makeRng, gaussian } from '../src/lib/wifi.js';
import { applyFloorTransition, initParticlesAt } from '../src/lib/particleFilter.js';
import {
  BAROMETER,
  WALK_ROUTES,
  buildWalkPlan,
  buildFusionContext,
  initFusionState,
  stepFusion,
  updateFloorDetector,
} from '../src/lib/fusion.js';

const DT = 0.1;

/** A fresh detector anchored at height 0. */
function freshDetector() {
  return {
    referenceHpa: BAROMETER.baseHpa,
    smoothedHpa: BAROMETER.baseHpa,
    relativeHeightM: 0,
    history: [{ t: 0, h: 0, steps: 0 }],
    settledSince: null,
    transition: null,
  };
}

/**
 * Feed the detector a height profile, with the same noise and drift model the
 * simulation uses, and collect every confirmed floor change.
 */
function runDetector(heightAt, stepsAt, seconds, seed = 1) {
  const rng = makeRng(seed);
  let det = freshDetector();
  let drift = 0;
  const confirmed = [];
  for (let t = DT; t <= seconds + 1e-9; t += DT) {
    drift += gaussian(rng) * BAROMETER.driftHpaPerSqrtS * Math.sqrt(DT);
    const p =
      BAROMETER.baseHpa + BAROMETER.hpaPerMetre * heightAt(t) + drift + gaussian(rng) * BAROMETER.noiseHpa;
    det = updateFloorDetector(det, p, t, DT, stepsAt(t));
    if (det.confirmed) confirmed.push({ t, ...det.confirmed });
  }
  return confirmed;
}

/** Height profile: flat, then a climb of `floors` storeys at `speed`, then flat. */
const ride = (startT, floors, speedMps) => (t) => {
  const total = Math.abs(floors) * FLOOR_HEIGHT_M;
  return Math.min(total, Math.max(0, (t - startT) * speedMps)) * Math.sign(floors || 1);
};

test('standing still for ten minutes never reports a floor change', () => {
  // Weather and HVAC drift are on, so this is the false-positive test that
  // matters: a detector that trusted absolute pressure would fail it.
  for (let seed = 1; seed <= 5; seed++) {
    const confirmed = runDetector(() => 0, () => 0, 600, seed);
    assert.deepEqual(confirmed, [], `seed ${seed} reported ${confirmed.length} phantom changes`);
  }
});

test('an escalator ride is confirmed once, as one floor up, by escalator, soon after arrival', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const arrival = 10 + FLOOR_HEIGHT_M / 0.2;
    const confirmed = runDetector(ride(10, 1, 0.2), () => 0, 60, seed);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].floors, 1);
    assert.equal(confirmed[0].type, 'escalator');
    assert.ok(confirmed[0].t - arrival < 6, `confirmed ${(confirmed[0].t - arrival).toFixed(1)} s late`);
    assert.ok(Math.abs(confirmed[0].arrivalT - arrival) < 2.5, 'arrival time estimated');
  }
});

test('a lift ride down two floors is confirmed as two floors down, by lift', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const confirmed = runDetector(ride(10, -2, 0.45), () => 0, 60, seed);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].floors, -2);
    assert.equal(confirmed[0].type, 'lift');
  }
});

test('climbing stairs is recognised from the steps taken during the climb', () => {
  // ~0.17 m per riser while climbing at 0.15 m/s.
  const height = ride(10, 1, 0.15);
  const steps = (t) => height(t) / 0.17;
  const confirmed = runDetector(height, steps, 60, 3);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].type, 'stairs');
});

test('the floor transition never sends anyone down an up-escalator', () => {
  const rng = makeRng(5);
  const ctx = buildFusionContext({ points: [], vectors: [], spacing: 1.5 }, ALL_APS, LEVELS);
  // A cloud on Level 2, standing right at the up-escalator, going DOWN a floor.
  const upEsc = CONNECTORS.find((c) => c.id === 'escalator-up');
  const particles = initParticlesAt(upEsc, 2, rng);
  const result = applyFloorTransition(
    particles,
    {
      deltaFloors: -1,
      typeHint: 'escalator',
      connectors: CONNECTORS,
      ordinalByLevel: ctx.ordinalByLevel,
      levelByOrdinal: ctx.levelByOrdinal,
      spreadM: 1,
    },
    rng,
  );
  assert.notEqual(result.connectorId, 'escalator-up');
  assert.equal(result.connectorId, 'escalator-down', 'the down-escalator is right beside it');
  assert.ok(result.particles.every((p) => p.level === 1));
});

test('no escalator reaches the car park, so a floor change down to it cannot use one', () => {
  const rng = makeRng(9);
  const ctx = buildFusionContext({ points: [], vectors: [], spacing: 1.5 }, ALL_APS, LEVELS);
  const downEsc = CONNECTORS.find((c) => c.id === 'escalator-down');
  const result = applyFloorTransition(
    initParticlesAt(downEsc, 1, rng),
    {
      deltaFloors: -1,
      connectors: CONNECTORS,
      ordinalByLevel: ctx.ordinalByLevel,
      levelByOrdinal: ctx.levelByOrdinal,
      spreadM: 1,
    },
    rng,
  );
  const used = CONNECTORS.find((c) => c.id === result.connectorId);
  assert.ok(!used || used.type !== 'escalator');
  assert.ok(result.particles.every((p) => p.level === 0));
});

test('end to end: the barometer detects every floor change within seconds on both routes', () => {
  const rm = buildRadioMap(LEVELS, ALL_APS);
  const ctx = buildFusionContext(rm, ALL_APS, LEVELS);
  const layers = { dr: true, qr: true, wifi: true, mapMatch: true, baro: true };
  for (const route of Object.values(WALK_ROUTES)) {
    const plan = buildWalkPlan(route);
    const latencies = [];
    for (let seed = 1; seed <= 4; seed++) {
      let s = initFusionState(plan, seed, layers, ctx);
      while (!s.finished) s = stepFusion(s, DT, plan, layers, ctx, 30);
      assert.equal(s.floorChangeLatencies.length, plan.floorChanges, `${route.id}: missed a floor change`);
      assert.equal(s.floorChanges.length, plan.floorChanges, `${route.id}: phantom floor change`);
      latencies.push(...s.floorChangeLatencies);
    }
    const worst = Math.max(...latencies);
    assert.ok(worst < 10, `${route.id}: worst latency ${worst.toFixed(1)} s`);
  }
});
