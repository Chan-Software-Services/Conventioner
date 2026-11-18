/**
 * Whether a day map draws a free part (T466 ticket 02): a table or a half nobody sits at, drawn in
 * the grey dashed outline the legend's "No vendor" names. Only the tables the map paints by a
 * seat count, those numbered in one of the location's sections, exactly as `LayoutMap` paints a
 * part `free`: a table with no whole seat and no seat on a half, or the half of a shared table
 * that has none.
 */
import { describe, expect, it } from 'vitest';
import type { FloorplanObject, FloorplanTable } from '@/assets/types/datatypes';
import { drawsAFreePart } from '@/components/daymap/freeParts';
import type { MapSeat, SeatHalf } from '@/components/layout/layoutDrawing';

const NORTH = { id: 'loc-north', name: 'North Wing' };
const AISLE = { id: 'sec-aisle', name: 'Aisle A', location: NORTH, tier: null, count: 3 };
/** Another location's section, whose tables this map draws in no section. */
const ELSEWHERE = {
  id: 'sec-b',
  name: 'Aisle B',
  location: { id: 'loc-south', name: 'South Wing' },
  tier: null,
  count: 1,
};

function table(id: string, sectionId: string | null, number: number | null): FloorplanTable {
  return { id, sectionId, number, tableTypeId: 'type-6ft', xMm: 1000, yMm: 1000, rotation: 0 };
}

const NUMBERED = [table('t1', AISLE.id, 1), table('t2', AISLE.id, 2), table('t3', AISLE.id, 3)];

function location(tables: FloorplanTable[]) {
  const layout = {
    id: 'fp-north',
    locationId: NORTH.id,
    revision: 1,
    scalePxPerUnit: 0.03,
    tables,
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  } as FloorplanObject;
  return { layout, sections: [AISLE, ELSEWHERE] };
}

function seat(tableId: string, half: SeatHalf = 'whole'): MapSeat {
  return { key: `${tableId}:${half}`, tableId, half, tone: 'outlined', name: 'A vendor' };
}

/** Every numbered table held whole. */
const FULL = [seat('t1'), seat('t2'), seat('t3')];

describe('drawsAFreePart', () => {
  it('is false when every numbered table is held, whole or by both halves', () => {
    expect(drawsAFreePart(location(NUMBERED), FULL)).toBe(false);
    const shared = [seat('t1'), seat('t2'), seat('t3', 'left'), seat('t3', 'right')];
    expect(drawsAFreePart(location(NUMBERED), shared)).toBe(false);
  });

  it('is true when a numbered table has nobody at it', () => {
    expect(drawsAFreePart(location(NUMBERED), [seat('t1'), seat('t3')])).toBe(true);
    expect(drawsAFreePart(location(NUMBERED), [])).toBe(true);
  });

  it('is true when one half of a shared table has nobody, either half', () => {
    expect(drawsAFreePart(location(NUMBERED), [seat('t1'), seat('t2'), seat('t3', 'left')])).toBe(
      true,
    );
    expect(drawsAFreePart(location(NUMBERED), [seat('t1'), seat('t2'), seat('t3', 'right')])).toBe(
      true,
    );
  });

  it('is false for a table held whole though a half of it is also given', () => {
    const both = [seat('t1'), seat('t2'), seat('t3'), seat('t3', 'left')];
    expect(drawsAFreePart(location(NUMBERED), both)).toBe(false);
  });

  it("leaves out a table in no section, or in another location's, which the map paints by no seat", () => {
    expect(drawsAFreePart(location([...NUMBERED, table('loose', null, 4)]), FULL)).toBe(false);
    expect(drawsAFreePart(location([...NUMBERED, table('away', ELSEWHERE.id, 1)]), FULL)).toBe(
      false,
    );
  });

  it('leaves out a table with no number, which has no code a seat can name', () => {
    expect(drawsAFreePart(location([...NUMBERED, table('blank', AISLE.id, null)]), FULL)).toBe(
      false,
    );
  });

  it("reads only the location's own tables: a seat at another location's table frees nothing", () => {
    expect(drawsAFreePart(location(NUMBERED), [...FULL, seat('elsewhere')])).toBe(false);
    expect(drawsAFreePart(location(NUMBERED), [seat('t1'), seat('t2'), seat('elsewhere')])).toBe(
      true,
    );
  });
});
