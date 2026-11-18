/**
 * Whether a day map draws a free part (T466): a table or a half nobody sits at that day, drawn in
 * the grey dashed outline a legend's "No vendor" names, so a legend names it only when the map
 * draws one. Pure: no store, no API.
 */
import { layoutSections, type MapSeat } from '@/components/layout/layoutDrawing';
import type { DayMapLocation } from './dayMap';

/**
 * True when one of the tables the map paints by a seat, numbered in one of the location's own
 * sections (`layoutSections`), has no whole seat and lacks a seat on at least one half: exactly the
 * parts `LayoutMap` paints `free`. A table in no section, or with no number, is drawn by no seat,
 * so it never counts.
 */
export function drawsAFreePart(
  location: Pick<DayMapLocation, 'layout' | 'sections'>,
  seats: readonly MapSeat[],
): boolean {
  const held = new Map<string, Set<MapSeat['half']>>();
  for (const seat of seats) {
    const halves = held.get(seat.tableId) ?? new Set();
    halves.add(seat.half);
    held.set(seat.tableId, halves);
  }
  return layoutSections(location.layout, location.sections).some(({ tables }) =>
    tables.some((table) => {
      const halves = held.get(table.id);
      return !halves?.has('whole') && !(halves?.has('left') && halves.has('right'));
    }),
  );
}
