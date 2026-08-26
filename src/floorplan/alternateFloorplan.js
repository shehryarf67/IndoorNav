/**
 * A deliberately different one-level plan used only by Tab 1 to demonstrate
 * that graph derivation is data-driven rather than tuned to the main mall.
 *
 * The corridor has two offset branches, producing two junctions instead of the
 * main plan's single central crossing. Keeping this as plain data also makes the
 * limitation explicit: this proves geometry-to-graph generality, not image
 * segmentation.
 */

const DOOR_W = 1.8;

function makeShop(id, name, rect, front) {
  const side = {
    north: { line: [rect.x, rect.y, rect.x + rect.w, rect.y], outward: { x: 0, y: -1 } },
    south: {
      line: [rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h],
      outward: { x: 0, y: 1 },
    },
    east: {
      line: [rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h],
      outward: { x: 1, y: 0 },
    },
    west: { line: [rect.x, rect.y, rect.x, rect.y + rect.h], outward: { x: -1, y: 0 } },
  }[front];
  const [x1, y1, x2, y2] = side.line;
  const door = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  return {
    id,
    name,
    category: 'services',
    level: 1,
    rect,
    frontLine: { x1, y1, x2, y2 },
    outward: side.outward,
    door,
    doorNode: {
      x: door.x + side.outward.x * 0.5,
      y: door.y + side.outward.y * 0.5,
    },
  };
}

function wallsForShop(shop) {
  const { rect, frontLine } = shop;
  const edges = [
    [rect.x, rect.y, rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h, rect.x, rect.y + rect.h],
    [rect.x, rect.y + rect.h, rect.x, rect.y],
  ];
  const same = (e) => {
    const direct =
      Math.abs(e[0] - frontLine.x1) < 1e-6 &&
      Math.abs(e[1] - frontLine.y1) < 1e-6 &&
      Math.abs(e[2] - frontLine.x2) < 1e-6 &&
      Math.abs(e[3] - frontLine.y2) < 1e-6;
    const reverse =
      Math.abs(e[2] - frontLine.x1) < 1e-6 &&
      Math.abs(e[3] - frontLine.y1) < 1e-6 &&
      Math.abs(e[0] - frontLine.x2) < 1e-6 &&
      Math.abs(e[1] - frontLine.y2) < 1e-6;
    return direct || reverse;
  };
  return edges.flatMap((edge) => {
    if (!same(edge)) {
      return [{ x1: edge[0], y1: edge[1], x2: edge[2], y2: edge[3], type: 'divider' }];
    }
    const horizontal = Math.abs(edge[1] - edge[3]) < 1e-6;
    if (horizontal) {
      const lo = Math.min(edge[0], edge[2]);
      const hi = Math.max(edge[0], edge[2]);
      const mid = (lo + hi) / 2;
      return [
        { x1: lo, y1: edge[1], x2: mid - DOOR_W / 2, y2: edge[1], type: 'storefront' },
        { x1: mid + DOOR_W / 2, y1: edge[1], x2: hi, y2: edge[1], type: 'storefront' },
      ];
    }
    const lo = Math.min(edge[1], edge[3]);
    const hi = Math.max(edge[1], edge[3]);
    const mid = (lo + hi) / 2;
    return [
      { x1: edge[0], y1: lo, x2: edge[0], y2: mid - DOOR_W / 2, type: 'storefront' },
      { x1: edge[0], y1: mid + DOOR_W / 2, x2: edge[0], y2: hi, type: 'storefront' },
    ];
  });
}

const shops = [
  makeShop('annex-cafe', 'Annex Cafe', { x: 2, y: 2, w: 8, h: 7 }, 'east'),
  makeShop('book-hub', 'Book Hub', { x: 2, y: 9, w: 8, h: 7 }, 'east'),
  makeShop('tech-stop', 'Tech Stop', { x: 18, y: 3, w: 12, h: 13 }, 'south'),
  makeShop('gallery', 'Gallery', { x: 30, y: 3, w: 12, h: 13 }, 'south'),
  makeShop('pharmacy', 'Pharmacy', { x: 50, y: 3, w: 8, h: 13 }, 'south'),
  makeShop('sports-lab', 'Sports Lab', { x: 2, y: 24, w: 12, h: 14 }, 'north'),
  makeShop('home-store', 'Home Store', { x: 18, y: 24, w: 12, h: 14 }, 'north'),
  makeShop('studio', 'Design Studio', { x: 30, y: 24, w: 12, h: 14 }, 'north'),
  makeShop('clinic', 'Clinic', { x: 50, y: 24, w: 8, h: 14 }, 'north'),
];

const level = {
  level: 1,
  id: 'annex-level-1',
  name: 'Atrium Annex — Irregular',
  shops,
  walls: shops.flatMap(wallsForShop),
  corridors: [
    { id: 'annex-main', x: 2, y: 16, w: 56, h: 8 },
    { id: 'annex-west', x: 10, y: 2, w: 8, h: 22 },
    { id: 'annex-east', x: 42, y: 16, w: 8, h: 22 },
  ],
  centrelines: [
    { id: 'annex-main-axis', axis: 'h', a: { x: 2, y: 20 }, b: { x: 58, y: 20 } },
    { id: 'annex-west-axis', axis: 'v', a: { x: 14, y: 2 }, b: { x: 14, y: 20 } },
    { id: 'annex-east-axis', axis: 'v', a: { x: 46, y: 20 }, b: { x: 46, y: 38 } },
  ],
  aps: [],
  verticalLinks: [],
};

export const ALTERNATE_LEVELS = [level];
export const ALTERNATE_VERTICAL_LINKS = [];
