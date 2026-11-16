import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEVELS,
  ALL_APS,
  CONNECTORS,
  FLOOR_HEIGHT_M,
  getLevel,
} from '../floorplan/floorplan.js';
import { buildRadioMap, DEFAULT_SPACING_M, MAP_MODEL } from '../lib/wifi.js';
import {
  WALK_ROUTES,
  BAROMETER,
  FLOOR_DETECTOR,
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
 * walks a presenter-chosen route between floors; position is estimated by a
 * particle filter whose five operations correspond exactly to the five
 * togglable layers.
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

/**
 * Every layer key, so preset matching cannot silently ignore a new layer.
 * `baroGate` (barometer-gated steps) is a sub-switch of `baro` and only acts
 * while the barometer is on, so it is compared only then (see layersMatch).
 */
const LAYER_KEYS = ['dr', 'qr', 'wifi', 'mapMatch', 'baro'];

/** Whether two layer mixes behave identically. */
function layersMatch(a, b) {
  if (!LAYER_KEYS.every((k) => !!a[k] === !!b[k])) return false;
  // The engine treats a missing baroGate as on.
  return !a.baro || (a.baroGate !== false) === (b.baroGate !== false);
}

/**
 * The orange comparison: dead reckoning alone, exactly the "Dead reckoning
 * alone" preset below.
 *
 * The barometer is deliberately EXCLUDED. The baseline answers one question —
 * what do the raw step counter and compass give you on their own — and the
 * barometer is a correcting layer, like Wi-Fi and map matching. Including it
 * would make the orange dot partly fused, and the gap between the two dots would
 * no longer measure what the correcting layers buy. (It also keeps the baseline
 * honest about floors: with nothing but a step counter it never leaves the start
 * floor, which is precisely the failure the barometer exists to fix.)
 */
const BASELINE_LAYERS = { dr: true, qr: true, wifi: false, mapMatch: false, baro: false, baroGate: true };

/**
 * Preset layer combinations, for a fast A/B during a live demo.
 *
 * Every preset leaves QR available. Since a scan only happens when the user
 * presses the button, having anchors switched on costs the comparison nothing —
 * and it keeps the recovery story demonstrable in the presets built to show the
 * system failing. Every preset spells out all five layers and the barometer's
 * step gate, so applying one can never inherit a stale value from whatever was
 * on before. The gate is on in every preset: with the barometer off it does
 * nothing, and it should be back on the moment the barometer is.
 */
const PRESETS = [
  {
    id: 'all',
    label: 'All layers on',
    layers: { dr: true, qr: true, wifi: true, mapMatch: true, baro: true, baroGate: true },
    hint: 'the product: one start scan, then the phone does the rest',
  },
  {
    id: 'nobaro',
    label: 'No barometer',
    layers: { dr: true, qr: true, wifi: true, mapMatch: true, baro: false, baroGate: true },
    hint: 'a phone without a pressure sensor: a floor change waits for the next usable Wi-Fi scan, and on stairs every step drags the dot along the corridor',
  },
  {
    id: 'nomap',
    label: 'No map matching',
    layers: { dr: true, qr: true, wifi: true, mapMatch: false, baro: true, baroGate: true },
    hint: 'what the floor plan was contributing',
  },
  {
    id: 'nowifi',
    label: 'No Wi-Fi',
    layers: { dr: true, qr: true, wifi: false, mapMatch: true, baro: true, baroGate: true },
    hint: 'drift with no radio correction — only the barometer can recover the floor',
  },
  {
    id: 'dr',
    label: 'Dead reckoning alone',
    layers: BASELINE_LAYERS,
    hint: 'raw sensors: drifts through walls and never leaves the start floor',
  },
];

/**
 * Every walking scenario the engine offers. Iterated generically so a route
 * added to WALK_ROUTES appears in the selector with no change here.
 */
const ROUTES = Object.values(WALK_ROUTES);

/**
 * Seconds between samples on the barometer height trace. Chosen, not derived:
 * fine enough that a 10 s lift climb is ~40 points, coarse enough that a long
 * walk stays a few hundred points at any playback speed.
 */
const TRACE_SAMPLE_S = 0.25;

/** The floor a route starts on. */
function startLevelOf(plan) {
  return plan.route.waypoints[0].level;
}

/**
 * The floor the APP knows it started on: the floor of the QR code it was
 * actually bootstrapped from, or null when the walk began without a scan.
 *
 * Read from the scans the state records, never from the route: the route's
 * bootstrap anchor is where the simulated shopper really starts, so using it
 * when no scan happened would hand the app the true start floor.
 */
function appStartLevelOf(state) {
  const id = state.scannedAnchorIds?.[0];
  const anchor = id ? QR_ANCHORS.find((a) => a.id === id) : null;
  return anchor ? anchor.level : null;
}

/**
 * A fresh main-simulation state, plus the component's own barometer bookkeeping.
 *
 * `routeId` lets a timer tick that was already queued when the route changed
 * recognise the state is for a different plan and leave it alone.
 *
 * `heightBaseM` is what the barometer's relative height is added to: the start
 * scan's floor elevation, or 0 when there was no scan, in which case the trace
 * is height change since the walk began (pressure alone cannot say which floor
 * that was). `trueHeightBaseM` puts the simulation-only true-height overlay on
 * the same basis; it is never used to compute the app's own height.
 */
function initMainState(plan, layers, ctx) {
  const s = initFusionState(plan, 7, layers, ctx);
  const appStartLevel = appStartLevelOf(s);
  const heightBaseM = appStartLevel === null ? 0 : getLevel(appStartLevel).elevationM;
  const trueHeightBaseM = appStartLevel === null ? s.truth.elevationM : 0;
  return {
    ...s,
    routeId: plan.route.id,
    appStartLevel,
    heightBaseM,
    trueHeightBaseM,
    baroFloorsSum: 0,
    heightTrail: [{ t: 0, h: heightBaseM, trueH: s.truth.elevationM - trueHeightBaseM }],
  };
}

function initBaselineState(plan, ctx) {
  return { ...initFusionState(plan, 7, BASELINE_LAYERS, ctx), routeId: plan.route.id };
}

/**
 * Append one sample of the APP's measured height to the trace.
 *
 * The height is built only from what the phone knows: the start floor (from the
 * QR scan, or 0 m "where the walk began" without one — see initMainState), plus
 * every floor change the detector has confirmed, plus the detector's current
 * relative height. The detector re-anchors to zero on each
 * confirmation, which is why the confirmed floors must be summed back in.
 *
 * Confirmations are counted from the detector itself rather than from
 * `floorChanges`, which is only written while the barometer LAYER is on — so the
 * trace stays right if the presenter toggles the layer mid-walk.
 *
 * `trueH` rides along for the faint "true height (simulation only)" overlay; it
 * is never used to compute `h`.
 */
function withHeightSample(prev, next) {
  const confirmed = next.baro?.confirmed ?? null;
  const baroFloorsSum = (prev.baroFloorsSum ?? 0) + (confirmed ? confirmed.floors : 0);
  const trail = prev.heightTrail ?? [];
  const last = trail.at(-1);
  const keep = !last || confirmed || next.finished || next.t - last.t >= TRACE_SAMPLE_S;
  const h =
    (prev.heightBaseM ?? 0) + baroFloorsSum * FLOOR_HEIGHT_M + (next.baro?.relativeHeightM ?? 0);
  const trueH = next.truth.elevationM - (prev.trueHeightBaseM ?? 0);
  return {
    ...next,
    routeId: prev.routeId,
    baroFloorsSum,
    heightTrail: keep ? [...trail, { t: next.t, h, trueH }] : trail,
  };
}

/** Correction-log badge for each event type. */
const EVENT_BADGES = {
  qr: { text: 'QR', className: 'bg-amber-100 text-amber-800' },
  manual: { text: 'MANUAL', className: 'bg-slate-200 text-slate-700' },
  wifi: { text: 'WI-FI', className: 'bg-blue-100 text-blue-800' },
  baro: { text: 'BARO', className: 'bg-indigo-100 text-indigo-800' },
};

/** Barometer colour: the `node` token (indigo), unused elsewhere on this tab. */
const BARO_COLOR = '#6366f1';
/** Faint slate for the simulation-only true-height overlay. */
const TRUE_HEIGHT_COLOR = '#94a3b8';

/** "up 2 floors" / "down 1 floor". */
function describeFloors(floors) {
  const n = Math.abs(floors);
  return `${floors > 0 ? 'up' : 'down'} ${n} floor${n === 1 ? '' : 's'}`;
}

function connectorLabel(id) {
  return CONNECTORS.find((c) => c.id === id)?.label ?? null;
}

export default function FusionTab({ presentationMode = false }) {
  const [layers, setLayers] = useState(PRESETS[0].layers);
  const [routeId, setRouteId] = useState(ROUTES[0].id);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
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
  // Every route's plan, built once: cheap, and it means switching route never
  // has to wait on a render to find out what the new plan is.
  const plans = useMemo(() => new Map(ROUTES.map((r) => [r.id, buildWalkPlan(r)])), []);
  const plan = plans.get(routeId) ?? plans.get(ROUTES[0].id);
  const ctx = useMemo(() => buildFusionContext(radioMap, ALL_APS, LEVELS), [radioMap]);

  const [manualLevel, setManualLevel] = useState(() => startLevelOf(plan));
  const [state, setState] = useState(() => initMainState(plan, PRESETS[0].layers, ctx));
  const [baselineState, setBaselineState] = useState(() => initBaselineState(plan, ctx));

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
      // A tick queued just before a route change must not step the new route's
      // state with the old route's plan.
      const ours = (prev) => !prev.finished && prev.routeId === plan.route.id;
      if (compareBaseline) {
        setBaselineState((prev) =>
          ours(prev)
            ? {
                ...stepFusion(
                  prev,
                  (TICK_MS / 1000) * speed,
                  plan,
                  BASELINE_LAYERS,
                  ctx,
                  intervalRef.current,
                ),
                routeId: prev.routeId,
              }
            : prev,
        );
      }
      setState((prev) => {
        if (!ours(prev)) return prev;
        const next = stepFusion(
          prev,
          (TICK_MS / 1000) * speed,
          plan,
          layersRef.current,
          ctx,
          intervalRef.current,
        );
        if (next.finished) setRunning(false);
        return withHeightSample(prev, next);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, speed, plan, ctx, compareBaseline]);

  /** Restart both simulations on a plan, with the view back on its start floor. */
  const restart = useCallback(
    (nextPlan, nextLayers) => {
      setRunning(false);
      setManualMode(false);
      setState(initMainState(nextPlan, nextLayers, ctx));
      setBaselineState(initBaselineState(nextPlan, ctx));
      setManualLevel(startLevelOf(nextPlan));
    },
    [ctx],
  );

  const reset = useCallback(() => restart(plan, layersRef.current), [restart, plan]);

  const applyPreset = useCallback(
    (preset) => {
      setLayers(preset.layers);
      layersRef.current = preset.layers;
      restart(plan, preset.layers);
    },
    [restart, plan],
  );

  /**
   * Switch scenario. Both simulations restart from the new route's start, the
   * walk stops, and the floor on screen returns to where the route begins —
   * when following the shopper that happens by itself (the view follows the
   * new state); when pinned to a floor, the pin moves to the start floor.
   */
  const changeRoute = useCallback(
    (id) => {
      const nextPlan = plans.get(id);
      if (!nextPlan || id === routeId) return;
      setRouteId(id);
      restart(nextPlan, layersRef.current);
    },
    [plans, routeId, restart],
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
  // The barometer can still move the cloud between floors on its own, so the
  // "nothing is positioning you" warning needs it off too.
  const allOff = noLayersActive(layers) && !layers.baro;
  const destination = plan.route.waypoints.at(-1);
  // The ride under way right now, if any — for the narration only (it reads the
  // simulated truth, like the rest of the story text).
  const rideLeg = state.truth.riding
    ? (plan.legs.find((l) => l.isRide && state.t >= l.tStart && state.t <= l.tEnd) ?? null)
    : null;
  const rideConnector = rideLeg ? (connectorLabel(rideLeg.connectorId) ?? 'connector') : null;
  // Confidence comes from the filter's OWN spread, not from the true error.
  const confidence = confidenceLabel(state.spreadM, state.floorConfidence);
  const meanError = state.errorCount ? state.errorSum / state.errorCount : 0;
  const baselineMeanError = baselineState.errorCount
    ? baselineState.errorSum / baselineState.errorCount
    : 0;
  const progress = plan.totalSeconds ? state.t / plan.totalSeconds : 0;
  const story = storyForState(state, layers, wifiIntervalS, rideLeg, rideConnector);

  const activePreset = PRESETS.find((p) => layersMatch(p.layers, layers));
  // Mirrors the engine's own test (stepFusion): the gate needs the barometer.
  const gateActive = !!layers.baro && layers.baroGate !== false;
  // The QR code this route's session starts from, for the QR layer's hint.
  const startAnchorLabel =
    QR_ANCHORS.find((a) => a.id === plan.route.bootstrapAnchorId)?.label ?? 'start';

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

        {/* ---- Route selector: which journey the shopper makes ---- */}
        <section className="rounded-xl border border-line bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Walking route — choosing one restarts both simulations from its start
            </div>
            <div className="tnum text-[11px] text-ink-soft">
              {plan.totalMetres.toFixed(0)} m walked · {plan.totalSeconds.toFixed(0)} s ·{' '}
              {plan.floorChanges} ride{plan.floorChanges === 1 ? '' : 's'} between floors
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Walking route">
            {ROUTES.map((r) => {
              const rp = plans.get(r.id);
              const active = r.id === plan.route.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => changeRoute(r.id)}
                  title={active ? 'This route is loaded' : `Restart the walk on "${r.label}"`}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-brand/40 bg-blue-50 text-blue-950'
                      : 'border-line bg-surface text-ink hover:bg-canvas'
                  }`}
                >
                  <div className="text-sm font-semibold">{r.label}</div>
                  <div className="text-[11px] text-ink-soft">{r.summary}</div>
                  <div className="tnum mt-0.5 text-[10px] font-medium text-ink-faint">
                    {getLevel(startLevelOf(rp)).shortName} →{' '}
                    {getLevel(rp.route.waypoints.at(-1).level).shortName} ·{' '}
                    {rp.totalSeconds.toFixed(0)} s
                  </div>
                </button>
              );
            })}
          </div>
        </section>

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

        {rideLeg && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-violet-950">
            <div className="flex items-center gap-3">
              {/* Destination drawn on top, so "up" reads upward. */}
              <div className="flex shrink-0 flex-col items-center text-[10px] font-bold">
                {(() => {
                  const up = rideLeg.toElevationM > rideLeg.fromElevationM;
                  const from = (
                    <span className="rounded bg-white px-2 py-1">
                      {getLevel(rideLeg.from.level).shortName}
                    </span>
                  );
                  const to = (
                    <span className="rounded bg-violet-700 px-2 py-1 text-white">
                      {getLevel(rideLeg.to.level).shortName}
                    </span>
                  );
                  return (
                    <>
                      {up ? to : from}
                      <span className="py-0.5">{up ? '↑' : '↓'}</span>
                      {up ? from : to}
                    </>
                  );
                })()}
              </div>
              <p className="text-xs leading-relaxed">
                <strong>
                  Floor transition — {rideConnector}, {getLevel(rideLeg.from.level).name} to{' '}
                  {getLevel(rideLeg.to.level).name}:
                </strong>{' '}
                {rideNarration(rideLeg, layers)}
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
                {Math.round(state.stepCount)} steps counted
                {(state.gatedStepCount ?? 0) >= 0.5 &&
                  ` (${Math.round(state.gatedStepCount)} held back as stair steps)`}{' '}
                · {state.scanCount} Wi-Fi scans
              </span>
              <span>
                {rideLeg
                  ? rideLeg.connectorType === 'stairs'
                    ? gateActive
                      ? 'On the stairs — steps counted, but held back while the barometer shows the height changing'
                      : 'On the stairs — every stair step moved as if walking'
                    : `On the ${rideConnector.toLowerCase()} — no steps to count`
                  : state.finished
                    ? `Arrived at ${destination.note}`
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
                title={`Restart the walk with this layer mix — ${p.hint}`}
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
                title={`Show ${l.name} (stops following the shopper between floors)`}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  l.level === levelNo ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>
        {/* The hint is the point of the preset, so it is shown, not hidden in a tooltip. */}
        <p className="-mt-2 text-[11px] text-ink-soft">
          {activePreset
            ? `${activePreset.label}: ${activePreset.hint}. Presets restart the walk.`
            : 'Custom layer mix — layer toggles take effect on the next tick without restarting.'}
        </p>

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
            step counter cannot tell a floor change — it feels nothing on an escalator or a lift
            and mistakes stair steps for strides — so only{' '}
            {layers.baro ? 'the barometer (once the height settles), ' : ''}a Wi-Fi scan or a QR
            scan resolves this.
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
              {plan.route.waypoints.slice(0, -1).map((wp, i) => {
                const next = plan.route.waypoints[i + 1];
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
            <LegendItem color="#cbd5e1" label={`Planned route: ${plan.route.label}`} solid />
            <LegendItem
              color="#2563eb"
              fill="#dbeafe"
              box
              label="Lift (blue = step-free) — the cloud may change floor only at a connector"
            />
            <LegendItem
              color="#64748b"
              fill="#e2e8f0"
              box
              label="Esc ↑ / Esc ↓ (one-way escalators), Stairs"
            />
            <span className="text-ink-soft">Dashed circle = 1σ self-assessed uncertainty</span>
          </div>
        </div>

        {/* ---- Barometer evidence ---- */}
        <BarometerPanel state={state} plan={plan} enabled={!!layers.baro} wifiOn={!!layers.wifi} />

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
                    ? 'just the start scan'
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
                {state.events.map((e, i) => {
                  const badge = EVENT_BADGES[e.type] ?? EVENT_BADGES.wifi;
                  return (
                    <li key={i} className="flex items-baseline gap-2 text-[11px]">
                      <span className="tnum shrink-0 text-ink-faint">{e.t.toFixed(1)} s</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
                      >
                        {badge.text}
                      </span>
                      <span className="text-ink-soft">{e.text}</span>
                    </li>
                  );
                })}
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
          whatThisIs="A simulated shopper walking a route you choose between floors, with the app's position estimate running alongside the truth so you can see exactly where and why it goes wrong."
          concept={[
            'No indoor positioning method is trustworthy alone, and they fail in different situations — so the product layers them. The estimator is a particle filter: instead of one guessed position it holds a cloud of a few hundred guesses, each carrying its own hypothesis about how wrong the phone’s compass and step length are.',
            'Each of the five layers below is one operation on that cloud. Dead reckoning moves every particle by its own hypothesis, so the cloud spreads as fast as the sensors are untrustworthy. Map matching deletes particles that walked through a wall. Wi-Fi re-weights particles by how well each one’s expected fingerprint matches what was heard. A QR scan collapses the whole cloud onto a known point. The barometer moves particles between floors, and holds back stair steps so they are not walked along the corridor.',
            `Floors are the step counter's blind spot: an escalator or lift lifts you ${FLOOR_HEIGHT_M} m with no footsteps, and on stairs it is worse than blind — the phone counts every stair step as a ${STRIDE_M} m stride along whichever way it points, exactly like a step on the flat. The phone's barometer feels every one of these — pressure falls about ${Math.abs(BAROMETER.hpaPerMetre * FLOOR_HEIGHT_M).toFixed(2)} hPa per storey — but only as a CHANGE, because the weather moves absolute pressure by far more. When the height has moved by most of a storey and then stopped, the app accepts a floor change and applies it by vertical map matching: a particle may only change floor through a connector within its reach that serves both floors and runs that way (escalators are one-way). Every other particle is deleted, so the floor change is also a free position fix — the cloud lands on the connector that must have been used. The same reading also tells dead reckoning when a step went up rather than along: steps taken while the height is changing on foot are not moved horizontally, so on the stairs the dot waits instead of being dragged along the corridor.`,
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
              kind: 'glyph',
              glyph: '⇄',
              color: '#1d4ed8',
              color2: '#dbeafe',
              label: 'Route selector',
              desc: 'the journey being simulated — which floors, and which escalator, lift or stairs it rides. Choosing one restarts both the blue and orange simulations from its start',
            },
            {
              kind: 'line',
              color: '#cbd5e1',
              label: 'Planned route',
              desc: `the chosen route's walking legs on the floor shown (now: ${plan.route.summary}). A ride has no horizontal length, so it shows as the line ending at the connector`,
            },
            {
              kind: 'line',
              color: BARO_COLOR,
              label: 'Barometer height trace',
              desc: 'the app’s own height: the floor of the start QR scan, plus every confirmed floor change, plus the current change in pressure-height. With no start scan it is drawn as change from wherever the walk began, because pressure alone cannot say which floor that was. Computed without the true elevation',
            },
            {
              kind: 'dashed',
              color: TRUE_HEIGHT_COLOR,
              label: 'True height (simulation only)',
              desc: 'where the shopper really is vertically, drawn faintly so you can judge the trace. A real app never has it',
            },
            {
              kind: 'diamond',
              color: BARO_COLOR,
              label: 'Floor-change marker',
              desc: 'a tick on the height trace where the app confirmed a floor change, with ↑/↓ and the number of floors',
            },
            {
              kind: 'glyph',
              glyph: 'B',
              color: '#3730a3',
              color2: '#e0e7ff',
              label: 'BARO badge',
              desc: 'a correction-log entry made by the barometer layer — a floor change and the connector it was matched to',
            },
            {
              kind: 'dot',
              color: '#7c3aed',
              label: 'Wi-Fi access points',
              desc: 'shown while the Wi-Fi layer is on — fixes come from the same predicted radio map as Tab 2',
            },
            // The connector markers are drawn by the shared floor plan. They
            // matter here because they are the ONLY places vertical map matching
            // lets a particle change floor.
            {
              kind: 'glyph',
              glyph: '⊞',
              color: '#1d4ed8',
              color2: '#dbeafe',
              label: 'Lift (step-free)',
              desc: 'blue box = step-free; serves P · L1 · L2. One of the places where vertical map matching may move particles between floors',
            },
            {
              kind: 'glyph',
              glyph: '↑',
              color: '#334155',
              label: 'Up-escalator ("Esc ↑")',
              desc: 'grey box; one-way, L1 to L2 only. The arrow is its direction of travel between floors, not a compass direction — so a particle may use it to go up, never down',
            },
            {
              kind: 'glyph',
              glyph: '↓',
              color: '#334155',
              label: 'Down-escalator ("Esc ↓")',
              desc: 'its one-way partner beside it, L2 to L1 only',
            },
            {
              kind: 'glyph',
              glyph: '⌃',
              color: '#334155',
              label: 'Stairs',
              desc: 'grey box; two-way and serves P · L1 · L2. The one connector climbed on foot, so the step counter keeps counting on it',
            },
          ]}
          whyItMatters="A blue dot that drifts into a shop or sits on the wrong floor destroys trust in the whole app — so MallNav's real contribution is not any single positioning method, it is the layered estimator that keeps the dot believable when individual sensors fail."
          footnote={`Simulated sensor errors (the filter never sees these numbers, only the corrupted measurements): assumed stride ${STRIDE_M} m against a true step-length estimate ${((SENSOR_ERROR.strideScaleBias - 1) * 100).toFixed(0)}% long, compass error random-walking at ${SENSOR_ERROR.compassDriftPerStep} rad per √step. These are calibrated so UNAIDED dead reckoning accumulates 8–12% of distance travelled as error when walking on the flat, which is mid-range for published phone-grade pedestrian dead reckoning (typically 5–15%). Stair steps are outside that calibration: the phone counts each one as a full stride, so with nothing to hold them back, a route that takes the stairs drifts by a larger share of its distance. Wi-Fi scan interval defaults to 30 s because Android 9+ throttles a foreground app to 4 scans per 2 minutes — most demos assume one scan a second and thereby hide how far the phone must coast between corrections. Barometer: ${Math.abs(BAROMETER.hpaPerMetre)} hPa per metre, ${BAROMETER.noiseHpa} hPa noise per 0.1 s sample and weather drift random-walking at ${BAROMETER.driftHpaPerSqrtS} hPa per √s (typical phone MEMS figures, chosen, not measured); a floor change is confirmed once the height has moved ${(FLOOR_DETECTOR.confirmFraction * 100).toFixed(0)}% of a storey and held still for ${FLOOR_DETECTOR.settleHoldS} s, with "still" judged over a ${FLOOR_DETECTOR.rateWindowS} s window (${FLOOR_DETECTOR.stairsRateWindowS} s on stairs, whose slow climb would otherwise look still mid-flight). All figures are simulated: no real RSSI, IMU or floor plan measurements are used anywhere in this project.`}
        />

        {/* ---- Layer toggles ---- */}
        <Panel
          title="Positioning layers"
          subtitle="Each one is a single operation on the particle cloud"
        >
          <div className="space-y-3.5">
            <Toggle
              checked={!!layers.qr}
              onChange={(v) => setLayers((l) => ({ ...l, qr: v }))}
              label="1 · QR anchors — collapse the cloud"
              accent="warn"
              hint={`One scan of the "${startAnchorLabel}" code, where the chosen route begins, starts the session; after that use the Scan button only if the dot looks wrong. A scan places you at the code's own coordinates, so residual error is how far you stand from it — at most ${QR_RADIUS_M} m. Weakness: it needs the user to stop and aim a camera, so it can never be the everyday mechanism.`}
            />
            <Toggle
              checked={layers.dr}
              onChange={(v) => setLayers((l) => ({ ...l, dr: v }))}
              label="2 · Dead reckoning — propagate"
              hint="Moves each particle by step count × its own stride hypothesis, along the compass heading plus its own error hypothesis. Weakness: error accumulates without bound, and a step counter cannot tell a floor change — it feels nothing on a lift or escalator and counts stair steps as strides."
            />
            <Toggle
              checked={layers.wifi}
              onChange={(v) => setLayers((l) => ({ ...l, wifi: v }))}
              label="3 · Wi-Fi fingerprinting — re-weight"
              accent="ap"
              hint="Scores every particle against the predicted radio map and resamples. If no particle can explain the reading at all, the filter admits it is lost and re-localises from scratch — which, without a barometer, is how it recovers the floor after a ride. A scan that lands mid-ride is between floors and wasted."
            />
            <Toggle
              checked={layers.mapMatch}
              onChange={(v) => setLayers((l) => ({ ...l, mapMatch: v }))}
              label="4 · Map matching — delete the impossible"
              accent="good"
              hint="Deletes any particle that is inside a wall or crossed one to get there. Because a particle's position encodes its own error hypotheses, this implicitly deletes wrong compass guesses — so it fixes along-corridor drift too."
            />
            <Toggle
              checked={!!layers.baro}
              onChange={(v) => setLayers((l) => ({ ...l, baro: v }))}
              label="5 · Barometer — detect floor changes"
              accent="node"
              hint={`Watches the change in air pressure (about ${Math.abs(BAROMETER.hpaPerMetre * FLOOR_HEIGHT_M).toFixed(2)} hPa per ${FLOOR_HEIGHT_M} m storey). When the height has moved most of a storey and stopped, only particles near a connector that could make that trip move floors — the rest are deleted. It also tells dead reckoning when a step went up rather than along: steps taken while the height is changing on foot are not moved horizontally (a phone counts each stair step as a ${STRIDE_M} m stride). Weaknesses: it needs a barometer, which many budget phones lack; absolute pressure drifts with the weather, so only relative change is usable; and it says a floor changed, not where.`}
            />
            {/* A sub-switch, so the step gate can be shown apart from floor
                detection: on the stairs route, turning it off leaves the floor
                change working but lets the stair steps drag the dot. */}
            <div className="pl-6">
              <Toggle
                checked={layers.baroGate !== false}
                disabled={!layers.baro}
                onChange={(v) => setLayers((l) => ({ ...l, baroGate: v }))}
                label="5b · Barometer-gated steps — hold back stair steps"
                accent="node"
                hint={
                  layers.baro
                    ? `Steps counted while the barometer shows the height changing on foot are treated as stair steps: they do not move the particles (they still age each particle's compass guess). Turn off on the stairs route to watch each stair step, counted as a ${STRIDE_M} m stride, drag the dot along the corridor while floor detection carries on as before.`
                    : 'Needs the barometer: without it the app cannot tell a stair step from a stride, so every step moves the dot.'
                }
              />
            </div>

            <details className="border-t border-line pt-3" open={!presentationMode}>
              <summary className="cursor-pointer text-xs font-semibold text-ink-soft">
                Advanced fallback · manual position
              </summary>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">6 · Manual selection</div>
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

/**
 * What happens to the phone's sensors during the ride under way, for the ride
 * banner. Stairs differ from lifts and escalators in two ways that the engine
 * models and the copy must not hide: the step counter keeps counting (each
 * stair step as a full stride), and the barometer needs a longer stillness
 * check before it confirms the floor.
 */
function rideNarration(rideLeg, layers) {
  const stairs = rideLeg.connectorType === 'stairs';
  const up = rideLeg.toElevationM > rideLeg.fromElevationM;
  const gateOn = !!layers.baro && layers.baroGate !== false;
  const sensing = stairs
    ? `the step counter counts every stair step as a full ${STRIDE_M} m stride along the stairs' compass heading, though you are not moving along the corridor.`
    : 'the step counter feels nothing at all.';
  let steps = '';
  if (stairs) {
    if (!layers.dr) steps = ' Dead reckoning is off, so those strides move nothing.';
    else if (gateOn)
      steps = ` The barometer shows you ${up ? 'climbing' : 'descending'} on foot, so those steps are held back from dead reckoning and the dot waits at the stairs.`;
    else if (layers.baro)
      steps = ' Barometer-gated steps are switched off, so those strides are applied and the dot is dragged along the corridor.';
    else
      steps = ` With no barometer to say they went ${up ? 'up' : 'down'}, those strides are applied and the dot is dragged along the corridor.`;
  }
  const floor = layers.baro
    ? stairs
      ? ` The app switches floor a few seconds after the stairs end — longer than after a lift or escalator, because a slow climb is only judged to have stopped over a ${FLOOR_DETECTOR.stairsRateWindowS} s window rather than ${FLOOR_DETECTOR.rateWindowS} s.`
      : ` The barometer sees the height change; the app switches floor a few seconds after the ride ends, once the height has read still over a ${FLOOR_DETECTOR.rateWindowS} s window and then for ${FLOOR_DETECTOR.settleHoldS} s more.`
    : ` With no barometer, the estimate cannot discover ${getLevel(rideLeg.to.level).name} until a Wi-Fi scan or a QR anchor changes the floor hypothesis.`;
  return sensing + steps + floor;
}

function storyForState(state, layers, wifiIntervalS, rideLeg, rideConnector) {
  if (state.finished) {
    return {
      title: 'Arrival proved — now compare the two trails',
      body: 'The blue estimate reached the destination. The orange baseline shows how much trust the constraints and periodic corrections bought over the same journey.',
      badge: 'ARRIVED',
      tone: 'good',
      className: 'border-green-200 bg-green-50 text-green-950',
    };
  }
  if (rideLeg) {
    const resolver = layers.baro
      ? 'the barometer sees the height settle on the new floor'
      : layers.wifi
        ? `the next usable Wi-Fi scan (up to ${wifiIntervalS} s after the ride)`
        : 'a QR scan';
    const fromTo = `from ${getLevel(rideLeg.from.level).shortName} to ${getLevel(rideLeg.to.level).shortName}`;
    if (rideLeg.connectorType === 'stairs') {
      const gateOn = !!layers.baro && layers.baroGate !== false;
      return {
        title: 'A floor change the step counter gets wrong',
        body: `Every stair step ${fromTo} reaches the step counter as a ${STRIDE_M} m stride. ${
          gateOn
            ? 'With the barometer on, steps taken while the height is changing are held back, so the dot waits at the stairs'
            : 'With nothing to hold them back, those strides drag the dot along the corridor'
        }, and the floor stays unconfirmed until ${resolver}.`,
        badge: 'FLOOR TEST',
        tone: 'warn',
        className: 'border-violet-200 bg-violet-50 text-violet-950',
      };
    }
    return {
      title: 'The hardest moment: a floor change with no footsteps',
      body: `Dead reckoning cannot sense the ${rideConnector.toLowerCase()} carrying the shopper ${fromTo}. The estimator must carry uncertainty honestly until ${resolver}.`,
      badge: 'FLOOR TEST',
      tone: 'warn',
      className: 'border-violet-200 bg-violet-50 text-violet-950',
    };
  }
  const lastChange = state.floorChanges?.at(-1);
  if (lastChange && state.t - lastChange.t < 3) {
    const via = connectorLabel(lastChange.connectorId);
    return {
      title: 'The barometer changed the floor — and fixed the position',
      body: `Pressure said ${describeFloors(lastChange.floors)}, looking like ${lastChange.type}. Only hypotheses within reach of a connector that serves both floors and runs that way were kept, so the cloud now starts from ${via ? `the ${via.toLowerCase()}` : 'the connectors that could have done it'}.`,
      badge: 'FLOOR CHANGE',
      tone: 'good',
      className: 'border-indigo-200 bg-indigo-50 text-indigo-950',
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

/** "+1.23" / "−0.40": a sign makes up and down readable at a glance. */
function signed(v, digits = 2) {
  const r = Number(v.toFixed(digits));
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}`;
}

/**
 * The barometer's evidence: what the app measures (top), and how quickly the
 * app caught up with reality (the evaluation box, which uses ground truth and
 * says so).
 */
function BarometerPanel({ state, plan, enabled, wifiOn }) {
  const relM = state.baro?.relativeHeightM ?? 0;
  const rateMps = state.baro?.rateMps ?? 0;
  // Null when the walk began without a scan: then the app has no absolute floor
  // and pressure can only report the change.
  const startLevel =
    state.appStartLevel === null || state.appStartLevel === undefined
      ? null
      : getLevel(state.appStartLevel);
  const confirmedFloors = state.baroFloorsSum ?? 0;
  const floorsSince = `${signed(confirmedFloors, 0)} floor${Math.abs(confirmedFloors) === 1 ? '' : 's'}`;
  // App-side: the floor the pressure history implies, from the start floor the
  // QR scan reported plus every confirmed change. No ground truth involved.
  const pressureLevel = startLevel
    ? LEVELS.find((l) => l.ordinal === startLevel.ordinal + confirmedFloors)
    : null;
  const changes = state.floorChanges ?? [];
  const latencies = state.floorChangeLatencies ?? [];
  const wasted = state.wastedScanCount ?? 0;
  const pendingS =
    state.pendingFloorChangeT !== null && state.pendingFloorChangeT !== undefined
      ? state.t - state.pendingFloorChangeT
      : null;
  const moving = Math.abs(rateMps) >= FLOOR_DETECTOR.settledRateMps;

  return (
    <Panel
      title="Barometer — floor-change evidence"
      subtitle={
        enabled
          ? 'What the phone’s pressure sensor tells the app — relative change only, never absolute pressure'
          : 'Layer off — as on a phone with no pressure sensor'
      }
    >
      {enabled ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat
              label="Height change"
              value={signed(relM)}
              unit="m"
              tone="brand"
              hint="since the floor it last settled on"
            />
            <Stat
              label="Vertical speed"
              value={signed(rateMps)}
              unit="m/s"
              hint={moving ? 'climbing or descending' : 'level — not changing height'}
            />
            <Stat
              label="Floor by pressure"
              value={pressureLevel?.shortName ?? '—'}
              hint={
                startLevel
                  ? `${startLevel.shortName} at the start scan, ${floorsSince} since`
                  : `no start scan: the barometer only knows the change, ${floorsSince} since the walk began`
              }
            />
          </div>

          <HeightTrace
            trail={state.heightTrail}
            changes={changes}
            totalSeconds={plan.totalSeconds}
            relative={!startLevel}
          />

          <div className="mt-3">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Confirmed floor changes
            </div>
            {changes.length === 0 ? (
              <p className="text-[11px] text-ink-soft">
                None yet. A change is confirmed once the height has moved{' '}
                {(FLOOR_DETECTOR.confirmFraction * 100).toFixed(0)}% of a {FLOOR_HEIGHT_M} m storey
                and held still for {FLOOR_DETECTOR.settleHoldS} s.
              </p>
            ) : (
              <ul className="space-y-1">
                {changes.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                    <span className="tnum shrink-0 text-ink-faint">{c.t.toFixed(1)} s</span>
                    <span className="font-semibold text-indigo-800">
                      {c.floors > 0 ? '↑' : '↓'} {describeFloors(c.floors)}
                    </span>
                    <span className="text-ink-soft">
                      classified as {c.type} · matched to{' '}
                      {connectorLabel(c.connectorId)?.toLowerCase() ?? 'every connector that could do it'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-ink-soft">
          The filter is ignoring the pressure sensor, so a floor change is only noticed when a Wi-Fi
          scan stops matching the old floor and the cloud re-localises — or when the user scans a QR
          code. Compare the latency below with the barometer on.
        </p>
      )}

      {/* Graded against the true floor: allowed only because it is labelled. */}
      <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-canvas/60 p-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
          Evaluation — simulation only (uses the true floor)
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Stat
            label="Floor-change latency"
            value={latencies.length ? latencies.map((l) => l.toFixed(1)).join(' · ') : '—'}
            unit={latencies.length ? 's' : undefined}
            hint={`arriving on a new floor → the blue dot agreeing. ${latencies.length} of ${plan.floorChanges} ride${plan.floorChanges === 1 ? '' : 's'} caught so far`}
          />
          <Stat
            label="Wi-Fi scans wasted mid-ride"
            value={wasted}
            unit={wasted === 1 ? 'scan' : 'scans'}
            tone={wasted ? 'bad' : 'default'}
            hint={
              wifiOn
                ? `of ${state.scanCount + wasted} so far. A scan that lands during a ride is taken between floors, matches neither, and is thrown away`
                : 'Wi-Fi layer is off'
            }
          />
        </div>
        {pendingS !== null && (
          <p className="mt-2 text-[11px] font-medium text-amber-700">
            Arrived on {getLevel(state.truth.level).name}{' '}
            <span className="tnum">{pendingS.toFixed(1)} s</span> ago — the app has not agreed yet.
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * The app's measured height over the walk, with confirmed floor changes marked.
 * Its own small chart frame (seconds across, metres up), separate from the map.
 *
 * `relative`: the walk began without a QR scan, so the app knows only height
 * CHANGE. The gridlines are then storeys above and below wherever it started,
 * as far as the building could possibly reach, rather than named floors.
 */
function HeightTrace({ trail = [], changes = [], totalSeconds, relative = false }) {
  const width = 420;
  const height = 150;
  const pad = { left: 56, right: 10, top: 16, bottom: 26 };
  const span = LEVELS.length - 1;
  const gridRows = relative
    ? Array.from({ length: 2 * span + 1 }, (_, i) => {
        const h = (i - span) * FLOOR_HEIGHT_M;
        return { key: i, h, label: `${signed(h, 1)} m` };
      })
    : LEVELS.map((l) => ({
        key: l.level,
        h: l.elevationM,
        label: `${l.shortName} ${signed(l.elevationM, 1)} m`,
      }));
  const gridHeights = gridRows.map((r) => r.h);
  // 1.5 m of headroom so a lift overshoot or noise stays on the chart.
  const yMin = Math.min(...gridHeights) - 1.5;
  const yMax = Math.max(...gridHeights) + 1.5;
  const tMax = Math.max(1, totalSeconds, trail.at(-1)?.t ?? 0);
  const x = (t) => pad.left + (t / tMax) * (width - pad.left - pad.right);
  const y = (h) =>
    pad.top +
    ((yMax - Math.min(yMax, Math.max(yMin, h))) / (yMax - yMin)) * (height - pad.top - pad.bottom);
  const pathFor = (key) =>
    trail.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const heightAt = (t) => (trail.find((p) => p.t >= t - 1e-6) ?? trail.at(-1))?.h ?? 0;
  const zeroLevel = LEVELS.find((l) => l.elevationM === 0);

  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-ink">Height measured by the app</div>
          <div className="text-[10px] text-ink-soft">
            {relative
              ? `Change in height in metres since the walk began, against time in seconds. No start scan, so the app does not know which floor that was: gridlines are ${FLOOR_HEIGHT_M} m storeys above and below the start. Confirmed floor changes + current pressure-height change`
              : `Height in metres (0 = ${zeroLevel?.shortName ?? 'ground'} floor) against time in seconds: start floor + confirmed floor changes + current pressure-height change`}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-[10px] text-ink-soft">
          <span>
            <i className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: BARO_COLOR }} />
            {relative ? 'app height change' : 'app height'}
          </span>
          <span>
            <i
              className="mr-1 inline-block w-3 border-t-2 border-dashed align-middle"
              style={{ borderColor: TRUE_HEIGHT_COLOR }}
            />
            {relative ? 'true height change (simulation only)' : 'true height (simulation only)'}
          </span>
          <span>
            <span className="mr-1 font-bold" style={{ color: BARO_COLOR }}>
              ◆
            </span>
            floor change confirmed
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 block w-full"
        role="img"
        aria-label="Chart of the height the app measured from air pressure over the walk, in metres against seconds"
      >
        {/* One gridline per floor (or per storey of change), so the trace reads
            as "which floor" / "how many floors". */}
        {gridRows.map((r) => (
          <g key={r.key}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(r.h)}
              y2={y(r.h)}
              stroke="#e2e8f0"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <text x={pad.left - 4} y={y(r.h) + 3} textAnchor="end" fontSize="9" fill="#64748b">
              {r.label}
            </text>
          </g>
        ))}
        <line
          x1={pad.left}
          y1={height - pad.bottom}
          x2={width - pad.right}
          y2={height - pad.bottom}
          stroke="#cbd5e1"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={height - pad.bottom}
          stroke="#cbd5e1"
          vectorEffect="non-scaling-stroke"
        />

        {changes.map((c, i) => (
          <g key={i}>
            <line
              x1={x(c.t)}
              x2={x(c.t)}
              y1={pad.top}
              y2={height - pad.bottom}
              stroke={BARO_COLOR}
              strokeDasharray="2 2"
              opacity={0.5}
              vectorEffect="non-scaling-stroke"
            />
            <text x={x(c.t)} y={pad.top - 4} textAnchor="middle" fontSize="9" fontWeight="700" fill={BARO_COLOR}>
              {c.floors > 0 ? '↑' : '↓'}
              {Math.abs(c.floors)}
            </text>
          </g>
        ))}

        <path
          d={pathFor('trueH')}
          fill="none"
          stroke={TRUE_HEIGHT_COLOR}
          strokeWidth="1.5"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={pathFor('h')}
          fill="none"
          stroke={BARO_COLOR}
          strokeWidth="2.2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {changes.map((c, i) => {
          const cx = x(c.t);
          const cy = y(heightAt(c.t));
          return (
            <path
              key={i}
              d={`M ${cx} ${cy - 4} L ${cx + 4} ${cy} L ${cx} ${cy + 4} L ${cx - 4} ${cy} Z`}
              fill={BARO_COLOR}
              stroke="#ffffff"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <text x={pad.left} y={height - 8} fontSize="9" fill="#64748b">
          0 s
        </text>
        <text x={(pad.left + width - pad.right) / 2} y={height - 8} textAnchor="middle" fontSize="9" fill="#64748b">
          time (s)
        </text>
        <text x={width - pad.right} y={height - 8} textAnchor="end" fontSize="9" fill="#64748b">
          {tMax.toFixed(0)} s
        </text>
      </svg>
      <p className="mt-1 text-[10px] leading-relaxed text-ink-soft">
        Only pressure <em>changes</em> are used: the reference re-anchors on every floor the detector
        settles on, which cancels weather drift. The grey dashed line is ground truth, shown only to
        judge the indigo one.
      </p>
    </div>
  );
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

/** One entry in the map legend strip. `box` draws a connector-style marker. */
function LegendItem({ color, label, dashed = false, solid = false, faint = false, box = false, fill }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-soft">
      {box ? (
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm border"
          style={{ background: fill, borderColor: color }}
        />
      ) : dashed || solid ? (
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
