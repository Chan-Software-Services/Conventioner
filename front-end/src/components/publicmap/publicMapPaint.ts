/**
 * The colours the public map paints in, from each section's style (T465): a table's fill and edge,
 * which the code pills of the card and the vendor list read, and the open hall's legend, which
 * names each section drawn there in its colours and a free table only on a day the hall draws one.
 * A no-table zone is never an item: the zones and their labels stay on the map to orient by.
 */
import type { DayMapLocation } from '@/components/daymap/dayMap';
import {
  layoutSections,
  paintValue,
  seatPaint,
  sectionPaint,
  type MapSeat,
  type Paint,
} from '@/components/layout/layoutDrawing';

/** A table's fill and edge, as CSS colour values. */
export interface TablePaint {
  fill: string;
  edge: string;
}

/** One item of the public map's legend: a section in its colours, or a free table, dashed. */
export interface PublicMapLegendItem {
  kind: 'section' | 'free';
  label: string;
  /** CSS colour values. */
  fill: string;
  edge: string;
  dashed: boolean;
}

const cssPaint = (paint: Paint): TablePaint => ({
  fill: paintValue(paint.fill),
  edge: paintValue(paint.edge),
});

/** Each table in a section of a hall, by its id, in its section's colours. */
export function tablePaints(locations: readonly DayMapLocation[]): Map<string, TablePaint> {
  const paints = new Map<string, TablePaint>();
  for (const location of locations) {
    for (const { paint, tables } of layoutSections(location.layout, location.sections)) {
      for (const table of tables) if (!paints.has(table.id)) paints.set(table.id, cssPaint(paint));
    }
  }
  return paints;
}

/** A section as the legend names it: "Section A" for a short name, else the name as it is, so a
 *  section never reads "Section Aisle A". */
export function sectionLabel(name: string): string {
  const short = name.trim();
  return short.length <= 3 ? `Section ${short}` : name;
}

export const FREE_TABLE = 'Free table';

/**
 * The open hall's legend on a day: each of its sections with a table drawn, in the plan's order,
 * and "Free table" when a table or a half of it is drawn free on the day, as `LayoutMap` draws
 * them: a table with no whole seat and no half seat, or a half with no seat beside one that has.
 * `seats` are the open day's.
 */
export function hallLegend(
  location: DayMapLocation | undefined,
  seats: readonly MapSeat[],
): PublicMapLegendItem[] {
  if (!location) return [];
  const drawn = layoutSections(location.layout, location.sections).filter(
    ({ tables }) => tables.length,
  );
  const items: PublicMapLegendItem[] = drawn.map(({ section, paint }) => ({
    kind: 'section',
    label: sectionLabel(section.name),
    ...cssPaint(paint),
    dashed: false,
  }));
  const held = (tableId: string, half: MapSeat['half']) =>
    seats.some((seat) => seat.tableId === tableId && seat.half === half);
  const hasFree = drawn.some(({ tables }) =>
    tables.some(
      (table) => !held(table.id, 'whole') && (!held(table.id, 'left') || !held(table.id, 'right')),
    ),
  );
  if (hasFree) {
    const free = seatPaint('free', sectionPaint(1));
    items.push({
      kind: 'free',
      label: FREE_TABLE,
      ...cssPaint(free),
      dashed: Boolean(free.dashes),
    });
  }
  return items;
}
