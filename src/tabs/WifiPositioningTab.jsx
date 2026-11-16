import { useCallback, useMemo, useState } from 'react';
import {
  LEVELS,
  ALL_APS,
  getLevel,
  isWalkable,
  BUILDING,
  GROUND_LEVEL,
} from '../floorplan/floorplan.js';
import { countWallsCrossed, dist } from '../floorplan/geometry.js';
import {
  MAP_MODEL,
  KNN_K,
  DEFAULT_SPACING_M,
  SURVEY_MINUTES_PER_POINT,
  buildRadioMap,
  observeVector,
  predictRssi,
  knnFingerprint,
  trilaterate,
  evaluateBatch,
  buildingBounds,
  makeRng,
  rssiToDistance,
} from '../lib/wifi.js';
import { runApCalibration } from '../lib/apCalibration.js';
import { RSSI_BANDS, ERROR_BANDS, rssiColor, errorColor } from '../lib/signalColor.js';
import FloorPlanSvg from '../components/FloorPlanSvg.jsx';
import ExplainerPanel from '../components/ExplainerPanel.jsx';
import { Panel, Button, Stat, Select, Slider, Badge, EvidenceStrip } from '../components/ui.jsx';

/**
 * The AP shown by default: the first one on the ground floor. Not ALL_APS[0] —
 * levels are ordered bottom-up, so that would be a car-park AP seen through the
 * floor slab, which is a confusing first picture.
 */
const DEFAULT_AP = ALL_APS.find((ap) => ap.level === GROUND_LEVEL) ?? ALL_APS[0];

/**
 * TAB 2 — Wi-Fi Positioning
 *
 * The core of the project. Demonstrates three things:
 *
 *  1. The radio map (fingerprint database) can be PREDICTED from the floor plan
 *     in milliseconds instead of surveyed on foot over days.
 *  2. Fingerprinting beats trilateration indoors by roughly an order of
 *     magnitude, and the coverage heatmap shows exactly why: walls.
 *  3. When the real building disagrees with the assumed propagation model, the
 *     predicted map degrades — but stays usable. Shown honestly, with sliders.
 */

/** Heatmap cell size in metres. Finer looks smoother but costs render time. */
const HEATMAP_CELL_M = 0.8;

/** Number of random positions the batch comparison evaluates. */
const BATCH_TRIALS = 400;

/** The four experiments form one guided argument, while keeping the map readable. */
const VIEWS = [
  { id: 'coverage', label: 'Coverage heatmap', hint: 'why trilateration fails' },
  { id: 'live', label: 'Live positioning', hint: 'click to place yourself' },
  { id: 'errors', label: 'Error map', hint: 'where accuracy is weak' },
  { id: 'calibration', label: 'AP calibration', hint: 'locate unknown routers from 20 stops' },
];

const REALITY_PRESETS = [
  { id: 'ideal', label: 'Empty mall', values: { ...MAP_MODEL } },
  {
    id: 'busy',
    label: 'Busy Saturday',
    values: { ...MAP_MODEL, crowdOffsetDb: 5, noiseSigmaDb: 5 },
  },
  {
    id: 'phone',
    label: 'Different phone',
    values: { ...MAP_MODEL, apOffsetScaleDb: 3, noiseSigmaDb: 6 },
  },
  {
    id: 'breakdown',
    label: 'Model breakdown',
    values: {
      ...MAP_MODEL,
      n: 3.3,
      wallLossDb: 9,
      apOffsetScaleDb: 3,
      fadingAmplitudeDb: 5,
      crowdOffsetDb: 4,
      noiseSigmaDb: 5,
    },
  },
];

export default function WifiPositioningTab({ presentationMode = false }) {
  const [radioMap, setRadioMap] = useState(null);
  const [levelNo, setLevelNo] = useState(1);
  const [view, setView] = useState('coverage');
  const [selectedApId, setSelectedApId] = useState(DEFAULT_AP.id);
  const [truePoint, setTruePoint] = useState(null);
  const [batch, setBatch] = useState(null);
  const [batchMs, setBatchMs] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [calibrating, setCalibrating] = useState(false);

  /**
   * The "real world" propagation parameters. The radio map is always built with
   * MAP_MODEL; these sliders change only how the simulated phone readings are
   * generated. That separation is the entire point of the mismatch experiment.
   */
  const [reality, setReality] = useState({ ...MAP_MODEL });

  const level = getLevel(levelNo);
  const bounds = useMemo(() => buildingBounds(LEVELS), []);
  const mismatched = useMemo(
    () =>
      reality.n !== MAP_MODEL.n ||
      reality.wallLossDb !== MAP_MODEL.wallLossDb ||
      reality.crowdOffsetDb !== MAP_MODEL.crowdOffsetDb ||
      reality.noiseSigmaDb !== MAP_MODEL.noiseSigmaDb ||
      reality.apOffsetScaleDb !== MAP_MODEL.apOffsetScaleDb ||
      reality.fadingAmplitudeDb !== MAP_MODEL.fadingAmplitudeDb,
    [reality],
  );

  // ---- 1. Build the radio map --------------------------------------------
  const generateRadioMap = useCallback(() => {
    const rm = buildRadioMap(LEVELS, ALL_APS, DEFAULT_SPACING_M, MAP_MODEL);
    setRadioMap(rm);
    setBatch(null);
    setTruePoint(null);
    setCalibration(null);
  }, []);

  // ---- 2. Coverage heatmap ------------------------------------------------
  /**
   * Predicted signal strength from ONE access point, sampled across the whole
   * building — corridors and shop interiors alike, because the point of this
   * view is to see the signal fall off a cliff at every wall.
   *
   * This uses the MAP model, not the reality sliders: it is a picture of what we
   * predicted, which is what actually gets stored in the database.
   */
  const heatmap = useMemo(() => {
    if (!radioMap) return null;
    const ap = ALL_APS.find((a) => a.id === selectedApId);
    if (!ap) return null;

    const cells = [];
    const step = HEATMAP_CELL_M;
    for (let x = 1; x < BUILDING.widthM - 1; x += step) {
      for (let y = 1; y < BUILDING.heightM - 1; y += step) {
        const p = { x: x + step / 2, y: y + step / 2 };
        const rssi = predictRssi(p, levelNo, ap, radioMap.wallsByLevel, MAP_MODEL);
        cells.push({ x, y, rssi });
      }
    }
    return { ap, cells, step };
  }, [radioMap, selectedApId, levelNo]);

  // ---- 3. Live positioning ------------------------------------------------
  /**
   * Simulate a reading at the clicked point and locate it with both methods.
   *
   * The RNG is seeded from the clicked coordinates, so the same click always
   * produces the same noisy reading. Without that, simply moving a mismatch
   * slider would re-roll the noise and you could not tell whether the error
   * changed because of the model or because of luck.
   */
  const livePosition = useMemo(() => {
    if (!radioMap || !truePoint) return null;
    const seed = Math.round(truePoint.x * 1000) * 7919 + Math.round(truePoint.y * 1000) + levelNo;
    const rng = makeRng(seed);

    const obs = observeVector(truePoint, levelNo, ALL_APS, radioMap.wallsByLevel, reality, rng);
    const fp = knnFingerprint(obs, radioMap, KNN_K);
    const tri = trilaterate(obs, ALL_APS, radioMap.model, bounds);

    return {
      obs,
      fp,
      tri,
      fpError: fp ? dist(truePoint, fp) : null,
      fpLevelCorrect: fp ? fp.level === levelNo : false,
      triError: tri ? dist(truePoint, tri) : null,
    };
  }, [radioMap, truePoint, levelNo, reality, bounds]);

  const handleMapClick = useCallback(
    (p) => {
      if (!radioMap || view !== 'live') return;
      // Only corridor positions are meaningful: a shopper stands in the
      // concourse, and the radio map only has reference points there.
      if (!isWalkable(levelNo, p)) return;
      setTruePoint(p);
    },
    [radioMap, view, levelNo],
  );

  // ---- 4. Batch comparison ------------------------------------------------
  const runBatch = useCallback(() => {
    if (!radioMap) return;
    const t0 = performance.now();
    const result = evaluateBatch(radioMap, LEVELS, BATCH_TRIALS, reality);
    setBatchMs(performance.now() - t0);
    setBatch(result);
    setView('errors');
  }, [radioMap, reality]);

  const runCalibration = useCallback(() => {
    setCalibrating(true);
    setTimeout(() => {
      const result = runApCalibration(LEVELS, ALL_APS, MAP_MODEL);
      const estimatedMap = buildRadioMap(
        LEVELS,
        result.estimatedAps,
        DEFAULT_SPACING_M,
        result.fittedModel,
      );
      const idealBatch = evaluateBatch(radioMap, LEVELS, BATCH_TRIALS, MAP_MODEL, 2026, ALL_APS);
      const estimatedBatch = evaluateBatch(
        estimatedMap,
        LEVELS,
        BATCH_TRIALS,
        MAP_MODEL,
        2026,
        ALL_APS,
      );
      setCalibration({ ...result, estimatedMap, idealBatch, estimatedBatch });
      setCalibrating(false);
      setView('calibration');
    }, 30);
  }, [radioMap]);

  const selectedAp = ALL_APS.find((a) => a.id === selectedApId);
  const wallExample = useMemo(
    () => findWallFailureExample(level, selectedAp ?? DEFAULT_AP, radioMap?.wallsByLevel),
    [level, selectedAp, radioMap],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ================= MAP COLUMN ================= */}
      <div className="space-y-4">
        {/* ---- Headline: survey cost ---- */}
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                Radio map (fingerprint database)
              </div>
              {!radioMap ? (
                <p className="mt-1 text-sm text-ink-soft">
                  No radio map yet — press <strong>Generate radio map</strong> to predict the
                  Wi-Fi signature of every point in the mall from the floor plan.
                </p>
              ) : (
                <p className="tnum mt-1 text-2xl font-semibold leading-tight text-ink">
                  {radioMap.points.length} reference points in {radioMap.buildMs.toFixed(0)} ms
                  <span className="ml-2 block text-sm font-normal text-ink-soft sm:inline">
                    vs an estimated ~{(radioMap.surveyMinutes / 60).toFixed(1)} h manual site survey (
                    {SURVEY_MINUTES_PER_POINT} min per point, walked)
                  </span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {radioMap && (
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                    Estimated survey effort
                  </div>
                  <div className="tnum text-2xl font-semibold text-good">
                    {(radioMap.surveyMinutes / 60).toFixed(1)} h
                  </div>
                  <div className="text-[10px] text-ink-faint">
                    assumption: {SURVEY_MINUTES_PER_POINT} min per point
                  </div>
                </div>
              )}
              <Button onClick={generateRadioMap}>
                {radioMap ? 'Rebuild radio map' : 'Show the proof — generate radio map'}
              </Button>
            </div>
          </div>
        </div>

        <EvidenceStrip
          proves="Walls make RSSI-to-distance geometry fail; fingerprint pattern matching remains useful."
          value="A short calibration walk can estimate the radio model instead of measuring thousands of fingerprints."
          limitation="All readings are simulated; structural mismatch shows why the headline accuracy is an optimistic floor."
        />

        {/* ---- View switcher + level switcher ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap rounded-lg border border-line bg-surface p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                disabled={!radioMap}
                onClick={() => setView(v.id)}
                title={v.hint}
                className={`rounded-md px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:opacity-40 ${
                  v.id === view ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
            {LEVELS.map((l) => (
              <button
                key={l.level}
                type="button"
                onClick={() => setLevelNo(l.level)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  l.level === levelNo ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Contextual instruction for the active view ---- */}
        {radioMap && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">
            {view === 'coverage' && (
              <>
                Showing predicted signal from <strong className="text-ink">{selectedApId}</strong>
                {selectedAp.level !== levelNo && (
                  <>
                    {' '}
                    (which is on <strong className="text-ink">Level {selectedAp.level}</strong> —
                    you are seeing it bleed through the floor slab)
                  </>
                )}
                . Notice the sharp steps at every storefront: two points the same distance from
                the AP can differ by 30 dB. That is what breaks trilateration.
              </>
            )}
            {view === 'live' && (
              <>
                <strong className="text-ink">Click anywhere in a corridor</strong> to place your
                true position. The app simulates the noisy Wi-Fi reading at that spot, then locates
                you with both methods.
              </>
            )}
            {view === 'errors' && (
              <>
                {batch
                  ? `${batch.trials} random test positions, coloured by fingerprinting error. Red zones are where we place QR correction anchors.`
                  : 'Run the batch comparison to populate this map.'}
              </>
            )}
            {view === 'calibration' && (
              <>
                Twenty known stops replace a full fingerprint survey. Black rings are the real APs
                (shown only for grading); blue markers are recovered positions. Lines are estimation error.
              </>
            )}
          </div>
        )}

        {/* ---- The plan ---- */}
        <div className="rounded-xl border border-line bg-surface p-3">
          <FloorPlanSvg
            level={level}
            showAps={view !== 'calibration'}
            showShopLabels={view !== 'coverage'}
            showVerticalLinks={view !== 'coverage'}
            onPointClick={handleMapClick}
            cursor={radioMap && view === 'live' ? 'crosshair' : 'default'}
          >
            {/* --- Coverage heatmap (drawn first, under everything) --- */}
            {radioMap && view === 'coverage' && heatmap && (
              <g style={{ pointerEvents: 'none' }}>
                {heatmap.cells.map((c, i) => (
                  <rect
                    key={i}
                    x={c.x}
                    y={c.y}
                    width={heatmap.step}
                    height={heatmap.step}
                    fill={rssiColor(c.rssi)}
                    opacity={0.92}
                  />
                ))}
              </g>
            )}

            {/* --- Radio map reference points --- */}
            {radioMap && view !== 'coverage' && (
              <g style={{ pointerEvents: 'none' }}>
                {view !== 'calibration' && radioMap.points
                  .filter((p) => p.level === levelNo)
                  .map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={0.22} fill="#94a3b8" opacity={0.75} />
                  ))}
              </g>
            )}

            {view === 'calibration' && calibration && (
              <g style={{ pointerEvents: 'none' }}>
                {calibration.stops
                  .filter((stop) => stop.level === levelNo)
                  .map((stop, index) => (
                    <g key={stop.id}>
                      <circle cx={stop.x} cy={stop.y} r={0.65} fill="#f59e0b" stroke="#ffffff" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                      <text x={stop.x} y={stop.y - 1.2} textAnchor="middle" fontSize={0.8} fill="#92400e" fontWeight={700}>
                        {index + 1}
                      </text>
                    </g>
                  ))}
                {calibration.estimates
                  .filter((item) => item.truth.level === levelNo || item.estimated.level === levelNo)
                  .map((item) => (
                    <g key={item.id}>
                      {item.truth.level === levelNo && item.estimated.level === levelNo && (
                        <line
                          x1={item.truth.x}
                          y1={item.truth.y}
                          x2={item.estimated.x}
                          y2={item.estimated.y}
                          stroke="#2563eb"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {item.truth.level === levelNo && (
                        <circle cx={item.truth.x} cy={item.truth.y} r={1.15} fill="none" stroke="#0f172a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      )}
                      {item.estimated.level === levelNo && (
                        <g>
                          <path
                            d={`M ${item.estimated.x} ${item.estimated.y - 1.2} L ${item.estimated.x + 1.2} ${item.estimated.y} L ${item.estimated.x} ${item.estimated.y + 1.2} L ${item.estimated.x - 1.2} ${item.estimated.y} Z`}
                            fill="#2563eb"
                            stroke="#ffffff"
                            strokeWidth={1.2}
                            vectorEffect="non-scaling-stroke"
                          />
                          <text x={item.estimated.x} y={item.estimated.y - 1.7} textAnchor="middle" fontSize={0.85} fill="#1e3a8a" fontWeight={700}>
                            {item.id}
                          </text>
                        </g>
                      )}
                    </g>
                  ))}
              </g>
            )}

            {/* --- Error map --- */}
            {radioMap && view === 'errors' && batch && (
              <g style={{ pointerEvents: 'none' }}>
                {batch.results
                  .filter((r) => r.truth.level === levelNo && r.fpError !== null)
                  .map((r, i) => (
                    <circle
                      key={i}
                      cx={r.truth.x}
                      cy={r.truth.y}
                      r={0.75}
                      fill={errorColor(r.fpError)}
                      opacity={0.85}
                    />
                  ))}
              </g>
            )}

            {/* --- Live positioning overlay --- */}
            {radioMap && view === 'live' && truePoint && livePosition && (
              <g style={{ pointerEvents: 'none' }}>
                {/* The reference points kNN actually matched against. */}
                {livePosition.fp?.neighbours
                  .filter((nb) => nb.level === levelNo)
                  .map((nb, i) => (
                    <circle
                      key={i}
                      cx={nb.x}
                      cy={nb.y}
                      r={0.65}
                      fill="none"
                      stroke="#16a34a"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                      opacity={0.8}
                    />
                  ))}

                {/* Error lines from truth to each estimate. */}
                {livePosition.tri && (
                  <line
                    x1={truePoint.x}
                    y1={truePoint.y}
                    x2={livePosition.tri.x}
                    y2={livePosition.tri.y}
                    stroke="#dc2626"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {livePosition.fp && (
                  <line
                    x1={truePoint.x}
                    y1={truePoint.y}
                    x2={livePosition.fp.x}
                    y2={livePosition.fp.y}
                    stroke="#16a34a"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    vectorEffect="non-scaling-stroke"
                  />
                )}

                {/* Trilateration estimate — red cross. */}
                {livePosition.tri && (
                  <g>
                    <line
                      x1={livePosition.tri.x - 1.3}
                      y1={livePosition.tri.y - 1.3}
                      x2={livePosition.tri.x + 1.3}
                      y2={livePosition.tri.y + 1.3}
                      stroke="#dc2626"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={livePosition.tri.x + 1.3}
                      y1={livePosition.tri.y - 1.3}
                      x2={livePosition.tri.x - 1.3}
                      y2={livePosition.tri.y + 1.3}
                      stroke="#dc2626"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )}

                {/* Fingerprint estimate — green diamond. */}
                {livePosition.fp && (
                  <path
                    d={`M ${livePosition.fp.x} ${livePosition.fp.y - 1.4} L ${livePosition.fp.x + 1.4} ${livePosition.fp.y} L ${livePosition.fp.x} ${livePosition.fp.y + 1.4} L ${livePosition.fp.x - 1.4} ${livePosition.fp.y} Z`}
                    fill="#16a34a"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                )}

                {/* True position — black dot with halo, drawn last so it wins. */}
                <circle cx={truePoint.x} cy={truePoint.y} r={2.4} fill="#0f172a" opacity={0.12} />
                <circle
                  cx={truePoint.x}
                  cy={truePoint.y}
                  r={1}
                  fill="#0f172a"
                  stroke="#ffffff"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}
          </FloorPlanSvg>

          {/* ---- Map legend strip, specific to the active view ---- */}
          {radioMap && view === 'coverage' && <RssiLegend />}
          {radioMap && view === 'errors' && batch && <ErrorLegend />}
          {radioMap && view === 'calibration' && calibration && <CalibrationLegend />}
        </div>

        {/* ---- Batch results ---- */}
        {radioMap && (
          <Panel
            title={`Batch comparison — ${BATCH_TRIALS} random positions`}
            subtitle={
              batch
                ? `Completed in ${batchMs.toFixed(0)} ms across both levels${mismatched ? ' · using your modified reality settings' : ''}`
                : 'Evaluate both methods across the whole building'
            }
            actions={<Button onClick={runBatch}>Run {BATCH_TRIALS} random tests</Button>}
          >
            {batch ? (
              <ResultsTable batch={batch} />
            ) : (
              <p className="text-xs text-ink-soft">
                Places {BATCH_TRIALS} random points across the walkable area of both levels,
                simulates a Wi-Fi reading at each, and locates it with both methods. Results are
                reproducible — the random sequence is seeded.
              </p>
            )}
          </Panel>
        )}
      </div>

      {/* ================= SIDE COLUMN ================= */}
      <div className="space-y-4">
        <ExplainerPanel
          title="Wi-Fi Positioning — what am I looking at?"
          whatThisIs="Two ways of working out where a phone is from Wi-Fi signal strength alone, running side by side on the same simulated readings."
          concept={[
            'A radio map (or “fingerprint database”) is a lookup table of what the Wi-Fi looks like from every spot in the building: at this point AP3 reads −52 dBm, AP6 reads −78 dBm, and so on. That list of numbers is the location’s fingerprint.',
            'Trilateration is the intuitive method: convert each signal strength into a distance, draw a circle of that radius around each access point, and see where the circles meet. It works outdoors. Indoors it breaks, because every wall between you and an AP weakens the signal, and the method reads that weakening as extra distance. To correct for the walls you would need to know where you are — which is the thing you are trying to find.',
            'Fingerprinting sidesteps that entirely. It never converts signal to distance. It just asks: which stored fingerprint looks most like what I am hearing right now? The walls are already baked into both the stored patterns and the live reading, so there is no physics assumption left to get wrong.',
            'The second idea here is that the radio map does not have to be surveyed on foot. Because we know where the walls are, we can PREDICT what the Wi-Fi should look like everywhere — turning days of walking into milliseconds of compute.',
          ]}
          defaultOpen={!presentationMode}
          legend={[
            {
              kind: 'dot',
              color: '#7c3aed',
              label: 'Wi-Fi access point',
              desc: '7 per level, ceiling-mounted along the corridors — labelled AP1…AP14',
            },
            {
              kind: 'gradient',
              color: '#3b0764',
              color2: '#f0edff',
              label: 'Coverage heatmap',
              desc: 'predicted signal strength from the selected AP: dark = strong, pale = barely heard. The sharp steps are walls',
            },
            {
              kind: 'dot',
              color: '#94a3b8',
              label: 'Reference point',
              desc: `one entry in the radio map — a grid of them at ${DEFAULT_SPACING_M} m spacing across the walkable area`,
            },
            {
              kind: 'halo',
              color: '#0f172a',
              label: 'True position',
              desc: 'black dot — where you actually clicked, i.e. ground truth',
            },
            {
              kind: 'diamond',
              color: '#16a34a',
              label: 'Fingerprinting estimate',
              desc: 'green diamond — the weighted average of the best-matching reference points',
            },
            {
              kind: 'ring',
              color: '#16a34a',
              label: 'Matched reference points',
              desc: `green rings — the ${KNN_K} fingerprints nearest to the live reading, which get blended into the estimate`,
            },
            {
              kind: 'cross',
              color: '#dc2626',
              label: 'Trilateration estimate',
              desc: 'red cross — the least-squares solution from the distance circles',
            },
            {
              kind: 'dashed',
              color: '#64748b',
              label: 'Error line',
              desc: 'connects the true position to each estimate; its length is the error in metres',
            },
            {
              kind: 'gradient',
              color: '#15803d',
              color2: '#dc2626',
              label: 'Error map dots',
              desc: 'test positions coloured by fingerprinting error — green accurate, red poor',
            },
            {
              kind: 'ring',
              color: '#0f172a',
              label: 'True AP (simulation grading only)',
              desc: 'black ring in calibration view — hidden from the estimator and shown only so the recovered AP can be graded',
            },
            {
              kind: 'square',
              color: '#2563eb',
              label: 'Estimated AP',
              desc: 'blue diamond inferred from the short calibration walk; its line to the black ring is localisation error',
            },
            {
              kind: 'dot',
              color: '#f59e0b',
              label: 'Calibration stop',
              desc: 'numbered measured positions selected across both floors; several RSSI scans are averaged at each stop',
            },
          ]}
          whyItMatters="Positioning is the product: the experiment tests whether modelling a small set of venue parameters can reduce—not magically eliminate—the site calibration needed for a usable blue dot."
          footnote={`Propagation model: RSSI = P0 − 10·n·log₁₀(d) − walls×wall_loss − floors×floor_loss + noise, with P0 = ${MAP_MODEL.p0} dBm, n = ${MAP_MODEL.n}, wall_loss = ${MAP_MODEL.wallLossDb} dB, floor_loss = ${MAP_MODEL.floorLossDb} dB, noise σ = ${MAP_MODEL.noiseSigmaDb} dB, signal floor ${MAP_MODEL.floorDbm} dBm. "walls" is the number of wall segments the straight line from the point to the AP intersects. Ported from the tested Python simulation.`}
        />

        {/* ---- AP selector (coverage view) ---- */}
        {radioMap && view === 'coverage' && (
          <Panel title="Coverage heatmap" subtitle="Pick an access point to visualise">
            <Select label="Access point" value={selectedApId} onChange={setSelectedApId}>
              {LEVELS.map((l) => (
                <optgroup key={l.level} label={l.name}>
                  {l.aps.map((ap) => (
                    <option key={ap.id} value={ap.id}>
                      {ap.id} — at ({ap.x} m, {ap.y} m)
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <p className="mt-2 text-[11px] leading-snug text-ink-soft">
              Try selecting an AP on the other level: the signal still reaches, about{' '}
              {MAP_MODEL.floorLossDb} dB weaker through the floor slab. That difference is what
              lets fingerprinting tell the floors apart — and trilateration cannot, because it
              solves in 2D only.
            </p>
          </Panel>
        )}

        {/* ---- Live positioning readout ---- */}
        {radioMap && view === 'live' && (
          <Panel
            title="Live positioning"
            subtitle={truePoint ? 'Both methods, same reading' : 'Click a corridor on the map'}
          >
            {!truePoint || !livePosition ? (
              <p className="text-xs text-ink-soft">
                Click anywhere in a corridor. The app will simulate what the phone hears from all{' '}
                {ALL_APS.length} access points at that exact spot, then run both algorithms on
                that single reading.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="Fingerprinting error"
                    value={livePosition.fpError?.toFixed(2) ?? '—'}
                    unit="m"
                    tone="good"
                    hint={`weighted ${KNN_K}-NN match`}
                  />
                  <Stat
                    label="Trilateration error"
                    value={livePosition.triError?.toFixed(2) ?? 'no solution'}
                    unit={livePosition.triError ? 'm' : undefined}
                    tone="bad"
                    hint="least-squares circles"
                  />
                </div>

                {livePosition.fpError !== null && livePosition.triError !== null && (
                  <p className="rounded-lg bg-green-50 px-3 py-2 text-xs leading-relaxed text-green-900">
                    At this spot fingerprinting is{' '}
                    <strong className="tnum">
                      {(livePosition.triError / livePosition.fpError).toFixed(1)}×
                    </strong>{' '}
                    more accurate than trilateration — from exactly the same Wi-Fi reading.
                  </p>
                )}

                {wallExample && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-950">
                    <strong>Why the circles lie:</strong> this worked example is {wallExample.realDistanceM.toFixed(1)} m from{' '}
                    {wallExample.ap.id} through {wallExample.walls} walls. Its predicted {wallExample.rssiDbm.toFixed(1)} dBm signal is
                    inverted as {wallExample.inferredDistanceM.toFixed(0)} m — the wall loss is mistaken for distance.
                  </div>
                )}

                <div className="rounded-lg border border-line bg-canvas px-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                    Floor detection
                  </div>
                  <div className="mt-0.5 text-xs text-ink">
                    Fingerprinting says{' '}
                    <strong>Level {livePosition.fp?.level ?? '?'}</strong>{' '}
                    {livePosition.fpLevelCorrect ? (
                      <Badge tone="good">correct</Badge>
                    ) : (
                      <Badge tone="bad">wrong</Badge>
                    )}
                    . Trilateration cannot tell — it has no floor concept.
                  </div>
                </div>

                {/* The actual reading, so nothing is a black box. */}
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-ink-soft hover:text-ink">
                    Show the simulated Wi-Fi reading ({ALL_APS.length} access points)
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    {ALL_APS.map((ap, i) => {
                      const v = livePosition.obs[i];
                      const heard = v > MAP_MODEL.floorDbm;
                      return (
                        <div key={ap.id} className="flex items-baseline justify-between gap-2">
                          <span className="text-ink-soft">
                            {ap.id}
                            <span className="text-ink-faint"> L{ap.level}</span>
                          </span>
                          <span
                            className={`tnum font-medium ${heard ? 'text-ink' : 'text-ink-faint'}`}
                          >
                            {heard ? `${v.toFixed(1)} dBm` : 'not heard'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            )}
          </Panel>
        )}

        {radioMap && view === 'calibration' && (
          <Panel
            title="Short calibration walk"
            subtitle="Measure the model, not the whole map"
            actions={
              <Button onClick={runCalibration} disabled={calibrating}>
                {calibrating ? 'Estimating APs…' : calibration ? 'Run again' : 'Run 20-stop calibration'}
              </Button>
            }
          >
            {!calibration ? (
              <div className="space-y-3 text-xs leading-relaxed text-ink-soft">
                <p>
                  The simulated technician stops at ten known points per floor and hears every AP.
                  A coarse-to-fine nonlinear search estimates each AP, then least squares fits
                  <strong className="text-ink"> n</strong> and <strong className="text-ink">wall loss</strong>.
                </p>
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-950">
                  Best-case feasibility test: the same propagation model generates and fits the data.
                  Real multipath and hardware variation are tested separately below.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Mean AP error" value={calibration.meanErrorM.toFixed(2)} unit="m" tone="good" />
                  <Stat label="Correct AP floor" value={(calibration.floorAccuracy * 100).toFixed(0)} unit="%" tone="good" />
                  <Stat label="Fitted n" value={calibration.fittedModel.n.toFixed(2)} hint={`truth ${MAP_MODEL.n}`} />
                  <Stat label="Fitted wall loss" value={calibration.fittedModel.wallLossDb.toFixed(2)} unit="dB" hint={`truth ${MAP_MODEL.wallLossDb} dB`} />
                </div>
                <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs leading-relaxed text-ink-soft">
                  <strong className="text-ink">{calibration.measurementCount} measurements</strong> ({calibration.stops.length} stops × {ALL_APS.length} APs),
                  about {calibration.estimatedWalkMinutes.toFixed(0)} minutes of walking, replace roughly {radioMap.points.length * ALL_APS.length} individually surveyed signal values.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="Ideal AP map"
                    value={calibration.idealBatch.fingerprint.mean.toFixed(2)}
                    unit="m"
                    hint="true AP positions"
                  />
                  <Stat
                    label="Estimated AP map"
                    value={calibration.estimatedBatch.fingerprint.mean.toFixed(2)}
                    unit="m"
                    tone="brand"
                    hint="same 400 test points"
                  />
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold text-ink-soft">Per-AP errors</summary>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    {calibration.estimates.map((item) => (
                      <div key={item.id} className="flex justify-between gap-2">
                        <span>{item.id} · L{item.estimated.level}</span>
                        <span className="tnum font-semibold text-ink">{item.errorM.toFixed(2)} m</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </Panel>
        )}

        {/* ---- Model mismatch experiment ---- */}
        {radioMap && (
          <Panel
            title="Model mismatch — the honest limitation"
            subtitle="Change the real world; the radio map stays as predicted"
            actions={
              mismatched ? (
                <Button variant="secondary" onClick={() => setReality({ ...MAP_MODEL })}>
                  Reset
                </Button>
              ) : null
            }
          >
            <p className="mb-3 text-[11px] leading-relaxed text-ink-soft">
              The radio map was predicted assuming n&nbsp;=&nbsp;{MAP_MODEL.n} and{' '}
              {MAP_MODEL.wallLossDb}&nbsp;dB per wall. Real buildings differ — thicker walls, more
              clutter, a crowd of bodies absorbing signal. These sliders change the{' '}
              <strong className="text-ink">simulated reality only</strong>. The database is not
              rebuilt, so you are watching a predicted map cope with a building that does not match
              its assumptions.
            </p>
            <div className="mb-4">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                Defence challenge presets
              </div>
              <div className="flex flex-wrap gap-1.5">
                {REALITY_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setReality({ ...preset.values })}
                    className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <Slider
                label="Real path-loss exponent (n)"
                value={reality.n}
                min={2}
                max={4}
                step={0.1}
                onChange={(n) => setReality((r) => ({ ...r, n }))}
                hint={`Map assumes ${MAP_MODEL.n}. Higher = signal decays faster with distance.`}
              />
              <Slider
                label="Real wall loss"
                value={reality.wallLossDb}
                min={2}
                max={12}
                step={0.5}
                unit=" dB"
                onChange={(wallLossDb) => setReality((r) => ({ ...r, wallLossDb }))}
                hint={`Map assumes ${MAP_MODEL.wallLossDb} dB. Concrete and glass attenuate very differently.`}
              />
              <Slider
                label="Crowd absorption"
                value={reality.crowdOffsetDb}
                min={0}
                max={10}
                step={0.5}
                unit=" dB"
                onChange={(crowdOffsetDb) => setReality((r) => ({ ...r, crowdOffsetDb }))}
                hint="Uniform extra loss — a busy Saturday afternoon versus an empty Tuesday morning."
              />
              <Slider
                label="Measurement noise (σ)"
                value={reality.noiseSigmaDb}
                min={0}
                max={8}
                step={0.5}
                unit=" dB"
                onChange={(noiseSigmaDb) => setReality((r) => ({ ...r, noiseSigmaDb }))}
                hint={`Map assumes ${MAP_MODEL.noiseSigmaDb} dB. Cheaper phone radios are noisier.`}
              />
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-amber-800">
                  Model-class mismatch · effects the formula cannot fit
                </div>
                <div className="mt-2 space-y-3">
                  <Slider
                    label="Per-AP hardware offset"
                    value={reality.apOffsetScaleDb}
                    min={0}
                    max={5}
                    step={0.5}
                    unit=" dB"
                    onChange={(apOffsetScaleDb) => setReality((r) => ({ ...r, apOffsetScaleDb }))}
                    hint="Each router has a stable transmit-power/antenna bias that the shared model does not know."
                  />
                  <Slider
                    label="Spatially correlated fading"
                    value={reality.fadingAmplitudeDb}
                    min={0}
                    max={8}
                    step={0.5}
                    unit=" dB"
                    onChange={(fadingAmplitudeDb) => setReality((r) => ({ ...r, fadingAmplitudeDb }))}
                    hint="A smooth, repeatable multipath field varies by location and cannot be represented by distance plus wall count."
                  />
                </div>
              </div>
            </div>
            {mismatched && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                Reality now differs from the map&rsquo;s assumptions. Re-run the batch comparison to
                see the effect on accuracy — and note that fingerprinting degrades gradually rather
                than failing outright.
              </p>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Results table plus a bar chart comparing the two methods. */
function ResultsTable({ batch }) {
  const rows = [
    ['Mean error', 'mean', 'm'],
    ['Median error', 'median', 'm'],
    ['90th percentile', 'p90', 'm'],
    ['Worst case', 'max', 'm'],
  ];
  const fp = batch.fingerprint;
  const tri = batch.trilateration;
  // Scale the bars to the largest value on show, so the comparison is honest.
  const scale = Math.max(fp.p90, tri.p90, fp.max, tri.max, 1);

  return (
    <div className="space-y-4">
      {/* Headline comparison */}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Fingerprinting — mean"
          value={fp.mean.toFixed(2)}
          unit="m"
          tone="good"
          hint={`${(fp.within3 * 100).toFixed(0)}% within 3 m`}
        />
        <Stat
          label="Trilateration — mean"
          value={tri.mean.toFixed(1)}
          unit="m"
          tone="bad"
          hint={`${(tri.within3 * 100).toFixed(0)}% within 3 m`}
        />
      </div>

      <p className="rounded-lg bg-green-50 px-3 py-2 text-xs leading-relaxed text-green-900">
        Across {batch.trials} random positions, fingerprinting is{' '}
        <strong className="tnum">{(tri.mean / fp.mean).toFixed(1)}×</strong> more accurate on
        average — from identical Wi-Fi readings. It also identified the correct floor{' '}
        <strong className="tnum">{(batch.floorAccuracy * 100).toFixed(1)}%</strong> of the time,
        which trilateration cannot do at all.
      </p>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-1.5 pr-2 font-semibold text-ink">Metric</th>
              <th className="py-1.5 pr-2 text-right font-semibold text-good">Fingerprinting</th>
              <th className="py-1.5 text-right font-semibold text-bad">Trilateration</th>
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map(([label, key, unit]) => (
              <tr key={key} className="border-b border-line/60">
                <td className="py-1.5 pr-2 text-ink-soft">{label}</td>
                <td className="py-1.5 pr-2 text-right font-medium text-ink">
                  {fp[key].toFixed(2)} {unit}
                </td>
                <td className="py-1.5 text-right font-medium text-ink">
                  {tri[key].toFixed(2)} {unit}
                </td>
              </tr>
            ))}
            <tr className="border-b border-line/60">
              <td className="py-1.5 pr-2 text-ink-soft">Within 3 m</td>
              <td className="py-1.5 pr-2 text-right font-medium text-ink">
                {(fp.within3 * 100).toFixed(1)}%
              </td>
              <td className="py-1.5 text-right font-medium text-ink">
                {(tri.within3 * 100).toFixed(1)}%
              </td>
            </tr>
            <tr className="border-b border-line/60">
              <td className="py-1.5 pr-2 text-ink-soft">Within 5 m</td>
              <td className="py-1.5 pr-2 text-right font-medium text-ink">
                {(fp.within5 * 100).toFixed(1)}%
              </td>
              <td className="py-1.5 text-right font-medium text-ink">
                {(tri.within5 * 100).toFixed(1)}%
              </td>
            </tr>
            <tr>
              <td className="py-1.5 pr-2 text-ink-soft">No solution produced</td>
              <td className="py-1.5 pr-2 text-right font-medium text-ink">{fp.failures}</td>
              <td className="py-1.5 text-right font-medium text-ink">
                {tri.failures}
                {tri.failures > 0 && (
                  <span className="ml-1 font-normal text-ink-faint">
                    ({((tri.failures / batch.trials) * 100).toFixed(1)}%)
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {tri.failures > 0 && (
        <p className="text-[11px] leading-snug text-ink-faint">
          Trilateration produced no answer at all in {tri.failures} of {batch.trials} tests: the
          access points sit in straight lines along the corridors, so the circle geometry is
          sometimes degenerate and the least-squares system has no unique solution. Those tests are
          excluded from its averages above — which flatters it slightly.
        </p>
      )}

      {/* Bar chart */}
      <div>
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
          Error comparison (metres, lower is better)
        </div>
        <div className="space-y-2">
          {[
            ['Mean', fp.mean, tri.mean],
            ['Median', fp.median, tri.median],
            ['90th pct', fp.p90, tri.p90],
          ].map(([label, a, b]) => (
            <div key={label} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
              <span className="text-[11px] text-ink-soft">{label}</span>
              <div className="space-y-1">
                <Bar value={a} scale={scale} color="#16a34a" />
                <Bar value={b} scale={scale} color="#dc2626" />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-good" /> Fingerprinting
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-bad" /> Trilateration
          </span>
        </div>
      </div>
    </div>
  );
}

/** One horizontal bar with its value labelled at the end. */
function Bar({ value, scale, color }) {
  const pct = Math.max(1, (value / scale) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-canvas">
        <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="tnum w-12 shrink-0 text-right text-[11px] font-medium text-ink-soft">
        {value.toFixed(1)} m
      </span>
    </div>
  );
}

/** Legend for the coverage heatmap, labelled in dBm. */
function RssiLegend() {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
        Predicted signal strength (dBm)
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {RSSI_BANDS.map((b) => (
          <span key={b.label} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-line"
              style={{ background: b.color }}
            />
            <span className="tnum">{b.label}</span>
            <span className="text-ink-faint">{b.note}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Legend for the error map, labelled in metres. */
function ErrorLegend() {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
        Fingerprinting error (metres)
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {ERROR_BANDS.map((b) => (
          <span key={b.label} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: b.color }}
            />
            <span className="tnum">{b.label}</span>
            <span className="text-ink-faint">{b.note}</span>
          </span>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-faint">
        Red zones are where we place QR correction anchors — a printed code on a pillar that
        resets the position to exact truth when scanned. See the Positioning Fusion tab.
      </p>
    </div>
  );
}

function CalibrationLegend() {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-[11px] text-ink-soft">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-ink" /> True AP (grading only)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rotate-45 bg-brand" /> Estimated AP
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full bg-warn" /> Known calibration stop
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 bg-brand" /> Position error
      </span>
    </div>
  );
}

function findWallFailureExample(level, ap, wallsByLevel) {
  if (!level || !ap || !wallsByLevel) return null;
  let best = null;
  for (const rect of level.corridors) {
    for (let x = rect.x + 0.5; x < rect.x + rect.w; x += 1) {
      for (let y = rect.y + 0.5; y < rect.y + rect.h; y += 1) {
        const point = { x, y };
        const walls = countWallsCrossed(point, ap, level.walls);
        if (walls < 2) continue;
        const realDistanceM = dist(point, ap);
        const rssiDbm = predictRssi(point, level.level, ap, wallsByLevel, MAP_MODEL);
        const inferredDistanceM = rssiToDistance(rssiDbm, MAP_MODEL);
        const ratio = inferredDistanceM / Math.max(realDistanceM, 1);
        if (!best || ratio > best.ratio) {
          best = { point, ap, walls, realDistanceM, rssiDbm, inferredDistanceM, ratio };
        }
      }
    }
  }
  return best;
}
