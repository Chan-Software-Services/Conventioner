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

// ── Filling its box, as the public map draws it (T465) ───────────────────────

describe('the day map without fills, as Attendance draws it', () => {
  it('renders exactly as before fills existed', () => {
    // LayoutMap stubbed, so the snapshot is the day map's own markup alone.
    wrapper = mount(DayMap, {
      props: {
        locations: publicDayLocations(ANSWER, imageUrl),
        tableTypes: TYPES,
        locationId: 'loc-upper',
        seats: publicSeats(ANSWER.seats, '2099-06-05'),
        picked: 'g1',
        marked: ['g2:right'],
        legend: LEGEND,
      },
      global: { stubs: { LayoutMap: true } },
    });
    expect(wrapper.html()).toMatchInlineSnapshot(`
      "<div data-v-d4ffb88c="" class="day-map" data-testid="day-map">
        <div data-v-d4ffb88c="" class="day-map__grid">
          <div data-v-203e6a75="" data-v-d4ffb88c="" class="filter-toggles day-map__locations" role="group" aria-label="Location" data-testid="day-map-locations"><button data-v-203e6a75="" type="button" class="btn btn--secondary btn--compact filter-toggles__toggle" aria-pressed="true" data-testid="day-map-locations-loc-upper"><span data-v-203e6a75="" class="filter-toggles__words" data-testid="day-map-locations-words">Upper Hall <!--v-if--></span></button><button data-v-203e6a75="" type="button" class="btn btn--secondary btn--compact filter-toggles__toggle" aria-pressed="false" data-testid="day-map-locations-loc-lower"><span data-v-203e6a75="" class="filter-toggles__words" data-testid="day-map-locations-words">Lower Hall <!--v-if--></span></button></div>
          <div data-v-d4ffb88c="" class="day-map__frame" style="aspect-ratio: 29999.999999999996 / 22500;">
            <layout-map-stub data-v-d4ffb88c="" layout="[object Object]" locationname="Upper Hall" sections="[object Object]" tabletypes="[object Object]" mode="read" imageurl="/api/public/markets/harbour/map/image/loc-upper" imageingrey="true" imagefaded="true" selection="" guides="" carried="" numbers="true" seats="[object Object],[object Object],[object Object]" marked="g1,g2:right"></layout-map-stub>
          </div>
          <div data-v-d4ffb88c="" class="day-map__zoom" role="group" aria-label="Zoom" data-testid="day-map-zoom"><button data-v-d4ffb88c="" type="button" class="btn btn--secondary btn--compact day-map__zoom-button" data-testid="day-map-zoom-out"><span data-v-d4ffb88c="" aria-hidden="true">-</span><span data-v-d4ffb88c="" class="visually-hidden">Zoom out</span></button><button data-v-d4ffb88c="" type="button" class="btn btn--secondary btn--compact day-map__zoom-button" data-testid="day-map-zoom-in"><span data-v-d4ffb88c="" aria-hidden="true">+</span><span data-v-d4ffb88c="" class="visually-hidden">Zoom in</span></button><button data-v-d4ffb88c="" type="button" class="btn btn--secondary btn--compact day-map__zoom-button" data-testid="day-map-fit"> Fit </button></div>
          <ul data-v-d4ffb88c="" class="day-map__legend" aria-label="Legend" data-testid="day-map-legend">
            <li data-v-d4ffb88c="" class="day-map__legend-item" data-tone="filled" data-testid="day-map-legend-item"><svg data-v-d4ffb88c="" class="day-map__swatch" viewBox="0 0 24 14" aria-hidden="true">
                <rect data-v-d4ffb88c="" x="0.75" y="0.75" width="22.5" height="12.5" rx="2" fill="var(--layout-section-1-fill)" stroke="var(--layout-section-1-edge)" stroke-width="1.5"></rect>
              </svg><span data-v-d4ffb88c="">Here</span></li>
            <li data-v-d4ffb88c="" class="day-map__legend-item" data-tone="outlined" data-testid="day-map-legend-item"><svg data-v-d4ffb88c="" class="day-map__swatch" viewBox="0 0 24 14" aria-hidden="true">
                <rect data-v-d4ffb88c="" x="0.75" y="0.75" width="22.5" height="12.5" rx="2" fill="white" stroke="var(--layout-section-1-edge)" stroke-width="1.5"></rect>
              </svg><span data-v-d4ffb88c="">Expected</span></li>
            <li data-v-d4ffb88c="" class="day-map__legend-item" data-tone="free" data-testid="day-map-legend-item"><svg data-v-d4ffb88c="" class="day-map__swatch" viewBox="0 0 24 14" aria-hidden="true">
                <rect data-v-d4ffb88c="" x="0.75" y="0.75" width="22.5" height="12.5" rx="2" fill="var(--layout-floor)" stroke="var(--layout-no-section-edge)" stroke-width="1.5" stroke-dasharray="4 3"></rect>
              </svg><span data-v-d4ffb88c="">No vendor</span></li>
          </ul>
        </div>
      </div>"
    `);
  });
});

describe('the day map filling its box, as the public map draws it', () => {
  const SLOT = '<ul data-testid="caller-legend"><li>Section A</li><li>Free table</li></ul>';

  let filled: VueWrapper | null = null;
  afterEach(() => {
    filled?.unmount();
    filled = null;
  });

  /** The day map filling its box, its legend slot holding the caller's two items. */
  function filling(props: Record<string, unknown> = {}) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.getAttribute('data-testid') !== 'layout-map') return new DOMRect(0, 0, 0, 0);
      return new DOMRect(0, 0, 1200, 900);
    });
    filled = mount(DayMap, {
      attachTo: document.body,
      props: {
        locations: publicDayLocations(ANSWER, imageUrl),
        tableTypes: TYPES,
        locationId: 'loc-upper',
        seats: publicSeats(ANSWER.seats, '2099-06-05'),
        picked: null,
        legend: [],
        fills: true,
        ...props,
      },
      slots: { legend: SLOT },
    });
    return filled;
  }

  it('marks its root as filling, which draws the zoom as a floating pill', () => {
    const map = filling();
    expect(map.get('[data-testid="day-map"]').classes()).toContain('day-map--fills');
    expect(map.get('[data-testid="day-map-zoom"]').findAll('button')).toHaveLength(3);
  });

  it('takes its box whole: the frame keeps no shape of the hall', () => {
    expect(filling().get('.day-map__frame').attributes('style')).toBeUndefined();
  });

  it('draws no location switch, even for two locations: the caller draws the choice', () => {
    const map = filling();
    expect(map.find('[data-testid="day-map-locations"]').exists()).toBe(false);
    expect(map.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Upper Hall layout, 2 tables',
    );
  });

  it("draws no legend list of its own, and the caller's legend in its slot", () => {
    const map = filling({ legend: LEGEND });
    expect(map.find('[data-testid="day-map-legend"]').exists()).toBe(false);
    const slot = map.get('.day-map__legend-slot');
    expect(slot.get('[data-testid="caller-legend"]').text()).toBe('Section AFree table');
  });

  it('draws no slot without fills', () => {
    const map = mount(DayMap, {
      props: {
        locations: publicDayLocations(ANSWER, imageUrl),
        tableTypes: TYPES,
        locationId: 'loc-upper',
        seats: [],
        picked: null,
        legend: LEGEND,
      },
      slots: { legend: SLOT },
      global: { stubs: { LayoutMap: true } },
    });
    expect(map.find('.day-map__legend-slot').exists()).toBe(false);
    expect(map.find('[data-testid="caller-legend"]').exists()).toBe(false);
    expect(map.get('[data-testid="day-map"]').classes()).not.toContain('day-map--fills');
    map.unmount();
  });
});

describe('the day map, for what a caller stands over its tables (T465)', () => {
  type Exposed = {
    targetRect: (tableId: string, half: string) => DOMRect | null;
    focusTarget: (tableId: string, half: string) => boolean;
    fit: () => void;
    floatingRects: () => DOMRect[];
  };

  it('tells viewed whenever its map does, as a zoom changes the part shown', async () => {
    const map = dayMap({ fills: true });
    await nextTick();
    const before = map.emitted('viewed')?.length ?? 0;
    await map.get('[data-testid="day-map-zoom-in"]').trigger('click');
    await nextTick();
    expect(map.emitted('viewed')).toHaveLength(before + 1);
    expect(map.emitted('viewed')!.at(-1)).toEqual([]);
  });

  it("passes on its map's targetRect, focusTarget and fit", async () => {
    const map = dayMap({ fills: true });
    const exposed = map.vm as unknown as Exposed;
    const g1 = new DOMRect(10, 20, 30, 40);
    const measured = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this.getAttribute('data-table-id') === 'g1' ? g1 : measured.call(this);
    });
    expect(exposed.targetRect('g1', 'whole')).toEqual(g1);
    expect(exposed.targetRect('nope', 'whole')).toBeNull();
    expect(exposed.focusTarget('g1', 'whole')).toBe(true);
    expect(document.activeElement).toBe(map.get('[data-table-id="g1"]').element);

    const width = () =>
      Number(map.get('[data-testid="layout-map"]').attributes('viewBox')!.split(' ')[2]);
    const whole = width();
    await map.get('[data-testid="day-map-zoom-in"]').trigger('click');
    expect(width()).toBeLessThan(whole);
    exposed.fit();
    await nextTick();
    expect(width()).toBeCloseTo(whole);
  });

  it('tells where what floats over its map stands: the zoom, and the legend slot when filling', async () => {
    const zoom = new DOMRect(880, 548, 108, 40);
    const legend = new DOMRect(12, 548, 300, 40);
    // Measured after the mount, whose own measure of the map's box it replaces.
    const floatingOf = (map: VueWrapper) => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        const id = this.getAttribute('data-testid');
        if (id === 'day-map-zoom') return zoom;
        if (id === 'day-map-legend-slot') return legend;
        return new DOMRect(0, 0, 0, 0);
      });
      return (map.vm as unknown as Exposed).floatingRects();
    };
    expect(floatingOf(dayMap({ fills: true }))).toEqual([zoom, legend]);
    wrapper!.unmount();
    const below = dayMap();
    expect(floatingOf(below)).toEqual([zoom]);
  });
});
