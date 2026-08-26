import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVELS, ALL_APS, getLevel } from '../floorplan/floorplan.js';
import { buildRadioMap, DEFAULT_SPACING_M, MAP_MODEL } from '../lib/wifi.js';
import {
  WALK_ROUTE,
  QR_ANCHORS,
  QR_RADIUS_M,
  STRIDE_M,
  SENSOR_ERROR,
  WIFI_SCAN_PRESETS,
  DEFAULT_WIFI_INTERVAL_S,
  buildWalkPlan,
  buildFusionContext,
  initFusionState,
  stepFusion,
  scanQrCode,
  setManualPosition,
  confidenceLabel,
  noLayersActive,
} from '../lib/fusion.js';
import { PF_CONFIG } from '../lib/particleFilter.js';
import FloorPlanSvg from '../components/FloorPlanSvg.jsx';
import ExplainerPanel from '../components/ExplainerPanel.jsx';
import { Panel, Button, Toggle, Stat, Badge, EvidenceStrip } from '../components/ui.jsx';

/**
 * TAB 3 — Positioning Fusion
 *
 * The "blue dot that doesn't walk through walls" story. A simulated shopper
 * walks a route across both levels; position is estimated by a particle filter
 * whose four operations correspond exactly to the four togglable layers.
 *
 * Everything on screen that claims to be the app's own knowledge is computed
 * without reference to the true position. The true position appears only in the
 * clearly-labelled evaluation readouts, because this is a simulation and we can
 * afford to grade ourselves.
 */

/** Simulation tick, in milliseconds of wall-clock time. */
const TICK_MS = 100;

/** Playback speeds offered to the presenter. */
const SPEEDS = [1, 2, 4];

/** Draw at most this many particles, for render cost. */
const MAX_DRAWN_PARTICLES = 220;
const BASELINE_LAYERS = { dr: true, qr: true, wifi: false, mapMatch: false };

/**
 * Preset layer combinations, for a fast A/B during a live demo.
 *
 * Every preset leaves QR available. Since a scan only happens when the user
 * presses the button, having anchors switched on costs the comparison nothing —
 * and it keeps the recovery story demonstrable in the presets built to show the
 * system failing.
 */
const PRESETS = [
  {
    id: 'all',
    label: 'All layers on',
    layers: { dr: true, qr: true, wifi: true, mapMatch: true },
    hint: 'the product: one entrance scan, then the phone',
  },
  {
    id: 'nomap',
    label: 'No map matching',
    layers: { dr: true, qr: true, wifi: true, mapMatch: false },
    hint: 'what the floor plan was contributing',
  },
  {
    id: 'nowifi',
    label: 'No Wi-Fi',
    layers: { dr: true, qr: true, wifi: false, mapMatch: true },
    hint: 'drift with no radio correction — and the floor is never recovered',
  },
  {
    id: 'dr',
    label: 'Dead reckoning alone',
    layers: { dr: true, qr: true, wifi: false, mapMatch: false },
    hint: 'raw sensors: drifts through walls and onto the wrong floor',
  },
];

export default function FusionTab({ presentationMode = false }) {
  const [layers, setLayers] = useState({ dr: true, qr: true, wifi: true, mapMatch: true });
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [manualLevel, setManualLevel] = useState(1);
  const [autoFollow, setAutoFollow] = useState(true);
  const [manualMode, setManualMode] = useState(false);
  const [showParticles, setShowParticles] = useState(true);
  const [wifiIntervalS, setWifiIntervalS] = useState(DEFAULT_WIFI_INTERVAL_S);
  const [compareBaseline, setCompareBaseline] = useState(true);

  // The radio map is needed for the Wi-Fi layer, built once with the same
  // predicted-map approach demonstrated in Tab 2.
  const radioMap = useMemo(
    () => buildRadioMap(LEVELS, ALL_APS, DEFAULT_SPACING_M, MAP_MODEL),
    [],
  );
  const plan = useMemo(() => buildWalkPlan(), []);
  const ctx = useMemo(() => buildFusionContext(radioMap, ALL_APS, LEVELS), [radioMap]);

  const [state, setState] = useState(() => initFusionState(plan, 7, { qr: true }, ctx));
  const [baselineState, setBaselineState] = useState(() =>
    initFusionState(plan, 7, BASELINE_LAYERS, ctx),
  );

  /**
   * Which floor is on screen. Derived during render rather than pushed into
   * state by an effect, so the view can never fall out of sync with the
   * simulation.
   */
  const levelNo = autoFollow ? state.truth.level : manualLevel;

  // Layers and scan interval are read inside the interval callback, so keep them
  // in refs — a toggle then takes effect on the next tick without tearing down
  // and restarting the timer, which would visibly stutter the walk.
  const layersRef = useRef(layers);
  const intervalRef = useRef(wifiIntervalS);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  useEffect(() => {
    intervalRef.current = wifiIntervalS;
  }, [wifiIntervalS]);

  // ---- The simulation loop ------------------------------------------------
  //
  // A fixed-interval timer rather than requestAnimationFrame: this is a
  // fixed-timestep integration, and a steady tick keeps the sensor errors
  // reproducible instead of varying with the display's refresh rate.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (compareBaseline) {
        setBaselineState((prev) =>
          prev.finished
            ? prev
            : stepFusion(
                prev,
                (TICK_MS / 1000) * speed,
                plan,
                BASELINE_LAYERS,
                ctx,
                intervalRef.current,
              ),
        );
      }
      setState((prev) => {
        if (prev.finished) return prev;
        const next = stepFusion(
          prev,
          (TICK_MS / 1000) * speed,
          plan,
          layersRef.current,
          ctx,
          intervalRef.current,
        );
        if (next.finished) setRunning(false);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, speed, plan, ctx, compareBaseline]);

  const reset = useCallback(() => {
    setRunning(false);
    setState(initFusionState(plan, 7, layersRef.current, ctx));
    setBaselineState(initFusionState(plan, 7, BASELINE_LAYERS, ctx));
    setManualLevel(1);
  }, [plan, ctx]);

  const applyPreset = useCallback(
    (preset) => {
      setRunning(false);
      setLayers(preset.layers);
      layersRef.current = preset.layers;
      setState(initFusionState(plan, 7, preset.layers, ctx));
      setBaselineState(initFusionState(plan, 7, BASELINE_LAYERS, ctx));
    },
    [plan, ctx],
  );

  /** The user deliberately scans a QR code — the recovery action. */
  const handleScan = useCallback(() => {
    setState((prev) => scanQrCode(prev, layersRef.current));
  }, []);

  /** Manual selection — the always-works fallback. */
  const handleMapClick = useCallback(
    (p) => {
      if (!manualMode) return;
      setState((prev) => setManualPosition(prev, p, levelNo));
      setManualMode(false);
    },
    [manualMode, levelNo],
  );

  const level = getLevel(levelNo);
  const allOff = noLayersActive(layers);
  // Confidence comes from the filter's OWN spread, not from the true error.
  const confidence = confidenceLabel(state.spreadM, state.floorConfidence);
  const meanError = state.errorCount ? state.errorSum / state.errorCount : 0;
  const baselineMeanError = baselineState.errorCount
    ? baselineState.errorSum / baselineState.errorCount
    : 0;
  const progress = plan.totalSeconds ? state.t / plan.totalSeconds : 0;
  const story = storyForState(state, layers, wifiIntervalS);

  const activePreset = PRESETS.find(
    (p) =>
      p.layers.dr === layers.dr &&
      p.layers.qr === layers.qr &&
      p.layers.wifi === layers.wifi &&
      p.layers.mapMatch === layers.mapMatch,
  );

  // Thin the cloud for rendering — 400 SVG circles per tick is wasteful and the
  // shape of the cloud is just as readable from half of them.
  const drawnParticles = useMemo(() => {
    if (!showParticles || !state.particles) return [];
    const stride = Math.max(1, Math.ceil(state.particles.length / MAX_DRAWN_PARTICLES));
    return state.particles.filter((p, i) => i % stride === 0 && p.level === levelNo);
  }, [showParticles, state.particles, levelNo]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ================= MAP COLUMN ================= */}
      <div className="space-y-4">
        <EvidenceStrip
          proves="The fused estimator stays believable where dead reckoning alone drifts"
          value="A synchronized orange baseline walks the same route from the same seed"
          limitation="Simulation evidence; phone IMU and live venue trials remain future validation"
        />

        <div className={`rounded-xl border px-4 py-3 ${story.className}`} aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] opacity-70">
                Live defence story
              </div>
              <div className="mt-0.5 text-sm font-semibold">{story.title}</div>
            </div>
            <Badge tone={story.tone}>{story.badge}</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed opacity-90">{story.body}</p>
        </div>

        {state.truth.riding && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-violet-950">
            <div className="flex items-center gap-3">
              <div className="flex shrink-0 flex-col items-center text-[10px] font-bold">
                <span className="rounded bg-white px-2 py-1">L1</span>
                <span className="py-0.5">↑</span>
                <span className="rounded bg-violet-700 px-2 py-1 text-white">L2</span>
              </div>
              <p className="text-xs leading-relaxed">
                <strong>Floor transition:</strong> the step counter reports no horizontal movement,
                so the estimate cannot discover Level 2 until radio evidence or a QR anchor changes
                the floor hypothesis.
              </p>
            </div>
          </div>
        )}
        {/* ---- Confidence vs actual error ---- */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-6">
              {/* What the app itself believes — no ground truth involved. */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                  App&rsquo;s own confidence
                </div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="tnum text-3xl font-semibold leading-none text-brand">
                    ±{state.spreadM.toFixed(2)}
                    <span className="ml-1 text-base font-medium text-ink-soft">m</span>
                  </span>
                  <Badge
                    tone={
                      confidence.tone === 'good'
                        ? 'good'
                        : confidence.tone === 'warn'
                          ? 'warn'
                          : 'bad'
                    }
                  >
                    {confidence.text}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-ink-soft">
                  Spread of the {PF_CONFIG.count}-particle cloud — computed{' '}
                  <strong className="text-ink">without</strong> knowing the true position
                </p>
                {/* A torn cloud is a different failure from a fuzzy one, and the
                    product would respond differently: ask for a QR scan rather
                    than just widen the circle. */}
                {state.modeShare !== undefined && state.modeShare < 0.6 && (
                  <p className="mt-1 text-[11px] font-medium text-amber-700">
                    Torn between separate locations — only{' '}
                    {(state.modeShare * 100).toFixed(0)}% of hypotheses agree on this one
                  </p>
                )}
              </div>

              {/* The grade. Only available because this is a simulation. */}
              <div className="border-l border-line pl-6">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                  Actual error (simulation only)
                </div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span
                    className={`tnum text-3xl font-semibold leading-none ${
                      state.wrongFloor
                        ? 'text-bad'
                        : state.currentError < 5
                          ? 'text-good'
                          : 'text-amber-600'
                    }`}
                  >
                    {state.currentError.toFixed(2)}
                    <span className="ml-1 text-base font-medium text-ink-soft">m</span>
                  </span>
                  {state.wrongFloor && <Badge tone="bad">wrong floor</Badge>}
                </div>
                <p className="mt-1 text-[11px] text-ink-soft">
                  Horizontal distance to ground truth — a real app can never see this
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setRunning((r) => !r)} disabled={state.finished}>
                {running ? 'Pause walk' : state.t > 0 ? 'Resume walk' : 'Start walk'}
              </Button>
              {/* Scanning is a user action, so it is a button — never automatic. */}
              <Button
                variant={state.qrInRange ? 'primary' : 'secondary'}
                onClick={handleScan}
                disabled={!layers.qr}
                title={
                  state.qrInRange
                    ? `Scan "${state.qrInRange.label}"`
                    : 'No QR code within reach right now'
                }
              >
                {state.qrInRange ? 'Scan QR ✓ in reach' : 'Scan QR code'}
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

          <p className="mt-2 text-[11px] text-ink-soft">
            Last correction: <strong className="text-ink">{state.lastCorrection}</strong>
          </p>

          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-ink-soft">
            <input
              type="checkbox"
              checked={compareBaseline}
              onChange={(event) => setCompareBaseline(event.target.checked)}
              className="accent-brand"
            />
            Overlay dead-reckoning-only baseline (same route + starting seed)
          </label>

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
                {Math.round(state.stepCount)} steps counted · {state.scanCount} Wi-Fi scans
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
            <strong>Every layer is off.</strong> The particle cloud is frozen where it was last
            corrected — this is what an indoor navigation app looks like with no positioning at
            all. Only the manual fallback is left.
          </div>
        )}
        {state.qrInRange && state.currentError > 4 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <span>
              The dot is <strong className="tnum">{state.currentError.toFixed(1)} m</strong> out and{' '}
              <strong>{state.qrInRange.label}</strong> is within reach — this is when a user would
              notice and re-scan.
            </span>
            <Button onClick={handleScan}>Scan to recover</Button>
          </div>
        )}
        {state.wrongFloor && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <strong>The estimate is on the wrong floor</strong> — it believes{' '}
            {getLevel(state.est.level).name} while you are on {getLevel(state.truth.level).name}. A
            step counter cannot feel an escalator, so only a Wi-Fi scan or a QR scan resolves this.
            {layers.wifi && (
              <>
                {' '}
                The next scan is due within {wifiIntervalS} s and should trigger a
                re-localisation.
              </>
            )}
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
                  const inReach = state.qrInRange?.id === a.id;
                  return (
                    <g key={a.id}>
                      <circle
                        cx={a.x}
                        cy={a.y}
                        r={QR_RADIUS_M}
                        fill="#f59e0b"
                        opacity={inReach ? 0.3 : scanned ? 0.07 : 0.12}
                      />
                      {inReach && (
                        <circle
                          cx={a.x}
                          cy={a.y}
                          r={QR_RADIUS_M}
                          fill="none"
                          stroke="#b45309"
                          strokeWidth={2}
                          strokeDasharray="3 2"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      <rect
                        x={a.x - 1.1}
                        y={a.y - 1.1}
                        width={2.2}
                        height={2.2}
                        rx={0.3}
                        fill={scanned && !inReach ? '#fed7aa' : '#f59e0b'}
                        stroke="#b45309"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                      <g fill="#78350f" opacity={scanned && !inReach ? 0.4 : 0.9}>
                        <rect x={a.x - 0.75} y={a.y - 0.75} width={0.5} height={0.5} />
                        <rect x={a.x + 0.25} y={a.y - 0.75} width={0.5} height={0.5} />
                        <rect x={a.x - 0.75} y={a.y + 0.25} width={0.5} height={0.5} />
                        <rect x={a.x + 0.25} y={a.y + 0.25} width={0.5} height={0.5} />
                      </g>
                      {inReach && (
                        <text
                          x={a.x}
                          y={a.y - QR_RADIUS_M - 0.8}
                          textAnchor="middle"
                          fontSize={1.3}
                          fontWeight={700}
                          fill="#b45309"
                        >
                          scannable
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            )}

            {/* --- Trails --- */}
            <g style={{ pointerEvents: 'none' }}>
              <TrailPath trail={state.trueTrail} level={levelNo} color="#0f172a" width={2} />
              {compareBaseline && (
                <TrailPath
                  trail={baselineState.estTrail}
                  level={levelNo}
                  color="#ea580c"
                  width={2.5}
                  dashed
                />
              )}
              <TrailPath trail={state.estTrail} level={levelNo} color="#2563eb" width={2} dashed />
            </g>

            {/* --- The particle cloud: the estimator's actual internal state --- */}
            {drawnParticles.length > 0 && (
              <g style={{ pointerEvents: 'none' }}>
                {drawnParticles.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={0.22} fill="#2563eb" opacity={0.35} />
                ))}
              </g>
            )}

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
                {/* The halo is the filter's 1-sigma spread — a self-assessed
                    confidence, not a peek at the true error. */}
                <circle
                  cx={state.est.x}
                  cy={state.est.y}
                  r={Math.max(1, Math.min(20, state.spreadM))}
                  fill="#2563eb"
                  opacity={0.14}
                />
                <circle
                  cx={state.est.x}
                  cy={state.est.y}
                  r={Math.max(1, Math.min(20, state.spreadM))}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  opacity={0.5}
                  vectorEffect="non-scaling-stroke"
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

            {compareBaseline && baselineState.est.level === levelNo && (
              <g style={{ pointerEvents: 'none' }}>
                <circle
                  cx={baselineState.est.x}
                  cy={baselineState.est.y}
                  r={1.25}
                  fill="#ea580c"
                  stroke="#ffffff"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={`M ${baselineState.est.x - 1.8} ${baselineState.est.y - 1.8} L ${baselineState.est.x + 1.8} ${baselineState.est.y + 1.8} M ${baselineState.est.x + 1.8} ${baselineState.est.y - 1.8} L ${baselineState.est.x - 1.8} ${baselineState.est.y + 1.8}`}
                  stroke="#9a3412"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}

            {/* --- The true position --- */}
            {state.truth.level === levelNo && (
              <circle
                cx={state.truth.x}
                cy={state.truth.y}
                r={1}
                fill="#0f172a"
                stroke="#ffffff"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* --- Flash --- */}
            {state.flash && (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={12} y={1.5} width={36} height={4.4} rx={0.8} fill="#b45309" opacity={0.95} />
                <text
                  x={30}
                  y={4.6}
                  textAnchor="middle"
                  fontSize={1.9}
                  fill="#ffffff"
                  fontWeight={600}
                >
                  {state.flash.text}
                </text>
              </g>
            )}
          </FloorPlanSvg>

          {/* ---- Map legend ---- */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[11px]">
            <LegendItem color="#0f172a" label="True position (ground truth)" />
            <LegendItem color="#2563eb" label="Estimated position — the blue dot" />
            <LegendItem color="#2563eb" label="Particle cloud (the filter's hypotheses)" faint />
            <LegendItem color="#2563eb" label="Estimate's path" dashed />
            {compareBaseline && (
              <LegendItem color="#ea580c" label="DR-only baseline (same route + seed)" dashed />
            )}
            <LegendItem color="#0f172a" label="Actual path walked" solid />
            <LegendItem color="#f59e0b" label="QR anchor (ring = scan range)" />
            <LegendItem color="#cbd5e1" label="Planned route" solid />
            <span className="text-ink-soft">Dashed circle = 1σ self-assessed uncertainty</span>
          </div>
        </div>

        {/* ---- Session statistics ---- */}
        <Panel title="This walk" subtitle="Accumulated since the last reset">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            <Stat label="Mean error" value={meanError.toFixed(2)} unit="m" hint="horizontal" />
            <Stat
              label="Floor correct"
              value={
                state.errorCount
                  ? ((state.floorCorrectCount / state.errorCount) * 100).toFixed(0)
                  : '100'
              }
              unit="%"
              tone={
                state.errorCount && state.floorCorrectCount === state.errorCount ? 'good' : 'bad'
              }
              hint="of the walk"
            />
            <Stat
              label="Worst error"
              value={state.maxError.toFixed(2)}
              unit="m"
              tone="bad"
              hint="horizontal"
            />
            {/* The thesis of this tab, as one number. A real app can compute
                this itself — it holds the floor plan. */}
            <Stat
              label="Dot inside a wall"
              value={
                state.errorCount
                  ? (((state.wallViolationCount ?? 0) / state.errorCount) * 100).toFixed(0)
                  : '0'
              }
              unit="%"
              tone={(state.wallViolationCount ?? 0) === 0 ? 'good' : 'bad'}
              hint="of the walk"
            />
            {/* Scans are a COST, not coverage: each is an interruption. */}
            <Stat
              label="QR scans used"
              value={state.qrScanCount}
              tone={state.qrScanCount <= 1 ? 'good' : 'default'}
              hint={
                state.qrScanCount === 0
                  ? 'no bootstrap — QR off'
                  : state.qrScanCount === 1
                    ? 'just the entrance scan'
                    : `${state.qrScanCount - 1} re-scan${state.qrScanCount > 2 ? 's' : ''} to recover`
              }
            />
          </div>

          {compareBaseline && (
            <div className="mt-3 grid gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 sm:grid-cols-3">
              <Stat
                label="Fused mean error"
                value={meanError.toFixed(2)}
                unit="m"
                tone="good"
                hint="blue estimator"
              />
              <Stat
                label="DR-only mean error"
                value={baselineMeanError.toFixed(2)}
                unit="m"
                tone="bad"
                hint="orange baseline"
              />
              <Stat
                label="Current gap"
                value={Math.max(0, baselineState.currentError - state.currentError).toFixed(2)}
                unit="m"
                hint="baseline minus fusion"
              />
            </div>
          )}

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
            <ConfidenceTimeline points={state.confidenceTrail} />
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              <Stat
                label="Learned stride correction"
                value={`${((state.learnedStrideScale - 1) * 100).toFixed(1)}%`}
                hint="particle-weighted hypothesis"
              />
              <Stat
                label="Learned heading correction"
                value={`${((state.learnedHeadingCorrectionRad * 180) / Math.PI).toFixed(1)}°`}
                hint="particle-weighted hypothesis"
              />
            </div>
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
          defaultOpen={!presentationMode}
          title="Positioning Fusion — what am I looking at?"
          whatThisIs="A shopper walking across two levels, with the app's position estimate running alongside the truth so you can see exactly where and why it goes wrong."
          concept={[
            'No indoor positioning method is trustworthy alone, and they fail in different situations — so the product layers them. The estimator is a particle filter: instead of one guessed position it holds a cloud of a few hundred guesses, each carrying its own hypothesis about how wrong the phone’s compass and step length are.',
            'Each of the four layers below is one operation on that cloud. Dead reckoning moves every particle by its own hypothesis, so the cloud spreads as fast as the sensors are untrustworthy. Map matching deletes particles that walked through a wall. Wi-Fi re-weights particles by how well each one’s expected fingerprint matches what was heard. A QR scan collapses the whole cloud onto a known point.',
            'The reason map matching is powerful rather than cosmetic: deleting particles that ended up somewhere impossible is deleting wrong hypotheses about the compass. So after a corner, only particles whose compass guess was roughly right survive — the filter learns the sensor error from the shape of the building, and corrects drift ALONG a corridor, not just across it.',
            'The blue halo is the spread of the surviving cloud. That is the app’s genuine self-assessed confidence: it is computed from the particles alone and never looks at the true position. Compare it against the "actual error" readout to see how honest the filter is being.',
          ]}
          legend={[
            {
              kind: 'dot',
              color: '#0f172a',
              label: 'True position',
              desc: 'black dot — where the shopper actually is. A real app never knows this; it is here so you can grade the estimate',
            },
            {
              kind: 'halo',
              color: '#2563eb',
              label: 'Estimated position (the blue dot)',
              desc: 'the centre of the densest particle cluster — what the app believes, without averaging separate corridors into a wall',
            },
            {
              kind: 'dot',
              color: '#93c5fd',
              label: 'Particle cloud',
              desc: `${PF_CONFIG.count} weighted hypotheses (a sample is drawn). Tight cloud = confident; spread out = uncertain`,
            },
            {
              kind: 'ring',
              color: '#2563eb',
              label: '1σ uncertainty circle',
              desc: 'the spread of the cloud — the app’s own confidence, derived without any access to ground truth',
            },
            {
              kind: 'thin-line',
              color: '#0f172a',
              label: 'Actual path walked',
              desc: 'solid dark trail — ground truth history',
            },
            {
              kind: 'dashed',
              color: '#2563eb',
              label: "Estimate's path",
              desc: 'dashed blue trail — where the app thought you were. Gaps between the trails are drift',
            },
            {
              kind: 'dashed',
              color: '#ea580c',
              label: 'Dead-reckoning-only baseline',
              desc: 'orange trail and crossed marker — a synchronized comparison using the same route and starting seed, but no Wi-Fi or map constraints',
            },
            {
              kind: 'square',
              color: '#f59e0b',
              color2: '#b45309',
              label: 'QR anchor',
              desc: `a printed code on a pillar. Its ring brightens and reads "scannable" within ${QR_RADIUS_M} m — but nothing happens until you press Scan, because scanning is the user's decision`,
            },
            {
              kind: 'line',
              color: '#cbd5e1',
              label: 'Planned route',
              desc: 'west entrance, escalator, then Metro Shoes on Level 2',
            },
            {
              kind: 'dot',
              color: '#7c3aed',
              label: 'Wi-Fi access points',
              desc: 'shown while the Wi-Fi layer is on — fixes come from the same predicted radio map as Tab 2',
            },
          ]}
          whyItMatters="A blue dot that drifts into a shop or sits on the wrong floor destroys trust in the whole app — so MallNav's real contribution is not any single positioning method, it is the layered estimator that keeps the dot believable when individual sensors fail."
          footnote={`Simulated sensor errors (the filter never sees these numbers, only the corrupted measurements): assumed stride ${STRIDE_M} m against a true step-length estimate ${((SENSOR_ERROR.strideScaleBias - 1) * 100).toFixed(0)}% long, compass error random-walking at ${SENSOR_ERROR.compassDriftPerStep} rad per √step. These are calibrated so UNAIDED dead reckoning accumulates 8–12% of distance travelled as error, which is mid-range for published phone-grade pedestrian dead reckoning (typically 5–15%). Wi-Fi scan interval defaults to 30 s because Android 9+ throttles a foreground app to 4 scans per 2 minutes — most demos assume one scan a second and thereby hide how far the phone must coast between corrections. All figures are simulated: no real RSSI, IMU or floor plan measurements are used anywhere in this project.`}
        />

        {/* ---- Layer toggles ---- */}
        <Panel
          title="Positioning layers"
          subtitle="Each one is a single operation on the particle cloud"
        >
          <div className="space-y-3.5">
            <Toggle
              checked={layers.qr}
              onChange={(v) => setLayers((l) => ({ ...l, qr: v }))}
              label="1 · QR anchors — collapse the cloud"
              accent="warn"
              hint={`One scan at the entrance starts the session; after that use the Scan button only if the dot looks wrong. A scan places you at the code's own coordinates, so residual error is how far you stand from it — at most ${QR_RADIUS_M} m. Weakness: it needs the user to stop and aim a camera, so it can never be the everyday mechanism.`}
            />
            <Toggle
              checked={layers.dr}
              onChange={(v) => setLayers((l) => ({ ...l, dr: v }))}
              label="2 · Dead reckoning — propagate"
              hint="Moves each particle by step count × its own stride hypothesis, along the compass heading plus its own error hypothesis. Weakness: error accumulates without bound, and a step counter cannot feel a floor change."
            />
            <Toggle
              checked={layers.wifi}
              onChange={(v) => setLayers((l) => ({ ...l, wifi: v }))}
              label="3 · Wi-Fi fingerprinting — re-weight"
              accent="ap"
              hint="Scores every particle against the predicted radio map and resamples. If no particle can explain the reading at all, the filter admits it is lost and re-localises from scratch — which is how it recovers the floor after the escalator."
            />
            <Toggle
              checked={layers.mapMatch}
              onChange={(v) => setLayers((l) => ({ ...l, mapMatch: v }))}
              label="4 · Map matching — delete the impossible"
              accent="good"
              hint="Deletes any particle that is inside a wall or crossed one to get there. Because a particle's position encodes its own error hypotheses, this implicitly deletes wrong compass guesses — so it fixes along-corridor drift too."
            />

            <details className="border-t border-line pt-3" open={!presentationMode}>
              <summary className="cursor-pointer text-xs font-semibold text-ink-soft">
                Advanced fallback · manual position
              </summary>
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
            </details>
          </div>
        </Panel>

        {/* ---- Realism controls ---- */}
        <Panel title="Wi-Fi scan interval" subtitle="A real platform constraint, not a tuning knob">
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {WIFI_SCAN_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setWifiIntervalS(p.seconds)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  p.seconds === wifiIntervalS
                    ? 'bg-brand text-white'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
            {WIFI_SCAN_PRESETS.find((p) => p.seconds === wifiIntervalS)?.note}. Since Android 9 a
            foreground app gets 4 scans per 2 minutes — about one every 30 s. At that rate the
            phone must coast{' '}
            <strong className="tnum text-ink">
              {(wifiIntervalS * 1.3).toFixed(0)} m
            </strong>{' '}
            on dead reckoning between corrections, which is why the other layers have to be good.
          </p>
        </Panel>

        {/* ---- View options ---- */}
        <Panel title="View">
          <div className="space-y-3">
            <Toggle
              checked={showParticles}
              onChange={setShowParticles}
              label="Show the particle cloud"
              hint="Draws a sample of the filter's individual hypotheses. Watch it stretch along a corridor as drift accumulates, then snap tight after a Wi-Fi scan."
            />
            <Toggle
              checked={autoFollow}
              onChange={setAutoFollow}
              label="Follow the shopper between levels"
              hint="Switches the displayed floor when the route changes level. Turn off to stay on one floor and watch the estimate get left behind."
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function storyForState(state, layers, wifiIntervalS) {
  if (state.finished) {
    return {
      title: 'Arrival proved — now compare the two trails',
      body: 'The blue estimate reached the destination. The orange baseline shows how much trust the constraints and periodic corrections bought over the same journey.',
      badge: 'ARRIVED',
      tone: 'good',
      className: 'border-green-200 bg-green-50 text-green-950',
    };
  }
  if (state.truth.riding) {
    return {
      title: 'The hardest moment: a floor change with no footsteps',
      body: `Dead reckoning cannot sense the escalator. The estimator must carry uncertainty honestly until ${layers.wifi ? `the next Wi-Fi scan (up to ${wifiIntervalS} s)` : 'a QR scan'} resolves the floor.`,
      badge: 'FLOOR TEST',
      tone: 'warn',
      className: 'border-violet-200 bg-violet-50 text-violet-950',
    };
  }
  if (state.relocalizeCount > 0 && state.t - state.lastWifiT < 3) {
    return {
      title: 'Recovery, not concealment',
      body: 'No surviving hypothesis explained the radio reading, so the filter admitted it was lost and rebuilt the cloud from the radio map.',
      badge: 'RE-LOCALISED',
      tone: 'good',
      className: 'border-green-200 bg-green-50 text-green-950',
    };
  }
  if (state.wrongFloor) {
    return {
      title: 'Visible failure: the blue dot is on the wrong level',
      body: 'This is deliberately exposed rather than hidden. Floor correctness and horizontal error are graded separately so a plausible x/y coordinate cannot mask the wrong floor.',
      badge: 'WRONG FLOOR',
      tone: 'bad',
      className: 'border-red-200 bg-red-50 text-red-950',
    };
  }
  if (state.scanCount > 0 && state.t - state.lastWifiT < 2.5) {
    return {
      title: 'Radio correction just tightened the hypothesis cloud',
      body: 'Wi-Fi did not draw a circle around an access point; it scored complete multi-AP fingerprints and re-weighted the particle cloud.',
      badge: 'WI-FI UPDATE',
      tone: 'good',
      className: 'border-blue-200 bg-blue-50 text-blue-950',
    };
  }
  return {
    title: state.t === 0 ? 'Start the synchronized walk' : 'Coasting between corrections',
    body:
      state.t === 0
        ? 'Press Start walk: blue is the layered estimator, orange is dead reckoning alone, and black is simulation truth.'
        : 'Step and compass measurements propagate both estimates. Map constraints continuously remove impossible blue hypotheses while orange drift remains unconstrained.',
    badge: state.t === 0 ? 'READY' : 'PREDICTION',
    tone: 'neutral',
    className: 'border-line bg-surface text-ink',
  };
}

function ConfidenceTimeline({ points = [] }) {
  const width = 420;
  const height = 104;
  const pad = { left: 28, right: 8, top: 10, bottom: 20 };
  const tMax = Math.max(1, points.at(-1)?.t ?? 1);
  const valueMax = Math.max(5, ...points.flatMap((p) => [p.spreadM, p.errorM]));
  const x = (t) => pad.left + (t / tMax) * (width - pad.left - pad.right);
  const y = (value) =>
    height - pad.bottom - (value / valueMax) * (height - pad.top - pad.bottom);
  const pathFor = (key) =>
    points.map((p, index) => `${index ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');

  return (
    <div className="rounded-lg border border-line bg-canvas/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-ink">Does confidence match reality?</div>
          <div className="text-[10px] text-ink-soft">Self-assessed spread vs simulation error</div>
        </div>
        <div className="flex gap-3 text-[10px] text-ink-soft">
          <span><i className="mr-1 inline-block h-0.5 w-3 bg-brand" />confidence</span>
          <span><i className="mr-1 inline-block h-0.5 w-3 bg-slate-900" />actual error</span>
          <span><i className="mr-1 inline-block h-2 w-2 bg-red-200" />wrong floor</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 block w-full" role="img" aria-label="Timeline comparing estimated uncertainty and actual positioning error">
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="#cbd5e1" />
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="#cbd5e1" />
        {points.filter((p) => !p.floorCorrect).map((p, index) => (
          <rect key={index} x={x(p.t) - 1} y={pad.top} width={2.5} height={height - pad.top - pad.bottom} fill="#fecaca" opacity={0.7} />
        ))}
        <path d={pathFor('spreadM')} fill="none" stroke="#2563eb" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        <path d={pathFor('errorM')} fill="none" stroke="#0f172a" strokeWidth="1.8" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <text x={2} y={pad.top + 4} fontSize="9" fill="#64748b">{valueMax.toFixed(0)}m</text>
        <text x={pad.left} y={height - 4} fontSize="9" fill="#64748b">0s</text>
        <text x={width - pad.right} y={height - 4} textAnchor="end" fontSize="9" fill="#64748b">{tMax.toFixed(0)}s</text>
      </svg>
      <p className="mt-1 text-[10px] leading-relaxed text-ink-soft">
        Blue is deployable confidence; black and red use hidden ground truth only to grade whether that confidence was honest.
      </p>
    </div>
  );
}

/** Draw a trail, split wherever it changes level. */
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
function LegendItem({ color, label, dashed = false, solid = false, faint = false }) {
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
          style={{ background: color, opacity: faint ? 0.4 : 1 }}
        />
      )}
      {label}
    </span>
  );
}
