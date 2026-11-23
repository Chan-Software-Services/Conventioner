/**
 * What a layout's drawing says and paints (T257): the sections a layout draws, each one's colour of
 * the section palette, and a table's code and name; and (T422) how a day's seats are painted.
 * `LayoutMap.vue` draws from these and the page's "Sections" card lists from them, so the map and
 * its legend can never disagree.
 */
import type {
  FloorplanObject,
  FloorplanTable,
  SectionObject,
  TableTypeObject,
} from '@/assets/types/datatypes';
import { plural } from '@/utils/utils';
import { sectionColors } from './layoutGeometry';

/** A fill and the edge round it, as the names of two tokens of `base.css`. */
export interface Paint {
  fill: string;
  edge: string;
}

/** A section colour's paint, with the darker step of its tint a checked-out seat is filled in
 *  (T501). */
export interface SectionPaint extends Paint {
  out: string;
}

/** The paint of the section palette's colour `index`, 1 to 8. */
export function sectionPaint(index: number): SectionPaint {
  return {
    fill: `--layout-section-${index}-fill`,
    edge: `--layout-section-${index}-edge`,
    out: `--layout-section-${index}-out`,
  };
}

/** The paint of a table in no section. */
export const NO_SECTION_PAINT: Paint = {
  fill: '--layout-no-section-fill',
  edge: '--layout-no-section-edge',
};

/** A colour as the drawing writes it on an element: a token of `base.css` by its name, or a CSS
 *  colour as it is (`white`). */
export function paintValue(colour: string): string {
  return colour.startsWith('--') ? `var(${colour})` : colour;
}

// ── A day's seats (T422) ─────────────────────────────────────────────────────

/** Which part of a table a seat holds: the whole, or the left or right half (D41). */
export type SeatHalf = 'whole' | 'left' | 'right';

/** How a held seat is drawn (D40): `filled` in its section's tint, `checkedOut` in the tint's
 *  darker out shade (T501), `outlined` white; each edged in its section's hue. Attendance draws
 *  checked in filled, checked out in the out shade and not checked in outlined; the public map,
 *  taken filled. */
export type SeatTone = 'filled' | 'checkedOut' | 'outlined';

/** How a table or a half is drawn on a day's map: by its seat's tone, or `free` with no seat. */
export type DrawnTone = SeatTone | 'free';

export const SEAT_TONES: readonly DrawnTone[] = ['filled', 'checkedOut', 'outlined', 'free'];

/** One seat of a day, as the map draws it: its `key` is the caller's own (a vendor, a seat of
 *  the public answer), told back when the seat is pressed. */
export interface MapSeat {
  key: string;
  tableId: string;
  half: SeatHalf;
  tone: SeatTone;
  /** Who holds it, as the map names the seat to a screen reader. */
  name: string;
}

/** A tone's paint: its fill and edge, the edge's dashes when it has any, and its number's ink. */
export interface SeatPaint extends Paint {
  dashes?: string;
  ink: string;
}

/** The dashes of a free table's edge, in screen pixels. */
export const FREE_DASHES = '4 3';

/**
 * How a table or a half is painted in a tone, from its section's paint. Every tone numbers in
 * `--mm-black`, the one ink that reads at the 7:1 a table's number is held to on each of the four
 * fills (`contrast.test.ts`): a section's hue on white is as low as 3.83, the muted ink on the
 * floor 4.40. A checked-out seat's out shade stands 1.5:1 from the tint, so it is told from a
 * checked-in one by its lightness as well as by its name. A free table's edge is the grey of a
 * table in no section, which stands at 3:1 on the floor where the faint border token would not.
 */
export function seatPaint(tone: DrawnTone, section: SectionPaint): SeatPaint {
  if (tone === 'filled') return { fill: section.fill, edge: section.edge, ink: '--mm-black' };
  if (tone === 'checkedOut') return { fill: section.out, edge: section.edge, ink: '--mm-black' };
  if (tone === 'outlined') return { fill: 'white', edge: section.edge, ink: '--mm-black' };
  return {
    fill: '--layout-floor',
    edge: '--layout-no-section-edge',
    dashes: FREE_DASHES,
    ink: '--mm-black',
  };
}

export interface LayoutSection {
  section: SectionObject & { id: string };
  /** Its place in the section palette, 1 to 8. */
  color: number;
  paint: SectionPaint;
  /** Its tables, in number order. */
  tables: FloorplanTable[];
}

/**
 * The sections a layout draws, in the plan's order: those of its location, each with its colour
 * and its tables. A table whose section is gone, or is another location's, is in none of them.
 */
export function layoutSections(
  layout: Pick<FloorplanObject, 'locationId' | 'tables' | 'sectionStyles'>,
  sections: readonly SectionObject[],
): LayoutSection[] {
  const here = sections.filter(
    (section): section is SectionObject & { id: string } =>
      Boolean(section.id) &&
      Boolean(layout.locationId) &&
      section.location?.id === layout.locationId,
  );
  const colors = sectionColors(
    here.map((section) => section.id),
    layout.sectionStyles ?? [],
  );
  return here.map((section) => {
    const color = colors.get(section.id) ?? 1;
    return {
      section,
      color,
      paint: sectionPaint(color),
      // A table with a section and no number is no table of the section: it has no code.
      tables: layout.tables
        .filter((table) => table.sectionId === section.id && table.number !== null)
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
    };
  });
}

/** A table's code, "Gold row 5", as the server's `table_code_for` names it; null in no section. */
export function tableCode(
  table: Pick<FloorplanTable, 'number'>,
  section: Pick<SectionObject, 'name'> | null | undefined,
): string | null {
  return section && table.number !== null ? `${section.name} ${table.number}` : null;
}

/** A length in metres to one decimal, "12.4 m". */
export const metres = (mm: number) => `${(mm / 1000).toFixed(1)} m`;

/** Where a table's centre stands, in metres from the floorplan's top-left corner: "12.4 m, 6.1 m". */
export function placeInMetres(table: Pick<FloorplanTable, 'xMm' | 'yMm'>): string {
  return `${metres(table.xMm)}, ${metres(table.yMm)}`;
}

/** What a table is called on the map: "Gold row 5, Standard 6 ft", or "Table in no section,
 *  Standard 6 ft". A type that is not the market's is left unsaid. */
export function tableName(
  table: Pick<FloorplanTable, 'number'>,
  section: Pick<SectionObject, 'name'> | null | undefined,
  type: Pick<TableTypeObject, 'name'> | null | undefined,
): string {
  const what = tableCode(table, section) ?? 'Table in no section';
  return type ? `${what}, ${type.name}` : what;
}

/** What the map is called: "Upper Hall layout, 49 tables". */
export function mapName(locationName: string, tables: number): string {
  return `${locationName} layout, ${plural(tables, 'table', 'tables')}`;
}

let measurer: CanvasRenderingContext2D | null | undefined;

/**
 * How wide words are drawn in the app's type at a size and weight, in pixels, measured as the
 * browser would draw them: in Outfit, or in another of the app's families (the printed layout's
 * name is in Merge One). Where nothing can measure (a test's DOM has no canvas), it is reckoned
 * from Outfit's average letter, a little over half the size.
 */
export function textWidthPx(text: string, sizePx: number, weight = 600, family = 'Outfit'): number {
  if (measurer === undefined) {
    try {
      // jsdom says its canvas is not implemented by a console error; a user agent check spares it.
      measurer = /jsdom/i.test(globalThis.navigator?.userAgent ?? '')
        ? null
        : document.createElement('canvas').getContext('2d');
    } catch {
      measurer = null;
    }
  }
  if (measurer) {
    measurer.font = `${weight} ${sizePx}px '${family}', sans-serif`;
    return measurer.measureText(text).width;
  }
  return text.length * sizePx * 0.56;
}
