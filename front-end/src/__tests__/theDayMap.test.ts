/**
 * The day map (T422 ticket 02): the one drawing of a layout on one market date, for the public
 * page and for Attendance. The helper turns the public answer's seats, and Attendance's roster
 * rows, into the drawing's seats; the component draws the location switch, the map with its zoom
 * and the legend, says what was picked, and reads no store and no API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TableTypeObject } from '@/assets/types/datatypes';
import { stylesOf, valueOf } from './support/sfcStyles';
import DayMap from '@/components/daymap/DayMap.vue';
import {
  UNNAMED_SEAT,
  publicDayLocations,
  publicSeats,
  rosterSeats,
  type DayMapLocation,
  type PublicMapAnswer,
  type RosterSeatRow,
} from '@/components/daymap/dayMap';

const TYPES: TableTypeObject[] = [
  { id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 },
];

/** A public answer as the server shapes it: two locations, a shared table, a vendor with no
 *  public name, and a seat on another day. */
const ANSWER: PublicMapAnswer = {
  marketName: 'Harbour Night Market',
  dates: ['2099-06-05', '2099-06-06'],
  tableTypes: [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
  locations: [
    {
      id: 'loc-upper',
      name: 'Upper Hall',
      sections: [{ id: 'sec-gold', name: 'Gold row' }],
      layout: {
        id: 'fp-upper',
        locationId: 'loc-upper',
        imageWidth: 800,
        imageHeight: 600,
        scalePxPerUnit: 800 / 30_000,
        hasImage: true,
        tables: [
          {
            id: 'g1',
            sectionId: 'sec-gold',
            number: 1,
            tableTypeId: 'type-6ft',
            xMm: 5000,
            yMm: 3000,
            rotation: 0,
          },
          {
            id: 'g2',
            sectionId: 'sec-gold',
            number: 2,
            tableTypeId: 'type-6ft',
            xMm: 7000,
            yMm: 3000,
            rotation: 0,
          },
        ],
        zones: [
          {
            id: 'z1',
            label: 'Stage',
            xMm: 12_000,
            yMm: 500,
            widthMm: 8000,
            depthMm: 3000,
            rotation: 30,
          },
        ],
        sectionStyles: [],
      },
    },
    {
      id: 'loc-lower',
      name: 'Lower Hall',
      sections: [{ id: 'sec-silver', name: 'Silver aisle' }],
      layout: {
        id: 'fp-lower',
        locationId: 'loc-lower',
        imageWidth: 800,
        imageHeight: 400,
        scalePxPerUnit: 800 / 20_000,
        hasImage: false,
        tables: [
          {
            id: 's1',
            sectionId: 'sec-silver',
            number: 1,
            tableTypeId: 'type-6ft',
            xMm: 4000,
            yMm: 4000,
            rotation: 0,
          },
        ],
        zones: [],
        sectionStyles: [{ sectionId: 'sec-silver', color: 3, labelAt: null }],
      },
    },
  ],
  seats: [
    {
      date: '2099-06-05',
      tableId: 'g1',
      half: 'whole',
      name: 'Acme Ceramics',
      website: 'https://acme.example',
      instagram: 'example_acme',
    },
    {
      date: '2099-06-05',
      tableId: 'g2',
      half: 'left',
      name: 'Bee Candles',
      website: null,
      instagram: null,
    },
    {
      date: '2099-06-05',
      tableId: 'g2',
      half: 'right',
      name: null,
      website: null,
      instagram: null,
    },
    {
      date: '2099-06-06',
      tableId: 's1',
      half: 'whole',
      name: 'Cog Prints',
      website: null,
      instagram: null,
    },
  ],
};

const imageUrl = (locationId: string) => `/api/public/markets/harbour/map/image/${locationId}`;

describe('the public answer as day map locations', () => {
  const [upper, lower] = publicDayLocations(ANSWER, imageUrl);

  it("draws each location's layout, its sections of it, and its image when it has one", () => {
    expect(upper.id).toBe('loc-upper');
    expect(upper.name).toBe('Upper Hall');
    expect(upper.layout.tables.map((t) => t.id)).toEqual(['g1', 'g2']);
    expect(upper.layout.zones[0].rotation).toBe(30);
    expect(upper.sections).toEqual([
      {
        id: 'sec-gold',
        name: 'Gold row',
        location: { id: 'loc-upper', name: 'Upper Hall' },
        tier: null,
        count: 0,
      },
    ]);
    expect(upper.imageUrl).toBe('/api/public/markets/harbour/map/image/loc-upper');
    expect(lower.imageUrl).toBe('');
    expect(lower.layout.sectionStyles).toEqual([
      { sectionId: 'sec-silver', color: 3, labelAt: null },
    ]);
  });
});

describe("the public answer's seats", () => {
  it('are the seats of the day, each taken, keyed by its table and half', () => {
    expect(publicSeats(ANSWER.seats, '2099-06-05')).toEqual([
      { key: 'g1:whole', tableId: 'g1', half: 'whole', tone: 'filled', name: 'Acme Ceramics' },
      { key: 'g2:left', tableId: 'g2', half: 'left', tone: 'filled', name: 'Bee Candles' },
      { key: 'g2:right', tableId: 'g2', half: 'right', tone: 'filled', name: UNNAMED_SEAT },
    ]);
    expect(publicSeats(ANSWER.seats, '2099-06-06').map((s) => s.key)).toEqual(['s1:whole']);
    expect(publicSeats(ANSWER.seats, '2099-06-07')).toEqual([]);
  });
});

describe("Attendance's roster rows as seats", () => {
  const locations = publicDayLocations(ANSWER, imageUrl);
  const row = (changes: Partial<RosterSeatRow>): RosterSeatRow => ({
    date: '2099-06-05',
    vendorEmail: 'vendor@example.com',
    vendorName: 'Vendor',
    tableCode: 'Gold row 1',
    tableChoice: 'Full Table',
    state: 'expected',
    ...changes,
  });

  it('draws here and here at another table filled, expected outlined, each half its own', () => {
    const { seats, notOnALayout } = rosterSeats(
      [
        row({ vendorEmail: 'a@example.com', vendorName: 'Acme', state: 'here' }),
        row({
          vendorEmail: 'b@example.com',
          vendorName: 'Bee',
          tableCode: 'Gold row 2',
          tableChoice: 'Half Table (Left)',
          state: 'here_elsewhere',
        }),
        row({
          vendorEmail: 'c@example.com',
          vendorName: 'Cog',
          tableCode: 'Gold row 2',
          tableChoice: 'Half Table (Right)',
          state: 'expected',
        }),
        row({
          vendorEmail: 'd@example.com',
          vendorName: 'Dot',
          tableCode: 'Silver aisle 1',
          state: 'expected',
        }),
      ],
      '2099-06-05',
      locations,
    );
    expect(seats).toEqual([
      { key: 'a@example.com', tableId: 'g1', half: 'whole', tone: 'filled', name: 'Acme' },
      { key: 'b@example.com', tableId: 'g2', half: 'left', tone: 'filled', name: 'Bee' },
      { key: 'c@example.com', tableId: 'g2', half: 'right', tone: 'outlined', name: 'Cog' },
      { key: 'd@example.com', tableId: 's1', half: 'whole', tone: 'outlined', name: 'Dot' },
    ]);
    expect(notOnALayout).toEqual([]);
  });

  it('leaves out other days and a check-in with no seat, and counts a table on no layout', () => {
    const away = row({ vendorEmail: 'e@example.com', tableCode: 'Bronze row 9' });
    const { seats, notOnALayout } = rosterSeats(
      [
        row({ date: '2099-06-06' }),
        row({ tableCode: null, tableChoice: null, state: 'here_without_seat' }),
        away,
      ],
      '2099-06-05',
      locations,
    );
    expect(seats).toEqual([]);
    expect(notOnALayout).toEqual([away]);
  });
});

// ── The component ────────────────────────────────────────────────────────────

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

const LEGEND = [
  { tone: 'filled' as const, label: 'Here' },
  { tone: 'outlined' as const, label: 'Expected' },
  { tone: 'free' as const, label: 'No vendor' },
];

function dayMap(props: Record<string, unknown> = {}, locations: DayMapLocation[] = []) {
  // The map's box, 1,200 by 900 px.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-testid') !== 'layout-map') return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, 0, 1200, 900);
  });
  wrapper = mount(DayMap, {
    attachTo: document.body,
    props: {
      locations: locations.length ? locations : publicDayLocations(ANSWER, imageUrl),
      tableTypes: TYPES,
      locationId: 'loc-upper',
      seats: publicSeats(ANSWER.seats, '2099-06-05'),
      picked: null,
      legend: LEGEND,
      ...props,
    },
  });
  return wrapper;
}

describe('the day map', () => {
  it('switches between two locations or more, the open one pressed', async () => {
    const map = dayMap();
    const group = map.get('[data-testid="day-map-locations"]');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-label')).toBe('Location');
    const switches = group.findAll('button');
    expect(switches.map((s) => s.text())).toEqual(['Upper Hall', 'Lower Hall']);
    expect(switches.map((s) => s.attributes('aria-pressed'))).toEqual(['true', 'false']);
    // The open one pressed again stays open.
    await switches[0].trigger('click');
    await switches[1].trigger('click');
    expect(map.emitted('update:locationId')).toEqual([['loc-lower']]);
  });

  it('draws no switch for one location', () => {
    const [upper] = publicDayLocations(ANSWER, imageUrl);
    const map = dayMap({}, [upper]);
    expect(map.find('[data-testid="day-map-locations"]').exists()).toBe(false);
  });

  it('draws the open location in read mode with its seats and its image', () => {
    const map = dayMap();
    const drawn = map.get('[data-testid="layout-map"]');
    expect(drawn.attributes('aria-label')).toBe('Upper Hall layout, 2 tables');
    expect(drawn.classes()).toContain('layout-map--read');
    expect(map.get('[data-testid="layout-map-image"]').attributes('href')).toBe(
      '/api/public/markets/harbour/map/image/loc-upper',
    );
    expect(map.get('[data-table-id="g1"]').attributes('aria-label')).toBe(
      'Gold row 1, Standard 6 ft, Acme Ceramics',
    );
    expect(map.findAll('[data-table-id="g2"] [role="button"]')).toHaveLength(2);
  });

  it('draws the location it is told', async () => {
    const map = dayMap({ locationId: 'loc-lower' });
    expect(map.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Lower Hall layout, 1 table',
    );
    expect(map.find('[data-testid="layout-map-image"]').exists()).toBe(false);
  });

  it('zooms by its buttons on the map, in, out and back to the whole', async () => {
    const map = dayMap();
    const zoom = map.get('[data-testid="day-map-zoom"]');
    expect(zoom.attributes('role')).toBe('group');
    expect(zoom.attributes('aria-label')).toBe('Zoom');
    const named = zoom.findAll('button').map((b) => b.text());
    expect(named).toEqual(['-Zoom out', '+Zoom in', 'Fit']);
    const width = () =>
      Number(map.get('[data-testid="layout-map"]').attributes('viewBox')!.split(' ')[2]);
    const whole = width();
    await map.get('[data-testid="day-map-zoom-in"]').trigger('click');
    expect(width()).toBeLessThan(whole);
    await map.get('[data-testid="day-map-zoom-out"]').trigger('click');
    expect(width()).toBeCloseTo(whole);
    await map.get('[data-testid="day-map-zoom-in"]').trigger('click');
    await map.get('[data-testid="day-map-fit"]').trigger('click');
    expect(width()).toBeCloseTo(whole);
  });

  it('names each tone in its legend, in order, each with its swatch', () => {
    const map = dayMap();
    const items = map.findAll('[data-testid="day-map-legend-item"]');
    expect(items.map((item) => item.text())).toEqual(['Here', 'Expected', 'No vendor']);
    expect(items.map((item) => item.attributes('data-tone'))).toEqual([
      'filled',
      'outlined',
      'free',
    ]);
    const swatch = items[2].get('rect');
    expect(swatch.attributes('fill')).toBe('var(--layout-floor)');
    expect(swatch.attributes('stroke-dasharray')).toBe('4 3');
  });

  it('says the table and the seat picked, and null for a table with no vendor', async () => {
    const map = dayMap();
    await map.get('[data-table-id="g2"] [data-half="right"]').trigger('click');
    await map.get('[data-table-id="g1"]').trigger('keydown', { key: 'Enter' });
    expect(map.emitted('pick')).toEqual([
      ['g2', 'g2:right'],
      ['g1', 'g1:whole'],
    ]);
    map.unmount();
    const lower = dayMap({ locationId: 'loc-lower' });
    await lower.get('[data-table-id="s1"]').trigger('click');
    expect(lower.emitted('pick')).toEqual([['s1', null]]);
  });

  it('marks the picked seat or table, and what it is told to mark', async () => {
    const map = dayMap({ picked: 'g2:left' });
    expect(map.findAll('[data-testid="layout-map-read"]')).toHaveLength(1);
    await map.setProps({ picked: 'g1', marked: ['g2:right'] });
    await nextTick();
    expect(map.findAll('[data-testid="layout-map-read"]')).toHaveLength(2);
  });

  it('draws no note and the switch by default, as the public map has them', () => {
    const map = dayMap();
    expect(map.find('[data-testid="day-map-note"]').exists()).toBe(false);
    expect(map.find('[data-testid="day-map-locations"]').exists()).toBe(true);
  });

  it("draws its note after the legend, the legend row's end", () => {
    const map = dayMap({ note: 'Updated just now' });
    const note = map.get('[data-testid="day-map-note"]');
    expect(note.text()).toBe('Updated just now');
    expect(note.element.tagName).toBe('P');
    expect(note.element.previousElementSibling).toBe(
      map.get('[data-testid="day-map-legend"]').element,
    );
  });

  it('draws no switch with locationSwitch off, for a page that draws its own', () => {
    const map = dayMap({ locationSwitch: false });
    expect(map.find('[data-testid="day-map-locations"]').exists()).toBe(false);
    // The grid opens on the map: nothing over it, not even an empty row.
    expect(map.get('.day-map__grid').element.firstElementChild?.classList).toContain(
      'day-map__frame',
    );
    expect(map.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Upper Hall layout, 2 tables',
    );
  });

  it("stands the note at the legend row's end, 4px under the map, small and muted, and under the legend in a phone's box", () => {
    const styles = stylesOf('daymap/DayMap.vue');
    const PHONE = '(width < 30rem)';
    const areas = (selector: string, query = '') =>
      valueOf(styles, selector, 'grid-template-areas', query)?.replace(/\s+/g, ' ');
    // With no note the legend keeps the whole row, and a phone's box adds no row for it.
    expect(areas('.day-map__grid')).toBe("'map map' 'legend legend'");
    expect(areas('.day-map__grid:has(> .day-map__note)')).toBe("'map map' 'legend note'");
    expect(areas('.day-map__grid', PHONE)).toBe("'map map' 'legend zoom'");
    expect(areas('.day-map__grid:has(> .day-map__note)', PHONE)).toBe(
      "'map map' 'legend zoom' 'note note'",
    );
    // The switch stands over the grid, its gap's 12px its own, so a map with no switch keeps no
    // empty row and no gap over the map (T466).
    const everyArea: string[] = [];
    styles.walkDecls('grid-template-areas', (decl) => {
      everyArea.push(decl.value);
    });
    expect(everyArea).toHaveLength(4);
    for (const value of everyArea) expect(value).not.toContain("'switch");
    expect(valueOf(styles, '.day-map__locations', 'margin-block-end')).toBe('var(--space-3)');
    const note = (property: string) => valueOf(styles, '.day-map__note', property);
    expect(note('grid-area')).toBe('note');
    expect(note('align-self')).toBe('start');
    // The grid's 12px gap less 8px leaves the note 4px under the map.
    expect(note('margin')).toBe('calc(-1 * var(--space-2)) 0 0');
    expect(note('text-align')).toBe('end');
    expect(note('font-size')).toBe('var(--text-xs)');
    expect(note('color')).toBe('var(--mm-text-muted)');
  });

  it('reads no store and no API: its data is all handed to it', () => {
    for (const file of ['DayMap.vue', 'dayMap.ts']) {
      const source = readFileSync(
        resolvePath(process.cwd(), 'src/components/daymap', file),
        'utf8',
      );
      expect(source, file).not.toMatch(/@\/stores|pinia|@\/utils\/api|axios|fetch\(/);
    }
  });
});
