import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVELS, ALL_APS, getLevel } from '../floorplan/floorplan.js';
import { buildRadioMap, DEFAULT_SPACING_M, MAP_MODEL } from '../lib/wifi.js';
import {
  WALK_ROUTE,
  QR_ANCHORS,
  WIFI_INTERVAL_S,
  QR_RADIUS_M,
  STRIDE_M,
  buildWalkPlan,
  initFusionState,
  stepFusion,
  confidenceLabel,
  noLayersActive,
} from '../lib/fusion.js';
import FloorPlanSvg from '../components/FloorPlanSvg.jsx';
import ExplainerPanel from '../components/ExplainerPanel.jsx';
import { Panel, Button, Toggle, Stat, Badge } from '../components/ui.jsx';

/**
 * TAB 3 — Positioning Fusion
 *
 * The "blue dot that doesn't walk through walls" story. A simulated shopper
 * walks a fixed route across both levels; the estimated position is driven by
 * four independently switchable layers. Turning layers off makes each one's
 * contribution visible, and dead-reckoning-alone drifts badly enough to make
 * the argument for layering by itself.
 */

/** Simulation tick, in milliseconds of wall-clock time. */
const TICK_MS = 100;

/** Playback speeds offered to the presenter. */
const SPEEDS = [1, 2, 4];

/** Preset layer combinations, for a fast A/B during a live demo. */
const PRESETS = [
  {
    id: 'all',
    label: 'All layers on',
    layers: { dr: true, qr: true, wifi: true, mapMatch: true },
    hint: 'the product',
  },
  {
    id: 'dr',
    label: 'Dead reckoning only',
    layers: { dr: true, qr: false, wifi: false, mapMatch: false },
    hint: 'watch it drift',
  },
  {
    id: 'wifi',
    label: 'Wi-Fi only',
    layers: { dr: false, qr: false, wifi: true, mapMatch: true },
    hint: 'accurate but laggy',
  },
];

export default function FusionTab() {
  const [layers, setLayers] = useState({ dr: true, qr: true, wifi: true, mapMatch: true });
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [manualLevel, setManualLevel] = useState(1);
  const [autoFollow, setAutoFollow] = useState(true);
  const [manualMode, setManualMode] = useState(false);

  // The radio map is needed for the Wi-Fi layer. It is built once, on mount,
  // with the same predicted-map approach demonstrated in Tab 2.
  const radioMap = useMemo(
    () => buildRadioMap(LEVELS, ALL_APS, DEFAULT_SPACING_M, MAP_MODEL),
    [],
  );
  const plan = useMemo(() => buildWalkPlan(), []);
  const ctx = useMemo(
    () => ({ radioMap, aps: ALL_APS, levels: LEVELS }),
    [radioMap],
  );

  const [state, setState] = useState(() => initFusionState(plan));

  /**
   * Which floor is on screen.
   *
   * Derived during render rather than pushed into state by an effect: while
   * `autoFollow` is on, this is simply "wherever the shopper is", so the view
   * can never fall out of sync with the simulation. Picking a floor by hand
   * turns following off and uses the manual choice instead.
   */
  const levelNo = autoFollow ? state.truth.level : manualLevel;

  // Layers are read inside the interval callback, so keep them in a ref. This
  // lets a toggle take effect on the very next tick without tearing down and
  // restarting the timer, which would visibly stutter the walk.
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // ---- The simulation loop ------------------------------------------------
  //
  // A fixed-interval timer rather than requestAnimationFrame: the physics here
  // is a fixed-timestep integration, and a steady 100 ms tick keeps the drift
  // reproducible instead of varying with the display's refresh rate.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setState((prev) => {
        if (prev.finished) return prev;
        const next = stepFusion(prev, (TICK_MS / 1000) * speed, plan, layersRef.current, ctx);
        // Stop the clock when the shopper arrives. Doing it here rather than in
        // an effect keeps it a consequence of the tick that ended the walk.
        if (next.finished) setRunning(false);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, speed, plan, ctx]);

  const reset = useCallback(() => {
    setRunning(false);
    setState(initFusionState(plan));
    setManualLevel(1);
  }, [plan]);

  const applyPreset = useCallback((preset) => {
    setLayers(preset.layers);
  }, []);

  /** Manual selection — the always-works fallback. */
  const handleMapClick = useCallback(
    (p) => {
      if (!manualMode) return;
      setState((prev) => ({
        ...prev,
        est: { x: p.x, y: p.y, level: levelNo },
        headingBias: 0,
        metresSinceFix: 0,
        lastCorrection: 'Manual selection by user',
        flash: { text: 'Position set manually', t: prev.t },
        events: [
          { type: 'manual', text: 'User tapped their own position', t: prev.t },
          ...prev.events,
        ].slice(0, 8),
      }));
      setManualMode(false);
    },
    [manualMode, levelNo],
  );

  const level = getLevel(levelNo);
  const allOff = noLayersActive(layers);
  const confidence = confidenceLabel(state.currentError, state.wrongFloor);
  const meanError = state.errorCount ? state.errorSum / state.errorCount : 0;
  const progress = plan.totalSeconds ? state.t / plan.totalSeconds : 0;

  const activePreset = PRESETS.find(
    (p) =>
      p.layers.dr === layers.dr &&
      p.layers.qr === layers.qr &&
      p.layers.wifi === layers.wifi &&
      p.layers.mapMatch === layers.mapMatch,
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ================= MAP COLUMN ================= */}
      <div className="space-y-4">
        {/* ---- Live confidence readout ---- */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                Current positioning error
              </div>
              <div className="mt-0.5 flex items-baseline gap-3">
                <span
                  className={`tnum text-3xl font-semibold leading-none ${
                    confidence.tone === 'good'
                      ? 'text-good'
                      : confidence.tone === 'warn'
                        ? 'text-amber-600'
                        : 'text-bad'
                  }`}
                >
                  {state.currentError.toFixed(2)}
                  <span className="ml-1 text-base font-medium text-ink-soft">m</span>
                </span>
                <Badge
                  tone={
                    confidence.tone === 'good' ? 'good' : confidence.tone === 'warn' ? 'warn' : 'bad'
                  }
                >
                  {confidence.text}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-ink-soft">
                Last correction: <strong className="text-ink">{state.lastCorrection}</strong>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setRunning((r) => !r)} disabled={state.finished}>
                {running ? 'Pause walk' : state.t > 0 ? 'Resume walk' : 'Start walk'}
              </Button>
              <Button variant="secondary" onClick={reset}>
                Reset
              </Button>
              <div className="inline-flex rounded-lg border border-line p-0.5">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSpeed(s)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      s === speed ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Walk progress */}
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-100"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
              <span className="tnum">
                {state.t.toFixed(0)} s of {plan.totalSeconds.toFixed(0)} s ·{' '}
                {Math.round(state.stepCount)} steps counted
              </span>
              <span>
                {state.truth.riding
                  ? 'Riding the escalator — no steps to count'
                  : state.finished
                    ? 'Arrived at Metro Shoes'
                    : `Walking on ${getLevel(state.truth.level).name}`}
              </span>
            </div>
          </div>
        </div>

        {/* ---- Presets + level switcher ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-ink-soft">Compare:</span>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                title={p.hint}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  activePreset?.id === p.id
                    ? 'border-brand/40 bg-blue-50 text-blue-900'
                    : 'border-line bg-surface text-ink-soft hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
            {LEVELS.map((l) => (
              <button
                key={l.level}
                type="button"
                onClick={() => {
                  setManualLevel(l.level);
                  setAutoFollow(false);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  l.level === levelNo ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Warnings ---- */}
        {allOff && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
            <strong>Every layer is off.</strong> The estimate is frozen wherever it was last
            corrected — this is what an indoor navigation app looks like with no positioning at
            all. The only thing left is the manual fallback below.
          </div>
        )}
        {state.wrongFloor && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <strong>The estimate is on the wrong floor</strong> — it thinks you are on{' '}
            {getLevel(state.est.level).name} while you are on {getLevel(state.truth.level).name}. A
            step counter cannot feel an escalator. Only a QR scan or a Wi-Fi fix can resolve the
            floor.
          </div>
        )}

        {/* ---- The plan ---- */}
        <div className="rounded-xl border border-line bg-surface p-3">
          <FloorPlanSvg
            level={level}
            showAps={layers.wifi}
            onPointClick={handleMapClick}
            cursor={manualMode ? 'crosshair' : 'default'}
          >
            {/* --- Planned route, faint, for context --- */}
            <g style={{ pointerEvents: 'none' }}>
              {WALK_ROUTE.slice(0, -1).map((wp, i) => {
                const next = WALK_ROUTE[i + 1];
                if (wp.level !== levelNo || next.level !== levelNo) return null;
                return (
                  <line
                    key={i}
                    x1={wp.x}
                    y1={wp.y}
                    x2={next.x}
                    y2={next.y}
                    stroke="#cbd5e1"
                    strokeWidth={6}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>

            {/* --- QR anchors --- */}
            {layers.qr && (
              <g style={{ pointerEvents: 'none' }}>
                {QR_ANCHORS.filter((a) => a.level === levelNo).map((a) => {
                  const scanned = state.scannedAnchorIds.includes(a.id);
                  return (
                    <g key={a.id}>
                      <circle
                        cx={a.x}
                        cy={a.y}
                        r={QR_RADIUS_M}
                        fill="#f59e0b"
                        opacity={scanned ? 0.08 : 0.14}
                      />
                      <rect
                        x={a.x - 1.1}
                        y={a.y - 1.1}
                        width={2.2}
                        height={2.2}
                        rx={0.3}
                        fill={scanned ? '#fed7aa' : '#f59e0b'}
                        stroke="#b45309"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* A tiny QR-like glyph, so the marker reads as a printed code. */}
                      <g fill="#78350f" opacity={scanned ? 0.4 : 0.9}>
                        <rect x={a.x - 0.75} y={a.y - 0.75} width={0.5} height={0.5} />
                        <rect x={a.x + 0.25} y={a.y - 0.75} width={0.5} height={0.5} />
                        <rect x={a.x - 0.75} y={a.y + 0.25} width={0.5} height={0.5} />
                        <rect x={a.x + 0.25} y={a.y + 0.25} width={0.5} height={0.5} />
                      </g>
                    </g>
                  );
                })}
              </g>
            )}

            {/* --- Trails: where each dot has actually been --- */}
            <g style={{ pointerEvents: 'none' }}>
              <TrailPath trail={state.trueTrail} level={levelNo} color="#0f172a" width={2} />
              <TrailPath trail={state.estTrail} level={levelNo} color="#2563eb" width={2} dashed />
            </g>

            {/* --- Error line between truth and estimate --- */}
            {state.est.level === levelNo && state.truth.level === levelNo && (
              <line
                x1={state.truth.x}
                y1={state.truth.y}
                x2={state.est.x}
                y2={state.est.y}
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* --- The estimated position: the "blue dot" --- */}
            {state.est.level === levelNo && (
              <g style={{ pointerEvents: 'none' }}>
                {/* The halo encodes uncertainty: it grows with the current error,
                    which is exactly how a real app communicates confidence. */}
                <circle
                  cx={state.est.x}
                  cy={state.est.y}
                  r={Math.max(1.5, Math.min(12, state.currentError))}
                  fill="#2563eb"
                  opacity={0.15}
                />
                <circle
                  cx={state.est.x}
                  cy={state.est.y}
                  r={1.15}
                  fill="#2563eb"
                  stroke="#ffffff"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}

            {/* --- The true position --- */}
            {state.truth.level === levelNo && (
              <g style={{ pointerEvents: 'none' }}>
                <circle
                  cx={state.truth.x}
                  cy={state.truth.y}
                  r={1}
                  fill="#0f172a"
                  stroke="#ffffff"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}

            {/* --- QR flash --- */}
            {state.flash && (
              <g style={{ pointerEvents: 'none' }}>
                <rect
                  x={12}
                  y={1.5}
                  width={36}
                  height={4.4}
                  rx={0.8}
                  fill="#b45309"
                  opacity={0.95}
                />
                <text x={30} y={4.6} textAnchor="middle" fontSize={1.9} fill="#ffffff" fontWeight={600}>
                  {state.flash.text}
                </text>
              </g>
            )}
          </FloorPlanSvg>

          {/* ---- Map legend ---- */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[11px]">
            <LegendItem color="#0f172a" label="True position (ground truth)" />
            <LegendItem color="#2563eb" label="Estimated position — the blue dot" />
            <LegendItem color="#2563eb" label="Estimate's path" dashed />
            <LegendItem color="#0f172a" label="Actual path walked" solid />
            <LegendItem color="#f59e0b" label="QR anchor (square = code, ring = scan range)" />
            <LegendItem color="#cbd5e1" label="Planned route" solid />
            <span className="text-ink-soft">
              Blue halo = current uncertainty (grows with error)
            </span>
          </div>
        </div>

        {/* ---- Session statistics ---- */}
        <Panel title="This walk" subtitle="Accuracy accumulated since the last reset">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Current error"
              value={state.currentError.toFixed(2)}
              unit="m"
              tone={confidence.tone === 'good' ? 'good' : 'bad'}
            />
            <Stat label="Mean error" value={meanError.toFixed(2)} unit="m" />
            <Stat label="Worst error" value={state.maxError.toFixed(2)} unit="m" tone="bad" />
            <Stat
              label="QR anchors scanned"
              value={`${state.scannedAnchorIds.length} / ${QR_ANCHORS.length}`}
              hint={layers.qr ? 'layer active' : 'layer off'}
            />
          </div>

          {/* Activity log — makes the invisible corrections visible. */}
          {state.events.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                Correction log
              </div>
              <ul className="space-y-1">
                {state.events.map((e, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-[11px]">
                    <span className="tnum shrink-0 text-ink-faint">{e.t.toFixed(1)} s</span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        e.type === 'qr'
                          ? 'bg-amber-100 text-amber-800'
                          : e.type === 'manual'
                            ? 'bg-slate-200 text-slate-700'
                            : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {e.type === 'qr' ? 'QR' : e.type === 'manual' ? 'MANUAL' : 'WI-FI'}
                    </span>
                    <span className="text-ink-soft">{e.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>

      {/* ================= SIDE COLUMN ================= */}
      <div className="space-y-4">
        <ExplainerPanel
          title="Positioning Fusion — what am I looking at?"
          whatThisIs="A shopper walking a route across two levels, with the app's estimate of their position running alongside the truth so you can see exactly where it goes wrong."
          concept={[
            'The real product never relies on one sensor, because every indoor positioning method has a different failure mode. So they are layered into a confidence ladder: the most trustworthy source available wins, and the others fill the gaps between.',
            'QR anchors are the top rung — a printed code encodes its own exact coordinates, so scanning one gives ground truth and resets all accumulated drift to zero. But you only get one when you happen to walk past a pillar.',
            'Dead reckoning carries the dot between those moments. It counts steps and reads a heading, which is smooth and instant, but every small error in stride length or compass heading is permanent — so error grows without bound. Turn everything else off and watch it wander into the shops.',
            'Wi-Fi fingerprinting corrects that drift with a bounded ~2 m fix every few seconds, and it is the only layer that can tell which floor you are on. But it is too slow and too noisy to drive a smooth dot alone — with only Wi-Fi the dot visibly lags behind the walker.',
            'Map matching contributes no position at all. It only knows where you cannot be, and pushes the estimate back onto walkable floor. Note its limit: it corrects error across the corridor but is blind to error along it.',
          ]}
          legend={[
            {
              kind: 'dot',
              color: '#0f172a',
              label: 'True position',
              desc: 'black dot — where the shopper actually is. In reality the app never knows this; it is here so you can judge the estimate',
            },
            {
              kind: 'halo',
              color: '#2563eb',
              label: 'Estimated position (the blue dot)',
              desc: 'what the app believes. Its halo grows with the current uncertainty',
            },
            {
              kind: 'thin-line',
              color: '#0f172a',
              label: "Actual path walked",
              desc: 'solid dark trail — ground truth history',
            },
            {
              kind: 'dashed',
              color: '#2563eb',
              label: "Estimate's path",
              desc: 'dashed blue trail — where the app thought you were. Gaps between the trails are drift',
            },
            {
              kind: 'square',
              color: '#f59e0b',
              color2: '#b45309',
              label: 'QR anchor',
              desc: `a printed code on a pillar. Pass within ${QR_RADIUS_M} m and it snaps the estimate to exact truth; it fades once used`,
            },
            {
              kind: 'line',
              color: '#cbd5e1',
              label: 'Planned route',
              desc: 'the path the simulated shopper follows — west entrance, escalator, then Metro Shoes on Level 2',
            },
            {
              kind: 'dot',
              color: '#7c3aed',
              label: 'Wi-Fi access points',
              desc: 'shown while the Wi-Fi layer is on — fixes are computed from the same predicted radio map as Tab 2',
            },
            {
              kind: 'dashed',
              color: '#94a3b8',
              label: 'Error line',
              desc: 'the gap between truth and estimate — its length is the number in the readout above',
            },
          ]}
          whyItMatters="A blue dot that drifts into a shop or lands on the wrong floor destroys trust in the whole app — so MallNav's real contribution is not any single positioning method, it is the fallback ladder that keeps the dot believable when individual sensors fail."
          footnote={`Layer parameters: stride ${STRIDE_M} m with a 6% systematic scale error plus gyro heading drift as a random walk; Wi-Fi fixes every ${WIFI_INTERVAL_S} s blended at 45% toward the fingerprint match; QR scan radius ${QR_RADIUS_M} m; map matching projects onto the corridor rectangles defined in the shared floor plan. Averaged over 12 random seeds on this route: all layers on ≈ 1.1 m mean error, dead reckoning alone ≈ 5.4 m mean drifting to ≈ 13 m by the end.`}
        />

        {/* ---- Layer toggles ---- */}
        <Panel title="Positioning layers" subtitle="Switch each one off to see what it was doing">
          <div className="space-y-3.5">
            <Toggle
              checked={layers.qr}
              onChange={(v) => setLayers((l) => ({ ...l, qr: v }))}
              label="1 · QR anchors — exact truth"
              accent="warn"
              hint={`Printed codes at ${QR_ANCHORS.length} points. Scanning one snaps the estimate onto it and resets drift to zero. Weakness: only works at the instant you pass one.`}
            />
            <Toggle
              checked={layers.dr}
              onChange={(v) => setLayers((l) => ({ ...l, dr: v }))}
              label="2 · Dead reckoning — carries you between fixes"
              hint="Step count × stride length, in the direction the compass reports. Weakness: errors accumulate forever, and it cannot sense a floor change."
            />
            <Toggle
              checked={layers.wifi}
              onChange={(v) => setLayers((l) => ({ ...l, wifi: v }))}
              label="3 · Wi-Fi fingerprinting — corrects drift"
              accent="ap"
              hint={`A fix every ${WIFI_INTERVAL_S} s from the predicted radio map, pulling the estimate back. Also resolves which floor you are on. Weakness: noisy and slow — it lags a walker.`}
            />
            <Toggle
              checked={layers.mapMatch}
              onChange={(v) => setLayers((l) => ({ ...l, mapMatch: v }))}
              label="4 · Map matching — stops walls being crossed"
              accent="good"
              hint="Constrains the estimate to walkable corridors. Weakness: it can only fix error across the corridor, never along it."
            />

            {/* The always-works fallback. */}
            <div className="border-t border-line pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">5 · Manual selection</div>
                  <p className="mt-0.5 text-xs leading-snug text-ink-soft">
                    The fallback that always works: the user taps where they actually are. Never
                    the primary method, but it means the app is never completely lost.
                  </p>
                </div>
                <Button
                  variant={manualMode ? 'primary' : 'secondary'}
                  onClick={() => setManualMode((m) => !m)}
                >
                  {manualMode ? 'Click the map…' : "I'm here"}
                </Button>
              </div>
            </div>
          </div>
        </Panel>

        {/* ---- View options ---- */}
        <Panel title="View">
          <Toggle
            checked={autoFollow}
            onChange={setAutoFollow}
            label="Follow the shopper between levels"
            hint="Automatically switches the displayed floor when the route changes level. Turn off to stay on one floor and watch the estimate get left behind."
          />
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Draw a trail, split wherever it changes level so a Level 2 segment never
 * draws a stray line across the Level 1 plan.
 */
function TrailPath({ trail, level, color, width, dashed = false }) {
  const runs = useMemo(() => {
    const out = [];
    for (const p of trail) {
      if (p.level !== level) {
        if (out.length && out[out.length - 1].length) out.push([]);
        continue;
      }
      if (!out.length) out.push([]);
      out[out.length - 1].push(p);
    }
    return out.filter((r) => r.length > 1);
  }, [trail, level]);

  return (
    <>
      {runs.map((run, i) => (
        <polyline
          key={i}
          points={run.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeDasharray={dashed ? '3 2.5' : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.7}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

/** One entry in the map legend strip. */
function LegendItem({ color, label, dashed = false, solid = false }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-soft">
      {dashed || solid ? (
        <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden>
          <line
            x1="1"
            y1="4"
            x2="15"
            y2="4"
            stroke={color}
            strokeWidth="2"
            strokeDasharray={dashed ? '3 2' : undefined}
          />
        </svg>
      ) : (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}
