import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVELS, VERTICAL_LINKS } from '../floorplan/floorplan.js';
import { ALTERNATE_LEVELS, ALTERNATE_VERTICAL_LINKS } from '../floorplan/alternateFloorplan.js';
import {
  buildNavGraph,
  findRoute,
  splitRouteByLevel,
  describeTransports,
  routeInstructions,
  ROUTE_PROFILES,
  WALK_SPEED_MPS,
} from '../lib/navGraph.js';
import { dist } from '../floorplan/geometry.js';
import FloorPlanSvg from '../components/FloorPlanSvg.jsx';
import ExplainerPanel from '../components/ExplainerPanel.jsx';
import FloorAlignmentPanel from '../components/FloorAlignmentPanel.jsx';
import { Panel, Button, Stat, Select, Badge, EvidenceStrip } from '../components/ui.jsx';

/**
 * TAB 1 — Auto Map Builder
 *
 * Demonstrates that a building can be turned into a routable map automatically
 * rather than traced by hand. Press "Generate navigation graph" and the graph is
 * derived from the floor plan geometry in a couple of milliseconds, then A*
 * routes across it — across any number of floors, under a route profile
 * (fastest / step-free / avoid escalators), around connectors the presenter has
 * marked out of service, and with step-by-step directions.
 */

/**
 * Who each route profile is for, and what it gives up. The RULE lives in
 * ROUTE_PROFILES (navGraph.js); this is only the sentence a visitor reads.
 */
const PROFILE_COPY = {
  fastest: {
    who: 'Most shoppers — any escalator, stairs or lift that is in service.',
    excludes: 'nothing',
  },
  'step-free': {
    who: 'Wheelchairs, prams and heavy luggage — never a step, so lifts only.',
    excludes: 'stairs and escalators have steps',
  },
  'avoid-escalators': {
    who: 'Shopping trolleys, buggies and very young children — lifts and stairs only.',
    excludes: 'escalators are unsafe with wheels or small children',
  },
};

/** Human's estimated time to trace one floor by hand, in minutes. */
const MANUAL_MINUTES_PER_FLOOR = 35;

/** How long the reveal animation runs, in milliseconds. */
const REVEAL_MS = 1400;

/** Batch size used to measure per-run generation cost above timer resolution. */
const GEN_SAMPLES = 200;

export default function MapBuilderTab({ presentationMode = false }) {
  const [scenario, setScenario] = useState('mall');
  const [graph, setGraph] = useState(null);
  const [genMs, setGenMs] = useState(null);
  const [reveal, setReveal] = useState(0);
  const [levelNo, setLevelNo] = useState(1);
  const [startId, setStartId] = useState('');
  const [destId, setDestId] = useState('');
  const [profile, setProfile] = useState('fastest');
  /** Connector ids the presenter has marked out of service (e.g. lift under repair). */
  const [outOfService, setOutOfService] = useState(() => new Set());
  const [pickTarget, setPickTarget] = useState('start');
  const [inspectStage, setInspectStage] = useState('input');
  const rafRef = useRef(null);
  const stageTimersRef = useRef([]);

  const currentLevels = scenario === 'mall' ? LEVELS : ALTERNATE_LEVELS;
  const currentLinks = scenario === 'mall' ? VERTICAL_LINKS : ALTERNATE_VERTICAL_LINKS;
  const level = currentLevels.find((l) => l.level === levelNo) ?? currentLevels[0];
  const disabledConnectors = useMemo(() => [...outOfService], [outOfService]);

  // Level names come from the CURRENT scenario's data, never a hard-coded
  // "Level N": level identifiers are not floor names (the car park is level 0
  // but is called "Level P"), and the annex has a name of its own.
  const levelName = useCallback(
    (l) => currentLevels.find((x) => x.level === l)?.name ?? `Floor ${l}`,
    [currentLevels],
  );
  const levelShort = useCallback(
    (l) => {
      const found = currentLevels.find((x) => x.level === l);
      return found?.shortName ?? found?.name ?? `Floor ${l}`;
    },
    [currentLevels],
  );

  const toggleConnector = useCallback((id) => {
    setOutOfService((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Graph generation ---------------------------------------------------
  /**
   * Build the graph and measure what it costs.
   *
   * We time only the derivation itself, never React rendering, because the
   * claim being made is about the algorithm rather than the browser.
   */
  const generate = useCallback(() => {
    // Timing a sub-millisecond routine needs care. Browsers deliberately clamp
    // `performance.now()` to ~0.1 ms for privacy reasons, so timing ONE
    // derivation of a 0.3 ms routine reports a value that is mostly rounding
    // error — it swung between 0.2 ms and 0.5 ms across presses, giving a
    // headline number that changed every time. So we do what any microbenchmark
    // does: warm the JIT up, then time a batch and divide. The reported figure
    // is the per-run cost, measured over an interval long enough for the clock
    // to be meaningful.
    let g = buildNavGraph(currentLevels, currentLinks); // warm-up, result discarded
    const t0 = performance.now();
    for (let i = 0; i < GEN_SAMPLES; i++) {
      g = buildNavGraph(currentLevels, currentLinks);
    }
    const elapsed = (performance.now() - t0) / GEN_SAMPLES;

    setGraph(g);
    setGenMs(elapsed);
    setReveal(0);
    setInspectStage('centrelines');

    // Pick a cross-level default route so the first thing the viewer sees is
    // the most interesting capability.
    const doors = g.nodes.filter((n) => n.kind === 'door');
    const defaultStart = doors.find((d) => d.label === 'Khaadi') ?? doors[0];
    const defaultDest = doors.find((d) => d.label === 'Cinepax Cinema') ?? doors[doors.length - 1];
    setStartId(defaultStart.id);
    setDestId(defaultDest.id);
    stageTimersRef.current.forEach(clearTimeout);
    stageTimersRef.current = [
      setTimeout(() => setInspectStage('graph'), 500),
      setTimeout(() => setInspectStage('route'), 1200),
    ];
  }, [currentLevels, currentLinks]);

  const chooseScenario = useCallback((next) => {
    stageTimersRef.current.forEach(clearTimeout);
    setScenario(next);
    setGraph(null);
    setGenMs(null);
    setReveal(0);
    setInspectStage('input');
    setLevelNo(1);
    setStartId('');
    setDestId('');
    setProfile('fastest');
    setOutOfService(new Set());
  }, []);

  // ---- Reveal animation ---------------------------------------------------
  // Nodes and edges fade in outwards from the corridor crossing, so the viewer
  // sees the graph "grow" along the corridors instead of simply appearing.
  useEffect(() => {
    if (!graph) return;
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / REVEAL_MS);
      setReveal(p);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    // Safety net: browsers stop delivering animation frames to a backgrounded
    // tab, which would leave the graph permanently half-drawn if the presenter
    // switched away mid-animation. This guarantees it always finishes.
    const failsafe = setTimeout(() => setReveal(1), REVEAL_MS + 400);

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(failsafe);
    };
  }, [graph]);

  // ---- Reveal ordering ----------------------------------------------------
  /**
   * Precompute, for every node and edge, the point in the timeline at which it
   * should appear — based on how far it is from its level's corridor crossing.
   */
  const revealOrder = useMemo(() => {
    if (!graph) return null;
    const junctions = new Map(
      graph.nodes.filter((n) => n.kind === 'junction').map((n) => [n.level, n]),
    );
    const distFromJunction = (n) => {
      const j = junctions.get(n.level);
      return j ? dist(n, j) : 0;
    };
    const maxD = Math.max(...graph.nodes.map(distFromJunction), 1);

    const nodeT = new Map(
      graph.nodes.map((n) => [n.id, 0.05 + 0.55 * (distFromJunction(n) / maxD)]),
    );
    const edgeT = new Map(
      graph.edges.map((e) => {
        const a = graph.nodeById.get(e.from);
        const b = graph.nodeById.get(e.to);
        const norm = Math.max(distFromJunction(a), distFromJunction(b)) / maxD;
        return [e.id, 0.15 + 0.8 * norm];
      }),
    );
    return { nodeT, edgeT };
  }, [graph]);

  // ---- Routing ------------------------------------------------------------
  const routable = !!graph && !!startId && !!destId && startId !== destId;

  const route = useMemo(() => {
    if (!routable) return null;
    return findRoute(graph, startId, destId, { profile, disabledConnectors });
  }, [routable, graph, startId, destId, profile, disabledConnectors]);

  /** The route split into one polyline per level, for per-floor drawing. */
  const routeRuns = useMemo(
    () => (graph && route ? splitRouteByLevel(graph, route) : []),
    [graph, route],
  );

  /**
   * The fastest route under the SAME outages, so a restrictive profile's cost
   * is quantified against what this visitor could otherwise do today — an
   * honest trade-off, not a hidden one.
   */
  const fastestRoute = useMemo(() => {
    if (!routable || profile === 'fastest') return null;
    return findRoute(graph, startId, destId, { profile: 'fastest', disabledConnectors });
  }, [routable, graph, startId, destId, profile, disabledConnectors]);

  /** The same profile with everything in service, to quantify what an outage costs. */
  const allInServiceRoute = useMemo(() => {
    if (!routable || disabledConnectors.length === 0) return null;
    return findRoute(graph, startId, destId, { profile });
  }, [routable, graph, startId, destId, profile, disabledConnectors]);

  /** Numbered directions, with each ride paired to the connector it uses. */
  const steps = useMemo(() => {
    if (!graph || !route) return [];
    const list = routeInstructions(graph, route, levelName);
    // routeInstructions emits ride steps in route order, one per transport, so
    // the n-th ride step IS route.transports[n]. That pairing is what lets the
    // list split a ride's time into "wait" and "travel" honestly.
    let ride = 0;
    return list.map((s) => (s.kind === 'ride' ? { ...s, transport: route.transports[ride++] } : s));
  }, [graph, route, levelName]);

  /** Why there is no route — computed from counterfactual searches, never guessed. */
  const noRouteReason = useMemo(() => {
    if (!routable || route) return null;
    return diagnoseNoRoute({
      graph,
      connectors: currentLinks,
      startId,
      destId,
      profile,
      disabled: disabledConnectors,
      levelName,
      levelShort,
    });
  }, [routable, route, graph, currentLinks, startId, destId, profile, disabledConnectors, levelName, levelShort]);

  // ---- Click-to-pick ------------------------------------------------------
  /** Clicking the map selects the nearest shop door on the visible level. */
  const handleMapClick = useCallback(
    (pointM) => {
      if (!graph) return;
      const doors = graph.nodes.filter((n) => n.kind === 'door' && n.level === levelNo);
      let best = null;
      let bestD = Infinity;
      for (const d of doors) {
        const dd = dist(d, pointM);
        if (dd < bestD) {
          bestD = dd;
          best = d;
        }
      }
      if (!best) return;
      if (pickTarget === 'start') {
        setStartId(best.id);
        setPickTarget('dest');
      } else {
        setDestId(best.id);
        setPickTarget('start');
      }
    },
    [graph, levelNo, pickTarget],
  );

  const startNode = graph?.nodeById.get(startId);
  const destNode = graph?.nodeById.get(destId);

  // Manual-tracing comparison for the headline metric.
  const manualMinutes = MANUAL_MINUTES_PER_FLOOR * currentLevels.length;
  const validation = useMemo(() => (graph ? validateGraph(graph) : null), [graph]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* ================= MAP COLUMN ================= */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" aria-label="Floor-plan scenario">
            {[
              ['mall', `Main mall · ${LEVELS.length} levels`],
              ['annex', 'Unseen annex · irregular'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => chooseScenario(id)}
                aria-pressed={scenario === id}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand ${
                  scenario === id ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Badge tone="warn">structured geometry input</Badge>
        </div>

        {/* Headline metric — the single most important number in the project. */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                Digitization cost
              </div>
              {genMs === null ? (
                <p className="mt-1 text-sm text-ink-soft">
                  No graph yet — press <strong>Generate navigation graph</strong> to derive one
                  from the floor plan.
                </p>
              ) : (
                <p className="tnum mt-1 text-2xl font-semibold leading-tight text-ink">
                  Graph generated in {genMs.toFixed(2)} ms
                  <span className="ml-2 text-sm font-normal text-ink-soft">
                    (mean of {GEN_SAMPLES} runs) vs ~{manualMinutes} min of manual tracing (
                    {MANUAL_MINUTES_PER_FLOOR} min × {currentLevels.length} floor{currentLevels.length === 1 ? '' : 's'})
                  </span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {graph && <Badge tone="warn">SIMULATED PLAN</Badge>}
              <Button onClick={generate}>
                {graph ? 'Show derivation again' : 'Show the proof — generate graph'}
              </Button>
            </div>
          </div>
        </div>

        <EvidenceStrip
          proves="Corridor geometry becomes a connected, weighted navigation graph without hand-placing nodes."
          value="The same graph supports routing, level changes, and accessibility rules immediately."
          limitation="The demo starts from clean vector geometry; image segmentation is not implemented here."
        />

        {graph && (
          <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-line bg-surface" aria-label="Derivation stages">
            {[
              ['input', '1 · Input'],
              ['centrelines', '2 · Centrelines'],
              ['graph', '3 · Graph'],
              ['route', '4 · Route'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setInspectStage(id)}
                aria-pressed={inspectStage === id}
                className={`border-r border-line px-2 py-2 text-[11px] font-semibold last:border-r-0 ${
                  inspectStage === id ? 'bg-blue-50 text-brand' : 'text-ink-soft hover:bg-canvas'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Level switcher + pick-mode hint */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
            {currentLevels.map((l) => (
              <button
                key={l.level}
                type="button"
                onClick={() => setLevelNo(l.level)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  l.level === levelNo
                    ? 'bg-brand text-white'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
          {graph && (
            <p className="text-xs text-ink-soft">
              Click the map to set{' '}
              <strong className="text-ink">
                {pickTarget === 'start' ? 'start' : 'destination'}
              </strong>{' '}
              (snaps to the nearest shop door)
            </p>
          )}
        </div>

        {/* The plan */}
        <div className="rounded-xl border border-line bg-surface p-3">
          <FloorPlanSvg
            level={level}
            onPointClick={graph ? handleMapClick : undefined}
            cursor={graph ? 'crosshair' : 'default'}
            dimShops={!!graph}
            disabledConnectorIds={disabledConnectors}
          >
            {graph && inspectStage !== 'input' && (
              <g style={{ pointerEvents: 'none' }}>
                {level.centrelines.map((c) => (
                  <line
                    key={c.id}
                    x1={c.a.x}
                    y1={c.a.y}
                    x2={c.b.x}
                    y2={c.b.y}
                    stroke="#0ea5e9"
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                    vectorEffect="non-scaling-stroke"
                    opacity={inspectStage === 'centrelines' ? 1 : 0.32}
                  />
                ))}
              </g>
            )}
            {graph && revealOrder && (inspectStage === 'graph' || inspectStage === 'route') && (
              <>
                {/* --- Navigation graph edges --- */}
                <g>
                  {graph.edges
                    .filter((e) => e.kind !== 'vertical')
                    .filter((e) => graph.nodeById.get(e.from).level === levelNo)
                    .filter((e) => reveal >= revealOrder.edgeT.get(e.id))
                    .map((e) => {
                      const a = graph.nodeById.get(e.from);
                      const b = graph.nodeById.get(e.to);
                      return (
                        <line
                          key={e.id}
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke={e.kind === 'entrance' ? '#a5b4fc' : '#6366f1'}
                          strokeWidth={e.kind === 'entrance' ? 1.2 : 2}
                          strokeDasharray={e.kind === 'entrance' ? '2 1.5' : undefined}
                          vectorEffect="non-scaling-stroke"
                          opacity={0.9}
                        />
                      );
                    })}
                </g>

                {/* --- Navigation graph nodes --- */}
                <g>
                  {graph.nodes
                    .filter((n) => n.level === levelNo)
                    .filter((n) => reveal >= revealOrder.nodeT.get(n.id))
                    .map((n) => (
                      <circle
                        key={n.id}
                        cx={n.x}
                        cy={n.y}
                        r={n.kind === 'junction' ? 0.85 : n.kind === 'door' ? 0.4 : 0.55}
                        fill={
                          n.kind === 'junction'
                            ? '#4338ca'
                            : n.kind === 'door'
                              ? '#818cf8'
                              : n.kind === 'link'
                                ? '#0891b2'
                                : '#6366f1'
                        }
                        stroke="#ffffff"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                </g>

                {/* --- Computed route --- */}
                {/* Grey dashed: the fastest route, shown under a restrictive
                    profile so the detour it forces is visible, not just stated. */}
                {inspectStage === 'route' && route && fastestRoute &&
                  !sameRoute(route, fastestRoute) &&
                  splitRouteByLevel(graph, fastestRoute)
                    .filter((run) => run.level === levelNo)
                    .map((run, i) => (
                      <polyline
                        key={`fast-${i}`}
                        points={run.points.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth={4}
                        strokeDasharray="7 5"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                {inspectStage === 'route' && routeRuns
                  .filter((run) => run.level === levelNo)
                  .map((run, i) => (
                    <g key={i}>
                      {/* A wide translucent halo under a solid core reads clearly
                          even when the route runs along a graph edge. */}
                      <polyline
                        points={run.points.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke="#2563eb"
                        strokeOpacity={0.2}
                        strokeWidth={11}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      <polyline
                        points={run.points.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={3}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ))}

                {/* --- Start / destination markers --- */}
                {inspectStage === 'route' && startNode?.level === levelNo && (
                  <EndpointMarker node={startNode} kind="start" />
                )}
                {inspectStage === 'route' && destNode?.level === levelNo && <EndpointMarker node={destNode} kind="dest" />}

                {/* --- Cross-level hand-off marker --- */}
                {inspectStage === 'route' && route?.transports.map((t) => {
                  // A connector appears on the floor you board on ("go to L2")
                  // and the floor you arrive on ("arrived from P"). Driven by
                  // the direction the route actually rode it, so this works for
                  // any number of floors.
                  const boarding = t.fromLevel === levelNo;
                  const arriving = t.toLevel === levelNo;
                  if (!boarding && !arriving) return null;
                  const linkNode = graph.nodes.find(
                    (n) => n.kind === 'link' && n.linkId === t.connectorId && n.level === levelNo,
                  );
                  if (!linkNode) return null;
                  const tag = boarding
                    ? `${t.label} → ${levelShort(t.toLevel)}`
                    : `Arrived from ${levelShort(t.fromLevel)}`;
                  return (
                    <g key={`${t.id}-${levelNo}`} style={{ pointerEvents: 'none' }}>
                      <circle
                        cx={linkNode.x}
                        cy={linkNode.y}
                        r={2.6}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={2}
                        strokeDasharray="3 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <rect
                        x={linkNode.x - 8.5}
                        y={linkNode.y - 7.6}
                        width={17}
                        height={3.4}
                        rx={0.7}
                        fill="#2563eb"
                      />
                      <text
                        x={linkNode.x}
                        y={linkNode.y - 5.2}
                        textAnchor="middle"
                        fontSize={1.5}
                        fill="#ffffff"
                        fontWeight={600}
                      >
                        {tag}
                      </text>
                    </g>
                  );
                })}
              </>
            )}
          </FloorPlanSvg>
        </div>

        {/* Phase 4: stacking separately supplied floor drawings. Only the
            multi-floor mall has floors to align; the annex is one level. */}
        {scenario === 'mall' && <FloorAlignmentPanel />}
      </div>

      {/* ================= SIDE COLUMN ================= */}
      <div className="space-y-4">
        <ExplainerPanel
          title="Auto Map Builder — what am I looking at?"
          whatThisIs="A multi-floor mall plan being turned into a routable navigation graph automatically, then routed across with A* — between any two floors, under a route profile, around broken connectors."
          concept={[
            'Before an app can give you directions inside a building, the building has to become a graph: nodes are decision points (corridor junctions, corridor ends, shop doors) and edges are walkable connections between them, each labelled with its real length in metres.',
            'Today that graph is traced by hand — someone opens the architect’s drawing and clicks out every corridor and doorway, roughly 30–40 minutes per floor, redone whenever a tenant moves. This tab derives the same graph from the floor plan’s geometry in a few milliseconds.',
            'Once the graph exists, finding a route is a solved problem: A* explores the graph outward from your start, always expanding the option with the lowest (cost so far + optimistic estimate of cost still to go), which guarantees the cheapest path.',
            'Floors are joined by connectors — escalators, stairs, the lift — each with a ride time (the lift’s includes a wait for the car), converted into the same units as walking. Escalators are one-way edges. A route profile removes the connectors a visitor cannot use, and an out-of-service connector is removed outright. If nothing is left that links two floors, the app says exactly why instead of quietly sending you somewhere you asked to avoid.',
          ]}
          defaultOpen={!presentationMode}
          legend={[
            {
              kind: 'dashed',
              color: '#0ea5e9',
              label: 'Recovered centreline',
              desc: 'the corridor skeleton from which junctions and weighted edges are derived',
            },
            {
              kind: 'square',
              color: '#f1f5f9',
              color2: '#475569',
              label: 'Shop units & walls',
              desc: 'the static floor plan — defined as line segments and rectangles in code, not an image',
            },
            {
              kind: 'dot',
              color: '#4338ca',
              label: 'Junction node',
              desc: 'where two corridors cross — the most important decision point on the floor',
            },
            {
              kind: 'dot',
              color: '#6366f1',
              label: 'Corridor node',
              desc: 'a corridor end, or the point on the corridor centreline nearest a shop door',
            },
            {
              kind: 'dot',
              color: '#818cf8',
              label: 'Shop door node',
              desc: 'the navigable entrance of each shop — these are the routing destinations',
            },
            {
              kind: 'line',
              color: '#6366f1',
              label: 'Corridor edge',
              desc: 'a walkable connection, weighted by its true length in metres',
            },
            {
              kind: 'dashed',
              color: '#a5b4fc',
              label: 'Entrance spur',
              desc: 'the short link from a corridor centreline out to a shop door',
            },
            {
              kind: 'dot',
              color: '#0891b2',
              label: 'Connector node',
              desc: 'where an escalator, stairs or lift stops on this floor. Each connector is joined to its own stop on every other floor it serves, so any number of floors become one graph',
            },
            {
              kind: 'line',
              color: '#2563eb',
              label: 'Computed route',
              desc: 'the best path A* found under the chosen route profile, avoiding out-of-service connectors',
            },
            {
              kind: 'dashed',
              color: '#94a3b8',
              label: 'Fastest route (comparison)',
              desc: 'shown only when a step-free or avoid-escalators profile forces a different path, so the detour is visible',
            },
            {
              kind: 'ring',
              color: '#2563eb',
              label: 'Floor hand-off tag',
              desc: 'dashed blue ring and tag on a connector the route uses: "→ L2" where you board, "Arrived from L1" where you get off',
            },
            {
              kind: 'halo',
              color: '#16a34a',
              label: 'Start marker',
              desc: 'green ring — where the route begins',
            },
            {
              kind: 'halo',
              color: '#dc2626',
              label: 'Destination marker',
              desc: 'red ring — where the route ends',
            },
            {
              kind: 'glyph',
              glyph: '⊞',
              color: '#1d4ed8',
              color2: '#dbeafe',
              label: 'Lift (step-free)',
              desc: 'blue = step-free, the only connector a step-free route may use. It stops on every floor',
            },
            {
              kind: 'glyph',
              glyph: '↑',
              color: '#334155',
              label: 'Up-escalator ("Esc ↑")',
              desc: 'one-way, from the floor below to the floor above. The arrow is its direction of travel between floors, not a compass direction',
            },
            {
              kind: 'glyph',
              glyph: '↓',
              color: '#334155',
              label: 'Down-escalator ("Esc ↓")',
              desc: 'its one-way partner beside it; routing never sends anyone up it',
            },
            {
              kind: 'glyph',
              glyph: '⌃',
              color: '#334155',
              label: 'Stairs',
              desc: 'two-way and reach every floor including the car park, but have steps',
            },
            {
              kind: 'cross',
              color: '#dc2626',
              label: 'Out-of-service connector',
              desc: 'red cross, dashed outline and struck-through caption — marked out of service in the Route panel, so routing will not use it',
            },
          ]}
          whyItMatters="Once a venue has structured geometry, MallNav can derive routing data consistently instead of hand-placing every junction, doorway, and edge for every floor."
          footnote="Scope boundary: this demo begins with clean vector geometry and proves the geometry-to-graph stage. A production image pipeline would first segment walkable space and recover centrelines; that image-processing stage is future work, not something this screen claims to have implemented."
        />

        {/* ---- Routing controls ---- */}
        <Panel
          title="Route"
          subtitle={graph ? 'Pick two shops, or click the map' : 'Generate the graph first'}
        >
          {!graph ? (
            <p className="text-xs text-ink-soft">
              The routing controls unlock once a navigation graph exists — that is the point of
              the demo: no graph, no directions.
            </p>
          ) : (
            <div className="space-y-3">
              <Select label="Start" value={startId} onChange={setStartId}>
                {renderDoorOptions(graph, currentLevels)}
              </Select>
              <Select label="Destination" value={destId} onChange={setDestId}>
                {renderDoorOptions(graph, currentLevels)}
              </Select>

              {/* ---- Route profile ---- */}
              <fieldset className="border-t border-line pt-3">
                <legend className="mb-1.5 text-xs font-medium text-ink">Route profile</legend>
                <div className="space-y-1.5" role="radiogroup" aria-label="Route profile">
                  {Object.entries(ROUTE_PROFILES).map(([key, def]) => {
                    const selected = profile === key;
                    const allowed = currentLinks.filter((c) => profileAllowsConnector(graph, key, c.id));
                    // With no connectors at all (the one-level annex) every
                    // profile gives the identical route, so offering a choice
                    // would suggest a difference that does not exist.
                    const disabled = currentLinks.length === 0 && key !== 'fastest';
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={disabled}
                        onClick={() => setProfile(key)}
                        title={`Route using the ${def.label} profile`}
                        className={`block w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected
                            ? 'border-brand/50 bg-blue-50'
                            : 'border-line hover:bg-canvas'
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className={`text-xs font-semibold ${selected ? 'text-blue-900' : 'text-ink'}`}>
                            {def.label}
                          </span>
                          {currentLinks.length > 0 && (
                            <span className="text-[10px] text-ink-faint">
                              may use: {allowed.length ? allowed.map((c) => c.shortLabel ?? c.label).join(', ') : 'no connector'}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">
                          {PROFILE_COPY[key]?.who ?? ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {currentLinks.length === 0 && (
                  <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
                    This one-level annex has no escalators, stairs or lifts, so every profile gives
                    the same route.
                  </p>
                )}
              </fieldset>

              {/* ---- Connector status ---- */}
              {currentLinks.length > 0 && (
                <div className="border-t border-line pt-3">
                  <div className="text-xs font-medium text-ink">Connector status</div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">
                    Mark a connector out of service (a lift under repair, a stopped escalator).
                    Routing drops it at query time — the graph is not rebuilt.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {currentLinks.map((c) => {
                      const isOut = outOfService.has(c.id);
                      return (
                        <li
                          key={c.id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${
                            isOut ? 'border-red-200 bg-red-50/60' : 'border-line'
                          }`}
                        >
                          <span className="min-w-0">
                            <span
                              className={`block text-xs font-medium ${isOut ? 'text-bad line-through' : 'text-ink'}`}
                            >
                              {c.label}
                            </span>
                            <span className="block text-[10px] text-ink-faint">
                              {describeService(c, graph, levelShort)} · {c.accessible ? 'step-free' : 'steps'}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleConnector(c.id)}
                            aria-pressed={isOut}
                            className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                              isOut
                                ? 'border-red-300 bg-white text-bad hover:bg-red-50'
                                : 'border-line bg-white text-ink-soft hover:text-ink'
                            }`}
                          >
                            {isOut ? 'Return to service' : 'Mark out of service'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {startId === destId ? (
                <p className="text-xs text-ink-soft">
                  Start and destination are the same — pick two different shops.
                </p>
              ) : route ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Stat
                      label="Walking distance"
                      value={route.distanceM.toFixed(1)}
                      unit="m"
                      tone="brand"
                    />
                    <Stat
                      label="Estimated time"
                      value={formatDuration(route.seconds)}
                      hint={`at ${WALK_SPEED_MPS} m/s`}
                    />
                  </div>
                  <div className="rounded-lg border border-line bg-canvas px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                      Level change
                    </div>
                    <div className="mt-0.5 text-xs font-medium text-ink">
                      {describeTransports(route, levelShort)}
                    </div>
                    {/* Quantify what the profile costs against the fastest
                        route under the same outages — an honest trade-off,
                        not a hidden one. */}
                    {fastestRoute && (
                      <div className="mt-1.5 text-[11px] leading-snug text-ink-soft">
                        {sameRoute(route, fastestRoute) ? (
                          <>
                            Here the {ROUTE_PROFILES[profile].label.toLowerCase()} route is also the
                            fastest route — this profile costs nothing on this trip.
                          </>
                        ) : (
                          <>
                            {ROUTE_PROFILES[profile].label} costs{' '}
                            <CostDelta route={route} reference={fastestRoute} /> vs the fastest
                            route ({describeTransports(fastestRoute, levelShort)}).
                          </>
                        )}
                      </div>
                    )}
                    {/* And what the outage costs, against the same profile with
                        everything running. */}
                    {allInServiceRoute && !sameRoute(route, allInServiceRoute) && (
                      <div className="mt-1.5 text-[11px] leading-snug text-ink-soft">
                        {disabledConnectors.length === 1 ? 'The outage costs' : 'The outages cost'}{' '}
                        <CostDelta route={route} reference={allInServiceRoute} /> vs this profile
                        with everything in service ({describeTransports(allInServiceRoute, levelShort)}).
                      </div>
                    )}
                  </div>

                  {/* Step-by-step directions; a step switches the map to its floor. */}
                  {steps.length > 0 && (
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                        Directions
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        Click a step to show its floor on the map.
                      </p>
                      <ol className="mt-1.5 space-y-1">
                        {steps.map((step, i) => (
                          <li key={i}>
                            <button
                              type="button"
                              onClick={() => setLevelNo(step.level)}
                              title={`Show ${levelName(step.level)} on the map`}
                              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                                step.level === levelNo
                                  ? 'border-brand/40 bg-blue-50 text-blue-900'
                                  : 'border-line text-ink-soft hover:bg-canvas'
                              }`}
                            >
                              <span
                                className={`tnum mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                                  step.kind === 'ride' ? 'bg-cyan-700 text-white' : 'bg-brand text-white'
                                }`}
                              >
                                {i + 1}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{step.text}</span>
                                <span className="tnum block text-[11px] text-ink-faint">
                                  {step.kind === 'walk'
                                    ? `${step.metres.toFixed(1)} m · ${formatDuration(step.seconds)} at ${WALK_SPEED_MPS} m/s`
                                    : describeRideTime(step, currentLinks)}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              ) : (
                noRouteReason && (
                  <div className="rounded-lg border border-red-200 bg-red-50/60 px-3 py-2" role="status">
                    <div className="text-xs font-semibold text-bad">{noRouteReason.headline}</div>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-snug text-ink-soft">
                      {noRouteReason.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </div>
          )}
        </Panel>

        {/* ---- Graph statistics ---- */}
        {graph && (
          <Panel title="Generated graph" subtitle="Derived from geometry, not drawn by hand">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Nodes" value={graph.stats.nodeCount} hint="decision points" />
              <Stat label="Edges" value={graph.stats.edgeCount} hint="walkable links" />
              <Stat
                label="Network length"
                value={graph.stats.totalEdgeMetres.toFixed(0)}
                unit="m"
                hint="sum of all edges"
              />
              <Stat
                label="Floors"
                value={graph.stats.levelCount}
                hint={
                  graph.stats.levelCount > 1
                    ? `joined by ${currentLinks.length} connector${currentLinks.length === 1 ? '' : 's'}`
                    : 'single floor — no connectors'
                }
              />
            </div>
            {route && (
              <p className="mt-3 text-[11px] leading-snug text-ink-faint">
                A* examined <strong className="tnum text-ink-soft">{route.visitedCount}</strong> of{' '}
                {graph.stats.nodeCount} nodes to prove this route is the cheapest under the chosen
                profile — the heuristic lets it ignore the rest.
              </p>
            )}
            {validation && (
              <div className="mt-3 grid gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[11px]">
                <ValidationRow ok={validation.connected} label="One connected graph" />
                <ValidationRow ok={validation.noOrphans} label="No orphan nodes" />
                <ValidationRow ok={validation.allDoorsReachable} label="Every shop door reachable" />
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

/** Grouped <option> list of every shop door, by level. */
function renderDoorOptions(graph, levels) {
  return levels.map((l) => (
    <optgroup key={l.level} label={l.name}>
      {graph.nodes
        .filter((n) => n.kind === 'door' && n.level === l.level)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((n) => (
          <option key={n.id} value={n.id}>
            {n.label}
          </option>
        ))}
    </optgroup>
  ));
}

/** Green start / red destination ring with a label. */
function EndpointMarker({ node, kind }) {
  const color = kind === 'start' ? '#16a34a' : '#dc2626';
  return (
    <g style={{ pointerEvents: 'none' }}>
      <circle cx={node.x} cy={node.y} r={2.2} fill={color} opacity={0.18} />
      <circle
        cx={node.x}
        cy={node.y}
        r={1.3}
        fill="#ffffff"
        stroke={color}
        strokeWidth={2.5}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={node.x}
        y={node.y + 4}
        textAnchor="middle"
        fontSize={1.3}
        fontWeight={700}
        fill={color}
      >
        {kind === 'start' ? 'START' : 'DEST'}
      </text>
    </g>
  );
}

/** True when two routes follow exactly the same nodes. */
function sameRoute(a, b) {
  return a.nodeIds.length === b.nodeIds.length && a.nodeIds.every((id, i) => id === b.nodeIds[i]);
}

/** "+12.3 m walking and +45 s" — signed, because a detour can walk LESS but take longer. */
function CostDelta({ route, reference }) {
  const signed = (v, digits) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
  return (
    <>
      <strong className="tnum text-ink">{signed(route.distanceM - reference.distanceM, 1)} m</strong>{' '}
      walking and{' '}
      <strong className="tnum text-ink">{signed(route.seconds - reference.seconds, 0)} s</strong>
    </>
  );
}

/**
 * Does a route profile allow this connector? Asked of the graph's own connector
 * edge, through the same `allow` rule findRoute uses, so the panel can never
 * disagree with the router.
 */
function profileAllowsConnector(graph, profileKey, connectorId) {
  const edge = graph.edges.find((e) => e.kind === 'vertical' && e.connectorId === connectorId);
  return !!edge && !!ROUTE_PROFILES[profileKey]?.allow(edge);
}

/** "L1 → L2 only" for a one-way escalator, "serves P · L1 · L2" for two-way ones. */
function describeService(connector, graph, levelShort) {
  const ordinal = (l) => graph.ordinalByLevel?.get(l) ?? l;
  const floors = [...(connector.servesLevels ?? [])].sort((p, q) => ordinal(p) - ordinal(q));
  if (floors.length === 0) return 'serves no floor';
  const lowest = levelShort(floors[0]);
  const highest = levelShort(floors[floors.length - 1]);
  if (connector.direction === 'up') return `${lowest} → ${highest} only`;
  if (connector.direction === 'down') return `${highest} → ${lowest} only`;
  return `serves ${floors.map(levelShort).join(' · ')}`;
}

/** "55 s = 35 s wait + 2 floors × 10 s" — the ride time, shown as it is derived. */
function describeRideTime(step, connectors) {
  const t = step.transport;
  const c = t && connectors.find((x) => x.id === t.connectorId);
  if (!c || !t.floors) return formatDuration(step.seconds);
  const travel = `${t.floors} floor${t.floors === 1 ? '' : 's'} × ${c.secondsPerFloor} s`;
  return `${formatDuration(step.seconds)} = ${c.waitS ? `${c.waitS} s wait + ` : ''}${travel}`;
}

/** "A", "A and B", "A, B and C". */
function listNames(names, conj = 'and') {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conj} ${names[names.length - 1]}`;
}

/**
 * Explain why findRoute returned null — by asking the router counterfactual
 * questions, never by guessing from the settings. Every sentence is backed by
 * a search that was actually run:
 *
 *  - Would this profile find a route if everything were in service? If yes,
 *    the outage is the cause; if no, the profile itself cannot link the floors.
 *  - Which out-of-service connector, returned to service on its own, restores
 *    a route? (And for those that would not, the concrete reason.)
 *  - Does another profile route right now? That is OFFERED, never applied: a
 *    wheelchair user who asked for step-free must not be quietly sent to stairs.
 *
 * Costs a handful of extra A* searches, only on the rare no-route path.
 */
function diagnoseNoRoute({ graph, connectors, startId, destId, profile, disabled, levelName, levelShort }) {
  const start = graph.nodeById.get(startId);
  const dest = graph.nodeById.get(destId);
  const label = ROUTE_PROFILES[profile]?.label ?? profile;
  const tryRoute = (p, off) => findRoute(graph, startId, destId, { profile: p, disabledConnectors: off });
  const reasons = [];

  if (start.level === dest.level) {
    // A same-floor trip needs no connector, so neither the profile nor an
    // outage can be the cause: the plan itself has no walkable link.
    return {
      headline: `No walkable path between ${start.label} and ${dest.label} on ${levelName(start.level)}.`,
      reasons: ['The floor plan has no corridor connection between these doors; no route profile or connector setting can change that.'],
    };
  }

  const headline = `No route from ${levelName(start.level)} to ${levelName(dest.level)} under the “${label}” profile.`;
  const allowed = connectors.filter((c) => profileAllowsConnector(graph, profile, c.id));
  const off = new Set(disabled);

  if (profile !== 'fastest') {
    reasons.push(
      allowed.length
        ? `The “${label}” profile may use only the ${listNames(allowed.map((c) => c.label))} — ${PROFILE_COPY[profile]?.excludes ?? 'the others are excluded'}.`
        : `The “${label}” profile may not use any connector in this building.`,
    );
  }

  if (tryRoute(profile, [])) {
    // The profile CAN link these floors, so it is the outage that breaks it.
    const relevant = allowed.filter((c) => off.has(c.id));
    const running = allowed.filter((c) => !off.has(c.id));
    const names = relevant.map((c) => c.label);
    if (running.length === 0) {
      reasons.push(
        profile === 'fastest'
          ? `Every connector in the building is out of service (${listNames(names)}).`
          : relevant.length === 1
            ? `The ${names[0]} is out of service.`
            : `All of them are out of service (${listNames(names)}).`,
      );
    } else {
      reasons.push(
        `Out of service: ${listNames(names)}. The connector${running.length === 1 ? '' : 's'} still running (${listNames(running.map((c) => c.label))}) cannot link these floors for this trip on ${running.length === 1 ? 'its' : 'their'} own.`,
      );
    }

    const restorers = relevant.filter((c) => tryRoute(profile, disabled.filter((id) => id !== c.id)));
    if (restorers.length > 0) {
      reasons.push(
        restorers.length === 1
          ? `Returning the ${restorers[0].label} to service would restore a route.`
          : `Returning any one of the ${listNames(restorers.map((c) => c.label), 'or')} to service would restore a route.`,
      );
      for (const c of relevant.filter((x) => !restorers.includes(x))) {
        reasons.push(`The ${c.label} alone would not help — ${whyNotAlone(c, start, dest, graph, levelName)}.`);
      }
    } else if (relevant.length > 1) {
      reasons.push('No single one of them returned to service would be enough — together they cut these floors apart.');
    }
  } else {
    reasons.push(
      profile === 'fastest'
        ? 'Even with everything in service, no connector links these floors.'
        : 'Even with everything in service, none of the connectors it may use links these floors.',
    );
  }

  const alternatives = Object.keys(ROUTE_PROFILES)
    .filter((k) => k !== profile)
    .map((k) => ({ k, r: tryRoute(k, disabled) }))
    .filter(({ r }) => r);
  if (alternatives.length) {
    const offers = alternatives.map(
      ({ k, r }) => `“${ROUTE_PROFILES[k].label}” (${describeTransports(r, levelShort)}, ${formatDuration(r.seconds)})`,
    );
    reasons.push(
      `A route does exist right now under ${listNames(offers)}, but it uses a connector this profile excludes. MallNav will not switch profiles for you — choose one yourself if that is acceptable.`,
    );
  }

  return { headline, reasons };
}

/** The concrete reason one connector, returned to service alone, would not restore a route. */
function whyNotAlone(connector, start, dest, graph, levelName) {
  const serves = connector.servesLevels ?? [];
  const missing = [start.level, dest.level].filter((l) => !serves.includes(l));
  if (missing.length) return `it does not stop on ${listNames(missing.map(levelName))}`;
  const ordinal = (l) => graph.ordinalByLevel?.get(l) ?? l;
  const tripDir = ordinal(dest.level) > ordinal(start.level) ? 'up' : 'down';
  if (connector.direction === 'up' || connector.direction === 'down') {
    if (connector.direction !== tripDir) return `it only runs ${connector.direction}, and this trip goes ${tripDir}`;
  }
  return 'it is not enough on its own';
}

/** "1 min 25 s" style duration. */
function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

function validateGraph(graph) {
  if (!graph.nodes.length) return { connected: false, noOrphans: false, allDoorsReachable: false };
  const neighbours = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  const visited = new Set();
  const queue = [graph.nodes[0].id];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of neighbours.get(id) ?? []) if (!visited.has(next)) queue.push(next);
  }
  const doors = graph.nodes.filter((node) => node.kind === 'door');
  return {
    connected: visited.size === graph.nodes.length,
    noOrphans: [...neighbours.values()].every((list) => list.length > 0),
    allDoorsReachable: doors.every((door) => visited.has(door.id)),
  };
}

function ValidationRow({ ok, label }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <Badge tone={ok ? 'good' : 'bad'}>{ok ? 'pass' : 'fail'}</Badge>
    </div>
  );
}
