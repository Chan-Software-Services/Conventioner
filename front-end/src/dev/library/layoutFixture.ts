/**
 * The layouts the `layout-map` entry draws (T257), every value made here: a hall of four sections
 * and 49 tables, a hall of nine sections, and a hall of 400 tables dealt from a seeded draw, so the
 * same seed draws the same hall; and (T422) the `day-map` entry's market day, two locations with
 * their seats dealt from a seeded draw. No file and no market is read.
 */
import type {
  FloorplanObject,
  FloorplanTable,
  FloorplanZone,
  SectionObject,
  TableTypeObject,
} from '@/assets/types/datatypes';
import type { DayMapLocation } from '@/components/daymap/dayMap';
import type { MapSeat, SeatHalf, SeatTone } from '@/components/layout/layoutDrawing';

export interface FixtureHall {
  layout: FloorplanObject;
  locationName: string;
  sections: SectionObject[];
  tableTypes: TableTypeObject[];
  /** The venue's floorplan as an upload would bring it, drawn here as an SVG data URL. */
  imageUrl: string;
}

const SIX_FOOT: TableTypeObject = {
  id: 'type-6ft',
  name: 'Standard 6 ft',
  widthMm: 1830,
  depthMm: 760,
};
const SQUARE: TableTypeObject = {
  id: 'type-4ft',
  name: 'Square 4 ft',
  widthMm: 1220,
  depthMm: 1220,
};

/** A seeded draw of numbers from 0 up to 1 (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A row of `count` tables of a section from its first table's centre, `stepMm` apart, across the
 *  hall or, turned a quarter, down it; numbered from `first`. */
function row(
  sectionId: string,
  from: [number, number],
  count: number,
  options: { down?: boolean; first?: number; stepMm?: number; type?: TableTypeObject } = {},
): FloorplanTable[] {
  const { down = false, first = 1, stepMm = 1980, type = SIX_FOOT } = options;
  return Array.from({ length: count }, (_, i) => ({
    id: `${sectionId}-${first + i}`,
    sectionId,
    number: first + i,
    tableTypeId: type.id,
    xMm: down ? from[0] : from[0] + i * stepMm,
    yMm: down ? from[1] + i * stepMm : from[1],
    rotation: down ? 90 : 0,
  }));
}

/** A hall's plan as a venue might send it: its walls, a door, and the rooms named, 1 px to 30 mm. */
function planImage(widthMm: number, heightMm: number, rooms: [string, number[]][]): string {
  const w = widthMm / 30;
  const h = heightMm / 30;
  const ink = '#6d6a66';
  const named = rooms
    .map(
      ([name, [x, y, width, height]]) =>
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${ink}" stroke-width="3"/>` +
        `<text x="${x + width / 2}" y="${y + height / 2 + 6}" font-size="16" text-anchor="middle" fill="${ink}" font-family="sans-serif">${name}</text>`,
    )
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#fbfaf7"/>` +
    `<rect x="16" y="16" width="${w - 32}" height="${h - 32}" fill="none" stroke="${ink}" stroke-width="10"/>` +
    `<rect x="${w / 2 - 60}" y="${h - 26}" width="120" height="20" fill="#fbfaf7"/>` +
    `<path d="M${w / 2 - 60} ${h - 16} A60 60 0 0 1 ${w / 2} ${h - 76}" fill="none" stroke="${ink}" stroke-width="2"/>` +
    `<path d="M${w / 2 + 60} ${h - 16} A60 60 0 0 0 ${w / 2} ${h - 76}" fill="none" stroke="${ink}" stroke-width="2"/>` +
    named +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function hall(
  id: string,
  widthMm: number,
  heightMm: number,
  tables: FloorplanTable[],
  zones: FloorplanZone[],
  locationId = 'loc-upper',
): FloorplanObject {
  return {
    id,
    locationId,
    revision: 1,
    imageGridfsId: `${id}-image`,
    imageWidth: widthMm / 30,
    imageHeight: heightMm / 30,
    scalePxPerUnit: 1 / 30,
    tables,
    zones,
    sectionStyles: [],
    startingCounts: [],
  };
}

const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const LOWER = { id: 'loc-lower', name: 'Lower Hall' };
const section = (
  id: string,
  name: string,
  tier: SectionObject['tier'] = null,
  location = UPPER,
): SectionObject => ({
  id,
  name,
  location,
  tier,
  count: 0,
});

/**
 * Upper Hall, 36 m by 24 m, as the layout's prototype drew it: Gold row's 13 tables, 9 down the
 * west wall and 4 by the kitchen; Silver aisle's 18 in two rows back to back; Bronze row's 11 along
 * the south wall; Food court's 7 down the east wall; a stage and two pillars.
 */
export function upperHall(): FixtureHall {
  const tables = [
    ...row('sec-gold', [2480, 6615], 9, { down: true }),
    ...row('sec-gold', [6800, 2480], 4, { first: 10 }),
    ...row('sec-silver', [10_815, 10_280], 9),
    ...row('sec-silver', [10_815, 11_090], 9, { first: 10 }),
    ...row('sec-bronze', [8415, 21_080], 11),
    ...row('sec-food', [34_280, 7815], 7, { down: true }),
  ];
  const zones: FloorplanZone[] = [
    { id: 'zone-stage', label: 'Stage', xMm: 14_100, yMm: 1080, widthMm: 9000, depthMm: 3600 },
    { id: 'zone-pillar-1', label: '', xMm: 11_700, yMm: 15_600, widthMm: 720, depthMm: 720 },
    { id: 'zone-pillar-2', label: '', xMm: 24_000, yMm: 15_600, widthMm: 720, depthMm: 720 },
  ];
  return {
    layout: hall('fp-upper', 36_000, 24_000, tables, zones),
    locationName: UPPER.name,
    sections: [
      section('sec-gold', 'Gold row', { id: 1, name: 'Gold' }),
      section('sec-silver', 'Silver aisle', { id: 2, name: 'Silver' }),
      section('sec-bronze', 'Bronze row', { id: 3, name: 'Bronze' }),
      section('sec-food', 'Food court'),
    ],
    tableTypes: [SIX_FOOT, SQUARE],
    imageUrl: planImage(36_000, 24_000, [
      ['Kitchen', [16, 16, 160, 110]],
      ['Toilets', [1024, 700, 160, 84]],
    ]),
  };
}

/**
 * A hall of nine sections, one row each, so the palette's eight colours are all drawn and the
 * ninth section takes the first again; two square tables stand in no section, and the third
 * section's name is placed by hand, at the east wall.
 */
export function nineSections(): FixtureHall {
  const sections = Array.from({ length: 9 }, (_, i) => section(`sec-${i + 1}`, `Row ${i + 1}`));
  const tables = sections.flatMap((s, i) => row(s.id!, [3000, 2500 + i * 2200], 6));
  const loose: FloorplanTable[] = [0, 1].map((i) => ({
    id: `loose-${i + 1}`,
    sectionId: null,
    number: null,
    tableTypeId: SQUARE.id,
    xMm: 24_000 + i * 2600,
    yMm: 12_000,
    rotation: i * 45,
  }));
  const layout = hall('fp-nine', 36_000, 24_000, [...tables, ...loose], []);
  layout.sectionStyles = [{ sectionId: 'sec-3', color: 3, labelAt: { xMm: 31_000, yMm: 6900 } }];
  return {
    layout,
    locationName: 'Lower Hall',
    sections,
    tableTypes: [SIX_FOOT, SQUARE],
    imageUrl: planImage(36_000, 24_000, []),
  };
}

/**
 * A hall of `count` tables, 60 m by 40 m, in eight sections: rows of 25 across it, each row's
 * start and each table's turn dealt from the seeded draw, a table in ten standing a little askew.
 */
export function bigHall(seed: number, count = 400): FixtureHall {
  const draw = seeded(seed);
  const sections = Array.from({ length: 8 }, (_, i) => section(`sec-${i + 1}`, `Block ${i + 1}`));
  const perSection = Math.ceil(count / sections.length);
  const numbers = new Map<string, number>();
  const tables: FloorplanTable[] = [];
  for (let r = 0; tables.length < count; r++) {
    const startMm = 3000 + Math.round(draw() * 1500);
    for (let c = 0; c < 25 && tables.length < count; c++) {
      const s = sections[Math.floor(tables.length / perSection)];
      const number = (numbers.get(s.id!) ?? 0) + 1;
      numbers.set(s.id!, number);
      tables.push({
        id: `big-${tables.length + 1}`,
        sectionId: s.id!,
        number,
        tableTypeId: SIX_FOOT.id,
        xMm: startMm + c * 2100,
        yMm: 3000 + r * 2200,
        rotation: draw() < 0.1 ? Math.round(draw() * 20 - 10) : 0,
      });
    }
  }
  return {
    layout: hall('fp-big', 60_000, 40_000, tables, []),
    locationName: 'Great Hall',
    sections,
    tableTypes: [SIX_FOOT],
    imageUrl: planImage(60_000, 40_000, []),
  };
}

// ── A market day (T422) ──────────────────────────────────────────────────────

/**
 * Lower Hall, 24 m by 16 m: Craft lane's 8 tables across the north wall, Food lane's 6 down the
 * east wall, and a stage turned 30 degrees in the middle of the floor.
 */
export function lowerHall(): FixtureHall {
  const tables = [
    ...row('sec-craft', [3000, 2500], 8, { stepMm: 2300 }),
    ...row('sec-food-lane', [21_500, 5000], 6, { down: true, stepMm: 1900 }),
  ];
  const zones: FloorplanZone[] = [
    {
      id: 'zone-lower-stage',
      label: 'Stage',
      xMm: 7000,
      yMm: 8000,
      widthMm: 6000,
      depthMm: 3000,
      rotation: 30,
    },
  ];
  return {
    layout: hall('fp-lower', 24_000, 16_000, tables, zones, LOWER.id),
    locationName: LOWER.name,
    sections: [
      section('sec-craft', 'Craft lane', null, LOWER),
      section('sec-food-lane', 'Food lane', null, LOWER),
    ],
    tableTypes: [SIX_FOOT, SQUARE],
    imageUrl: planImage(24_000, 16_000, [['Lift', [660, 400, 100, 90]]]),
  };
}

/** The words a fixture vendor's name is made from: never a person's name. */
const NAME_FIRST = [
  'Amber',
  'Birch',
  'Cobalt',
  'Driftwood',
  'Ember',
  'Fennel',
  'Granite',
  'Harbour',
  'Indigo',
  'Juniper',
  'Kelp',
  'Linden',
  'Marigold',
  'Nettle',
  'Oakmoss',
  'Pebble',
  'Quill',
  'Rowan',
];
const NAME_KIND = [
  'Ceramics',
  'Candles',
  'Prints',
  'Knits',
  'Soaps',
  'Jams',
  'Leather',
  'Glass',
  'Tea',
  'Woodwork',
  'Zines',
  'Bakery',
];

/** A market day as the `day-map` entry draws it, with how many of each it dealt. */
export interface FixtureDay {
  locations: DayMapLocation[];
  tableTypes: TableTypeObject[];
  /** The seats as Attendance draws them: checked in filled, checked out in the out shade, not
   *  checked in outlined. */
  seats: MapSeat[];
  counts: {
    tables: number;
    /** Tables with no seat. */
    free: number;
    /** Tables shared by two seats, and those with one half free. */
    shared: number;
    halfFree: number;
    filled: number;
    checkedOut: number;
    outlined: number;
  };
}

/**
 * Upper Hall and Lower Hall on one market day, every seat dealt from the seeded draw: a table in
 * eight is free; one in six is shared, a third of those with one half free; and of the seats, two
 * in three are checked in, of them three in four still in (filled) and the rest checked out (in
 * the out shade, T501), and the rest not checked in (outlined). Each seat's key is its vendor's,
 * `vendor-<n>`, and its name is two words of the lists above.
 */
export function marketDay(seed: number): FixtureDay {
  const draw = seeded(seed);
  const halls = [upperHall(), lowerHall()];
  const seats: MapSeat[] = [];
  const counts = {
    tables: 0,
    free: 0,
    shared: 0,
    halfFree: 0,
    filled: 0,
    checkedOut: 0,
    outlined: 0,
  };
  const seat = (tableId: string, half: SeatHalf) => {
    // One draw a seat, as before the out shade, so the deal of tables and names stays as it was.
    const at = draw();
    const tone: SeatTone = at < 1 / 2 ? 'filled' : at < 2 / 3 ? 'checkedOut' : 'outlined';
    counts[tone] += 1;
    const n = seats.length + 1;
    seats.push({
      key: `vendor-${n}`,
      tableId,
      half,
      tone,
      name: `${NAME_FIRST[Math.floor(draw() * NAME_FIRST.length)]} ${NAME_KIND[Math.floor(draw() * NAME_KIND.length)]}`,
    });
  };
  for (const { layout } of halls) {
    for (const table of layout.tables) {
      counts.tables += 1;
      const r = draw();
      if (r < 1 / 8) {
        counts.free += 1;
      } else if (r < 1 / 8 + 1 / 6) {
        counts.shared += 1;
        const free = draw();
        if (free < 1 / 6) counts.halfFree += 1;
        else seat(table.id, 'left');
        if (free >= 1 / 6 && free < 1 / 3) counts.halfFree += 1;
        else seat(table.id, 'right');
      } else {
        seat(table.id, 'whole');
      }
    }
  }
  return {
    locations: halls.map((fixture) => ({
      id: fixture.layout.locationId!,
      name: fixture.locationName,
      layout: fixture.layout,
      sections: fixture.sections,
      imageUrl: fixture.imageUrl,
    })),
    tableTypes: [SIX_FOOT, SQUARE],
    seats,
    counts,
  };
}
