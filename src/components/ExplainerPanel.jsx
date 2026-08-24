import { useState } from 'react';

/**
 * ExplainerPanel — the component that carries the meaning of each prototype.
 *
 * The interactive view alone is not enough: a panel member who has never seen
 * indoor positioning should understand what is on screen within ~20 seconds and
 * without narration. So every tab renders one of these with the same four
 * sections, in the same order:
 *
 *   1. What this is        — one sentence.
 *   2. The concept         — the problem it solves.
 *   3. What you're looking at — a legend for EVERY visual element on screen.
 *   4. Why it matters      — the tie back to the product.
 *
 * Collapsible, because during a live demo you eventually want the map bigger.
 */
export default function ExplainerPanel({
  title,
  whatThisIs,
  concept,
  legend,
  whyItMatters,
  footnote,
  defaultOpen = true,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
            i
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">{title}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-ink-soft">
          {open ? 'Hide' : 'Show'}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          >
            <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <div>
            <SectionLabel>What this is</SectionLabel>
            <p className="text-sm font-medium leading-relaxed text-ink">{whatThisIs}</p>
          </div>

          <div>
            <SectionLabel>The concept</SectionLabel>
            <div className="space-y-2">
              {concept.map((para, i) => (
                <p key={i} className="text-sm leading-relaxed text-ink-soft">
                  {para}
                </p>
              ))}
            </div>
          </div>

          <div>
            <SectionLabel>What you&rsquo;re looking at</SectionLabel>
            <ul className="space-y-2">
              {legend.map((item) => (
                <li key={item.label} className="flex items-start gap-2.5">
                  <span className="mt-0.5 shrink-0">
                    <Swatch {...item} />
                  </span>
                  <span className="min-w-0 text-xs leading-snug">
                    <span className="font-semibold text-ink">{item.label}</span>
                    {item.desc && <span className="text-ink-soft"> — {item.desc}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg bg-blue-50/70 px-3 py-2.5">
            <SectionLabel className="text-brand">Why it matters for MallNav</SectionLabel>
            <p className="text-xs leading-relaxed font-medium text-blue-900">{whyItMatters}</p>
          </div>

          {footnote && (
            <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
              {footnote}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children, className = '' }) {
  return (
    <h3
      className={`mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint ${className}`}
    >
      {children}
    </h3>
  );
}

/**
 * Legend swatch. `kind` picks the shape so the legend entry looks exactly like
 * the thing it describes on the map — a dashed line in the legend means a
 * dashed line on the map.
 */
export function Swatch({ kind = 'dot', color = '#2563eb', color2, glyph }) {
  const S = 16;
  const mid = S / 2;

  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden className="block">
      {kind === 'dot' && <circle cx={mid} cy={mid} r={4.5} fill={color} />}

      {kind === 'ring' && (
        <circle cx={mid} cy={mid} r={4.5} fill="none" stroke={color} strokeWidth={2.5} />
      )}

      {kind === 'halo' && (
        <>
          <circle cx={mid} cy={mid} r={7} fill={color} opacity={0.18} />
          <circle cx={mid} cy={mid} r={3.5} fill={color} />
        </>
      )}

      {kind === 'line' && (
        <line x1={1} y1={mid} x2={S - 1} y2={mid} stroke={color} strokeWidth={3} />
      )}

      {kind === 'thin-line' && (
        <line x1={1} y1={mid} x2={S - 1} y2={mid} stroke={color} strokeWidth={1.5} />
      )}

      {kind === 'dashed' && (
        <line
          x1={1}
          y1={mid}
          x2={S - 1}
          y2={mid}
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray="4 3"
        />
      )}

      {kind === 'square' && (
        <rect
          x={2}
          y={2}
          width={S - 4}
          height={S - 4}
          rx={2}
          fill={color}
          stroke={color2 ?? 'none'}
          strokeWidth={1.5}
        />
      )}

      {kind === 'diamond' && (
        <path
          d={`M ${mid} 1.5 L ${S - 1.5} ${mid} L ${mid} ${S - 1.5} L 1.5 ${mid} Z`}
          fill={color}
        />
      )}

      {kind === 'cross' && (
        <g stroke={color} strokeWidth={2.5} strokeLinecap="round">
          <line x1={3.5} y1={3.5} x2={S - 3.5} y2={S - 3.5} />
          <line x1={S - 3.5} y1={3.5} x2={3.5} y2={S - 3.5} />
        </g>
      )}

      {kind === 'gradient' && (
        <>
          <defs>
            <linearGradient id={`g-${color.replace('#', '')}-${(color2 ?? '').replace('#', '')}`}>
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={color2} />
            </linearGradient>
          </defs>
          <rect
            x={1}
            y={4}
            width={S - 2}
            height={S - 8}
            rx={1.5}
            fill={`url(#g-${color.replace('#', '')}-${(color2 ?? '').replace('#', '')})`}
          />
        </>
      )}

      {kind === 'glyph' && (
        <>
          <rect x={1} y={1} width={S - 2} height={S - 2} rx={2} fill={color2 ?? '#e2e8f0'} />
          <text
            x={mid}
            y={mid + 4}
            textAnchor="middle"
            fontSize={11}
            fill={color}
            fontWeight={600}
          >
            {glyph}
          </text>
        </>
      )}
    </svg>
  );
}
