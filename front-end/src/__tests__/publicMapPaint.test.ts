/**
 * The public map's paints (T465): each table's section colours, as the code pills read them, and
 * the open hall's legend, one item for each section drawn there and "Free table" only on a day the
 * hall draws a free table or half; a no-table zone is never an item.
 */
import { describe, expect, it } from 'vitest';
import {
  publicDayLocations,
  publicSeats,
  type PublicMapAnswer,
  type PublicMapSeat,
} from '@/components/daymap/dayMap';
import { hallLegend, sectionLabel, tablePaints } from '@/components/publicmap/publicMapPaint';
import { ANSWER, TODAY, TOMORROW } from './support/publicMapAnswer';

const table = (id: string, sectionId: string, number: number, xMm: number) => ({
  id,
  sectionId,
  number,
  tableTypeId: 'type-6ft',
  xMm,
  yMm: 3000,
  rotation: 0,
});

const seat = (tableId: string, half: PublicMapSeat['half']): PublicMapSeat => ({
  date: TODAY,
  tableId,
  half,
  name: `At ${tableId} ${half}`,
  website: null,
  instagram: null,
});

/** One hall of two sections, "A" and "Aisle B", a third with no table, and a stage zone. */
function twoSections(seats: PublicMapSeat[]): PublicMapAnswer {
  return {
    ...ANSWER,
    locations: [
      {
        id: 'loc-hall',
        name: 'Main Hall',
        sections: [
          { id: 'sec-a', name: 'A' },
          { id: 'sec-empty', name: 'Empty row' },
          { id: 'sec-b', name: 'Aisle B' },
        ],
        layout: {
          id: 'fp-hall',
          locationId: 'loc-hall',
          imageWidth: 800,
          imageHeight: 600,
          scalePxPerUnit: 800 / 30_000,
          hasImage: false,
          tables: [table('a1', 'sec-a', 1, 4000), table('b1', 'sec-b', 1, 9000)],
          zones: [
            {
              id: 'zone-stage',
              label: 'Stage',
              xMm: 15_000,
              yMm: 2000,
              widthMm: 4000,
              depthMm: 2000,
              rotation: 0,
            },
          ],
          sectionStyles: [],
        },
      },
    ],
    seats,
  };
}

const legendOf = (answer: PublicMapAnswer, date = TODAY, at = 0) =>
  hallLegend(publicDayLocations(answer, () => '')[at], publicSeats(answer.seats, date));

describe("a section's label", () => {
  it('reads "Section <name>" for a name of three characters or fewer', () => {
    expect(sectionLabel('A')).toBe('Section A');
    expect(sectionLabel('B2')).toBe('Section B2');
    expect(sectionLabel(' B12 ')).toBe('Section B12');
  });

  it('is the name as it is from four characters on', () => {
    expect(sectionLabel('Gold')).toBe('Gold');
    expect(sectionLabel('Aisle A')).toBe('Aisle A');
  });
});

describe("the hall's legend", () => {
  it('names the one section of a hall in its colours, and a free table on a day it has one', () => {
    // Today Gold row 4 is free.
    expect(legendOf(ANSWER)).toEqual([
      {
        kind: 'section',
        label: 'Gold row',
        fill: 'var(--layout-section-1-fill)',
        edge: 'var(--layout-section-1-edge)',
        dashed: false,
      },
      {
        kind: 'free',
        label: 'Free table',
        fill: 'var(--layout-floor)',
        edge: 'var(--layout-no-section-edge)',
        dashed: true,
      },
    ]);
  });

  it("names each section with a table, in the plan's order, and never a zone", () => {
    const items = legendOf(twoSections([seat('a1', 'whole'), seat('b1', 'whole')]));
    expect(items.map((item) => [item.kind, item.label])).toEqual([
      ['section', 'Section A'],
      ['section', 'Aisle B'],
    ]);
    expect(items[0].fill).not.toBe(items[1].fill);
    expect(items.some((item) => item.label === 'Stage')).toBe(false);
  });

  it('holds no "Free table" on a day every table and half is taken', () => {
    const items = legendOf(
      twoSections([seat('a1', 'left'), seat('a1', 'right'), seat('b1', 'whole')]),
    );
    expect(items.map((item) => item.kind)).toEqual(['section', 'section']);
  });

  it('holds "Free table" for a whole table with nobody at it', () => {
    const items = legendOf(twoSections([seat('a1', 'whole')]));
    expect(items.at(-1)).toMatchObject({ kind: 'free', label: 'Free table' });
  });

  it('holds "Free table" for a half with nobody, beside a half that is taken', () => {
    const items = legendOf(twoSections([seat('a1', 'left'), seat('b1', 'whole')]));
    expect(items.map((item) => item.kind)).toEqual(['section', 'section', 'free']);
  });

  it("reads the open hall's tables alone, on the day given", () => {
    // Tomorrow Gold row 1 to 3 are free in Upper Hall; Lower Hall's one table too.
    expect(legendOf(ANSWER, TOMORROW).at(-1)?.kind).toBe('free');
    expect(legendOf(ANSWER, TODAY, 1).map((item) => item.label)).toEqual(['Silver aisle']);
  });

  it('is empty for no open hall', () => {
    expect(hallLegend(undefined, [])).toEqual([]);
  });
});

describe("each table's paint", () => {
  it("is its section's fill and edge, as CSS values, at every hall", () => {
    const paints = tablePaints(publicDayLocations(ANSWER, () => ''));
    expect(paints.get('g1')).toEqual({
      fill: 'var(--layout-section-1-fill)',
      edge: 'var(--layout-section-1-edge)',
    });
    expect([...paints.keys()].sort()).toEqual(['g1', 'g2', 'g3', 'g4', 's1']);
  });

  it('gives two sections of a hall each their own colour, and a table in none no paint', () => {
    const answer = twoSections([]);
    answer.locations[0].layout.tables.push(table('loose', 'sec-gone', 1, 20_000));
    const paints = tablePaints(publicDayLocations(answer, () => ''));
    expect(paints.get('a1')?.fill).not.toBe(paints.get('b1')?.fill);
    expect(paints.has('loose')).toBe(false);
  });
});
