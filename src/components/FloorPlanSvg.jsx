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
 *
 * `disabledConnectorIds` (optional, any iterable of connector ids) draws those
 * connectors as out of service. It is purely visual: whether routing avoids them
 * is decided by the caller passing the same ids to `findRoute`.
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
  disabledConnectorIds = NO_IDS,
}) {
  const svgRef = useRef(null);
  const disabled = new Set(disabledConnectorIds);

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
            <VerticalLinkMarker
              key={v.id}
              link={v}
              outOfService={v.inService === false || disabled.has(v.id)}
            />
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

/** Shared empty default, so the prop's default is stable between renders. */
const NO_IDS = [];

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

/**
 * Escalator / stairs / lift marker. Shape and glyph encode the type.
 *
 * The up- and down-escalators stand side by side only 3.6 m apart, with an AP
 * ceiling-mounted between them on Level 2 (AP13 at (30, 8)). So escalators get
 * a NARROW box (1.8 m wide — roughly an escalator's real footprint across its
 * width) and a drawn arrow for their direction of travel between floors, and
 * every marker is captioned with the connector's short label. With the full
 * labels and 3 m boxes, the two captions overprinted each other and the AP dot
 * sat on top of both boxes.
 *
 * The arrow is a path, not a font glyph, so it looks the same on every machine
 * and survives the graph node dot Tab 1 draws over the marker's centre (the
 * arrowhead stays visible above / below the dot).
 */
function VerticalLinkMarker({ link, outOfService = false }) {
  const isEscalator = link.type === 'escalator';
  const oneWay = isEscalator && (link.direction === 'up' || link.direction === 'down');
  const halfW = isEscalator ? 0.9 : 1.5;
  const halfH = isEscalator ? 1.6 : 1.5;
  const glyph = { escalator: '⇅', stairs: '⌃', lift: '⊞' }[link.type] ?? '⇅';
  const caption = link.shortLabel ?? link.label;

  const style = outOfService
    ? CONNECTOR_STYLE.closed
    : link.accessible
      ? CONNECTOR_STYLE.stepFree
      : CONNECTOR_STYLE.stepped;
  const { fill, stroke, ink } = style;

  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={link.x - halfW}
        y={link.y - halfH}
        width={halfW * 2}
        height={halfH * 2}
        rx={0.4}
        fill={fill}
        stroke={stroke}
        strokeWidth={1.2}
        strokeDasharray={outOfService ? '3 2' : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {oneWay ? (
        <EscalatorArrow x={link.x} y={link.y} up={link.direction === 'up'} color={ink} />
      ) : (
        <text x={link.x} y={link.y + 0.6} textAnchor="middle" fontSize={1.9} fill={ink}>
          {glyph}
        </text>
      )}
      {outOfService && (
        // A red cross over the whole box: "closed" must read at a glance, even
        // for a viewer who never opens the legend.
        <g stroke="#dc2626" strokeWidth={2} strokeLinecap="round">
          <line
            x1={link.x - halfW}
            y1={link.y - halfH}
            x2={link.x + halfW}
            y2={link.y + halfH}
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={link.x + halfW}
            y1={link.y - halfH}
            x2={link.x - halfW}
            y2={link.y + halfH}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
      <text
        x={link.x}
        y={link.y + halfH + 1.6}
        textAnchor="middle"
        fontSize={0.95}
        fill={outOfService ? '#dc2626' : '#64748b'}
        textDecoration={outOfService ? 'line-through' : undefined}
      >
        {caption}
      </text>
    </g>
  );
}

/**
 * Marker colours, shared by the marker and its legend entries so the two
 * cannot drift apart. Blue is reserved for step-free connectors (the lift),
 * because that is the one property a wheelchair user scans the plan for.
 */
const CONNECTOR_STYLE = {
  stepFree: { fill: '#dbeafe', stroke: '#2563eb', ink: '#1d4ed8' },
  stepped: { fill: '#e2e8f0', stroke: '#64748b', ink: '#334155' },
  closed: { fill: '#f8fafc', stroke: '#94a3b8', ink: '#94a3b8' },
};

/**
 * Legend entries for the connector markers above, in ExplainerPanel's legend
 * item shape. VerticalLinkMarker is drawn by every tab that shows the plan, so
 * every such tab must explain it; each tab spreads this one array into its
 * ExplainerPanel `legend` instead of keeping its own copy.
 *
 * The arrow note matters on a plan view: without it an up arrow reads as
 * "north". Captions quote the connectors' shortLabel from floorplan.js.
 */
const CONNECTOR_LEGEND = [
  {
    kind: 'glyph',
    glyph: '⊞',
    color: CONNECTOR_STYLE.stepFree.ink,
    color2: CONNECTOR_STYLE.stepFree.fill,
    label: 'Lift (step-free)',
    desc: 'blue = step-free, the only connector a step-free route may use. It stops on every floor',
  },
  {
    kind: 'glyph',
    glyph: '↑',
    color: CONNECTOR_STYLE.stepped.ink,
    label: 'Up-escalator ("Esc ↑")',
    desc: 'one-way, from the floor below to the floor above. The arrow is its direction of travel between floors, not a compass direction',
  },
  {
    kind: 'glyph',
    glyph: '↓',
    color: CONNECTOR_STYLE.stepped.ink,
    label: 'Down-escalator ("Esc ↓")',
    desc: 'its one-way partner beside it; routing never sends anyone up it',
  },
  {
    kind: 'glyph',
    glyph: '⌃',
    color: CONNECTOR_STYLE.stepped.ink,
    label: 'Stairs',
    desc: 'two-way and reach every floor including the car park, but have steps',
  },
];

/**
 * Extra entry for tabs that can mark connectors out of service (Tab 1 today).
 * Kept separate so a tab that never shows a closed connector does not explain
 * a symbol the viewer cannot see.
 */
const CONNECTOR_OUT_OF_SERVICE_LEGEND = {
  kind: 'cross',
  color: '#dc2626',
  label: 'Out-of-service connector',
  desc: 'red cross, dashed outline and struck-through caption — marked out of service, so routing will not use it',
};

/** Direction-of-travel arrow drawn inside an escalator marker (metres). */
function EscalatorArrow({ x, y, up, color }) {
  // Tip and tail 1.1 m either side of centre; the head is 0.55 m deep.
  const tip = up ? y - 1.1 : y + 1.1;
  const tail = up ? y + 1.1 : y - 1.1;
  const back = up ? tip + 0.55 : tip - 0.55;
  return (
    <path
      d={`M ${x} ${tail} L ${x} ${tip} M ${x - 0.55} ${back} L ${x} ${tip} L ${x + 0.55} ${back}`}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
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
        fill="#ffffff"
        stroke="#4c1d95"
        strokeWidth={2.8}
        paintOrder="stroke"
        vectorEffect="non-scaling-stroke"
      >
        {ap.id}
      </text>
    </g>
  );
}

export { ApMarker, VerticalLinkMarker, CONNECTOR_LEGEND, CONNECTOR_OUT_OF_SERVICE_LEGEND };
