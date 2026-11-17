/**
 * The public map's vendor search (T465 ticket 06): each vendor of the day as an entry built field by
 * field from what the server published (D26), found by the public name, the website's host, the
 * Instagram handle, the table code or the section name, and never by anything else a seat carries.
 */
import { describe, expect, it } from 'vitest';
import type { PublicMapAnswer, PublicMapSeat } from '@/components/daymap/dayMap';
import {
  findsVendor,
  publicVendorEntries,
  type PublicVendorEntry,
} from '@/components/publicmap/publicMapSearch';
import { ANSWER, TODAY, TOMORROW } from './support/publicMapAnswer';

const entries = (map: PublicMapAnswer = ANSWER, date = TODAY) => publicVendorEntries(map, date);
const found = (words: string, map: PublicMapAnswer = ANSWER) =>
  entries(map)
    .filter((entry) => findsVendor(entry, words))
    .map((entry) => entry.name);

/** The answer with a section of a short name, "A", whose table 13 reads "A 13". */
const SHORT_CODES: PublicMapAnswer = {
  ...ANSWER,
  locations: [
    {
      ...ANSWER.locations[0]!,
      sections: [{ id: 'sec-gold', name: 'A' }],
      layout: {
        ...ANSWER.locations[0]!.layout,
        tables: ANSWER.locations[0]!.layout.tables.map((table, at) => ({
          ...table,
          number: at === 0 ? 13 : at + 1,
        })),
      },
    },
    ANSWER.locations[1]!,
  ],
};

/** A seat that carries more than the allowlist, as a server fault would send it. */
const LEAKED = {
  email: 'kiln.owner@example.com',
  fullName: 'Morgan Example',
  preferredName: 'Mo',
};
const LEAKY: PublicMapAnswer = {
  ...ANSWER,
  seats: ANSWER.seats.map((seat) =>
    seat.tableId === 'g1' ? ({ ...seat, ...LEAKED } as PublicMapSeat) : seat,
  ),
};

describe("the public search's entries", () => {
  it('are the named vendors of the day, by name, each exactly the nine public fields', () => {
    expect(entries()).toEqual<PublicVendorEntry[]>([
      {
        key: 'g2:left',
        name: 'Acme Ceramics',
        tableId: 'g2',
        code: 'Gold row 2',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
        sectionName: 'Gold row',
        website: null,
        instagram: 'example_acme',
      },
      {
        key: 'g2:right',
        name: 'Bee Candles',
        tableId: 'g2',
        code: 'Gold row 2',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
        sectionName: 'Gold row',
        website: null,
        instagram: null,
      },
      {
        key: 's1:whole',
        name: 'Cog Prints',
        tableId: 's1',
        code: 'Silver aisle 1',
        locationId: 'loc-lower',
        locationName: 'Lower Hall',
        sectionName: 'Silver aisle',
        website: null,
        instagram: null,
      },
      {
        key: 'g1:whole',
        name: 'Kiln & Co',
        tableId: 'g1',
        code: 'Gold row 1',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
        sectionName: 'Gold row',
        website: 'www.kiln-and-co.example',
        instagram: 'example_kiln',
      },
    ]);
    expect(entries(ANSWER, TOMORROW).map((entry) => entry.name)).toEqual(['Dune Glass']);
  });

  it('leave out a vendor with no public name', () => {
    expect(entries().map((entry) => entry.tableId)).not.toContain('g3');
  });

  it('copy nothing past the public fields, though a seat carries more', () => {
    const kiln = entries(LEAKY).find((entry) => entry.tableId === 'g1')!;
    expect(Object.keys(kiln).sort()).toEqual(
      [
        'code',
        'instagram',
        'key',
        'locationId',
        'locationName',
        'name',
        'sectionName',
        'tableId',
        'website',
      ].sort(),
    );
    expect(JSON.stringify(entries(LEAKY))).not.toMatch(/kiln\.owner|Morgan|"Mo"/);
  });

  it('hold a website only as its host, and a handle only as the link helpers take it', () => {
    const odd: PublicMapAnswer = {
      ...ANSWER,
      seats: ANSWER.seats.map((seat) =>
        seat.tableId === 'g1'
          ? { ...seat, website: 'javascript:alert(1)', instagram: 'not a handle' }
          : seat,
      ),
    };
    const kiln = entries(odd).find((entry) => entry.tableId === 'g1')!;
    expect(kiln.website).toBeNull();
    expect(kiln.instagram).toBeNull();
  });
});

describe('what the words find', () => {
  it('finds every vendor for no words, or for spaces alone', () => {
    expect(found('')).toEqual(['Acme Ceramics', 'Bee Candles', 'Cog Prints', 'Kiln & Co']);
    expect(found('   ')).toHaveLength(4);
  });

  it('finds by the public name, capitals and runs of spaces aside', () => {
    expect(found('kiln')).toEqual(['Kiln & Co']);
    expect(found('  KILN   &  co ')).toEqual(['Kiln & Co']);
  });

  it("finds by the website's host", () => {
    expect(found('kiln-and-co.example')).toEqual(['Kiln & Co']);
    expect(found('shop')).toEqual([]);
  });

  it('finds by the Instagram handle, with or without its "@"', () => {
    expect(found('example_acme')).toEqual(['Acme Ceramics']);
    expect(found('@example_acme')).toEqual(['Acme Ceramics']);
    expect(found('@')).toEqual([]);
  });

  it('finds by the table code, its spaces aside', () => {
    expect(found('silver aisle 1')).toEqual(['Cog Prints']);
    expect(found('a13', SHORT_CODES)).toEqual(['Kiln & Co']);
    expect(found('A 13', SHORT_CODES)).toEqual(['Kiln & Co']);
    expect(found('a 1 3', SHORT_CODES)).toEqual(['Kiln & Co']);
  });

  it('finds by the section name', () => {
    expect(found('gold row')).toEqual(['Acme Ceramics', 'Bee Candles', 'Kiln & Co']);
    expect(found('silver')).toEqual(['Cog Prints']);
  });

  it("never finds by the hall's name, or by what the server should not have sent", () => {
    expect(found('upper hall')).toEqual([]);
    for (const value of Object.values(LEAKED)) expect(found(value, LEAKY)).toEqual([]);
  });
});
