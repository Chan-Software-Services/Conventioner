<script setup lang="ts">
/**
 * The one drawing of a location's layout (T257), in SVG: the floorplan image faded under the
 * tables, each table at its true size and turn in its section's colour with its number, each
 * section's name in a pill beside its tables, no-table zones hatched, a table in no section grey.
 * The page that reads a layout, its editor, the PNG export and any later map draw this component.
 *
 * The drawing's units are millimetres from the floorplan's top-left corner, so a table is its true
 * size at any zoom, and `view` is the part of the hall shown (the whole hall when not given). What
 * the eye reads in pixels holds its size at every zoom: edges and outlines by
 * `vector-effect: non-scaling-stroke`, and names, numbers, gaps and the hatch by the scale the map
 * measures itself at.
 *
 * Modes: `read` and `edit` make the map a group named "Upper Hall layout, 49 tables" and each
 * table a button named "Gold row 5, Standard 6 ft", one Tab stop among them (the table focused
 * last, else the first selected, else the first), the arrow keys moving the focus to the nearest
 * table that way. In `read` a table pressed, by pointer, Enter or Space, emits `activate` with
 * its id, and the table the page reads (its `selection`) is outlined over the map. `edit` draws the selection's outline and the guides it is given, says each table pressed
 * or not as it is selected or not, draws the tables picked up by keyboard lifted, and leaves what
 * a press does to the editor round it, which may draw over the map in its slot, and move a
 * section's name, which carries its section's id for it. In `edit` a map with no table is itself
 * the Tab stop, so the keys have somewhere to place the first table from.
 * `print` is a picture: no button, no stop. In `read` the map is looked round by hand unless it is
 * given its `view`: two fingers pinch it, from the whole hall in to the editor's most, one drags it
 * once zoomed, and a tap (a press that moved no more than a few pixels) on a table, or within a
 * few pixels of one, activates it, as a click with no press before it (a screen reader's) does;
 * at the whole hall one finger scrolls the page as it would anywhere. At a desk (T422, D42) Ctrl
 * and the wheel zoom it about the pointer, the mouse drags it once zoomed, a plain wheel scrolls
 * the page, and `zoomIn`, `zoomOut` and `fit` are exposed for a caller's buttons. Each table given
 * the focus is told as `focused`. A caller standing something over a table (T465, the public map's
 * bubble) reads its screen box by `targetRect`, gives it the focus back by `focusTarget`, and hears
 * `viewed` whenever the part of the hall shown or the map's box changes.
 *
 * A day's map (T422) is the drawing given `seats`, in `read` or `print`: a table with a whole seat
 * drawn in its seat's tone and named with who holds it, a shared table drawn as two halves (D41),
 * each with a seat a button of its own, and a table with no seat drawn free (D40, `seatPaint`). A
 * press on a seat emits `activateSeat` with its key before `activate` with the table's id. In
 * `read`, the `selection` and what is `marked` (seat keys or table ids) are outlined over the map.
 * While the page waits for the floorplan image (`imagePending`, T501), the map draws the hall's floor
 * alone, at its own size, so a location's tables and its image appear together.
 * The map owns no editing state: its only state is which table or half has the focus and, in
 * `read`, the part of the hall it shows.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { FloorplanObject, SectionObject, TableTypeObject } from '@/assets/types/datatypes';
import LayoutMapTable, { type DrawnHalf } from './LayoutMapTable.vue';
import {
  NO_SECTION_PAINT,
  layoutSections,
  mapName,
  seatPaint,
  tableName,
  textWidthPx,
  type LayoutSection,
  type MapSeat,
  type SeatHalf,
} from './layoutDrawing';
import {
  OUTLINE_OUT_PX,
  OUTLINE_WIDTH_PX,
  STANDARD_TABLE,
  TAP_REACH_PX,
  TAP_SLOP_PX,
  distanceToTable,
  grownTable,
  halfAt,
  halfTable,
  hallOf,
  keptView,
  nearestInDirection,
  numberSizePx,
  pannedView,
  pinchedView,
  sectionLabelAt,
  seenView,
  tableBounds,
  unionOf,
  zoomedView,
  type Bounds,
  type Direction,
  type PointPx,
  type ViewMm,
} from './layoutGeometry';

/** The part of the hall a map shows, in millimetres. */
export interface MapView {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** An alignment guide, a line in millimetres. */
export interface MapGuide {
  x1Mm: number;
  y1Mm: number;
  x2Mm: number;
  y2Mm: number;
}

const props = withDefaults(
  defineProps<{
    layout: FloorplanObject;
    /** The layout's location, as the map's name says it. */
    locationName: string;
    /** The plan's sections, each with its location and tier; the map draws its location's. */
    sections: readonly SectionObject[];
    /** The market's table types, which size the tables. */
    tableTypes: readonly TableTypeObject[];
    mode: 'read' | 'edit' | 'print';
    /** The floorplan image, as the page fetched it; none draws the floor alone. */
    imageUrl?: string;
    /** True while the page waits for the image (T501): the map draws the hall's floor alone, no
     *  image, table, zone or section name, at the size it keeps, so the tables and their image
     *  appear together and nothing moves when they come. False unless given. */
    imagePending?: boolean;
    /** Whether the image is drawn under the tables: unless told, it is in `read` and `edit`, and
     *  is left out of `print`. */
    showImage?: boolean;
    /** Whether the image is drawn in grey under the tables of `read` and `edit`, as it is unless
     *  told, rather than in its own colours. */
    imageInGrey?: boolean;
    /** Whether the image is drawn at half strength under the tables of `read` and `edit`, as it is
     *  unless told, so the tables stand out over a busy plan; else at full strength. */
    imageFaded?: boolean;
    /** The part of the hall shown; the whole hall when not given. */
    view?: MapView | null;
    /** The ids of the selected tables, outlined in `edit`; in `read`, the table the page reads,
     *  outlined over the map. */
    selection?: readonly string[];
    /** Alignment guides, drawn in `edit`. */
    guides?: readonly MapGuide[];
    /** The ids of the tables picked up by keyboard, drawn lifted in `edit`. */
    carried?: readonly string[];
    /** Whether each table carries its number; a printed map may leave them out. */
    numbers?: boolean;
    /** A day's seats, drawn in `read` and `print`; none draws the layout as it is planned. */
    seats?: readonly MapSeat[] | null;
    /** Seat keys and table ids outlined in `read`, beside the `selection`. */
    marked?: readonly string[];
  }>(),
  {
    imageUrl: '',
    showImage: undefined,
    imageInGrey: true,
    imageFaded: true,
    view: null,
    selection: () => [],
    guides: () => [],
    carried: () => [],
    numbers: true,
    seats: null,
    marked: () => [],
  },
);

const emit = defineEmits<{
  /** A table pressed in `read` mode. */
  activate: [tableId: string];
  /** A seat pressed in `read` mode, a whole table's or a half's, before its table's `activate`. */
  activateSeat: [seatKey: string];
  /** A table given the focus, in `read` or `edit`. */
  focused: [tableId: string];
  /** The part of the hall shown changed, or the box was measured at another size, so what a
   *  caller stands over a table (the public map's bubble) is placed again (T465). */
  viewed: [];
}>();

const interactive = computed(() => props.mode !== 'print');
const imageShown = computed(() => props.showImage ?? props.mode !== 'print');
const hall = computed(() => hallOf(props.layout));
const typeById = computed(() => new Map(props.tableTypes.map((type) => [type.id, type])));
const drawnSections = computed(() => layoutSections(props.layout, props.sections));

// ── The view and its scale ───────────────────────────────────────────────────

/** The whole of the layout: its hall, or, with no hall yet (no scale), its tables' box with a
 *  metre round it. */
const whole = computed<MapView>(() => {
  if (hall.value) return { xMm: 0, yMm: 0, ...hall.value };
  const box = unionOf(
    props.layout.tables.map((table) =>
      tableBounds(table, typeById.value.get(table.tableTypeId) ?? STANDARD_TABLE),
    ),
  );
  if (!box) return { xMm: 0, yMm: 0, widthMm: 10_000, heightMm: 10_000 };
  return {
    xMm: box.left - 1000,
    yMm: box.top - 1000,
    widthMm: box.right - box.left + 2000,
    heightMm: box.bottom - box.top + 2000,
  };
});

/** The part of the hall a read map was pinched or dragged to, of its box's shape; null shows the
 *  whole. */
const looked = ref<ViewMm | null>(null);

const shown = computed<MapView>(() => props.view ?? looked.value ?? whole.value);

const svg = ref<SVGSVGElement | null>(null);
/** The map's own box on the screen, once it has been measured. */
const box = ref<{ width: number; height: number } | null>(null);
let resize: ResizeObserver | null = null;

function measure() {
  const el = svg.value;
  if (!el) return;
  const { width, height } = el.getBoundingClientRect();
  box.value = width > 0 && height > 0 ? { width, height } : null;
}

/** Words are measured in the app's type, which may arrive after the map is first drawn. */
const typeLoaded = ref(0);

onMounted(() => {
  measure();
  if (svg.value && typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver(measure);
    resize.observe(svg.value);
  }
  void document.fonts?.ready.then(() => {
    typeLoaded.value += 1;
  });
});
onBeforeUnmount(() => resize?.disconnect());

/** Screen pixels per millimetre: measured (the view drawn whole in the box, as
 *  `preserveAspectRatio` fits it), else as if the view were 1,000 px across. */
const scale = computed(() => {
  const view = shown.value;
  if (box.value) return Math.min(box.value.width / view.widthMm, box.value.height / view.heightMm);
  return 1000 / view.widthMm;
});
const mmPerPx = computed(() => 1 / scale.value);

// ── Looking round by hand (read) ─────────────────────────────────────────────

/** Whether this map is looked round by hand: a read map whose view is its own. */
const byHand = computed(() => props.mode === 'read' && !props.view);

/** What the box shows of the whole layout, the bounds a view looked round to is kept in. */
const wholeSeen = computed(() =>
  seenView(whole.value, box.value?.width ?? 0, box.value?.height ?? 0),
);

/** Whether the map is zoomed in past the whole, so one finger drags it rather than the page. */
const zoomedIn = computed(
  () => looked.value !== null && looked.value.widthMm < wholeSeen.value.widthMm * 0.999,
);

/** A view kept to the whole; the whole itself is no view of its own. */
function look(view: ViewMm) {
  const width = box.value?.width ?? 0;
  if (width <= 0) return;
  const kept = keptView(view, wholeSeen.value, width);
  looked.value = kept.widthMm >= wholeSeen.value.widthMm * 0.999 ? null : kept;
}

/** How much a zoom button zooms by. */
const ZOOM_STEP = 1.5;
/** The most one wheel event zooms by, in the pixels it says it scrolled, as the editor's does. */
const WHEEL_ZOOM_PX = 25;

/** Zoom the view by `factor` about a point of the box, its middle unless told. */
function zoomBy(factor: number, at?: PointPx) {
  const width = box.value?.width ?? 0;
  const height = box.value?.height ?? 0;
  if (!byHand.value || width <= 0) return;
  look(
    zoomedView(
      looked.value ?? wholeSeen.value,
      factor,
      at ?? { x: width / 2, y: height / 2 },
      width,
    ),
  );
}

const zoomIn = () => zoomBy(ZOOM_STEP);
const zoomOut = () => zoomBy(1 / ZOOM_STEP);
/** Show the whole hall again. */
function fit() {
  looked.value = null;
}

/** Ctrl (or Command) and the wheel zoom about the pointer; a plain wheel is the page's. */
function onWheel(event: WheelEvent) {
  if (!byHand.value || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  // A mouse's wheel says lines, a trackpad pixels; a notch is held to a quarter more or less.
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
  const by = Math.min(Math.max(event.deltaY * unit, -WHEEL_ZOOM_PX), WHEEL_ZOOM_PX);
  zoomBy(Math.exp(-by * 0.01), onBox(event));
}

// A box of another size (a phone turned) keeps the view's middle and its zoom.
watch(box, (now, before) => {
  const view = looked.value;
  if (!view || !now || !before) return;
  const widthMm = view.widthMm * (now.width / before.width);
  const heightMm = (widthMm * now.height) / now.width;
  look({
    xMm: view.xMm + (view.widthMm - widthMm) / 2,
    yMm: view.yMm + (view.heightMm - heightMm) / 2,
    widthMm,
    heightMm,
  });
});

// The part shown or the box's size changed: told once the drawing is updated, so a caller reading a
// table's screen box then reads where it now is.
watch(
  () => {
    const view = shown.value;
    const size = box.value ? `${box.value.width} ${box.value.height}` : '';
    return `${view.xMm} ${view.yMm} ${view.widthMm} ${view.heightMm} ${size}`;
  },
  () => emit('viewed'),
  { flush: 'post' },
);

/** The pointers down on a read map, where each is on its box. */
const pointers = new Map<number, PointPx>();
/** The hand at work: the view as it began, where its pointers began, and whether it has moved
 *  (pinched, or dragged past a tap's slop). */
let hand: { start: ViewMm; from: Map<number, PointPx>; moved: boolean } | null = null;
/** Whether this press is no tap: the hand moved, or held two fingers. */
let notATap = false;
/** When the last press by hand ended, by `performance.now()`. The click a browser sends after it
 *  is that press's, already read (or no tap at all), so it reads nothing; a click with no press
 *  before it, a screen reader's, reads the table. */
let pressEnded = -Infinity;
/** How long after a press its click may come. */
const CLICK_AFTER_PRESS_MS = 1000;

function onBox(event: MouseEvent): PointPx {
  const rect = svg.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** Begin the hand again from the pointers down now and the view as it stands, so a finger lifted
 *  or added takes up from there. */
function rehand() {
  const view = looked.value ?? wholeSeen.value;
  hand = pointers.size
    ? { start: view, from: new Map(pointers), moved: hand?.moved ?? false }
    : null;
}

function onPointerDown(event: PointerEvent) {
  if (!byHand.value || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if (!pointers.size) notATap = false;
  pointers.set(event.pointerId, onBox(event));
  if (pointers.size > 1) notATap = true;
  rehand();
}

function onPointerMove(event: PointerEvent) {
  if (!hand || !pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, onBox(event));
  const width = box.value?.width ?? 0;
  const [first, second] = [...pointers.keys()];
  if (!hand.moved) {
    const from = hand.from.get(first)!;
    const now = pointers.get(first)!;
    if (pointers.size === 1 && Math.hypot(now.x - from.x, now.y - from.y) <= TAP_SLOP_PX) return;
    hand.moved = true;
    notATap = true;
    // The hand keeps its pointers when they leave the map.
    for (const id of pointers.keys()) {
      try {
        svg.value?.setPointerCapture(id);
      } catch {
        // A pointer already gone has nothing to keep.
      }
    }
  }
  if (width <= 0) return;
  if (second !== undefined && hand.from.has(second)) {
    look(
      pinchedView(
        hand.start,
        [hand.from.get(first)!, hand.from.get(second)!],
        [pointers.get(first)!, pointers.get(second)!],
        width,
      ),
    );
    return;
  }
  const from = hand.from.get(first)!;
  const now = pointers.get(first)!;
  look(pannedView(hand.start, now.x - from.x, now.y - from.y, width));
}

/**
 * A finger or button lifted. The last one up ends the press, and a press that neither moved past a
 * tap's slop nor held two fingers is a tap, read here rather than by its click: a browser sends no
 * click for a tap that comes as a drag's fling would be running, and this map has none.
 */
function onPointerUp(event: PointerEvent) {
  if (!pointers.delete(event.pointerId)) return;
  rehand();
  if (pointers.size) return;
  pressEnded = performance.now();
  if (event.type !== 'pointerup' || notATap) return;
  pressAt(event, true);
}

/** What was pressed: the table and the seat the press fell on, or by a tap on the floor (`near`)
 *  the nearest within a tap's reach and the seat on the side it fell. */
function pressAt(event: MouseEvent, near: boolean) {
  const id = tableOf(event);
  if (id) {
    press(id, seatOf(event));
    return;
  }
  const found = near ? tableNear(event) : null;
  if (found) press(found.id, found.seatKey);
}

function press(tableId: string, seatKey: string | null) {
  if (seatKey) emit('activateSeat', seatKey);
  emit('activate', tableId);
}

/** The table drawn nearest a point of the box within a tap's reach, for a tap on the floor, and
 *  its seat there: the whole table's, or that of the half on the side the tap fell. */
function tableNear(event: MouseEvent): { id: string; seatKey: string | null } | null {
  const rect = svg.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const seen = seenView(shown.value, rect.width, rect.height);
  const mmPerPx = seen.widthMm / rect.width;
  const point = {
    xMm: seen.xMm + (event.clientX - rect.left) * mmPerPx,
    yMm: seen.yMm + (event.clientY - rect.top) * mmPerPx,
  };
  let nearest: DrawnTable | null = null;
  let least = TAP_REACH_PX * mmPerPx;
  for (const table of tables.value) {
    const away = distanceToTable(point, table, table);
    if (away <= least) {
      nearest = table;
      least = away;
    }
  }
  if (!nearest) return null;
  if (!nearest.halves) return { id: nearest.id, seatKey: nearest.seatKey };
  const side = halfAt(point, nearest, nearest);
  return {
    id: nearest.id,
    seatKey: nearest.halves.find((half) => half.side === side)?.seatKey ?? null,
  };
}

// ── The tables ───────────────────────────────────────────────────────────────

interface DrawnTable {
  id: string;
  name: string;
  xMm: number;
  yMm: number;
  rotation: number;
  widthMm: number;
  depthMm: number;
  fill: string;
  edge: string;
  dashes?: string;
  ink: string;
  number: string;
  numberSizeMm: number;
  bounds: Bounds;
  /** The seat that holds the whole table, on a day's map. */
  seatKey: string | null;
  /** A shared table's halves, each drawn and pressed on its own; null for one table. */
  halves: Omit<DrawnHalf, 'tabStop'>[] | null;
}

/** The day's seats by their table, in `read` and `print`: the first seat each part is given. */
const seatsByTable = computed(() => {
  if (!props.seats || props.mode === 'edit') return null;
  const byTable = new Map<string, Partial<Record<SeatHalf, MapSeat>>>();
  for (const seat of props.seats) {
    const held = byTable.get(seat.tableId) ?? {};
    held[seat.half] ??= seat;
    byTable.set(seat.tableId, held);
  }
  return byTable;
});

/** Every table as it is drawn, section by section in number order, those in no section last, which
 *  is the order a screen reader meets them in. */
const tables = computed<DrawnTable[]>(() => {
  const draw = (
    table: FloorplanObject['tables'][number],
    placed: Pick<LayoutSection, 'section' | 'paint'> | null,
  ): DrawnTable => {
    const section = placed?.section ?? null;
    const paint = placed?.paint ?? NO_SECTION_PAINT;
    const type = typeById.value.get(table.tableTypeId);
    const size = type ?? STANDARD_TABLE;
    const number = props.numbers && section && table.number !== null ? String(table.number) : '';
    const named = tableName(table, section, type);
    const drawn: DrawnTable = {
      id: table.id,
      name: named,
      xMm: table.xMm,
      yMm: table.yMm,
      rotation: table.rotation,
      widthMm: size.widthMm,
      depthMm: size.depthMm,
      fill: paint.fill,
      edge: paint.edge,
      ink: '--mm-black',
      number,
      numberSizeMm: number ? numberSizePx(size, number.length, scale.value) * mmPerPx.value : 0,
      bounds: tableBounds(table, size),
      seatKey: null,
      halves: null,
    };
    // A day's seats are drawn on the tables with a code, the only tables a seat can name.
    const seats = seatsByTable.value;
    if (!seats || !placed || table.number === null) return drawn;
    const held = seats.get(table.id) ?? {};
    if (held.whole || !(held.left || held.right)) {
      const seat = held.whole ?? null;
      return {
        ...drawn,
        ...seatPaint(seat ? seat.tone : 'free', placed.paint),
        name: `${named}, ${seat ? seat.name : 'no vendor'}`,
        seatKey: seat?.key ?? null,
      };
    }
    const halves = (['left', 'right'] as const).map((side) => {
      const seat = held[side] ?? null;
      const shape = halfTable(size, side, table.rotation);
      const label = props.numbers ? `${table.number}${side === 'left' ? 'L' : 'R'}` : '';
      return {
        side,
        seatKey: seat?.key ?? null,
        name: seat ? `${named}, ${side} half, ${seat.name}` : '',
        d: shape.d,
        focusD: halfTable(size, side, table.rotation, -0.25 * mmPerPx.value).d,
        ...seatPaint(seat ? seat.tone : 'free', placed.paint),
        label,
        labelSizeMm: label
          ? numberSizePx(shape.size, label.length, scale.value) * mmPerPx.value
          : 0,
        ...shape.centre,
      };
    });
    return { ...drawn, halves };
  };
  const inSections = drawnSections.value.flatMap((placed) =>
    placed.tables.map((table) => draw(table, placed)),
  );
  const placed = new Set(inSections.map((table) => table.id));
  const inNone = props.layout.tables
    .filter((table) => !placed.has(table.id))
    .map((table) => draw(table, null));
  return [...inSections, ...inNone];
});

const selected = computed(() => new Set(props.mode === 'edit' ? props.selection : []));

/** What the focus moves among, in the order a screen reader meets them: each table that is one
 *  button by its id, and each seated half of a shared table as "<id>#left" or "#right", left
 *  first, at its own middle on the hall. */
const targets = computed(() =>
  tables.value.flatMap((table) => {
    if (!table.halves)
      return [{ key: table.id, tableId: table.id, xMm: table.xMm, yMm: table.yMm }];
    const turn = (table.rotation * Math.PI) / 180;
    return table.halves
      .filter((half) => half.seatKey !== null)
      .map((half) => ({
        key: `${table.id}#${half.side}`,
        tableId: table.id,
        xMm: table.xMm + half.xMm * Math.cos(turn) - half.yMm * Math.sin(turn),
        yMm: table.yMm + half.xMm * Math.sin(turn) + half.yMm * Math.cos(turn),
      }));
  }),
);

/** In `read`, the tables of the selection (the table the page reads) and the seats and tables
 *  `marked`, each marked by an outline drawn over the map, outside the table's own button, so the
 *  mark coming and going as the focus moves never changes a table's box: round the table, or
 *  round the half its seat holds. */
interface ReadMark {
  id: string;
  transform: string;
  /** The outline round a whole table, or the shape of the one round a half. */
  rect: ReturnType<typeof grownTable> | null;
  d: string | null;
}

const readMarks = computed<ReadMark[]>(() => {
  if (props.mode !== 'read' || (!props.selection.length && !props.marked.length)) return [];
  const marked = new Set([...props.selection, ...props.marked]);
  const out = OUTLINE_OUT_PX * mmPerPx.value;
  return tables.value.flatMap((table): ReadMark[] => {
    const transform = `translate(${table.xMm} ${table.yMm}) rotate(${table.rotation})`;
    if (marked.has(table.id) || (table.seatKey !== null && marked.has(table.seatKey))) {
      return [{ id: table.id, transform, rect: grownTable(table, out), d: null }];
    }
    return (table.halves ?? [])
      .filter((half) => half.seatKey !== null && marked.has(half.seatKey))
      .map((half) => ({
        id: `${table.id}#${half.side}`,
        transform,
        rect: null,
        d: halfTable(table, half.side, table.rotation, out).d,
      }));
  });
});
const carriedIds = computed(() => new Set(props.mode === 'edit' ? props.carried : []));

// ── The sections' names ──────────────────────────────────────────────────────

const LABEL_TEXT_PX = 12;
const LABEL_HEIGHT_PX = 22;
const LABEL_PADDING_PX = 10;
const LABEL_GAP_PX = 6;

interface DrawnLabel {
  id: string;
  text: string;
  edge: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Each section's name in a white pill edged in its colour, at the place its style names, else
 *  beside its tables where it covers no table and no other name (`sectionLabelAt`). */
const labels = computed<DrawnLabel[]>(() => {
  void typeLoaded.value;
  const toMm = mmPerPx.value;
  const boundsOf = new Map(tables.value.map((table) => [table.id, table.bounds]));
  const taken = tables.value.map((table) => table.bounds);
  const drawn: DrawnLabel[] = [];
  for (const { section, paint, tables: own } of drawnSections.value) {
    if (!own.length) continue;
    const width = (textWidthPx(section.name, LABEL_TEXT_PX) + LABEL_PADDING_PX * 2) * toMm;
    const height = LABEL_HEIGHT_PX * toMm;
    const style = props.layout.sectionStyles?.find((s) => s.sectionId === section.id);
    const at =
      style?.labelAt ??
      sectionLabelAt({
        own: own.map((table) => boundsOf.get(table.id)!),
        taken,
        hall: hall.value,
        widthMm: width,
        heightMm: height,
        gapMm: LABEL_GAP_PX * toMm,
      });
    if (!at) continue;
    const label = {
      id: section.id,
      text: section.name,
      edge: paint.edge,
      x: at.xMm - width / 2,
      y: at.yMm - height / 2,
      width,
      height,
    };
    drawn.push(label);
    taken.push({
      left: label.x,
      top: label.y,
      right: label.x + width,
      bottom: label.y + height,
    });
  }
  return drawn;
});

/** A table's drawn group, or a half's of a shared table, inside this map; a half the table is not
 *  split into is the table. */
function targetOf(tableId: string, half: SeatHalf): SVGGElement | null {
  const table = [...(svg.value?.querySelectorAll<SVGGElement>('[data-table-id]') ?? [])].find(
    (el) => el.getAttribute('data-table-id') === tableId,
  );
  if (!table || half === 'whole') return table ?? null;
  return table.querySelector<SVGGElement>(`[data-half="${half}"]`) ?? table;
}

/** The screen box of a table, or of one half of it, as drawn now; null when it is not drawn. */
function targetRect(tableId: string, half: SeatHalf): DOMRect | null {
  return targetOf(tableId, half)?.getBoundingClientRect() ?? null;
}

/** Give the focus to a table's button, or to a half's when the half is one, else to the table's
 *  own when it is one; whether anything took it. */
function focusTarget(tableId: string, half: SeatHalf): boolean {
  const target = targetOf(tableId, half);
  const button = [target, target?.closest<SVGGElement>('[data-table-id]')].find(
    (el) => el?.getAttribute('role') === 'button',
  );
  button?.focus();
  return Boolean(button);
}

defineExpose({ zoomIn, zoomOut, fit, targetRect, focusTarget });

// ── The no-table zones ───────────────────────────────────────────────────────

const ZONE_TEXT_PX = 14;
const MIN_ZONE_TEXT_PX = 8;

/** A zone's label is drawn at 14 px where the zone has the room, smaller to fit, and left out of a
 *  zone too small to carry it, such as a pillar; the zone is still named to a screen reader. */
const zones = computed(() => {
  void typeLoaded.value;
  return props.layout.zones.map((zone) => {
    const label = zone.label.trim();
    const widthPx = zone.widthMm * scale.value;
    const heightPx = zone.depthMm * scale.value;
    const fits = label
      ? Math.min(
          ZONE_TEXT_PX,
          heightPx * 0.6,
          (ZONE_TEXT_PX * widthPx * 0.9) / Math.max(textWidthPx(label, ZONE_TEXT_PX), 1),
        )
      : 0;
    // A turned zone is drawn turned about its centre, and its label turned back upright.
    const centre = `${zone.xMm + zone.widthMm / 2} ${zone.yMm + zone.depthMm / 2}`;
    return {
      ...zone,
      label,
      name: label ? `No-table zone: ${label}` : 'No-table zone',
      textSizeMm: fits >= MIN_ZONE_TEXT_PX ? fits * mmPerPx.value : 0,
      transform: zone.rotation ? `rotate(${zone.rotation} ${centre})` : undefined,
      upright: zone.rotation ? `rotate(${-zone.rotation} ${centre})` : undefined,
    };
  });
});

const hatchId = `layout-hatch-${useId()}`;

// ── The focus ────────────────────────────────────────────────────────────────

const focusedId = ref<string | null>(null);

/** The one table or half Tab stops on: the one focused last, else the first selected, else the
 *  first. */
const tabStopId = computed(() => {
  const all = targets.value;
  if (focusedId.value && all.some((target) => target.key === focusedId.value))
    return focusedId.value;
  return all.find((target) => selected.value.has(target.tableId))?.key ?? all[0]?.key ?? null;
});

watch(
  () => props.layout.id,
  () => {
    focusedId.value = null;
    looked.value = null;
  },
);

function onFocused(id: string, target: string) {
  focusedId.value = target;
  emit('focused', id);
}

/** The value of `attribute` on the element an event came from or the nearest round it. */
function closestOf(event: Event, attribute: string): string | null {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
}

const tableOf = (event: Event) => closestOf(event, 'data-table-id');
/** The seat an event fell on: the half's, or the whole table's; none on a free half. */
const seatOf = (event: Event) => closestOf(event, 'data-seat-key');

function onClick(event: MouseEvent) {
  if (props.mode !== 'read') return;
  // The click of a press by hand: read as it ended, if it was a tap.
  if (performance.now() - pressEnded < CLICK_AFTER_PRESS_MS) return;
  pressAt(event, byHand.value);
}

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function onKeydown(event: KeyboardEvent) {
  // The editor round the map may take a key first, as it does while a table is picked up: on the
  // table or in the capture phase, since a listener of its own round the map hears the key after.
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
  // In the editor, whose selection takes the plain arrows, Alt and an arrow moves between tables
  // too (T422). A read map leaves Alt alone: Alt and an arrow is the browser's back and forward.
  if (event.altKey && (props.mode !== 'edit' || !ARROWS[event.key])) return;
  const id = tableOf(event);
  if (!id) return;
  if ((event.key === 'Enter' || event.key === ' ') && props.mode === 'read') {
    event.preventDefault();
    // A key held down presses once.
    if (!event.repeat) press(id, seatOf(event));
    return;
  }
  const direction = ARROWS[event.key];
  if (!direction || event.shiftKey) return;
  // An arrow on the map never scrolls the page, whether or not a table stands that way.
  event.preventDefault();
  const at = closestOf(event, 'data-target') ?? id;
  const from = targets.value.find((target) => target.key === at);
  if (!from) return;
  const next = nearestInDirection(
    from,
    targets.value.filter((target) => target.key !== at),
    direction,
  );
  if (!next) return;
  const el = [...(svg.value?.querySelectorAll<SVGGElement>('[data-target]') ?? [])].find(
    (target) => target.getAttribute('data-target') === next.key,
  );
  el?.focus();
}
</script>

<template>
  <svg
    ref="svg"
    class="layout-map"
    :class="`layout-map--${mode}`"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="`${shown.xMm} ${shown.yMm} ${shown.widthMm} ${shown.heightMm}`"
    preserveAspectRatio="xMidYMid meet"
    :role="interactive ? 'group' : 'img'"
    :aria-label="mapName(locationName, tables.length)"
    :tabindex="mode === 'edit' && !tables.length ? 0 : undefined"
    :style="byHand ? { touchAction: zoomedIn ? 'none' : 'pan-y' } : undefined"
    :data-zoomed="byHand && zoomedIn ? '' : undefined"
    data-testid="layout-map"
    @click="onClick"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <defs>
      <!-- The hatch of a no-table zone: 45°, 10 px apart on the screen at any zoom. -->
      <pattern
        :id="hatchId"
        width="10"
        height="10"
        patternUnits="userSpaceOnUse"
        :patternTransform="`rotate(45) scale(${mmPerPx})`"
      >
        <rect width="10" height="10" fill="var(--layout-zone-fill)" />
        <line
          x1="0.75"
          y1="0"
          x2="0.75"
          y2="10"
          stroke="var(--layout-zone-hatch)"
          stroke-width="1.5"
        />
      </pattern>
    </defs>

    <rect
      v-if="hall"
      class="layout-map__floor"
      x="0"
      y="0"
      :width="hall.widthMm"
      :height="hall.heightMm"
      fill="var(--layout-floor)"
    />
    <image
      v-if="hall && imageUrl && imageShown && !imagePending"
      class="layout-map__image"
      :class="{ 'layout-map__image--colour': !imageInGrey }"
      :href="imageUrl"
      x="0"
      y="0"
      :width="hall.widthMm"
      :height="hall.heightMm"
      preserveAspectRatio="none"
      :opacity="interactive && imageFaded ? 0.5 : undefined"
      aria-hidden="true"
      data-testid="layout-map-image"
    />

    <!-- Everything over the floor waits with the image, while it is pending. -->
    <template v-if="!imagePending">
      <g
        v-for="zone in zones"
        :key="zone.id"
        class="layout-map__zone"
        :transform="zone.transform"
        :role="interactive ? 'img' : undefined"
        :aria-label="interactive ? zone.name : undefined"
        data-testid="layout-map-zone"
      >
        <rect
          data-testid="layout-map-zone-box"
          :x="zone.xMm"
          :y="zone.yMm"
          :width="zone.widthMm"
          :height="zone.depthMm"
          :rx="4 * mmPerPx"
          :fill="`url(#${hatchId})`"
          stroke="var(--layout-zone-edge)"
          stroke-width="1.5"
          stroke-dasharray="6 4"
          vector-effect="non-scaling-stroke"
        />
        <text
          v-if="zone.textSizeMm > 0"
          data-testid="layout-map-zone-label"
          :transform="zone.upright"
          :x="zone.xMm + zone.widthMm / 2"
          :y="zone.yMm + zone.depthMm / 2"
          :font-size="zone.textSizeMm"
          font-family="Outfit, sans-serif"
          font-weight="600"
          text-anchor="middle"
          dy="0.36em"
          fill="var(--mm-black)"
          aria-hidden="true"
        >
          {{ zone.label }}
        </text>
      </g>

      <template v-if="mode === 'edit'">
        <line
          v-for="(guide, index) in guides"
          :key="index"
          class="layout-map__guide"
          :x1="guide.x1Mm"
          :y1="guide.y1Mm"
          :x2="guide.x2Mm"
          :y2="guide.y2Mm"
          stroke="var(--mm-blue)"
          stroke-width="1"
          stroke-dasharray="4 4"
          vector-effect="non-scaling-stroke"
          aria-hidden="true"
          data-testid="layout-map-guide"
        />
      </template>

      <LayoutMapTable
        v-for="table in tables"
        :id="table.id"
        :key="table.id"
        :name="table.name"
        :xMm="table.xMm"
        :yMm="table.yMm"
        :rotation="table.rotation"
        :widthMm="table.widthMm"
        :depthMm="table.depthMm"
        :fill="table.fill"
        :edge="table.edge"
        :dashes="table.dashes"
        :ink="table.ink"
        :seatKey="table.seatKey"
        :halves="
          table.halves?.map((half) => ({
            ...half,
            tabStop: `${table.id}#${half.side}` === tabStopId,
          })) ?? null
        "
        :number="table.number"
        :numberSizeMm="table.numberSizeMm"
        :selected="selected.has(table.id)"
        :carried="carriedIds.has(table.id)"
        :pressed="mode === 'edit' ? selected.has(table.id) : undefined"
        :interactive="interactive"
        :tabStop="table.id === tabStopId"
        :mmPerPx="mmPerPx"
        @focused="onFocused"
      />

      <g
        v-for="mark in readMarks"
        :key="mark.id"
        class="layout-map__read"
        :transform="mark.transform"
        aria-hidden="true"
        data-testid="layout-map-read"
      >
        <rect
          v-if="mark.rect"
          v-bind="mark.rect"
          fill="none"
          stroke="var(--mm-black)"
          :stroke-width="OUTLINE_WIDTH_PX"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-else
          :d="mark.d!"
          fill="none"
          stroke="var(--mm-black)"
          :stroke-width="OUTLINE_WIDTH_PX"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <g
        v-for="label in labels"
        :key="label.id"
        class="layout-map__label"
        :data-section-label="label.id"
        aria-hidden="true"
        data-testid="layout-map-label"
      >
        <rect
          data-testid="layout-map-label-pill"
          :x="label.x"
          :y="label.y"
          :width="label.width"
          :height="label.height"
          :rx="label.height / 2"
          fill="white"
          :stroke="`var(${label.edge})`"
          stroke-width="1.5"
          vector-effect="non-scaling-stroke"
        />
        <text
          :x="label.x + label.width / 2"
          :y="label.y + label.height / 2"
          :font-size="LABEL_TEXT_PX * mmPerPx"
          font-family="Outfit, sans-serif"
          font-weight="600"
          text-anchor="middle"
          dy="0.36em"
          fill="var(--mm-black)"
        >
          {{ label.text }}
        </text>
      </g>

      <!-- What the editor draws over the map, in the map's millimetres: the selection's frame and
           its corners' turn knobs. -->
      <slot :mmPerPx="mmPerPx" />
    </template>
  </svg>
</template>

<style scoped>
/* The map fills the box its page gives it, its view drawn whole inside; the ground round a hall
   that does not fill the box is the floor's. */
.layout-map {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--layout-floor);
}

/* The floorplan lies under the tables in grey and at half strength, unless the person viewing
   asks for its own colours (`imageInGrey`, `imageFaded`), so the sections' colours are the only
   colours. A printed map that carries the image draws it as it is. */
.layout-map--read .layout-map__image,
.layout-map--edit .layout-map__image {
  filter: grayscale(1);
}

.layout-map .layout-map__image--colour {
  filter: none;
}

/* A name, a zone and the image are read, never pressed: a press on them is a press on the floor. */
.layout-map__image,
.layout-map__label,
.layout-map__read,
.layout-map__zone text {
  pointer-events: none;
  user-select: none;
}
</style>
