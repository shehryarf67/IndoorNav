import test from 'node:test';
import assert from 'node:assert/strict';

import { countWallsCrossed, segmentsIntersect } from '../src/floorplan/geometry.js';
import {
  ALL_APS,
  ALL_SHOPS,
  LEVELS,
  VERTICAL_LINKS,
} from '../src/floorplan/floorplan.js';
import {
  ALTERNATE_LEVELS,
  ALTERNATE_VERTICAL_LINKS,
} from '../src/floorplan/alternateFloorplan.js';
import { buildNavGraph, findRoute } from '../src/lib/navGraph.js';
import {
  MAP_MODEL,
  buildRadioMap,
  correlatedFading,
  deterministicApOffset,
  evaluateBatch,
  predictRssi,
} from '../src/lib/wifi.js';
import { CALIBRATION_CONFIG, runApCalibration } from '../src/lib/apCalibration.js';

test('geometry detects crossings and counts only crossed walls', () => {
  assert.equal(
    segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -2 }, { x: 5, y: 2 }),
    true,
  );
  assert.equal(
    countWallsCrossed(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      [
        { x1: 3, y1: -2, x2: 3, y2: 2 },
        { x1: 7, y1: -2, x2: 7, y2: 2 },
        { x1: 0, y1: 4, x2: 10, y2: 4 },
      ],
    ),
    2,
  );
});

function assertConnectedGraph(levels, verticalLinks) {
  const graph = buildNavGraph(levels, verticalLinks);
  const seen = new Set();
  const queue = [graph.nodes[0].id];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.adjacency.get(id)) {
      queue.push(edge.from === id ? edge.to : edge.from);
    }
  }
  assert.equal(seen.size, graph.nodes.length, 'every generated node should be connected');
  assert.equal(
    graph.nodes.filter((node) => node.kind === 'door').length,
    levels.flatMap((level) => level.shops).length,
    'every shop should have a routable door node',
  );
  for (const edge of graph.edges) {
    assert.ok(Number.isFinite(edge.cost) && edge.cost >= 0);
    assert.ok(graph.nodeById.has(edge.from) && graph.nodeById.has(edge.to));
  }
  return graph;
}

test('generated graphs are connected for the main mall and unseen annex', () => {
  const main = assertConnectedGraph(LEVELS, VERTICAL_LINKS);
  const annex = assertConnectedGraph(ALTERNATE_LEVELS, ALTERNATE_VERTICAL_LINKS);
  assert.equal(main.nodes.filter((node) => node.kind === 'door').length, ALL_SHOPS.length);
  assert.equal(annex.stats.levelCount, 1);
});

test('step-free routing excludes stairs and escalators', () => {
  const graph = buildNavGraph(LEVELS, VERTICAL_LINKS);
  const start = 'L1-door-khaadi';
  const goal = 'L2-door-cinepax-cinema';
  const fastest = findRoute(graph, start, goal);
  const stepFree = findRoute(graph, start, goal, { accessibleOnly: true });
  assert.ok(fastest && stepFree);
  assert.ok(stepFree.transports.every((edge) => edge.accessible));
  assert.ok(stepFree.transports.some((edge) => edge.transport === 'lift'));
  assert.ok(stepFree.seconds > fastest.seconds);
});

test('radio propagation is deterministic and applies floor loss exactly', () => {
  const walls = new Map([[1, []], [2, []]]);
  const ap = { id: 'test-ap', x: 5, y: 5, level: 1 };
  const point = { x: 15, y: 5 };
  const sameFloor = predictRssi(point, 1, ap, walls, MAP_MODEL);
  const otherFloor = predictRssi(point, 2, ap, walls, MAP_MODEL);
  assert.ok(Math.abs(sameFloor - otherFloor - MAP_MODEL.floorLossDb) < 1e-9);
  assert.equal(correlatedFading(point, 1, ap.id, 0), 0);
  assert.equal(
    correlatedFading(point, 1, ap.id, 4),
    correlatedFading(point, 1, ap.id, 4),
  );
  assert.ok(deterministicApOffset(ap.id) >= -1 && deterministicApOffset(ap.id) <= 1);
});

test('seeded fingerprint evaluation stays within the documented prototype envelope', () => {
  const radioMap = buildRadioMap(LEVELS, ALL_APS);
  const result = evaluateBatch(radioMap, LEVELS, 120, MAP_MODEL, 90210, ALL_APS);
  assert.ok(result.fingerprint.mean < 3);
  assert.ok(result.floorAccuracy > 0.95);
  assert.ok(result.fingerprint.mean < result.trilateration.mean);
});

test('short-walk AP calibration recovers floor, position, and model parameters', () => {
  const result = runApCalibration(LEVELS, ALL_APS, MAP_MODEL, 4401);
  assert.equal(result.stops.length, LEVELS.length * CALIBRATION_CONFIG.stopsPerLevel);
  assert.equal(result.averagedScans, CALIBRATION_CONFIG.averagedScans);
  assert.equal(result.floorAccuracy, 1);
  assert.ok(result.meanErrorM < 1.25);
  assert.ok(Math.abs(result.fittedModel.n - MAP_MODEL.n) < 0.35);
  assert.ok(Math.abs(result.fittedModel.wallLossDb - MAP_MODEL.wallLossDb) < 1.5);
});
