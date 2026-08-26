import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVELS, VERTICAL_LINKS } from '../floorplan/floorplan.js';
import { ALTERNATE_LEVELS, ALTERNATE_VERTICAL_LINKS } from '../floorplan/alternateFloorplan.js';
import {
  buildNavGraph,
  findRoute,
  splitRouteByLevel,
  describeTransports,
  WALK_SPEED_MPS,
} from '../lib/navGraph.js';
import { dist } from '../floorplan/geometry.js';
import FloorPlanSvg from '../components/FloorPlanSvg.jsx';
import ExplainerPanel from '../components/ExplainerPanel.jsx';
import { Panel, Button, Toggle, Stat, Select, Badge, EvidenceStrip } from '../components/ui.jsx';

/**
 * TAB 1 — Auto Map Builder
 *
 * Demonstrates that a building can be turned into a routable map automatically
 * rather than traced by hand. Press "Generate navigation graph" and the graph is
 * derived from the floor plan geometry in a couple of milliseconds, then A*
 * routes across it — including between levels, and including an accessible-only
 * mode that refuses stairs and escalators.
 */

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
  const [accessibleOnly, setAccessibleOnly] = useState(false);
  const [pickTarget, setPickTarget] = useState('start');
  const [inspectStage, setInspectStage] = useState('input');
  const rafRef = useRef(null);
  const stageTimersRef = useRef([]);

  const currentLevels = scenario === 'mall' ? LEVELS : ALTERNATE_LEVELS;
  const currentLinks = scenario === 'mall' ? VERTICAL_LINKS : ALTERNATE_VERTICAL_LINKS;
  const level = currentLevels.find((l) => l.level === levelNo) ?? currentLevels[0];

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
    setAccessibleOnly(false);
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
  const route = useMemo(() => {
    if (!graph || !startId || !destId || startId === destId) return null;
    return findRoute(graph, startId, destId, { accessibleOnly });
  }, [graph, startId, destId, accessibleOnly]);

  /** The route split into one polyline per level, for per-floor drawing. */
  const routeRuns = useMemo(
    () => (graph && route ? splitRouteByLevel(graph, route) : []),
    [graph, route],
  );

  /** The unaccessible-mode comparison, so we can quantify the detour cost. */
  const defaultRoute = useMemo(() => {
    if (!graph || !startId || !destId || startId === destId) return null;
    return findRoute(graph, startId, destId, { accessibleOnly: false });
  }, [graph, startId, destId]);

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
              ['mall', 'Main mall · two levels'],
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
                {inspectStage === 'route' && accessibleOnly && defaultRoute &&
                  splitRouteByLevel(graph, defaultRoute)
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
                  const linkNode = graph.nodes.find(
                    (n) => n.kind === 'link' && n.label === t.label && n.level === levelNo,
                  );
                  if (!linkNode) return null;
                  const otherLevel = levelNo === 1 ? 2 : 1;
                  return (
                    <g key={t.id} style={{ pointerEvents: 'none' }}>
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
                        {t.label} → Level {otherLevel}
                      </text>
                    </g>
                  );
                })}
              </>
            )}
          </FloorPlanSvg>
        </div>
      </div>

      {/* ================= SIDE COLUMN ================= */}
      <div className="space-y-4">
        <ExplainerPanel
          title="Auto Map Builder — what am I looking at?"
          whatThisIs="A mall floor plan being turned into a routable navigation graph automatically, then routed across with A*."
          concept={[
            'Before an app can give you directions inside a building, the building has to become a graph: nodes are decision points (corridor junctions, corridor ends, shop doors) and edges are walkable connections between them, each labelled with its real length in metres.',
            'Today that graph is traced by hand — someone opens the architect’s drawing and clicks out every corridor and doorway, roughly 30–40 minutes per floor, redone whenever a tenant moves. This tab derives the same graph from the floor plan’s geometry in a few milliseconds.',
            'Once the graph exists, finding a route is a solved problem: A* explores the graph outward from your start, always expanding the option with the lowest (distance walked + straight-line distance still to go), which guarantees the shortest path.',
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
              label: 'Vertical link node',
              desc: 'escalator, stairs or lift — these stitch Level 1 and Level 2 into one graph',
            },
            {
              kind: 'line',
              color: '#2563eb',
              label: 'Computed route',
              desc: 'the shortest path A* found across the generated graph',
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
              label: 'Lift (accessible)',
              desc: 'blue outline = step-free. The escalator and stairs are grey because they are not',
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

              <div className="border-t border-line pt-3">
                <Toggle
                  checked={accessibleOnly}
                  onChange={setAccessibleOnly}
                  label="Step-free route only"
                  disabled={currentLinks.length === 0}
                  hint={
                    currentLinks.length
                      ? 'Removes stairs and escalator edges from the graph, forcing the lift. For wheelchairs, prams and luggage.'
                      : 'This one-level annex has no vertical transport to filter.'
                  }
                />
              </div>

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
                      {describeTransports(route)}
                    </div>
                    {/* Quantify what accessibility costs — an honest trade-off,
                        not a hidden one. */}
                    {accessibleOnly && defaultRoute && (
                      <div className="mt-1.5 text-[11px] leading-snug text-ink-soft">
                        Step-free detour adds{' '}
                        <strong className="tnum text-ink">
                          {(route.distanceM - defaultRoute.distanceM).toFixed(1)} m
                        </strong>{' '}
                        and{' '}
                        <strong className="tnum text-ink">
                          {Math.round(route.seconds - defaultRoute.seconds)} s
                        </strong>{' '}
                        vs the fastest route ({describeTransports(defaultRoute)}).
                      </div>
                    )}
                  </div>

                  {/* Per-level breakdown, clickable to switch floors. */}
                  {routeRuns.length > 1 && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                        Route by level
                      </div>
                      {routeRuns.map((run, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setLevelNo(run.level)}
                          className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                            run.level === levelNo
                              ? 'border-brand/40 bg-blue-50 text-blue-900'
                              : 'border-line text-ink-soft hover:bg-canvas'
                          }`}
                        >
                          <span>
                            Leg {i + 1} — Level {run.level}
                          </span>
                          <span className="tnum">
                            {runLength(run.points).toFixed(1)} m
                            {run.level !== levelNo && ' · view'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-bad">
                  No route found. With step-free mode on, this can happen if the only connection
                  between levels is stairs.
                </p>
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
                label="Levels linked"
                value={graph.stats.levelCount}
                hint={`${currentLinks.length} vertical links`}
              />
            </div>
            {route && (
              <p className="mt-3 text-[11px] leading-snug text-ink-faint">
                A* examined <strong className="tnum text-ink-soft">{route.visitedCount}</strong> of{' '}
                {graph.stats.nodeCount} nodes to prove this route is the shortest — the heuristic
                lets it ignore the rest.
              </p>
            )}
            {validation && (
              <div className="mt-3 grid gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[11px]">
                <ValidationRow ok={validation.connected} label="One connected graph" />
                <ValidationRow ok={validation.noOrphans} label="No orphan nodes" />
                <ValidationRow ok={validation.allDoorsReachable} label="Every shop door reachable" />
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {currentLinks.map((v) => (
                <Badge key={v.id} tone={v.accessible ? 'brand' : 'neutral'}>
                  {v.label} · {v.accessible ? 'step-free' : 'steps'}
                </Badge>
              ))}
            </div>
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

/** Total length of a polyline, in metres. */
function runLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  return total;
}

/** "1 min 25 s" style duration. */
function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
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
