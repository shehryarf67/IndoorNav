/**
 * navGraph.js — derive a routable navigation graph from the floor plan, and
 * search it with A*.
 *
 * WHY THIS MATTERS
 * ----------------
 * A navigation graph is what turns a picture of a building into something a
 * phone can route on. Nodes are decision points (junctions, corridor ends, shop
 * doors); edges are walkable connections with a real length in metres. Today,
 * deploying an indoor navigation product in a new mall means a human opens the
 * architect's drawing and traces this graph by hand — typically 30–40 minutes
 * per floor, and it has to be redone every time a tenant moves. Automating this
 * step is the difference between onboarding one mall and onboarding fifty.
 *
 * HOW THIS IMPLEMENTATION WORKS
 * -----------------------------
 * The floor plan in this demo is already clean vector geometry, so we derive the
 * graph directly from the corridor structure:
 *
 *   1. Take each corridor's CENTRELINE (its midline).
 *   2. Put a node where the centrelines cross (the junction) and at each
 *      corridor end.
 *   3. Project every shop door perpendicularly onto its corridor's centreline;
 *      that projection is an "access" node, and a short spur edge connects it to
 *      the door itself.
 *   4. Do the same for the connectors (escalators, stairs, lifts) on that floor.
 *   5. Sort the nodes along each centreline and connect consecutive pairs.
 *   6. Join the floors: every connector gets one edge between its stops on each
 *      PAIR of floors it serves (any number of floors), costed by ride time and
 *      directed for escalators, which only run one way.
 *
 * IN THE REAL PROJECT this same graph is produced from a floor plan IMAGE:
 * semantic segmentation to separate walls from walkable floor, then morphological
 * skeletonisation of the walkable mask to recover the centrelines, then exactly
 * the steps above. Only step 1 changes — everything downstream is identical,
 * which is why implementing the clean-geometry version is a faithful
 * demonstration rather than a shortcut.
 */

import { closestPointOnSegment, dist } from '../floorplan/geometry.js';

/** Average walking speed inside a mall, metres per second. */
export const WALK_SPEED_MPS = 1.25;

/** Two nodes closer than this along a centreline are merged into one. */
const MERGE_TOLERANCE_M = 0.6;

/** @typedef {{ id: string, x: number, y: number, level: number, kind: string, label?: string, shopId?: string, linkId?: string }} NavNode */
/**
 * A graph edge. Corridor and entrance edges carry only the first group of
 * fields. Connector ('vertical') edges add which connector they ride, how many
 * floors, the ride time, whether they are one-way, and whether the connector
 * is in service per the floor-plan data.
 *
 * @typedef {{ id: string, from: string, to: string, cost: number, distanceM: number, kind: string, accessible: boolean,
 *   transport?: string, connectorId?: string, floors?: number, seconds?: number, directed?: boolean, inService?: boolean, label?: string }} NavEdge
 */

/**
 * Build the navigation graph for the whole building (all levels).
 *
 * @param {object[]} levels level objects from floorplan.js, sorted by ordinal
 * @param {object[]} verticalLinks the connectors (CONNECTORS in floorplan.js):
 *   escalators, stairs and lifts, each with the floors it serves, its direction
 *   and its timing. An empty list is fine (a one-floor plan).
 * @returns {{ nodes: NavNode[], edges: NavEdge[], nodeById: Map<string, NavNode>, adjacency: Map<string, NavEdge[]>, stats: object }}
 */
export function buildNavGraph(levels, verticalLinks) {
  const nodes = [];
  const edges = [];

  /** Records which node represents a given vertical link on a given level. */
  const linkNodeIds = new Map(); // `${linkId}@${level}` -> nodeId

  for (const level of levels) {
    // --- Step 1: work out which centreline each door / link belongs to ------
    //
    // A shop's `outward` normal points into the corridor it fronts. A vertical
    // (y) normal means it opens onto the horizontal corridor; a horizontal (x)
    // normal means it opens onto the vertical corridor.
    const perCentreline = new Map(level.centrelines.map((c) => [c.id, []]));

    for (const shop of level.shops) {
      const axis = Math.abs(shop.outward.y) > 0 ? 'h' : 'v';
      const candidates = level.centrelines.filter((c) => c.axis === axis);
      const cl = nearestCentreline(candidates, shop.doorNode);
      if (!cl) continue;
      perCentreline.get(cl.id).push({
        kind: 'access',
        point: shop.doorNode,
        shop,
      });
    }

    for (const link of level.verticalLinks) {
      // Pick whichever centreline the link physically sits closest to.
      const cl = nearestCentreline(level.centrelines, link);
      perCentreline.get(cl.id).push({
        kind: 'link-access',
        point: { x: link.x, y: link.y },
        link,
      });
    }

    // --- A shared node pool for this level ---------------------------------
    //
    // This pool is essential, not an optimisation. The horizontal and vertical
    // corridors both pass through (30, 20); if each centreline created its own
    // node there, the two corridors would be two DISCONNECTED graphs and no
    // route could ever turn a corner. The pool guarantees that any two
    // centrelines meeting at a point share one node, which is what actually
    // stitches the corridor network together.
    const pool = [];
    const getOrCreateNode = (point, kind) => {
      for (const existing of pool) {
        if (dist(existing, point) < MERGE_TOLERANCE_M) {
          // A junction outranks an access node, so the label stays meaningful
          // when a shop door happens to project onto a crossing.
          if (kind === 'junction') existing.kind = 'junction';
          return existing;
        }
      }
      const node = {
        id: `L${level.level}-n${pool.length}`,
        x: point.x,
        y: point.y,
        level: level.level,
        kind: kind === 'junction' ? 'junction' : kind === 'end' ? 'end' : 'access',
      };
      pool.push(node);
      nodes.push(node);
      return node;
    };

    /** Guards against emitting the same corridor edge twice. */
    const emittedEdges = new Set();
    const addEdge = (a, b, kind) => {
      if (a.id === b.id) return;
      const key = [a.id, b.id].sort().join('~');
      if (emittedEdges.has(key)) return;
      emittedEdges.add(key);
      const d = dist(a, b);
      edges.push({
        id: key,
        from: a.id,
        to: b.id,
        cost: d,
        distanceM: d,
        kind,
        accessible: true,
      });
    };

    // --- Step 2 & 3: build the ordered node chain along each centreline -----
    for (const cl of level.centrelines) {
      const candidates = [];

      // Corridor ends.
      candidates.push({ kind: 'end', point: cl.a, t: 0 });
      candidates.push({ kind: 'end', point: cl.b, t: 1 });

      // The crossing with every other centreline: a true decision point.
      for (const other of level.centrelines) {
        if (other.id === cl.id) continue;
        const crossing = centrelineCrossing(cl, other);
        if (crossing) {
          const { t } = closestPointOnSegment(crossing, cl.a, cl.b);
          candidates.push({ kind: 'junction', point: crossing, t });
        }
      }

      // Projections of doors and vertical links.
      for (const item of perCentreline.get(cl.id)) {
        const { point, t } = closestPointOnSegment(item.point, cl.a, cl.b);
        candidates.push({ ...item, point, t, target: item.point });
      }

      // Sort along the corridor, then resolve each candidate through the shared
      // pool. Two shops opposite each other project to nearly the same spot and
      // correctly collapse into one shared access node.
      candidates.sort((p, q) => p.t - q.t);

      /** The ordered list of distinct corridor nodes along this centreline. */
      const chain = [];

      for (const c of candidates) {
        const node = getOrCreateNode(c.point, c.kind);
        if (chain[chain.length - 1] !== node) chain.push(node);

        // --- Step 3 (cont): spur edges out to doors and vertical links ------
        if (c.kind === 'access') {
          const doorNode = {
            id: `L${level.level}-door-${c.shop.id}`,
            x: c.shop.doorNode.x,
            y: c.shop.doorNode.y,
            level: level.level,
            kind: 'door',
            label: c.shop.name,
            shopId: c.shop.id,
          };
          nodes.push(doorNode);
          addEdge(node, doorNode, 'entrance');
        } else if (c.kind === 'link-access') {
          const linkNode = {
            id: `L${level.level}-link-${c.link.id}`,
            x: c.link.x,
            y: c.link.y,
            level: level.level,
            kind: 'link',
            label: c.link.label,
            linkId: c.link.id,
          };
          nodes.push(linkNode);
          linkNodeIds.set(`${c.link.id}@${level.level}`, linkNode.id);
          addEdge(node, linkNode, 'entrance');
        }
      }

      // --- Step 5: connect consecutive nodes along the corridor ------------
      for (let i = 0; i < chain.length - 1; i++) {
        addEdge(chain[i], chain[i + 1], 'corridor');
      }
    }
  }

  // --- Step 6: stitch the levels together ----------------------------------
  //
  // A connector that stops on N floors gets an edge for EVERY pair of floors it
  // serves, not just neighbouring ones. That is what makes a lift ride from the
  // car park to Level 2 cost one wait plus two floors of travel, rather than two
  // waits (which is what chaining P->1->2 edges would charge).
  //
  // Cost is DERIVED from time: (wait + seconds per floor x floors) converted to
  // an equivalent walking distance. One number therefore drives both what A*
  // optimises and the time the route reports, so the two can never disagree.
  // `distanceM` stays 0 because riding is not walking, which keeps the distance
  // readout honest.
  const ordinalByLevel = new Map(levels.map((l) => [l.level, l.ordinal ?? l.level]));

  for (const link of verticalLinks) {
    const served = (link.servesLevels ?? levels.map((l) => l.level))
      .filter((lvl) => linkNodeIds.has(`${link.id}@${lvl}`))
      .sort((p, q) => ordinalByLevel.get(p) - ordinalByLevel.get(q));

    for (let i = 0; i < served.length; i++) {
      for (let j = i + 1; j < served.length; j++) {
        const lower = served[i];
        const upper = served[j];
        const floors = Math.abs(ordinalByLevel.get(upper) - ordinalByLevel.get(lower));
        const seconds = (link.waitS ?? 0) + (link.secondsPerFloor ?? 20) * floors;
        const lowerId = linkNodeIds.get(`${link.id}@${lower}`);
        const upperId = linkNodeIds.get(`${link.id}@${upper}`);

        // An escalator moves one way. Its edge is DIRECTED, and stored only in
        // the adjacency list of the floor you board on, so the search simply
        // cannot see it from the other end.
        const direction = link.direction ?? 'both';
        const [from, to] = direction === 'down' ? [upperId, lowerId] : [lowerId, upperId];

        edges.push({
          id: `${from}~${to}`,
          from,
          to,
          cost: seconds * WALK_SPEED_MPS,
          distanceM: 0,
          kind: 'vertical',
          directed: direction !== 'both',
          transport: link.type,
          connectorId: link.id,
          floors,
          seconds,
          accessible: !!link.accessible,
          inService: link.inService !== false,
          label: link.label,
        });
      }
    }
  }

  // --- Index for fast lookup during search ---------------------------------
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    adjacency.get(e.from).push(e);
    // Corridors, stairs and lifts work both ways; escalators do not.
    if (!e.directed) adjacency.get(e.to).push(e);
  }

  return {
    nodes,
    edges,
    nodeById,
    adjacency,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      totalEdgeMetres: edges.reduce((s, e) => s + e.distanceM, 0),
      levelCount: levels.length,
      connectorEdgeCount: edges.filter((e) => e.kind === 'vertical').length,
    },
    ordinalByLevel,
  };
}

/** Which centreline is this point closest to? */
function nearestCentreline(centrelines, p) {
  let best = centrelines[0];
  let bestD = Infinity;
  for (const cl of centrelines) {
    const { point } = closestPointOnSegment(p, cl.a, cl.b);
    const d = dist(p, point);
    if (d < bestD) {
      bestD = d;
      best = cl;
    }
  }
  return best;
}

/**
 * Where two axis-aligned centrelines cross, or null if they don't.
 * Kept simple on purpose: the corridors in this building are axis-aligned, and
 * a general line-intersection routine here would be code the panel has to read
 * for no benefit.
 */
function centrelineCrossing(a, b) {
  if (a.axis === b.axis) return null;
  const h = a.axis === 'h' ? a : b;
  const v = a.axis === 'h' ? b : a;
  const x = v.a.x;
  const y = h.a.y;
  const withinH = x >= Math.min(h.a.x, h.b.x) && x <= Math.max(h.a.x, h.b.x);
  const withinV = y >= Math.min(v.a.y, v.b.y) && y <= Math.max(v.a.y, v.b.y);
  return withinH && withinV ? { x, y } : null;
}

// ---------------------------------------------------------------------------
// A* shortest path
// ---------------------------------------------------------------------------

/**
 * Route profiles. Each is just a rule about which connector edges may be used —
 * corridors are always allowed.
 *
 *  - fastest            anything in service
 *  - step-free          lifts only: wheelchairs, prams, heavy luggage
 *  - avoid-escalators   lifts and stairs: trolleys, very young children
 */
export const ROUTE_PROFILES = {
  fastest: { label: 'Fastest', allow: () => true },
  'step-free': { label: 'Step-free', allow: (e) => e.accessible },
  'avoid-escalators': { label: 'Avoid escalators', allow: (e) => e.transport !== 'escalator' },
};

/**
 * Minimal binary min-heap keyed on `f`.
 *
 * The first version of this file used a sorted array as the frontier, because
 * it was short enough to read aloud. With three floors the graph is larger, and
 * the test suite now routes every pair of shops, so re-sorting the whole
 * frontier on every pop became the dominant cost. A heap makes each pop
 * O(log n) instead of O(n log n).
 */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].f <= a[i].f) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* search over the navigation graph.
 *
 * A* is Dijkstra plus a heuristic: at each step it expands the node with the
 * lowest (cost so far + optimistic estimate of cost remaining). Here the
 * estimate is
 *
 *     straight-line distance  +  |floors apart| x (cheapest cost per floor)
 *
 * Neither term can overestimate. The walk can be no shorter than a straight
 * line, because every connector sits at the same (x, y) on every floor it
 * serves. And any sequence of rides covering k floors costs at least k times
 * the cheapest per-floor cost available. That admissibility is what makes A*
 * provably return the shortest path rather than merely a short one — and the
 * test suite checks it against plain Dijkstra on every pair of shops.
 *
 * @param {object} graph result of buildNavGraph
 * @param {string} startId
 * @param {string} goalId
 * @param {{ profile?: string, accessibleOnly?: boolean, disabledConnectors?: Iterable<string>, heuristic?: boolean }} options
 *   `profile` is a key of ROUTE_PROFILES; `accessibleOnly` is kept as shorthand
 *   for the step-free profile. `disabledConnectors` lists connector ids that are
 *   out of service right now. `heuristic: false` turns A* into Dijkstra, which
 *   the tests use as the reference answer.
 * @returns {null | { nodeIds: string[], edges: NavEdge[], distanceM: number, seconds: number, transports: object[], profile: string, visitedCount: number }}
 */
export function findRoute(graph, startId, goalId, options = {}) {
  const profileKey = options.accessibleOnly ? 'step-free' : (options.profile ?? 'fastest');
  const profile = ROUTE_PROFILES[profileKey] ?? ROUTE_PROFILES.fastest;
  const disabled = new Set(options.disabledConnectors ?? []);
  const useHeuristic = options.heuristic !== false;
  const { nodeById, adjacency } = graph;
  if (!nodeById.has(startId) || !nodeById.has(goalId)) return null;

  /**
   * The one rule deciding whether an edge exists for this query. Removing edges
   * rather than penalising them is deliberate: an inaccessible or broken
   * connector is not "expensive", it is unusable.
   */
  const usable = (edge) => {
    if (edge.kind !== 'vertical') return true;
    if (edge.inService === false || disabled.has(edge.connectorId)) return false;
    return profile.allow(edge);
  };

  const ordinal = (node) => graph.ordinalByLevel?.get(node.level) ?? node.level;

  // Cheapest cost per floor among the connectors this query is allowed to use.
  let perFloor = Infinity;
  for (const e of graph.edges) {
    if (e.kind === 'vertical' && usable(e)) {
      perFloor = Math.min(perFloor, e.cost / (e.floors || 1));
    }
  }
  if (!Number.isFinite(perFloor)) perFloor = 0;

  const goal = nodeById.get(goalId);
  const goalOrdinal = ordinal(goal);
  const heuristic = (node) => {
    if (!useHeuristic) return 0;
    const flat = Math.hypot(node.x - goal.x, node.y - goal.y);
    return flat + Math.abs(ordinal(node) - goalOrdinal) * perFloor;
  };

  const gScore = new Map([[startId, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  const open = new MinHeap();
  open.push({ id: startId, f: heuristic(nodeById.get(startId)) });

  let visitedCount = 0;

  while (open.size > 0) {
    const current = open.pop();
    if (closed.has(current.id)) continue;
    closed.add(current.id);
    visitedCount++;

    if (current.id === goalId) break;

    for (const edge of adjacency.get(current.id)) {
      if (!usable(edge)) continue;

      // Directed edges are only ever listed under their `from` node, so this
      // can never send the search the wrong way up an escalator.
      const neighbourId = edge.from === current.id ? edge.to : edge.from;
      if (closed.has(neighbourId)) continue;

      const tentative = gScore.get(current.id) + edge.cost;
      if (tentative < (gScore.get(neighbourId) ?? Infinity)) {
        gScore.set(neighbourId, tentative);
        cameFrom.set(neighbourId, { edge, from: current.id });
        open.push({ id: neighbourId, f: tentative + heuristic(nodeById.get(neighbourId)) });
      }
    }
  }

  if (goalId !== startId && !cameFrom.has(goalId)) return null;

  // Walk the parent pointers back to the start, recording which way each
  // connector was ridden.
  const nodeIds = [goalId];
  const pathEdges = [];
  const transports = [];
  let cursor = goalId;
  while (cursor !== startId) {
    const step = cameFrom.get(cursor);
    if (!step) return null;
    pathEdges.push(step.edge);
    if (step.edge.kind === 'vertical') {
      transports.push({
        ...step.edge,
        fromLevel: nodeById.get(step.from).level,
        toLevel: nodeById.get(cursor).level,
      });
    }
    cursor = step.from;
    nodeIds.push(cursor);
  }
  nodeIds.reverse();
  pathEdges.reverse();
  transports.reverse();

  const distanceM = pathEdges.reduce((sum, e) => sum + e.distanceM, 0);
  const rideSeconds = transports.reduce((sum, t) => sum + (t.seconds ?? 0), 0);

  return {
    nodeIds,
    edges: pathEdges,
    distanceM,
    // Total time = walking time + time spent waiting for and riding connectors.
    seconds: distanceM / WALK_SPEED_MPS + rideSeconds,
    transports,
    profile: profileKey,
    visitedCount,
  };
}

/**
 * Split a route into per-level polylines so each floor can be drawn separately.
 * Returns one entry per contiguous run of nodes on the same level, which is also
 * exactly what the floor hand-off markers need.
 */
export function splitRouteByLevel(graph, route) {
  if (!route) return [];
  const runs = [];
  for (const id of route.nodeIds) {
    const node = graph.nodeById.get(id);
    const last = runs[runs.length - 1];
    if (last && last.level === node.level) {
      last.points.push({ x: node.x, y: node.y });
    } else {
      runs.push({ level: node.level, points: [{ x: node.x, y: node.y }] });
    }
  }
  return runs;
}

/**
 * Human-readable summary of the connectors a route uses, one phrase per ride
 * ("Up-escalator to L2, then Lift to P"), each naming the floor it arrives on.
 * Callers should pass `levelName`: the default prints raw level identifiers,
 * which are not floor names (the car park is level 0 but is called "P").
 */
export function describeTransports(route, levelName = (l) => `Level ${l}`) {
  if (!route || route.transports.length === 0) return 'Same level — no stairs or lift needed';
  return route.transports.map((t) => `${t.label} to ${levelName(t.toLevel)}`).join(', then ');
}

/**
 * Turn a route into the step-by-step instructions a user would actually read.
 *
 * Consecutive corridor edges collapse into one "walk" step, and each connector
 * becomes its own step saying which way and to which floor. That grouping IS the
 * multi-floor UX: a route is a sequence of per-floor legs joined by level
 * changes.
 *
 * Ride steps appear in the same order as `route.transports`, one each, so a
 * caller can pair the n-th ride step with the n-th transport (Tab 1 does, to
 * split a ride's time into wait and travel).
 *
 * @param {object} graph
 * @param {object} route result of findRoute
 * @param {(level: number) => string} levelName the floor's display name. Pass
 *   one: the default prints raw level identifiers ("Level 0" for the car park).
 * @returns {{ kind: 'walk' | 'ride', text: string, level: number, metres?: number, seconds: number }[]}
 */
export function routeInstructions(graph, route, levelName = (l) => `Level ${l}`) {
  if (!route) return [];
  const steps = [];
  let walkM = 0;
  let walkLevel = null;

  const flushWalk = (towards) => {
    if (walkM < 0.5) {
      walkM = 0;
      return;
    }
    steps.push({
      kind: 'walk',
      level: walkLevel,
      metres: walkM,
      seconds: walkM / WALK_SPEED_MPS,
      text: `Walk ${Math.round(walkM)} m on ${levelName(walkLevel)} ${towards}`,
    });
    walkM = 0;
  };

  let rideIndex = 0;
  route.edges.forEach((edge, i) => {
    if (edge.kind !== 'vertical') {
      walkLevel = graph.nodeById.get(route.nodeIds[i]).level;
      walkM += edge.distanceM;
      return;
    }
    const ride = route.transports[rideIndex++];
    flushWalk(`to the ${edge.label.toLowerCase()}`);
    // NOTE: compares level identifiers, which equal ordinals in this building.
    // A building numbered out of stack order would need graph.ordinalByLevel here.
    const way = ride.toLevel > ride.fromLevel ? 'up' : 'down';
    const what = edge.transport === 'escalator' ? 'escalator' : edge.label.toLowerCase();
    steps.push({
      kind: 'ride',
      level: ride.fromLevel,
      seconds: edge.seconds,
      text: `Take the ${what} ${way} to ${levelName(ride.toLevel)}`,
    });
  });

  const goal = graph.nodeById.get(route.nodeIds[route.nodeIds.length - 1]);
  flushWalk(`to ${goal.label ?? 'your destination'}`);
  return steps;
}
