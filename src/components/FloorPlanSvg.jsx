import { useCallback, useRef } from 'react';
import { VIEWBOX, ASPECT, CATEGORY_COLORS, BUILDING } from '../floorplan/floorplan.js';

/**
 * FloorPlanSvg — the one renderer used by all three prototypes.
 *
 * It draws the static building (shell, shop units, storefronts, corridors,
 * access points, vertical circulation) and then renders whatever `children` the
 * calling tab passes on top. Each tab therefore only has to think about its own
 * overlay: the navigation graph, the signal heatmap, the walking dots.
 *
 * All coordinates — both here and in every overlay — are in METRES, because the
 * viewBox is in metres. See the note on VIEWBOX in floorplan.js.
 */
export default function FloorPlanSvg({
  level,
  children,
  onPointClick,
  showShopLabels = true,
  showAps = false,
  showVerticalLinks = true,
  dimShops = false,
  cursor = 'default',
  className = '',
}) {
  const svgRef = useRef(null);

  /**
   * Convert a browser click into building coordinates (metres).
   *
   * We use the SVG's own screen transform matrix rather than doing the maths by
   * hand, so the conversion stays correct no matter how CSS has scaled the SVG.
   */
  const handleClick = useCallback(
    (event) => {
      if (!onPointClick || !svgRef.current) return;
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = event.clientX;
      pt.y = event.clientY;
      const m = pt.matrixTransform(svg.getScreenCTM().inverse());
      onPointClick({ x: m.x, y: m.y }, event);
    },
    [onPointClick],
  );

  return (
    <svg
      ref={svgRef}
      viewBox={VIEWBOX}
      className={`w-full ${className}`}
      style={{ aspectRatio: ASPECT, cursor, touchAction: 'manipulation' }}
      onClick={handleClick}
      role="img"
      aria-label={`Floor plan of ${level.name}`}
    >
      {/* ---- Building envelope -------------------------------------------- */}
      <rect
        x={0}
        y={0}
        width={BUILDING.widthM}
        height={BUILDING.heightM}
        fill="#f1f5f9"
        stroke="#334155"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        rx={0.4}
      />

      {/* ---- Walkable corridors ------------------------------------------- */}
      {/* Drawn as a light fill so the plus-shaped walkable space reads at a
          glance. This is the same rectangle list `isWalkable()` tests against. */}
      <g>
        {level.corridors.map((c) => (
          <rect
            key={c.id}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            fill="#ffffff"
          />
        ))}
      </g>

      {/* ---- Shop units ---------------------------------------------------- */}
      <g opacity={dimShops ? 0.45 : 1}>
        {level.shops.map((s) => (
          <g key={s.id}>
            <rect
              x={s.rect.x}
              y={s.rect.y}
              width={s.rect.w}
              height={s.rect.h}
              fill={CATEGORY_COLORS[s.category] ?? '#f1f5f9'}
            />
            {showShopLabels && (
              <ShopLabel shop={s} />
            )}
          </g>
        ))}
      </g>

      {/* ---- Walls ---------------------------------------------------------
          Storefronts are drawn heavier than internal dividers so the viewer can
          see where the door gaps are — the same gaps the radio model lets signal
          through and the navigation graph routes people through. */}
      <g strokeLinecap="square">
        {level.walls.map((w, i) => (
          <line
            key={i}
            x1={w.x1}
            y1={w.y1}
            x2={w.x2}
            y2={w.y2}
            stroke={
              w.type === 'exterior' ? '#334155' : w.type === 'storefront' ? '#475569' : '#cbd5e1'
            }
            strokeWidth={w.type === 'exterior' ? 2.5 : w.type === 'storefront' ? 2 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>

      {/* ---- Vertical circulation ------------------------------------------ */}
      {showVerticalLinks && (
        <g>
          {level.verticalLinks.map((v) => (
            <VerticalLinkMarker key={v.id} link={v} />
          ))}
        </g>
      )}

      {/* ---- Wi-Fi access points ------------------------------------------- */}
      {showAps && (
        <g>
          {level.aps.map((ap) => (
            <ApMarker key={ap.id} ap={ap} />
          ))}
        </g>
      )}

      {/* ---- Per-tab overlay ----------------------------------------------- */}
      {children}
    </svg>
  );
}

/** Shop name, wrapped onto two lines if it won't fit the unit's frontage. */
function ShopLabel({ shop }) {
  const cx = shop.rect.x + shop.rect.w / 2;
  const cy = shop.rect.y + shop.rect.h / 2;
  const words = shop.name.split(' ');

  // Rough fit test: at font-size 1.15 m, a character is ~0.6 m wide.
  const fitsOneLine = shop.name.length * 0.6 < shop.rect.w - 0.6;
  const lines = fitsOneLine || words.length === 1 ? [shop.name] : chunkWords(words);

  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      fontSize={1.15}
      fill="#475569"
      fontWeight={shop.category === 'anchor' ? 600 : 500}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={cx} dy={i === 0 ? -((lines.length - 1) * 0.7) : 1.4}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** Split a multi-word name into two roughly balanced lines. */
function chunkWords(words) {
  if (words.length <= 1) return words;
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/** Escalator / stairs / lift marker. Shape encodes the type. */
function VerticalLinkMarker({ link }) {
  const glyph = { escalator: '⇅', stairs: '⌃', lift: '⊞' }[link.type] ?? '⇅';
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={link.x - 1.5}
        y={link.y - 1.5}
        width={3}
        height={3}
        rx={0.4}
        fill={link.accessible ? '#dbeafe' : '#e2e8f0'}
        stroke={link.accessible ? '#2563eb' : '#64748b'}
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={link.x}
        y={link.y + 0.6}
        textAnchor="middle"
        fontSize={1.9}
        fill={link.accessible ? '#1d4ed8' : '#334155'}
      >
        {glyph}
      </text>
      <text x={link.x} y={link.y + 3.1} textAnchor="middle" fontSize={0.95} fill="#64748b">
        {link.label}
      </text>
    </g>
  );
}

/** Ceiling-mounted Wi-Fi access point. */
function ApMarker({ ap, highlighted = false }) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      <circle
        cx={ap.x}
        cy={ap.y}
        r={highlighted ? 1.2 : 0.9}
        fill="#7c3aed"
        stroke="#ffffff"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={ap.x}
        y={ap.y - 1.6}
        textAnchor="middle"
        fontSize={1}
        fontWeight={600}
        fill="#5b21b6"
      >
        {ap.id}
      </text>
    </g>
  );
}

export { ApMarker, VerticalLinkMarker };
