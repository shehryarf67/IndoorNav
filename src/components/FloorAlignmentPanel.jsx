import { useMemo, useState } from 'react';
import { getLevel } from '../floorplan/floorplan.js';
import {
  applySimilarity,
  fitRobust,
  simulateClicks,
  wallsAsDrawn,
  alignmentErrorM,
  SUPPLIED_DRAWINGS,
  CLICK_NOISE_M,
} from '../lib/alignment.js';
import { Panel, Button, Toggle, Stat, Badge } from './ui.jsx';

/**
 * Phase 4 — floor-plan alignment, as a self-contained panel in Tab 1.
 *
 * Shows one floor's drawing laid over the reference floor (Level 1) exactly as
 * supplied — offset, rotated, at another scale — and then after the
 * least-squares fit from matched anchors. Everything the fit uses comes from
 * the "clicked" anchors; the whole-plan error readout uses the true drawing
 * transform and is labelled simulation-only.
 *
 * Coordinates: the reference floor is in metres. A drawing "as supplied" is in
 * its own units, plotted naively as if they were metres — which is precisely
 * the mistake alignment exists to fix, and why it lands in the wrong place.
 */

const FLOORS = [
  { level: 0, label: 'Level P — Parking' },
  { level: 2, label: 'Level 2 — Food & Cinema' },
];

const REF = '#94a3b8'; // reference floor
const DRAWN = '#2563eb'; // floor being aligned
const BAD = '#dc2626'; // rejected anchor

export default function FloorAlignmentPanel() {
  const [level, setLevel] = useState(0);
  const [aligned, setAligned] = useState(false);
  const [misclick, setMisclick] = useState(false);

  const result = useMemo(() => {
    const pairs = simulateClicks(level, { seed: 1, misclick });
    const fit = fitRobust(pairs);
    const rejectedIds = new Set(fit.rejected.map((r) => r.id));
    const residualById = new Map(fit.kept.map((k) => [k.id, k.residualM]));
    return {
      pairs,
      fit,
      rejectedIds,
      residualById,
      drawnWalls: wallsAsDrawn(level, getLevel(level).walls),
      error: alignmentErrorM(level, getLevel(level).walls, fit.transform),
    };
  }, [level, misclick]);

  const { pairs, fit, rejectedIds, residualById, drawnWalls, error } = result;
  /** Where a drawing point is plotted: as supplied, or through the fitted transform. */
  const place = (p) => (aligned ? applySimilarity(fit.transform, p) : p);

  // The supplied drawing can extend well outside the building, so the view
  // box is fitted to everything on screen (still in metres-as-plotted).
  const viewBox = useMemo(() => {
    const xs = [0, 60];
    const ys = [0, 40];
    for (const w of drawnWalls) {
      for (const p of [
        place({ x: w.x1, y: w.y1 }),
        place({ x: w.x2, y: w.y2 }),
      ]) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    const pad = 3;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    return `${x0} ${y0} ${Math.max(...xs) + pad - x0} ${Math.max(...ys) + pad - y0}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnWalls, aligned, fit]);

  const supplied = SUPPLIED_DRAWINGS[level];
  const rotationDeg = (-fit.transform.theta * 180) / Math.PI;
  const offsetM = Math.hypot(fit.transform.tx, fit.transform.ty);

  return (
    <Panel
      title="Floor-plan alignment"
      subtitle="Stacking separately drawn floors into one frame"
      actions={
        <Button onClick={() => setAligned((a) => !a)}>
          {aligned ? 'Show as supplied' : 'Align to Level 1'}
        </Button>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        A real mall supplies one drawing per floor, each with its own origin, scale and
        a few degrees of rotation. Routing, the barometer&rsquo;s floor changes and Wi-Fi
        bleed between floors all assume the floors are stacked exactly. Anchors that run
        through every floor — the lift shaft, the stair core, structural columns, the
        building corners — are matched across floors, and a least-squares fit finds the
        shift, rotation and scale. Anchors beyond two are redundancy: their leftover
        disagreement measures the fit, and one that disagrees far more than the rest
        is a mis-click and is dropped.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line p-0.5" aria-label="Floor to align">
          {FLOORS.map((f) => (
            <button
              key={f.level}
              type="button"
              aria-pressed={level === f.level}
              onClick={() => {
                setLevel(f.level);
                setAligned(false);
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                level === f.level ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="min-w-[16rem]">
          <Toggle
            checked={misclick}
            onChange={setMisclick}
            label="Include a mis-clicked anchor"
            hint="One anchor matched to the wrong feature, 6 m off — watch it get rejected."
          />
        </div>
      </div>

      <svg
        viewBox={viewBox}
        className="w-full rounded-lg border border-line bg-canvas"
        style={{ aspectRatio: '3 / 2' }}
        role="img"
        aria-label={`${getLevel(level).name} ${aligned ? 'aligned to' : 'as supplied over'} Level 1`}
      >
        {/* Reference floor (Level 1), in metres. */}
        <g>
          {getLevel(1).walls.map((w, i) => (
            <line
              key={i}
              x1={w.x1}
              y1={w.y1}
              x2={w.x2}
              y2={w.y2}
              stroke={REF}
              strokeWidth={w.type === 'exterior' ? 2 : 1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {/* The floor being aligned. */}
        <g opacity={0.85}>
          {drawnWalls.map((w, i) => {
            const a = place({ x: w.x1, y: w.y1 });
            const b = place({ x: w.x2, y: w.y2 });
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={DRAWN}
                strokeWidth={w.type === 'exterior' ? 1.8 : 0.9}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>

        {/* Anchor pairs: a line from this floor's anchor to the reference one. */}
        <g>
          {pairs.map((p) => {
            const s = place(p.src);
            const bad = rejectedIds.has(p.id);
            return (
              <g key={p.id}>
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={p.dst.x}
                  y2={p.dst.y}
                  stroke={bad ? BAD : '#0f172a'}
                  strokeWidth={1.2}
                  strokeDasharray="3 2"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={p.dst.x} cy={p.dst.y} r={0.9} fill="none" stroke="#0f172a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <path
                  d={`M ${s.x - 0.8} ${s.y - 0.8} L ${s.x + 0.8} ${s.y + 0.8} M ${s.x + 0.8} ${s.y - 0.8} L ${s.x - 0.8} ${s.y + 0.8}`}
                  stroke={bad ? BAD : DRAWN}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend for every mark on the chart. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        <LegendLine color={REF} label="Level 1 walls (reference, metres)" />
        <LegendLine color={DRAWN} label={`${getLevel(level).shortName} walls (${aligned ? 'aligned' : 'as supplied'})`} />
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-ink" /> Anchor on Level 1</span>
        <span className="flex items-center gap-1.5"><span className="font-bold text-brand">✕</span> Same anchor on {getLevel(level).shortName}</span>
        <LegendLine color="#0f172a" dashed label="Pair: its length is the disagreement" />
        <span className="flex items-center gap-1.5"><span className="font-bold text-bad">✕</span> Rejected as a mis-click</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Scale found"
          value={(1 / fit.transform.scale).toFixed(3)}
          unit="units/m"
          hint={`supplied at ${supplied.scale}`}
        />
        <Stat
          label="Rotation corrected"
          value={rotationDeg.toFixed(2)}
          unit="°"
          hint={`supplied at ${((supplied.theta * 180) / Math.PI).toFixed(0)}°`}
        />
        <Stat label="Shift" value={offsetM.toFixed(1)} unit="m" hint="origin moved by" />
        <Stat
          label="Anchor fit (RMS)"
          value={fit.rmsM.toFixed(2)}
          unit="m"
          tone={fit.rmsM < 0.5 ? 'good' : 'bad'}
          hint={`${fit.kept.length} of ${pairs.length} anchors used`}
        />
      </div>

      <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
          Anchors — leftover disagreement after the fit
        </div>
        <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-3">
          {pairs.map((p) => {
            const bad = rejectedIds.has(p.id);
            const rejected = fit.rejected.find((r) => r.id === p.id);
            return (
              <li key={p.id} className="flex items-baseline justify-between gap-2">
                <span className={bad ? 'text-bad' : 'text-ink-soft'}>{p.label}</span>
                <span className="tnum font-medium">
                  {bad ? (
                    <Badge tone="bad">rejected · {rejected.residualM.toFixed(1)} m</Badge>
                  ) : (
                    `${residualById.get(p.id).toFixed(2)} m`
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px] leading-snug text-ink-faint">
          A rejected anchor is judged by how badly the fit made <em>without</em> it predicts
          it, against how well the other anchors agree — so a mis-click far from the rest
          cannot drag the fit towards itself and hide. Clicking precision is simulated at
          ±{CLICK_NOISE_M} m.
        </p>
      </div>

      <p className="mt-2 text-[11px] text-ink-soft">
        <strong className="text-ink">Simulation only:</strong> after alignment, the worst point
        anywhere on {getLevel(level).shortName} is{' '}
        <strong className="tnum text-ink">{error.maxM.toFixed(2)} m</strong> from its true position
        (mean {error.meanM.toFixed(2)} m) — below the clicking noise, because the fit averages over
        every anchor. A real deployment cannot measure this; it sees only the anchor fit.
      </p>
    </Panel>
  );
}

function LegendLine({ color, label, dashed = false }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden>
        <line x1="1" y1="4" x2="15" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '3 2' : undefined} />
      </svg>
      {label}
    </span>
  );
}
