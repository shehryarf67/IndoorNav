/**
 * Multi-floor routing invariants.
 *
 * These tests route EVERY pair of shop doors in the building, under every route
 * profile, and check the rules that make multi-floor navigation trustworthy.
 * Each test corresponds to a mistake that is easy to make and expensive to ship:
 * sending someone the wrong way up an escalator, routing a wheelchair user to the
 * stairs, or routing anyone through a lift that is out of service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, CONNECTORS, getLevel } from '../src/floorplan/floorplan.js';
import {
  buildNavGraph,
  findRoute,
  routeInstructions,
  ROUTE_PROFILES,
} from '../src/lib/navGraph.js';

const graph = buildNavGraph(LEVELS, CONNECTORS);
const doors = graph.nodes.filter((n) => n.kind === 'door');
const connectorById = new Map(CONNECTORS.map((c) => [c.id, c]));

/** Every ordered pair of distinct doors. */
function* allPairs() {
  for (const a of doors) for (const b of doors) if (a.id !== b.id) yield [a, b];
}

/** Route every pair under one set of options and hand each result to `check`. */
function forEveryRoute(options, check) {
  let routed = 0;
  for (const [a, b] of allPairs()) {
    const route = findRoute(graph, a.id, b.id, options);
    check(route, a, b);
    if (route) routed++;
  }
  return routed;
}

test('the data model covers three floors with connectors that serve different floors', () => {
  assert.equal(LEVELS.length, 3);
  const ordinals = LEVELS.map((l) => l.ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b), 'LEVELS sorted by ordinal');
  const parking = LEVELS.find((l) => l.ordinal === 0);
  const parkingConnectors = parking.verticalLinks.map((c) => c.type).sort();
  assert.deepEqual(parkingConnectors, ['lift', 'stairs'], 'no escalator reaches the car park');
});

test('every door can reach every other door on the fastest profile', () => {
  const routed = forEveryRoute({}, (route, a, b) => {
    assert.ok(route, `no route from ${a.id} to ${b.id}`);
  });
  assert.equal(routed, doors.length * (doors.length - 1));
});

test('escalators are only ever ridden in their direction of travel', () => {
  let escalatorRides = 0;
  forEveryRoute({}, (route) => {
    for (const t of route.transports) {
      if (t.transport !== 'escalator') continue;
      escalatorRides++;
      const going = getLevel(t.toLevel).ordinal > getLevel(t.fromLevel).ordinal ? 'up' : 'down';
      assert.equal(going, connectorById.get(t.connectorId).direction, `${t.connectorId} ridden ${going}`);
    }
  });
  assert.ok(escalatorRides > 0, 'the test must actually exercise escalators');
});

test('step-free routes never use stairs or escalators', () => {
  forEveryRoute({ profile: 'step-free' }, (route) => {
    assert.ok(route, 'the lift reaches every floor, so step-free is always possible');
    for (const t of route.transports) assert.equal(t.transport, 'lift');
  });
});

test('avoid-escalators routes never use an escalator', () => {
  forEveryRoute({ profile: 'avoid-escalators' }, (route) => {
    assert.ok(route);
    for (const t of route.transports) assert.notEqual(t.transport, 'escalator');
  });
});

test('an out-of-service connector is never used, and step-free fails honestly without the lift', () => {
  forEveryRoute({ disabledConnectors: ['lift'] }, (route) => {
    assert.ok(route, 'stairs still connect every floor');
    for (const t of route.transports) assert.notEqual(t.connectorId, 'lift');
  });

  // With the only step-free connector broken, cross-floor step-free routes must
  // return null rather than quietly sending a wheelchair user to the stairs.
  forEveryRoute({ profile: 'step-free', disabledConnectors: ['lift'] }, (route, a, b) => {
    if (a.level === b.level) assert.ok(route, 'same-floor routes need no connector');
    else assert.equal(route, null);
  });
});

test('A* returns exactly the Dijkstra-optimal cost for every pair under every profile', () => {
  // This is the empirical proof that the multi-floor heuristic is admissible: if
  // it ever overestimated, A* would sometimes return a costlier path than
  // Dijkstra (which is A* with a zero heuristic).
  for (const profile of Object.keys(ROUTE_PROFILES)) {
    forEveryRoute({ profile }, (route, a, b) => {
      const reference = findRoute(graph, a.id, b.id, { profile, heuristic: false });
      const costOf = (r) => r.edges.reduce((s, e) => s + e.cost, 0);
      assert.ok(Math.abs(costOf(route) - costOf(reference)) < 1e-6, `${profile}: ${a.id}->${b.id}`);
      assert.ok(route.visitedCount <= reference.visitedCount, 'A* never explores more than Dijkstra');
    });
  }
});

test('a lift ride across two floors pays its wait once, not once per floor', () => {
  const lift = connectorById.get('lift');
  const twoFloorRide = graph.edges.find(
    (e) => e.connectorId === 'lift' && e.floors === 2,
  );
  assert.ok(twoFloorRide);
  assert.equal(twoFloorRide.seconds, lift.waitS + 2 * lift.secondsPerFloor);
});

test('route instructions have one ride step per floor change and end at the destination', () => {
  forEveryRoute({}, (route, a, b) => {
    const steps = routeInstructions(graph, route);
    assert.equal(steps.filter((s) => s.kind === 'ride').length, route.transports.length);
    if (steps.length) assert.match(steps.at(-1).text, new RegExp(b.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('routing every pair of shops in the building is fast', () => {
  const t0 = performance.now();
  const routed = forEveryRoute({}, () => {});
  const ms = performance.now() - t0;
  // ~2,100 routes. A real app routes one at a time; this is a generous ceiling
  // that would catch an accidental return to an O(n^2) frontier.
  assert.ok(ms < 1500, `all-pairs routing took ${ms.toFixed(0)} ms for ${routed} routes`);
});

// ---------------------------------------------------------------------------
// Facts Tab 1's routing panel relies on
// ---------------------------------------------------------------------------

const levelName = (l) => getLevel(l).name;
const doorOn = (level) => doors.find((d) => d.level === level);

test('route instructions use the supplied floor names and never print a raw level number', () => {
  // A marker name proves every floor reference goes through `levelName`; the
  // car park is level 0 but must never be shown as "Level 0".
  forEveryRoute({}, (route) => {
    for (const step of routeInstructions(graph, route, (l) => `<${getLevel(l).shortName}>`)) {
      assert.doesNotMatch(step.text, /Level \d/, step.text);
      assert.match(step.text, /<(P|L1|L2)>/, step.text);
    }
  });
  const toParking = findRoute(graph, doorOn(2).id, doorOn(0).id);
  const text = routeInstructions(graph, toParking, levelName).map((s) => s.text).join(' | ');
  assert.match(text, /Level P — Parking/);
  assert.doesNotMatch(text, /Level 0/);
});

test('ride steps pair one-to-one, in order, with route.transports, and the steps add up to the route time', () => {
  forEveryRoute({ profile: 'step-free' }, (route) => {
    const steps = routeInstructions(graph, route, levelName);
    const rides = steps.filter((s) => s.kind === 'ride');
    rides.forEach((s, i) => {
      assert.equal(s.seconds, route.transports[i].seconds);
      assert.equal(s.level, route.transports[i].fromLevel);
    });
    // Walks under 0.5 m are dropped from the list, so allow that much slack per step.
    const total = steps.reduce((sum, s) => sum + s.seconds, 0);
    assert.ok(Math.abs(total - route.seconds) <= (steps.length + 1) * (0.5 / 1.25), `${total} vs ${route.seconds}`);
  });
});

test('with every connector out of service, cross-floor trips have no route and same-floor trips still do', () => {
  const allOff = CONNECTORS.map((c) => c.id);
  for (const profile of Object.keys(ROUTE_PROFILES)) {
    forEveryRoute({ profile, disabledConnectors: allOff }, (route, a, b) => {
      if (a.level === b.level) assert.ok(route, `${profile}: same-floor ${a.id}->${b.id}`);
      else assert.equal(route, null, `${profile}: ${a.id}->${b.id} must not route`);
    });
  }
});

test('profiles allow exactly the connectors their one-line descriptions promise', () => {
  const allowedBy = (profile) =>
    CONNECTORS.filter((c) =>
      ROUTE_PROFILES[profile].allow(graph.edges.find((e) => e.connectorId === c.id)),
    ).map((c) => c.id);
  assert.deepEqual(allowedBy('fastest'), CONNECTORS.map((c) => c.id));
  assert.deepEqual(allowedBy('step-free'), ['lift']);
  assert.deepEqual(allowedBy('avoid-escalators'), ['stairs', 'lift']);
});

test('no-route explanations are backed by real counterfactuals', () => {
  const parking = doorOn(0);
  const top = doorOn(2);
  // Step-free with the lift down: no route, but returning the lift restores one,
  // and a non-step-free route exists that the UI must only OFFER.
  assert.equal(findRoute(graph, parking.id, top.id, { profile: 'step-free', disabledConnectors: ['lift'] }), null);
  assert.ok(findRoute(graph, parking.id, top.id, { profile: 'step-free' }));
  const viaStairs = findRoute(graph, parking.id, top.id, { profile: 'fastest', disabledConnectors: ['lift'] });
  assert.deepEqual(viaStairs.transports.map((t) => t.connectorId), ['stairs']);

  // Everything off, going up from L1: the down-escalator alone cannot help
  // (wrong way); each of the other three alone can.
  const allOff = CONNECTORS.map((c) => c.id);
  const l1 = doorOn(1);
  const restores = (id) =>
    !!findRoute(graph, l1.id, top.id, { disabledConnectors: allOff.filter((x) => x !== id) });
  assert.deepEqual(allOff.filter(restores), ['escalator-up', 'stairs', 'lift']);

  // The car park is not served by escalators, so with stairs and lift down it is cut off.
  assert.equal(findRoute(graph, parking.id, top.id, { disabledConnectors: ['stairs', 'lift'] }), null);
});

test('the one-floor annex routes every pair with no connectors at all, and its directions name the annex', async () => {
  const { ALTERNATE_LEVELS, ALTERNATE_VERTICAL_LINKS } = await import('../src/floorplan/alternateFloorplan.js');
  const annex = buildNavGraph(ALTERNATE_LEVELS, ALTERNATE_VERTICAL_LINKS);
  const annexDoors = annex.nodes.filter((n) => n.kind === 'door');
  const name = (l) => ALTERNATE_LEVELS.find((x) => x.level === l).name;
  for (const a of annexDoors) {
    for (const b of annexDoors) {
      if (a.id === b.id) continue;
      const route = findRoute(annex, a.id, b.id, { profile: 'step-free' });
      assert.ok(route, `${a.id}->${b.id}`);
      assert.equal(route.transports.length, 0);
      for (const step of routeInstructions(annex, route, name)) {
        assert.equal(step.kind, 'walk');
        assert.ok(step.text.includes(name(step.level)), step.text);
      }
    }
  }
});
