/**
 * The locations Attendance's map can draw (T466 ticket 02), one rule the map and the page's
 * location select share: a location with an id, a layout with a scale, and a table numbered in one
 * of the location's own sections, in the plan's order, as the public map's server chooses them.
 * The open one is the one the address asks for when it is laid out, else the first.
 */
import { describe, expect, it } from 'vitest';
import type { FloorplanObject, FloorplanTable, SetupObject } from '@/assets/types/datatypes';
import { laidOutLocations, openLocationId } from '@/components/attendance/laidOutLocations';

const NORTH = { id: 'loc-north', name: 'North Wing' };
const SOUTH = { id: 'loc-south', name: 'South Wing' };
const ANNEX = { id: 'loc-annex', name: 'Annex' };
const AISLE_A = { id: 'sec-a', name: 'Aisle A', location: NORTH, tier: null, count: 2 };
const AISLE_B = { id: 'sec-b', name: 'Aisle B', location: SOUTH, tier: null, count: 1 };
const ANNEX_ROW = { id: 'sec-annex', name: 'Annex row', location: ANNEX, tier: null, count: 1 };

function table(id: string, sectionId: string | null, number: number | null): FloorplanTable {
  return { id, sectionId, number, tableTypeId: 'type-6ft', xMm: 1000, yMm: 1000, rotation: 0 };
}

function layout(locationId: string, tables: FloorplanTable[], scale: number | null = 0.03) {
  return {
    id: `fp-${locationId}`,
    locationId,
    revision: 1,
    scalePxPerUnit: scale,
    tables,
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  } as FloorplanObject;
}

/** North and South laid out, in the plan's order South then North; the Annex as each test makes it. */
function plan(annex?: FloorplanObject, changes: Partial<SetupObject> = {}): SetupObject {
  return {
    locations: [SOUTH, NORTH, ANNEX],
    sections: [AISLE_A, AISLE_B, ANNEX_ROW],
    floorplans: [
      layout(NORTH.id, [table('a1', AISLE_A.id, 1), table('a2', AISLE_A.id, 2)]),
      layout(SOUTH.id, [table('b1', AISLE_B.id, 1)]),
      ...(annex ? [annex] : []),
    ],
    ...changes,
  } as SetupObject;
}

const ids = (setup: SetupObject | null | undefined) => laidOutLocations(setup).map(({ id }) => id);

describe('laidOutLocations', () => {
  it("gives two laid out in the plan's order, each its name, layout and own sections", () => {
    const laidOut = laidOutLocations(plan());
    expect(laidOut.map(({ id, name }) => [id, name])).toEqual([
      [SOUTH.id, SOUTH.name],
      [NORTH.id, NORTH.name],
    ]);
    expect(laidOut[1]!.layout.id).toBe('fp-loc-north');
    expect(laidOut[1]!.sections).toEqual([AISLE_A]);
    expect(laidOut[0]!.sections).toEqual([AISLE_B]);
  });

  it('leaves out a location whose layout has no scale, or a scale of 0', () => {
    expect(ids(plan(layout(ANNEX.id, [table('x1', ANNEX_ROW.id, 1)], null)))).toEqual([
      SOUTH.id,
      NORTH.id,
    ]);
    expect(ids(plan(layout(ANNEX.id, [table('x1', ANNEX_ROW.id, 1)], 0)))).toEqual([
      SOUTH.id,
      NORTH.id,
    ]);
    expect(ids(plan(layout(ANNEX.id, [table('x1', ANNEX_ROW.id, 1)])))).toEqual([
      SOUTH.id,
      NORTH.id,
      ANNEX.id,
    ]);
  });

  it("leaves out a location whose tables are in no section of its own: none, or another's", () => {
    expect(ids(plan(layout(ANNEX.id, [table('x1', null, 1)])))).toEqual([SOUTH.id, NORTH.id]);
    expect(ids(plan(layout(ANNEX.id, [table('x1', AISLE_A.id, 1)])))).toEqual([SOUTH.id, NORTH.id]);
  });

  it('leaves out a location whose tables in its sections have no number', () => {
    expect(ids(plan(layout(ANNEX.id, [table('x1', ANNEX_ROW.id, null)])))).toEqual([
      SOUTH.id,
      NORTH.id,
    ]);
  });

  it('leaves out a location with no id, and gives none with no plan or no layouts', () => {
    const unnamed = plan(undefined, { locations: [{ name: 'South Wing' }, NORTH] });
    expect(ids(unnamed)).toEqual([NORTH.id]);
    expect(ids(undefined)).toEqual([]);
    expect(ids(null)).toEqual([]);
    expect(ids(plan(undefined, { floorplans: undefined }))).toEqual([]);
  });
});

describe('openLocationId', () => {
  const laidOut = laidOutLocations(plan());

  it('is the location asked for when it is laid out', () => {
    expect(openLocationId(laidOut, NORTH.id)).toBe(NORTH.id);
  });

  it('is the first laid out when the one asked for is not laid out, or none is asked', () => {
    expect(openLocationId(laidOut, ANNEX.id)).toBe(SOUTH.id);
    expect(openLocationId(laidOut, 'loc-gone')).toBe(SOUTH.id);
    expect(openLocationId(laidOut, '')).toBe(SOUTH.id);
  });

  it('is empty with nothing laid out', () => {
    expect(openLocationId([], NORTH.id)).toBe('');
  });
});
