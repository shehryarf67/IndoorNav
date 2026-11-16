/**
 * floorplan.js — THE shared floor plan for all three MallNav prototypes.
 *
 * Why this file exists
 * --------------------
 * All three tabs (map building, Wi-Fi positioning, sensor fusion) draw the same
 * mall. If each tab invented its own geometry the demo would read as three
 * disconnected experiments instead of one system. So the building is defined
 * exactly once, here, as DATA — not as an image — and every tab imports it.
 *
 * The building
 * ------------
 * A three-level mall, 60 m x 40 m per level: a basement car park (Level P) and
 * two shopping floors above it (Level 1, the ground floor, and Level 2). Every
 * level shares the same footprint. Each has one wide horizontal corridor and one
 * wide vertical corridor crossing it, forming a plus-shaped walkable area. Units
 * fill all four quadrants — shops on the upper floors, parking zones and service
 * rooms in the car park: some front the horizontal corridor, some the vertical.
 *
 *   x --->            0                30                60
 *   y                 +-----------------+-----------------+  0
 *   |                 |  shops   | V |  shops             |
 *   v                 |----------| c |----------          | 16
 *                     |   horizontal corridor             | 20  <- centreline
 *                     |----------| r |----------          | 24
 *                     |  shops   | . |  shops             |
 *                     +-----------------+-----------------+ 40
 *
 * Coordinates are metres, y grows downward (see geometry.js for why).
 *
 * The three kinds of vertical circulation (escalators, stairs, lift) are what
 * make step-free routing meaningful: a step-free route may not use the
 * escalators or stairs, so it is forced to the lift, which is deliberately
 * placed far from the centre so the detour is visible. They also serve
 * different floors — the escalators do not reach the car park — see CONNECTORS.
 */

/** @typedef {import('./geometry.js').Point} Point */
/** @typedef {import('./geometry.js').Rect} Rect */
/** @typedef {import('./geometry.js').Segment} Segment */

// ---------------------------------------------------------------------------
// Building constants
// ---------------------------------------------------------------------------

/** Overall building footprint in metres. */
export const BUILDING = { widthM: 60, heightM: 40 };

/** Thickness of the exterior shell, in metres — drawn, but not walkable. */
const SHELL_M = 1;

/** Interior extent (inside the shell). */
const INNER = {
  x1: SHELL_M,
  y1: SHELL_M,
  x2: BUILDING.widthM - SHELL_M,
  y2: BUILDING.heightM - SHELL_M,
};

/** Corridor width in metres. Wide enough to read clearly on screen. */
const CORRIDOR_W = 8;

/** The horizontal corridor runs at this y; the vertical corridor at this x. */
export const CORRIDOR_AXES = { hY: 20, vX: 30 };

/** Walkable corridor rectangles. Their union is the plus-shaped walkable area. */
const CORRIDOR_RECTS = [
  // Horizontal corridor: full interior width, centred on y = 20.
  {
    id: 'corridor-h',
    label: 'Main Concourse',
    x: INNER.x1,
    y: CORRIDOR_AXES.hY - CORRIDOR_W / 2,
    w: INNER.x2 - INNER.x1,
    h: CORRIDOR_W,
  },
  // Vertical corridor: full interior height, centred on x = 30.
  {
    id: 'corridor-v',
    label: 'Cross Concourse',
    x: CORRIDOR_AXES.vX - CORRIDOR_W / 2,
    y: INNER.y1,
    w: CORRIDOR_W,
    h: INNER.y2 - INNER.y1,
  },
];

/**
 * Corridor centrelines — the skeleton of the walkable space.
 *
 * In the production system these come out of skeletonising a segmented floor
 * plan image. Here the geometry is already clean, so the centreline of each
 * corridor is just its midline. Tab 1 builds the navigation graph along these.
 */
const CENTRELINES = [
  {
    id: 'cl-h',
    axis: 'h',
    a: { x: INNER.x1, y: CORRIDOR_AXES.hY },
    b: { x: INNER.x2, y: CORRIDOR_AXES.hY },
  },
  {
    id: 'cl-v',
    axis: 'v',
    a: { x: CORRIDOR_AXES.vX, y: INNER.y1 },
    b: { x: CORRIDOR_AXES.vX, y: INNER.y2 },
  },
];

/** Width of a shop doorway, in metres. Signal and people both pass through it. */
export const DOOR_W = 2.4;

// ---------------------------------------------------------------------------
// Shop-strip geometry
// ---------------------------------------------------------------------------

/**
 * The four quadrants each contain two strips of shops: one fronting the
 * horizontal corridor and one fronting the vertical corridor. Splitting each
 * quadrant this way means every square metre of the building is either corridor
 * or leasable shop area — no unreachable dead space.
 *
 * `front` names the edge of the strip that faces a corridor; that edge becomes
 * the glass storefront with a door in it, and the other three edges are solid.
 */
const STRIP_GEOMETRY = {
  // North-west quadrant
  nwH: { x: INNER.x1, y: INNER.y1, w: 17, h: 15, front: 'south' },
  nwV: { x: 18, y: INNER.y1, w: 8, h: 15, front: 'east' },
  // North-east quadrant
  neV: { x: 34, y: INNER.y1, w: 8, h: 15, front: 'west' },
  neH: { x: 42, y: INNER.y1, w: 17, h: 15, front: 'south' },
  // South-west quadrant
  swH: { x: INNER.x1, y: 24, w: 17, h: 15, front: 'north' },
  swV: { x: 18, y: 24, w: 8, h: 15, front: 'east' },
  // South-east quadrant
  seV: { x: 34, y: 24, w: 8, h: 15, front: 'west' },
  seH: { x: 42, y: 24, w: 17, h: 15, front: 'north' },
};

/**
 * Split one strip into individual shop units.
 *
 * Units are divided along the strip's frontage (left-to-right for strips facing
 * the horizontal corridor, top-to-bottom for strips facing the vertical one).
 * `weight` lets an anchor tenant take more frontage than a small unit.
 *
 * @param {string} stripKey key into STRIP_GEOMETRY
 * @param {{name: string, category: string, weight?: number}[]} units
 * @returns {object[]} shop objects with rect, door point and frontage line
 */
function buildStrip(stripKey, units) {
  const s = STRIP_GEOMETRY[stripKey];
  const alongX = s.front === 'south' || s.front === 'north';
  const frontage = alongX ? s.w : s.h;
  const totalWeight = units.reduce((sum, u) => sum + (u.weight ?? 1), 0);

  let cursor = alongX ? s.x : s.y;
  return units.map((u) => {
    const span = (frontage * (u.weight ?? 1)) / totalWeight;
    const rect = alongX
      ? { x: cursor, y: s.y, w: span, h: s.h }
      : { x: s.x, y: cursor, w: s.w, h: span };
    cursor += span;

    // The frontage line is the edge that faces the corridor; the door sits at
    // its midpoint. `outward` is the unit normal pointing into the corridor,
    // used to place the door-node just outside the threshold.
    let frontLine;
    let outward;
    switch (s.front) {
      case 'south':
        frontLine = { x1: rect.x, y1: rect.y + rect.h, x2: rect.x + rect.w, y2: rect.y + rect.h };
        outward = { x: 0, y: 1 };
        break;
      case 'north':
        frontLine = { x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y };
        outward = { x: 0, y: -1 };
        break;
      case 'east':
        frontLine = { x1: rect.x + rect.w, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h };
        outward = { x: 1, y: 0 };
        break;
      default: // 'west'
        frontLine = { x1: rect.x, y1: rect.y, x2: rect.x, y2: rect.y + rect.h };
        outward = { x: -1, y: 0 };
        break;
    }

    const door = {
      x: (frontLine.x1 + frontLine.x2) / 2,
      y: (frontLine.y1 + frontLine.y2) / 2,
    };

    return {
      id: slugify(u.name),
      name: u.name,
      category: u.category,
      rect,
      frontLine,
      outward,
      // The navigable door point sits 0.5 m into the corridor so that routes
      // visibly terminate at the shop threshold rather than inside the wall.
      doorNode: { x: door.x + outward.x * 0.5, y: door.y + outward.y * 0.5 },
      door,
    };
  });
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ---------------------------------------------------------------------------
// Wall generation
// ---------------------------------------------------------------------------

/** Canonical key for a segment, so shared edges between shops are deduplicated. */
function segKey(x1, y1, x2, y2) {
  const r = (v) => v.toFixed(3);
  // Order endpoints so A->B and B->A collapse to the same key.
  return x1 < x2 || (x1 === x2 && y1 <= y2)
    ? `${r(x1)},${r(y1)}|${r(x2)},${r(y2)}`
    : `${r(x2)},${r(y2)}|${r(x1)},${r(y1)}`;
}

/**
 * Turn the shop rectangles into the wall-segment list used for both rendering
 * and radio propagation.
 *
 * Two things matter here:
 *  1. Deduplication. Neighbouring shops share a dividing wall. If we emitted it
 *     twice, Tab 2 would charge 13 dB instead of 6.5 dB for crossing it, and
 *     the whole positioning simulation would be wrong.
 *  2. Door gaps. The storefront is emitted as TWO segments with a DOOR_W gap in
 *     the middle. That gap is why a phone standing in the corridor right outside
 *     a shop still hears the shop's side clearly, and it is what lets the
 *     navigation graph connect a shop to the corridor.
 *
 * @param {object[]} shops
 * @returns {Segment[]}
 */
function buildWalls(shops) {
  const seen = new Map();

  const add = (x1, y1, x2, y2, type) => {
    if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) return; // skip zero-length
    const key = segKey(x1, y1, x2, y2);
    // First writer wins, so the exterior shell keeps its type where a shop's
    // back wall coincides with it.
    if (!seen.has(key)) seen.set(key, { x1, y1, x2, y2, type });
  };

  // 1. Exterior shell (the inner face of the building envelope).
  add(INNER.x1, INNER.y1, INNER.x2, INNER.y1, 'exterior');
  add(INNER.x2, INNER.y1, INNER.x2, INNER.y2, 'exterior');
  add(INNER.x2, INNER.y2, INNER.x1, INNER.y2, 'exterior');
  add(INNER.x1, INNER.y2, INNER.x1, INNER.y1, 'exterior');

  // 2. Each shop: solid edges, plus a storefront split around the doorway.
  for (const shop of shops) {
    const { rect, frontLine } = shop;
    const edges = [
      [rect.x, rect.y, rect.x + rect.w, rect.y],
      [rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h],
      [rect.x + rect.w, rect.y + rect.h, rect.x, rect.y + rect.h],
      [rect.x, rect.y + rect.h, rect.x, rect.y],
    ];
    const frontKey = segKey(frontLine.x1, frontLine.y1, frontLine.x2, frontLine.y2);

    for (const [x1, y1, x2, y2] of edges) {
      if (segKey(x1, y1, x2, y2) === frontKey) {
        // Storefront: two panes of glass either side of the door.
        const horizontal = Math.abs(y2 - y1) < 1e-9;
        if (horizontal) {
          const [lo, hi] = [Math.min(x1, x2), Math.max(x1, x2)];
          const mid = (lo + hi) / 2;
          add(lo, y1, mid - DOOR_W / 2, y1, 'storefront');
          add(mid + DOOR_W / 2, y1, hi, y1, 'storefront');
        } else {
          const [lo, hi] = [Math.min(y1, y2), Math.max(y1, y2)];
          const mid = (lo + hi) / 2;
          add(x1, lo, x1, mid - DOOR_W / 2, 'storefront');
          add(x1, mid + DOOR_W / 2, x1, hi, 'storefront');
        }
      } else {
        add(x1, y1, x2, y2, 'divider');
      }
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Floors and vertical circulation
// ---------------------------------------------------------------------------

/**
 * Storey height in metres. Floors are stacked at multiples of this, which is
 * what lets anything — routing time, a barometer, a renderer — reason about how
 * far apart two floors are.
 */
export const FLOOR_HEIGHT_M = 4.5;

/**
 * Connectors: the escalators, stairs and lifts that join floors.
 *
 * Each connector is a first-class object rather than an implicit "this spot
 * exists on both floors", because real vertical circulation has properties the
 * routing MUST respect:
 *
 *  - `servesLevels`  Which floors it actually stops at. The lift and stairs
 *                     reach the car park; the escalators do not. Malls really are
 *                     built this way, and it is what makes routing to the car
 *                     park non-trivial.
 *  - `direction`     `up`, `down` or `both`. An escalator moves one way, so
 *                     the up and down escalators are two separate connectors
 *                     side by side. Treating one escalator as two-way was a real
 *                     bug in the first version of this demo.
 *  - `waitS`,       Time costs. A ride costs `waitS + secondsPerFloor × floors`,
 *    `secondsPerFloor` so a lift's wait is paid once per ride, not per floor.
 *                     Routing cost is derived from this time, so the route the
 *                     algorithm picks and the time it reports can never disagree.
 *  - `accessible`    Step-free. Only the lift is.
 *  - `inService`     A broken lift is removed from routing without rebuilding
 *                     the graph.
 *
 * Positions are where the connector sits on every floor it serves (the same
 * (x, y) everywhere: a stair core or lift shaft is vertically continuous).
 */
export const CONNECTORS = [
  {
    id: 'escalator-up',
    type: 'escalator',
    label: 'Up-escalator',
    shortLabel: 'Esc ↑',
    x: 28.2,
    y: 9,
    servesLevels: [1, 2],
    direction: 'up',
    waitS: 0,
    secondsPerFloor: 22,
    accessible: false,
    inService: true,
  },
  {
    id: 'escalator-down',
    type: 'escalator',
    label: 'Down-escalator',
    shortLabel: 'Esc ↓',
    x: 31.8,
    y: 9,
    servesLevels: [1, 2],
    direction: 'down',
    waitS: 0,
    secondsPerFloor: 22,
    accessible: false,
    inService: true,
  },
  {
    id: 'stairs',
    type: 'stairs',
    label: 'Stairs',
    shortLabel: 'Stairs',
    x: CORRIDOR_AXES.vX,
    y: 31,
    servesLevels: [0, 1, 2],
    direction: 'both',
    waitS: 0,
    secondsPerFloor: 30,
    accessible: false,
    inService: true,
  },
  {
    // The lift deliberately sits far east, so the step-free route is visibly
    // longer than the escalator route — that is what the accessibility toggle
    // is there to show.
    id: 'lift',
    type: 'lift',
    label: 'Lift',
    shortLabel: 'Lift',
    x: 50,
    y: CORRIDOR_AXES.hY,
    servesLevels: [0, 1, 2],
    direction: 'both',
    waitS: 35,
    secondsPerFloor: 10,
    accessible: true,
    inService: true,
  },
];

/**
 * Kept as an alias so existing imports (tests, the alternate plan) keep working.
 * New code should use `CONNECTORS`.
 */
export const VERTICAL_LINKS = CONNECTORS;

// ---------------------------------------------------------------------------
// Wi-Fi access points
// ---------------------------------------------------------------------------

/**
 * Ceiling-mounted access points along the corridors — which is where a mall's
 * IT contractor actually puts them (power and cable trays follow the corridors,
 * not the tenant units). Seven on each shopping floor, four in the car park.
 *
 * IDs are not in floor order: AP1–AP7 (L1) and AP8–AP14 (L2) predate the car
 * park, whose APs became AP15–AP18 so that existing IDs kept their meaning.
 * Code must therefore look APs up by `level`, never infer it from the number.
 *
 * The positions are intentionally NOT perfectly symmetric. Real deployments
 * never are, and the slight unevenness is what produces the weak coverage zones
 * that Tab 2's error map is meant to expose.
 */
const APS_BY_LEVEL = {
  // The car park gets only four APs. Basements are characteristically sparse —
  // Wi-Fi is installed for shoppers, not for cars — so positioning down here is
  // deliberately harder, as it would be in a real building.
  0: [
    { id: 'AP15', x: 8, y: 20 },
    { id: 'AP16', x: 30, y: 21 },
    { id: 'AP17', x: 52, y: 19 },
    { id: 'AP18', x: 30, y: 33 },
  ],
  1: [
    { id: 'AP1', x: 5, y: 18 },
    { id: 'AP2', x: 17, y: 21 },
    { id: 'AP3', x: 30, y: 20 },
    { id: 'AP4', x: 43, y: 19 },
    { id: 'AP5', x: 56, y: 21 },
    { id: 'AP6', x: 30, y: 6 },
    { id: 'AP7', x: 30, y: 33 },
  ],
  2: [
    { id: 'AP8', x: 7, y: 21 },
    { id: 'AP9', x: 20, y: 19 },
    { id: 'AP10', x: 30, y: 22 },
    { id: 'AP11', x: 45, y: 20 },
    { id: 'AP12', x: 57, y: 19 },
    { id: 'AP13', x: 30, y: 8 },
    { id: 'AP14', x: 30, y: 31 },
  ],
};

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * Level P: the basement car park.
 *
 * Simplification worth stating: the parking zones reuse the same strip geometry
 * and walls as the shop floors above. A real car park is mostly open, with
 * columns rather than partition walls, so radio propagation down here is
 * pessimistic in this model. What it does model faithfully is the thing that
 * matters for navigation — that only the lift and stairs reach it.
 */
const LEVEL_0_STRIPS = {
  nwH: [{ name: 'Parking Zone A', category: 'parking' }],
  nwV: [
    { name: 'Plant Room', category: 'services' },
    { name: 'Security Office', category: 'services' },
  ],
  neV: [
    { name: 'EV Charging', category: 'parking' },
    { name: 'Valet Desk', category: 'services' },
  ],
  neH: [{ name: 'Parking Zone B', category: 'parking' }],
  swH: [{ name: 'Parking Zone C', category: 'parking' }],
  swV: [
    { name: 'Motorbike Bay', category: 'parking' },
    { name: 'Loading Dock', category: 'services' },
  ],
  seV: [
    { name: 'Car Wash', category: 'services' },
    { name: 'Taxi Pickup', category: 'parking' },
  ],
  seH: [{ name: 'Parking Zone D', category: 'parking' }],
};

/** Level 1: fashion and general retail, with a supermarket anchor. */
const LEVEL_1_STRIPS = {
  nwH: [{ name: 'Hyperstar', category: 'anchor' }],
  nwV: [
    { name: 'Khaadi', category: 'fashion' },
    { name: 'Sana Safinaz', category: 'fashion' },
  ],
  neV: [
    { name: 'J.', category: 'fashion' },
    { name: 'Outfitters', category: 'fashion' },
  ],
  neH: [
    { name: 'Sapphire', category: 'fashion' },
    { name: 'Gul Ahmed', category: 'fashion' },
    { name: 'Bata', category: 'fashion' },
  ],
  swH: [
    { name: 'Nishat Linen', category: 'fashion' },
    { name: 'Breakout', category: 'fashion' },
    { name: 'Servis', category: 'fashion' },
  ],
  swV: [
    { name: 'Bonanza Satrangi', category: 'fashion' },
    { name: 'Ideas', category: 'fashion' },
  ],
  seV: [
    { name: 'Limelight', category: 'fashion' },
    { name: 'Beechtree', category: 'fashion' },
  ],
  seH: [
    { name: 'Chen One', category: 'services' },
    { name: 'Stoneage', category: 'fashion' },
    { name: 'Almirah', category: 'fashion' },
  ],
};

/** Level 2: food, entertainment and electronics — the classic upper level. */
const LEVEL_2_STRIPS = {
  nwH: [
    { name: 'Cinepax Cinema', category: 'entertainment', weight: 1.6 },
    { name: 'Toy Kingdom', category: 'entertainment', weight: 1 },
  ],
  nwV: [
    { name: 'iStore', category: 'electronics' },
    { name: 'Samsung', category: 'electronics' },
  ],
  neV: [
    { name: 'Timex', category: 'electronics' },
    { name: 'Vision Optics', category: 'services' },
  ],
  neH: [
    { name: 'Metro Shoes', category: 'fashion' },
    { name: 'Sports One', category: 'fashion' },
    { name: 'Home Accents', category: 'services' },
  ],
  swH: [{ name: 'Food Court', category: 'food' }],
  swV: [
    { name: 'KFC', category: 'food' },
    { name: "Hardee's", category: 'food' },
  ],
  seV: [
    { name: "Gloria Jean's", category: 'food' },
    { name: 'Chaaye Khana', category: 'food' },
  ],
  seH: [
    { name: 'Rahat Bakers', category: 'food' },
    { name: 'Kids Play Area', category: 'entertainment' },
    { name: 'Salon Ecstasy', category: 'services' },
  ],
};

// ---------------------------------------------------------------------------
// Level assembly
// ---------------------------------------------------------------------------

/**
 * Build one complete level: shops, walls, walkable rectangles, centrelines,
 * access points and the connectors that stop on it.
 *
 * @param {{level:number, ordinal:number, name:string, shortName:string}} meta
 *   `level` is the identifier used everywhere else in the code; `ordinal` is
 *   its position in the stack (0 = car park, 1 = ground, 2 = first floor).
 *   They are equal in this building, but kept separate deliberately: real
 *   buildings number floors inconsistently ("G", "M" for mezzanine, "LG"), and
 *   anything that reasons about up/down must use the ordinal, never the label.
 * @param {Record<string, object[]>} stripSpec tenant list per strip
 */
function buildLevel(meta, stripSpec) {
  const { level, ordinal, name, shortName } = meta;
  const shops = Object.entries(stripSpec)
    .flatMap(([stripKey, units]) => buildStrip(stripKey, units))
    .map((shop) => ({ ...shop, level }));

  return {
    level,
    ordinal,
    /** Floor height above the ground floor, in metres (negative = below). */
    elevationM: (ordinal - 1) * FLOOR_HEIGHT_M,
    id: `level-${level}`,
    name,
    shortName,
    shops,
    walls: buildWalls(shops),
    /** Walkable regions. `isWalkable()` tests a point against these. */
    corridors: CORRIDOR_RECTS.map((r) => ({ ...r })),
    centrelines: CENTRELINES.map((c) => ({ ...c })),
    aps: APS_BY_LEVEL[level].map((ap) => ({ ...ap, level })),
    /** Only the connectors that actually stop on this floor. */
    verticalLinks: CONNECTORS.filter((c) => c.servesLevels.includes(level)).map((c) => ({
      ...c,
    })),
  };
}

/**
 * Every level, bottom to top. Order matters: floor pickers, the barometer and
 * the routing heuristic all assume this list is sorted by ordinal.
 */
export const LEVELS = [
  buildLevel({ level: 0, ordinal: 0, name: 'Level P — Parking', shortName: 'P' }, LEVEL_0_STRIPS),
  buildLevel({ level: 1, ordinal: 1, name: 'Level 1 — Ground', shortName: 'L1' }, LEVEL_1_STRIPS),
  buildLevel(
    { level: 2, ordinal: 2, name: 'Level 2 — Food & Cinema', shortName: 'L2' },
    LEVEL_2_STRIPS,
  ),
];

/** The ground floor — where a visitor arrives, and the sensible default view. */
export const GROUND_LEVEL = 1;

/** Convenience lookup: level identifier -> level object (falls back to ground). */
export function getLevel(level) {
  return LEVELS.find((l) => l.level === level) ?? LEVELS.find((l) => l.level === GROUND_LEVEL);
}

/**
 * Every access point on every level, flattened — used by Tab 2's radio map.
 * Follows LEVELS order (bottom-up), so ALL_APS[0] is a car-park AP, not AP1:
 * pick a default AP by level, not by index.
 */
export const ALL_APS = LEVELS.flatMap((l) => l.aps);

/** Every shop on every level, flattened — used to populate route dropdowns. */
export const ALL_SHOPS = LEVELS.flatMap((l) => l.shops);

// ---------------------------------------------------------------------------
// Spatial queries
// ---------------------------------------------------------------------------

/**
 * Is this point inside the walkable corridor area of the given level?
 * Used for click validation in Tab 2 and for map matching in Tab 3.
 *
 * @param {number} level
 * @param {Point} p
 */
export function isWalkable(level, p) {
  const l = getLevel(level);
  return l.corridors.some(
    (r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h,
  );
}

/** Total walkable floor area of a level in m², corrected for corridor overlap. */
export function walkableAreaM2(level) {
  const [h, v] = getLevel(level).corridors;
  const overlapW = Math.min(h.x + h.w, v.x + v.w) - Math.max(h.x, v.x);
  const overlapH = Math.min(h.y + h.h, v.y + v.h) - Math.max(h.y, v.y);
  const overlap = Math.max(0, overlapW) * Math.max(0, overlapH);
  return h.w * h.h + v.w * v.h - overlap;
}

// ---------------------------------------------------------------------------
// Rendering scale
// ---------------------------------------------------------------------------

/**
 * Rendering scale.
 *
 * Every SVG in this app uses a viewBox measured in METRES, i.e. `0 0 60 40`,
 * with a small margin. That is a deliberate choice: it means all the overlay
 * drawing code in the three tabs plots points in the same units the maths works
 * in, so there is never a metres-to-pixels conversion to get wrong or to
 * explain. Stroke widths use `vector-effect="non-scaling-stroke"` so hairlines
 * stay crisp regardless of how large the SVG is displayed.
 */
export const MARGIN_M = 1.5;

/** viewBox covering the building plus a margin, in metres. */
export const VIEWBOX = [
  -MARGIN_M,
  -MARGIN_M,
  BUILDING.widthM + MARGIN_M * 2,
  BUILDING.heightM + MARGIN_M * 2,
].join(' ');

/** Aspect ratio of the drawing, for sizing containers. */
export const ASPECT =
  (BUILDING.widthM + MARGIN_M * 2) / (BUILDING.heightM + MARGIN_M * 2);

/** Colour tokens per shop category, kept next to the data so all tabs agree. */
export const CATEGORY_COLORS = {
  anchor: '#e0e7ff',
  fashion: '#f1f5f9',
  food: '#fef3c7',
  entertainment: '#ede9fe',
  electronics: '#e0f2fe',
  services: '#f1f5f9',
  parking: '#f5f5f4',
};
