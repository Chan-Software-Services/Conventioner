/**
 * The door as a map (T422 ticket 10): Attendance switches from its list to a map of the open day,
 * each table drawn by whether its vendor is here, expected or absent from the plan, kept fresh as
 * the list is. A press on a vendor's table opens their drawer as a press on their row does, each
 * half of a shared table its own vendor; a table with no vendor says so and opens nothing. The
 * map's search finds one vendor of the day, and picking them opens their drawer and outlines their
 * table, in the other location when they sit there (T466); the vendors the map cannot draw are
 * counted under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import type { LocationQuery } from 'vue-router';

import AttendanceStatusView, { REREAD_MS } from '@/views/AttendanceStatusView.vue';
import AttendanceMap from '@/components/attendance/AttendanceMap.vue';
import { MarketPhase, type FloorplanTable, type Market } from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { calendarToday } from '@/utils/marketGuide';
import { getShortDate } from '@/utils/utils';
import { answersRefusing, VIEWER_ANSWERS } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

const route = reactive<{ params: Record<string, string>; query: LocationQuery }>({
  params: { marketId: 'market-1' },
  query: {},
});
const router = {
  push: vi.fn(({ query }: { query: LocationQuery }) => {
    route.query = query;
    return Promise.resolve();
  }),
  replace: vi.fn(({ query }: { query: LocationQuery }) => {
    route.query = query;
    return Promise.resolve();
  }),
  back: vi.fn(),
  afterEach: vi.fn(),
  resolve: vi.fn(),
  options: { history: { state: {} } },
};

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => router,
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: ref(marketNow), status: ref('loaded'), refresh: vi.fn() }),
}));
vi.mock('@/utils/vendorDetails', () => ({
  useVendorDetails: () => ({ loaded: { value: false }, load: vi.fn() }),
}));

const TODAY = calendarToday();
const ARRIVED = '2099-08-01T09:41:00Z';
const NORTH = { id: 'loc-north', name: 'North Wing' };
const AISLE = { id: 'sec-aisle', name: 'Aisle A' };

const ANA = 'ana@example.com';
const BEN = 'ben@example.com';
const CAL = 'cal@example.com';
const DEE = 'dee@example.com';
const EVE = 'eve@example.com';
const FAY = 'fay@example.com';

function table(id: string, number: number, xMm: number): FloorplanTable {
  return { id, sectionId: AISLE.id, number, tableTypeId: 'type-6ft', xMm, yMm: 3000, rotation: 0 };
}

/** North Wing laid out, its Aisle A of four tables in a row, 30 m across. */
const LAID_OUT = {
  locations: [NORTH],
  sections: [{ ...AISLE, location: NORTH, tier: null, count: 4 }],
  tableTypes: [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
  floorplans: [
    {
      id: 'fp-north',
      locationId: NORTH.id,
      revision: 1,
      imageGridfsId: null,
      imageWidth: 800,
      imageHeight: 600,
      scalePxPerUnit: 800 / 30_000,
      tables: [
        table('t1', 1, 4000),
        table('t2', 2, 6400),
        table('t3', 3, 8800),
        table('t4', 4, 11_200),
      ],
      zones: [],
      sectionStyles: [],
      startingCounts: [],
    },
  ],
};

function market(changes: Partial<Market> = {}, setup: object = LAID_OUT): Market {
  return {
    id: 'market-1',
    name: 'Spring Market',
    phase: MarketPhase.MarketDays,
    actionRefusals: answersRefusing(),
    setupObject: setup,
    ...changes,
  } as unknown as Market;
}
let marketNow: Market = market();

interface Row {
  date: string;
  vendorEmail: string;
  vendorName: string;
  /** The name on their identification, served beside the one shown (T466). */
  vendorFullName?: string;
  tableCode: string | null;
  tableChoice: string | null;
  section: string | null;
  location: string | null;
  state: 'expected' | 'here' | 'here_elsewhere' | 'here_without_seat';
  checkedInTableCode: string | null;
  checkedInAt: string | null;
  checkedInBy: string | null;
  checkedInVia: string | null;
  checkedOutAt?: string | null;
}

function row(email: string, name: string, tableCode: string | null, extra: Partial<Row> = {}) {
  return {
    date: TODAY,
    vendorEmail: email,
    vendorName: name,
    tableCode,
    tableChoice: 'Full Table',
    section: 'Aisle A',
    location: NORTH.name,
    state: 'expected',
    checkedInTableCode: null,
    checkedInAt: null,
    checkedInBy: null,
    checkedInVia: null,
    ...extra,
  } as Row;
}
const here = (at: string | null): Partial<Row> => ({
  state: 'here',
  checkedInTableCode: at,
  checkedInAt: ARRIVED,
});
const LEFT = '2099-08-01T15:02:00Z';
/** Checked in at `at`, and checked out since (T496). */
const out = (at: string | null): Partial<Row> => ({ ...here(at), checkedOutAt: LEFT });

/**
 * Ana here at Aisle A 1; Ben expected at 2; 3 shared, Cal here on its left half and Dee expected
 * on its right; 4 free. Eve checked in with no table, and Fay's table is on no layout.
 */
function day(changes: Record<string, Partial<Row>> = {}) {
  const rows = [
    row(ANA, 'Ana Pottery', 'Aisle A 1', here('Aisle A 1')),
    row(BEN, 'Ben Prints', 'Aisle A 2'),
    row(CAL, 'Cal Knits', 'Aisle A 3', { tableChoice: 'Half Table (Left)', ...here('Aisle A 3') }),
    row(DEE, 'Dee Soaps', 'Aisle A 3', { tableChoice: 'Half Table (Right)' }),
    row(EVE, 'Eve Jams', null, { ...here('Aisle A 9'), state: 'here_without_seat' }),
    row(FAY, 'Fay Candles', 'Annex 7', { section: 'Annex', location: 'Annex' }),
  ].map((one) => ({ ...one, ...changes[one.vendorEmail] }));
  return { data: { dates: [TODAY], roster: rows } };
}

const ROSTER_URL = '/markets/market-1/attendance';
let answer = day();

let visibility: DocumentVisibilityState = 'visible';

async function open(): Promise<VueWrapper> {
  const measured = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-testid') !== 'layout-map') return measured.call(this);
    const [, , widthMm, heightMm] = (this.getAttribute('viewBox') ?? '0 0 0 0')
      .split(' ')
      .map(Number);
    return new DOMRect(0, 0, widthMm * 0.04, heightMm * 0.04);
  });
  const wrapper = mount(AttendanceStatusView, {
    attachTo: document.body,
    global: {
      stubs: {
        MarketFrame: { template: '<div><slot /></div>' },
        VendorDrawer: true,
        DoorCodeScreen: true,
        VendorNotes: true,
        RouterLink: {
          props: ['to'],
          template: '<a :href="String(to)" v-bind="$attrs"><slot /></a>',
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

async function openOnMap(): Promise<VueWrapper> {
  route.query = { view: 'map' };
  return open();
}

const testid = (id: string) => `[data-testid="${id}"]`;
const tableOf = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-table-id="${id}"]`);
const halfOf = (wrapper: VueWrapper, id: string, side: 'left' | 'right') =>
  tableOf(wrapper, id).get(`[data-half="${side}"]`);
/** A whole table's top's fill: its section's colour when filled, white when outlined. */
const fillOf = (wrapper: VueWrapper, id: string) =>
  tableOf(wrapper, id).get(testid('layout-table-top')).attributes('fill');
const halfFill = (wrapper: VueWrapper, id: string, side: 'left' | 'right') =>
  halfOf(wrapper, id, side).get('path').attributes('fill');
/** The map's marks: a rectangle round a whole table, a path round a half. */
const marks = (wrapper: VueWrapper) => wrapper.findAll(testid('layout-map-read'));
/** What a line says, its words' spacing as a reader hears it. */
const words = (wrapper: VueWrapper, id: string) =>
  wrapper.get(testid(id)).text().replace(/\s+/g, ' ');

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  router.push.mockImplementation(({ query }: { query: LocationQuery }) => {
    route.query = query;
    return Promise.resolve();
  });
  router.replace.mockImplementation(({ query }: { query: LocationQuery }) => {
    route.query = query;
    return Promise.resolve();
  });
  router.options.history.state = {};
  route.query = {};
  marketNow = market();
  answer = day();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  localStorage.setItem('user', JSON.stringify({ email: 'org@example.com' }));
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url === ROSTER_URL ? answer : { data: {} }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('List and Map', () => {
  it('stand in the tools row, List pressed and the list shown, with no map', async () => {
    const wrapper = await open();
    const tools = wrapper.get(testid('attendance-toolbar'));
    const list = tools.get(testid('attendance-view-list'));
    const map = tools.get(testid('attendance-view-map'));
    expect([list.text(), map.text()]).toEqual(['List', 'Map']);
    expect(list.attributes('aria-pressed')).toBe('true');
    expect(map.attributes('aria-pressed')).toBe('false');
    expect(wrapper.findAll(testid('attendance-row')).length).toBeGreaterThan(0);
    expect(wrapper.find(testid('attendance-map')).exists()).toBe(false);
  });

  it('Map is view=map in the address, replaced, with the day kept; List takes it away', async () => {
    route.query = { date: TODAY };
    const wrapper = await open();
    await wrapper.get(testid('attendance-view-map')).trigger('click');
    expect(router.replace).toHaveBeenLastCalledWith({ query: { date: TODAY, view: 'map' } });
    expect(router.push).not.toHaveBeenCalled();
    await flushPromises();
    expect(wrapper.get(testid('attendance-view-map')).attributes('aria-pressed')).toBe('true');
    expect(wrapper.find(testid('attendance-map')).exists()).toBe(true);
    expect(wrapper.findAll(testid('attendance-row'))).toHaveLength(0);

    await wrapper.get(testid('attendance-view-list')).trigger('click');
    expect(router.replace).toHaveBeenLastCalledWith({ query: { date: TODAY } });
  });

  it('a change of day keeps the map', async () => {
    const wrapper = await openOnMap();
    await wrapper.get(testid('attendance-date-select')).setValue(TODAY);
    expect(router.replace).toHaveBeenLastCalledWith({ query: { view: 'map', date: TODAY } });
  });

  it('opens on the map from the address, as a reload does, the Show toggles hidden', async () => {
    const wrapper = await openOnMap();
    expect(wrapper.find(testid('attendance-map')).exists()).toBe(true);
    expect(wrapper.find(testid('attendance-show-all')).exists()).toBe(false);
    expect(wrapper.find(testid('attendance-map-search')).exists()).toBe(true);
    expect(wrapper.get(testid('attendance-summary')).text()).toBe('2 of 5 checked in');
  });
});

describe("the open day's seats", () => {
  it('draws here filled, expected outlined, each half its own, and a table with no vendor free', async () => {
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't1')).toBe('var(--layout-section-1-fill)');
    expect(fillOf(wrapper, 't2')).toBe('white');
    expect(halfFill(wrapper, 't3', 'left')).toBe('var(--layout-section-1-fill)');
    expect(halfFill(wrapper, 't3', 'right')).toBe('white');
    expect(fillOf(wrapper, 't4')).toBe('var(--layout-floor)');
    expect(tableOf(wrapper, 't1').attributes('aria-label')).toBe(
      'Aisle A 1, Standard 6 ft, Ana Pottery, checked in',
    );
  });

  it("draws a vendor checked out in their section's out shade, a whole table and a half, at their seat or another (T501)", async () => {
    answer = day({
      [ANA]: out('Aisle A 1'),
      [CAL]: { ...out('Aisle A 4'), state: 'here_elsewhere' },
    });
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't1')).toBe('var(--layout-section-1-out)');
    expect(tableOf(wrapper, 't1').get(testid('layout-table-top')).attributes('stroke')).toBe(
      'var(--layout-section-1-edge)',
    );
    expect(halfFill(wrapper, 't3', 'left')).toBe('var(--layout-section-1-out)');
    expect(fillOf(wrapper, 't2')).toBe('white');
  });

  it("names each seat by its vendor and their state, a half of a shared table's too (T501)", async () => {
    answer = day({ [ANA]: out('Aisle A 1') });
    const wrapper = await openOnMap();
    const names = wrapper
      .get(testid('attendance-map'))
      .findAll('[role="button"][data-seat-key]')
      .map((button) => button.attributes('aria-label'));
    expect(names).toEqual([
      'Aisle A 1, Standard 6 ft, Ana Pottery, checked out',
      'Aisle A 2, Standard 6 ft, Ben Prints, not checked in',
      'Aisle A 3, Standard 6 ft, left half, Cal Knits, checked in',
      'Aisle A 3, Standard 6 ft, right half, Dee Soaps, not checked in',
    ]);
  });

  it('a vendor here at another table is drawn filled at the seat they hold', async () => {
    answer = day({ [BEN]: { ...here('Aisle A 4'), state: 'here_elsewhere' } });
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't2')).toBe('var(--layout-section-1-fill)');
  });

  it('a vendor with no name is named by their address, as their row is', async () => {
    answer = day({ [BEN]: { vendorName: '' } });
    const wrapper = await openOnMap();
    expect(tableOf(wrapper, 't2').attributes('aria-label')).toBe(
      `Aisle A 2, Standard 6 ft, ${BEN}, not checked in`,
    );
  });

  it('the legend reads Checked in, Checked out, Not checked in and No vendor on a day with a table nobody sits at', async () => {
    const wrapper = await openOnMap();
    expect(wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text())).toEqual([
      'Checked in',
      'Checked out',
      'Not checked in',
      'No vendor',
    ]);
    expect(
      wrapper.findAll(testid('day-map-legend-item')).map((item) => item.attributes('data-tone')),
    ).toEqual(['filled', 'checkedOut', 'outlined', 'free']);
  });

  it.each([
    ['before the day', { dates: ['2099-12-31'] }],
    ['after the day', { dates: ['2000-01-01'] }],
    ['on an archived market', { phase: MarketPhase.Archived }],
  ])(
    'the legend names the same three states %s, whether or not a vendor is in each (T501)',
    async (_when, change) => {
      const date = 'dates' in change ? change.dates[0]! : TODAY;
      if ('phase' in change) marketNow = market({ phase: change.phase });
      answer = day();
      answer.data.dates = [date];
      answer.data.roster = answer.data.roster.map((one) => ({
        ...one,
        date,
        state: one.state === 'here_without_seat' ? one.state : 'expected',
        checkedInAt: null,
      }));
      route.query = { view: 'map', date };
      const wrapper = await open();
      expect(wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text())).toEqual([
        'Checked in',
        'Checked out',
        'Not checked in',
        'No vendor',
      ]);
      const text = wrapper.get(testid('attendance-map')).text();
      for (const old of ['Here', 'Expected', 'Did not come', 'here with no table']) {
        expect(text).not.toContain(old);
      }
    },
  );

  it('the legend leaves No vendor out on a day every table is held, the zones still drawn', async () => {
    // Fay sits at Aisle A 4 today: every table, and both halves of the shared one, are held.
    answer = day({ [FAY]: { tableCode: 'Aisle A 4', section: 'Aisle A', location: NORTH.name } });
    const stage = { id: 'z1', label: 'Stage', xMm: 14_000, yMm: 500, widthMm: 6000, depthMm: 2000 };
    marketNow = market(
      {},
      { ...LAID_OUT, floorplans: [{ ...LAID_OUT.floorplans[0], zones: [stage] }] },
    );
    const wrapper = await openOnMap();
    expect(wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text())).toEqual([
      'Checked in',
      'Checked out',
      'Not checked in',
    ]);
    expect(wrapper.get(testid('layout-map-zone-label')).text()).toBe('Stage');
  });

  it('a free half counts: the legend names No vendor while one half of a shared table has nobody', async () => {
    // Fay holds Aisle A 4, and Dee is not seated today, so Aisle A 3's right half is free.
    answer = day({
      [FAY]: { tableCode: 'Aisle A 4', section: 'Aisle A', location: NORTH.name },
      [DEE]: { date: '2099-01-01' },
    });
    const wrapper = await openOnMap();
    expect(halfFill(wrapper, 't3', 'right')).toBe('var(--layout-floor)');
    expect(wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text())).toEqual([
      'Checked in',
      'Checked out',
      'Not checked in',
      'No vendor',
    ]);
  });

  it('the legend follows the re-read: No vendor goes once the free table is given', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = await openOnMap();
    const legend = () => wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text());
    expect(legend()).toContain('No vendor');
    answer = day({ [FAY]: { tableCode: 'Aisle A 4', section: 'Aisle A', location: NORTH.name } });
    vi.advanceTimersByTime(REREAD_MS);
    await flushPromises();
    expect(legend()).toEqual(['Checked in', 'Checked out', 'Not checked in']);
  });

  it('on an archived market with every table held, the legend is the three states alone', async () => {
    marketNow = market({ phase: MarketPhase.Archived });
    answer = day({ [FAY]: { tableCode: 'Aisle A 4', section: 'Aisle A', location: NORTH.name } });
    const wrapper = await openOnMap();
    expect(wrapper.findAll(testid('day-map-legend-item')).map((item) => item.text())).toEqual([
      'Checked in',
      'Checked out',
      'Not checked in',
    ]);
  });

  it('changes when the re-read brings a check-in, with no reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't2')).toBe('white');
    answer = day({ [BEN]: here('Aisle A 2') });
    vi.advanceTimersByTime(REREAD_MS);
    await flushPromises();
    expect(fillOf(wrapper, 't2')).toBe('var(--layout-section-1-fill)');
  });

  it('changes when the re-read brings a check-out, with no reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't1')).toBe('var(--layout-section-1-fill)');
    answer = day({ [ANA]: out('Aisle A 1') });
    vi.advanceTimersByTime(REREAD_MS);
    await flushPromises();
    expect(fillOf(wrapper, 't1')).toBe('var(--layout-section-1-out)');
  });
});

describe('a press on the map', () => {
  it("on a vendor's table opens their drawer on its Application tab, the day and the view kept", async () => {
    route.query = { view: 'map', date: TODAY };
    const wrapper = await open();
    await tableOf(wrapper, 't2').trigger('click');
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({ query: { view: 'map', date: TODAY, vendor: BEN } }),
    );
    expect(wrapper.find(testid('attendance-map-note')).exists()).toBe(false);
  });

  it("on each half of a shared table opens that half's vendor", async () => {
    const wrapper = await openOnMap();
    await halfOf(wrapper, 't3', 'left').trigger('click');
    expect(route.query.vendor).toBe(CAL);
    await halfOf(wrapper, 't3', 'right').trigger('click');
    expect(route.query.vendor).toBe(DEE);
  });

  it('on the free half of a shared table opens nothing and says nothing, the half no button', async () => {
    // Dee is not seated today: Aisle A 3's right half is nobody's.
    answer = day({ [DEE]: { date: '2099-01-01' } });
    const wrapper = await openOnMap();
    const free = halfOf(wrapper, 't3', 'right');
    expect(halfFill(wrapper, 't3', 'right')).toBe('var(--layout-floor)');
    expect(free.attributes('role')).toBeUndefined();
    expect(free.attributes('tabindex')).toBeUndefined();
    expect(halfOf(wrapper, 't3', 'left').attributes('role')).toBe('button');

    await free.get('path').trigger('click');

    expect(router.push).not.toHaveBeenCalled();
    expect(wrapper.find(testid('attendance-map-note')).exists()).toBe(false);
    expect(marks(wrapper)).toHaveLength(0);
  });

  it("marks the open vendor's seat as the picked one", async () => {
    route.query = { view: 'map', vendor: DEE };
    const wrapper = await open();
    expect(marks(wrapper)).toHaveLength(1);
    expect(marks(wrapper)[0]!.find('path').exists()).toBe(true);
  });

  it('on a table with no vendor says so under the map and opens nothing', async () => {
    const wrapper = await openOnMap();
    await tableOf(wrapper, 't4').trigger('click');
    expect(wrapper.get(testid('attendance-map-note')).text()).toBe(
      `Table Aisle A 4: no vendor on ${getShortDate(TODAY)}.`,
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(marks(wrapper)).toHaveLength(1);
  });
});

/*
 * On the map the count row's search finds one vendor of the day (T466, release walk F3): a search
 * with a dropdown, each row saying where the vendor sits. Picking one opens their drawer, as a
 * press on their table does, so their seat is outlined, in the other location when they sit there.
 * Typing alone outlines nothing (Q2), which replaces the outline of every match (D40).
 */
describe("the map's search (T466)", () => {
  const SOUTH = { id: 'loc-south', name: 'South Wing' };
  const AISLE_B = { id: 'sec-aisle-b', name: 'Aisle B' };
  const GIL = 'gil@example.com';

  /** North Wing as before, and South Wing laid out with Aisle B's one table. */
  const TWO_LAID_OUT = {
    ...LAID_OUT,
    locations: [NORTH, SOUTH],
    sections: [...LAID_OUT.sections, { ...AISLE_B, location: SOUTH, tier: null, count: 1 }],
    floorplans: [
      ...LAID_OUT.floorplans,
      {
        ...LAID_OUT.floorplans[0],
        id: 'fp-south',
        locationId: SOUTH.id,
        tables: [{ ...table('s1', 1, 4000), sectionId: AISLE_B.id }],
      },
    ],
  };
  /** The day, with Gil Glass expected at South Wing's Aisle B 1. */
  function twoHalls() {
    const answered = day();
    answered.data.roster.push(
      row(GIL, 'Gil Glass', 'Aisle B 1', { section: 'Aisle B', location: SOUTH.name }),
    );
    return answered;
  }

  const picker = (wrapper: VueWrapper) => wrapper.get(testid('attendance-map-search'));
  const field = (wrapper: VueWrapper) => wrapper.get(testid('attendance-map-search-input'));
  const value = (wrapper: VueWrapper) => (field(wrapper).element as HTMLInputElement).value;
  const listed = (wrapper: VueWrapper) =>
    wrapper
      .findAll(testid('attendance-map-search-option'))
      .map((option) => option.attributes('data-value'));
  /** Each row as it reads: the vendor, then where they sit. */
  const rows = (wrapper: VueWrapper) =>
    wrapper
      .findAll(testid('attendance-map-search-option'))
      .map((option) => [
        option.get('.search-picker-option-label').text(),
        option.get('.search-picker-option-detail').text(),
      ]);
  async function type(wrapper: VueWrapper, words: string) {
    await field(wrapper).setValue(words);
    await field(wrapper).trigger('input');
  }

  it('is a search named "Find a vendor", compact, its list over the map, in place of the list\'s field', async () => {
    const wrapper = await openOnMap();
    const bar = wrapper.get(testid('attendance-bar'));
    expect(bar.find(testid('attendance-map-search')).exists()).toBe(true);
    expect(wrapper.find(testid('attendance-search')).exists()).toBe(false);
    expect(field(wrapper).attributes('role')).toBe('combobox');
    expect(field(wrapper).attributes('placeholder')).toBe('Name, email or table');
    expect(field(wrapper).classes()).toEqual(['field', 'field--compact']);
    const label = picker(wrapper).get(`label[for="${field(wrapper).attributes('id')}"]`);
    expect(label.text()).toBe('Find a vendor');
    expect(label.classes()).toContain('visually-hidden');
    expect(picker(wrapper).classes()).toContain('search-picker--list-over');
    expect(picker(wrapper).classes()).toContain('door-search');
  });

  it("is the map's alone: the list keeps its own field", async () => {
    const wrapper = await open();
    expect(wrapper.find(testid('attendance-search')).exists()).toBe(true);
    expect(wrapper.find(testid('attendance-map-search')).exists()).toBe(false);
  });

  it('lists every vendor of the day once, seated or here with no table, each saying where they sit', async () => {
    answer = day({ [BEN]: { vendorName: '' } });
    answer.data.roster.push(
      row('zed@example.com', 'Zed Tomorrow', 'Aisle A 4', { date: '2099-01-01' }),
    );
    const wrapper = await openOnMap();
    await field(wrapper).trigger('click');
    expect(rows(wrapper)).toEqual([
      ['Ana Pottery', 'Table Aisle A 1, a whole table'],
      [BEN, 'Table Aisle A 2, a whole table'],
      ['Cal Knits', 'Table Aisle A 3, left half'],
      ['Dee Soaps', 'Table Aisle A 3, right half'],
      ['Eve Jams', 'No table'],
      ['Fay Candles', 'Table Annex 7, a whole table'],
    ]);
    expect(listed(wrapper)).toEqual([ANA, BEN, CAL, DEE, EVE, FAY]);
  });

  it.each([
    ['their name, as the roster gives it (a preferred name, else the full name)', 'pottery', [ANA]],
    ['a preferred name standing for a full one', 'bee', [BEN]],
    ['the full name on their identification, when they go by another', 'beatrice', [BEN]],
    ['their address', 'dee@', [DEE]],
    ['their table', 'aisle a 3', [CAL, DEE]],
    ['a table on no layout', 'Annex', [FAY]],
    ['words with spaces round them', '  knits ', [CAL]],
  ])('finds a vendor by %s', async (_what, words, found) => {
    answer = day({ [BEN]: { vendorName: 'Bee', vendorFullName: 'Beatrice Fixture' } });
    const wrapper = await openOnMap();
    await type(wrapper, words);
    expect(listed(wrapper)).toEqual(found);
  });

  it('names a vendor found by their full name as they go by', async () => {
    answer = day({ [BEN]: { vendorName: 'Bee', vendorFullName: 'Beatrice Fixture' } });
    const wrapper = await openOnMap();
    await type(wrapper, 'beatrice');
    expect(rows(wrapper)).toEqual([['Bee', 'Table Aisle A 2, a whole table']]);
  });

  it("the list's search finds a vendor by their full name too, the map's and the list's one set of terms", async () => {
    answer = day({ [BEN]: { vendorName: 'Bee', vendorFullName: 'Beatrice Fixture' } });
    const wrapper = await open();
    await wrapper.get(testid('attendance-search')).setValue('beatrice');
    expect(
      wrapper.findAll(testid('attendance-row')).map((one) => one.attributes('data-vendor')),
    ).toEqual([BEN]);
  });

  it('draws at most 50 rows, then says how many more and to type to narrow them', async () => {
    answer = day();
    for (let n = 0; n < 55; n += 1) {
      answer.data.roster.push(row(`v${n}@example.com`, `Vendor ${n}`, `Annex ${n + 10}`));
    }
    const wrapper = await openOnMap();
    await field(wrapper).trigger('click');
    expect(listed(wrapper)).toHaveLength(50);
    expect(wrapper.get(testid('attendance-map-search-more')).text()).toBe(
      '11 more, type to narrow',
    );
  });

  it('typing outlines nothing on the map and opens nothing', async () => {
    const wrapper = await openOnMap();
    for (const words of ['Ben', 'knits', 'Aisle A']) {
      await type(wrapper, words);
      expect(listed(wrapper).length).toBeGreaterThan(0);
      expect(marks(wrapper)).toHaveLength(0);
    }
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a pick by the keys opens the vendor's drawer and outlines their seat, the field emptied", async () => {
    route.query = { view: 'map', date: TODAY };
    const wrapper = await open();
    await type(wrapper, 'prints');
    await field(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({ query: { view: 'map', date: TODAY, vendor: BEN } }),
    );
    expect(router.replace).not.toHaveBeenCalled();
    await flushPromises();
    expect(marks(wrapper)).toHaveLength(1);
    expect(marks(wrapper)[0]!.find('rect').exists()).toBe(true);
    expect(value(wrapper)).toBe('');
    expect(wrapper.find(testid('attendance-map-search-list')).exists()).toBe(false);
  });

  it('a pick by a click on half a shared table outlines that half', async () => {
    const wrapper = await openOnMap();
    await type(wrapper, 'soaps');
    await wrapper.get(testid('attendance-map-search-option')).trigger('click');
    await flushPromises();
    expect(route.query.vendor).toBe(DEE);
    expect(marks(wrapper)).toHaveLength(1);
    expect(marks(wrapper)[0]!.find('path').exists()).toBe(true);
  });

  it("a pick in the other location replaces the address's location and outlines there", async () => {
    marketNow = market({}, TWO_LAID_OUT);
    answer = twoHalls();
    route.query = { view: 'map', date: TODAY };
    const wrapper = await open();
    expect(wrapper.find('[data-table-id="s1"]').exists()).toBe(false);
    await type(wrapper, 'glass');
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    // The location first, replaced, then the drawer's own step, so Back closes the drawer and
    // leaves the map on the vendor's location.
    expect(router.replace).toHaveBeenCalledWith({
      query: { view: 'map', date: TODAY, location: SOUTH.id },
    });
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { view: 'map', date: TODAY, location: SOUTH.id, vendor: GIL },
      }),
    );
    expect(router.replace.mock.invocationCallOrder[0]!).toBeLessThan(
      router.push.mock.invocationCallOrder[0]!,
    );
    expect(
      (wrapper.get(testid('attendance-location-select')).element as HTMLSelectElement).value,
    ).toBe(SOUTH.id);
    expect(wrapper.find('[data-table-id="s1"]').exists()).toBe(true);
    expect(marks(wrapper)).toHaveLength(1);
  });

  it('a pick in the open location keeps the address as it is', async () => {
    marketNow = market({}, TWO_LAID_OUT);
    answer = twoHalls();
    route.query = { view: 'map', location: SOUTH.id };
    const wrapper = await open();
    await type(wrapper, 'glass');
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.replace).not.toHaveBeenCalled();
    expect(route.query).toEqual({ view: 'map', location: SOUTH.id, vendor: GIL });
    expect(marks(wrapper)).toHaveLength(1);
  });

  it.each([
    ['checked in with no table', 'jams', EVE],
    ['at a table on no layout', 'candles', FAY],
  ])(
    'a pick of a vendor %s opens their drawer and outlines nothing',
    async (_what, words, email) => {
      marketNow = market({}, TWO_LAID_OUT);
      answer = twoHalls();
      const wrapper = await openOnMap();
      await type(wrapper, words);
      await field(wrapper).trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(route.query).toEqual({ view: 'map', vendor: email });
      expect(router.replace).not.toHaveBeenCalled();
      expect(marks(wrapper)).toHaveLength(0);
    },
  );

  it('closing the drawer clears the outline', async () => {
    const wrapper = await openOnMap();
    await type(wrapper, 'prints');
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(marks(wrapper)).toHaveLength(1);
    wrapper.findComponent({ name: 'VendorDrawer' }).vm.$emit('close');
    await flushPromises();
    expect(route.query.vendor).toBeUndefined();
    expect(marks(wrapper)).toHaveLength(0);
  });

  it('a re-read with the list open keeps the words and the list, its rows as read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = await openOnMap();
    await type(wrapper, 'a');
    expect(listed(wrapper)).toContain(ANA);
    const before = listed(wrapper);

    answer = day();
    answer.data.roster.push(row('hal@example.com', 'Hal Candles', 'Aisle A 4'));
    vi.advanceTimersByTime(REREAD_MS);
    await flushPromises();

    expect(api.get.mock.calls.filter(([url]) => url === ROSTER_URL).length).toBeGreaterThan(1);
    expect(value(wrapper)).toBe('a');
    expect(field(wrapper).attributes('aria-expanded')).toBe('true');
    expect(listed(wrapper)).toEqual([...before, 'hal@example.com']);
    expect(marks(wrapper)).toHaveLength(0);
  });
});

describe('under the map', () => {
  it('counts who is checked in with no table and who sits at a table on no layout, each with Show in the list', async () => {
    const wrapper = await openOnMap();
    expect(words(wrapper, 'attendance-map-unseated')).toBe(
      '1 checked in with no table Show in the list',
    );
    expect(words(wrapper, 'attendance-map-off-layout')).toBe(
      '1 vendor is at a table not on a layout. Show in the list',
    );
    await wrapper.get(testid('attendance-map-off-layout-show-list')).trigger('click');
    expect(router.replace).toHaveBeenLastCalledWith({ query: {} });
  });

  it.each([
    ['attendance-map-unseated-show-list', 'Eve Jams'],
    ['attendance-map-off-layout-show-list', 'Fay Candles'],
  ])(
    'Show in the list (%s) lands on a list that shows whom it counted, whatever Show was',
    async (button, vendor) => {
      const wrapper = await open();
      // Eve is here and Fay is not: each Show but All hides one of them.
      for (const toggle of ['attendance-show-not-yet', 'attendance-show-here']) {
        await wrapper.get(testid(toggle)).trigger('click');
        await wrapper.get(testid('attendance-view-map')).trigger('click');
        await flushPromises();

        await wrapper.get(testid(button)).trigger('click');
        await flushPromises();

        expect(route.query.view).toBeUndefined();
        const listed = wrapper.findAll(testid('attendance-row')).map((one) => one.text());
        expect(listed.some((text) => text.includes(vendor))).toBe(true);
        expect(wrapper.get(testid('attendance-show-all')).attributes('aria-pressed')).toBe('true');
      }
    },
  );

  it('says each count only when it applies, and in the plural for more than one', async () => {
    answer = day({
      [EVE]: { state: 'expected', tableCode: 'Annex 8', checkedInAt: null },
      [ANA]: { tableCode: 'Annex 1' },
    });
    const wrapper = await openOnMap();
    expect(wrapper.find(testid('attendance-map-unseated')).exists()).toBe(false);
    expect(words(wrapper, 'attendance-map-off-layout')).toBe(
      '3 vendors are at tables not on a layout. Show in the list',
    );
  });
});

/*
 * The location is the toolbar's select beside the day (T466, release walk F5), offered on the map
 * when two locations or more are laid out, by the one rule the map reads (`laidOutLocations`).
 */
describe('the location select (T466)', () => {
  const SOUTH = { id: 'loc-south', name: 'South Wing' };
  const ANNEX = { id: 'loc-annex', name: 'Annex' };
  const AISLE_B = { id: 'sec-aisle-b', name: 'Aisle B' };

  /** North Wing as before, South Wing laid out with Aisle B's one table, and the Annex drawn with
   *  no scale, so not laid out. */
  const TWO_LAID_OUT = {
    ...LAID_OUT,
    locations: [NORTH, SOUTH, ANNEX],
    sections: [...LAID_OUT.sections, { ...AISLE_B, location: SOUTH, tier: null, count: 1 }],
    floorplans: [
      ...LAID_OUT.floorplans,
      {
        ...LAID_OUT.floorplans[0],
        id: 'fp-south',
        locationId: SOUTH.id,
        tables: [{ ...table('s1', 1, 4000), sectionId: AISLE_B.id }],
      },
      { ...LAID_OUT.floorplans[0], id: 'fp-annex', locationId: ANNEX.id, scalePxPerUnit: null },
    ],
  };

  const select = (wrapper: VueWrapper) => wrapper.get(testid('attendance-location-select'));
  const options = (wrapper: VueWrapper) =>
    select(wrapper)
      .findAll('option')
      .map((option) => [option.attributes('value'), option.text()]);
  const chosen = (wrapper: VueWrapper) => (select(wrapper).element as HTMLSelectElement).value;

  it('on the map, offers exactly the laid-out locations, the first open, after the day', async () => {
    marketNow = market({}, TWO_LAID_OUT);
    const wrapper = await openOnMap();
    expect(options(wrapper)).toEqual([
      [NORTH.id, NORTH.name],
      [SOUTH.id, SOUTH.name],
    ]);
    expect(chosen(wrapper)).toBe(NORTH.id);
    expect(select(wrapper).attributes('name')).toBe('attendance-location-select');
    expect(select(wrapper).classes()).toEqual(
      expect.arrayContaining(['field', 'field--select', 'field--compact']),
    );
    const label = select(wrapper).element.closest('label');
    expect(label?.querySelector('.visually-hidden')?.textContent?.trim()).toBe('Location');
    // The Tab order: the day, then the location, then List and Map.
    const order = wrapper
      .get(testid('attendance-toolbar'))
      .findAll('select, button')
      .map((el) => el.attributes('data-testid'));
    expect(order.slice(0, 4)).toEqual([
      'attendance-date-select',
      'attendance-location-select',
      'attendance-view-list',
      'attendance-view-map',
    ]);
    // The day map draws no switch of its own: the select is the one.
    expect(wrapper.find(testid('day-map-locations')).exists()).toBe(false);
  });

  it("choosing one replaces the address's location, and the map draws it", async () => {
    marketNow = market({}, TWO_LAID_OUT);
    const wrapper = await openOnMap();
    expect(wrapper.find('[data-table-id="t1"]').exists()).toBe(true);
    await select(wrapper).setValue(SOUTH.id);
    expect(router.replace).toHaveBeenLastCalledWith({
      query: { view: 'map', location: SOUTH.id },
    });
    expect(router.push).not.toHaveBeenCalled();
    await flushPromises();
    expect(chosen(wrapper)).toBe(SOUTH.id);
    expect(wrapper.find('[data-table-id="s1"]').exists()).toBe(true);
    expect(wrapper.find('[data-table-id="t1"]').exists()).toBe(false);
  });

  it('opens on the location in the address, as a reload does', async () => {
    marketNow = market({}, TWO_LAID_OUT);
    route.query = { view: 'map', location: SOUTH.id };
    const wrapper = await open();
    expect(chosen(wrapper)).toBe(SOUTH.id);
    expect(wrapper.find('[data-table-id="s1"]').exists()).toBe(true);
  });

  it('an address naming a location not laid out shows the first, as the map does', async () => {
    marketNow = market({}, TWO_LAID_OUT);
    route.query = { view: 'map', location: ANNEX.id };
    const wrapper = await open();
    expect(chosen(wrapper)).toBe(NORTH.id);
    expect(wrapper.find('[data-table-id="t1"]').exists()).toBe(true);
  });

  it('is not offered on the list', async () => {
    marketNow = market({}, TWO_LAID_OUT);
    const wrapper = await open();
    expect(wrapper.find(testid('attendance-location-select')).exists()).toBe(false);
  });

  it('is not offered with one location laid out', async () => {
    const wrapper = await openOnMap();
    expect(wrapper.find(testid('attendance-location-select')).exists()).toBe(false);
    expect(wrapper.find(testid('day-map-locations')).exists()).toBe(false);
  });
});

describe('when it was read, on the map (T466)', () => {
  it("is the day map's note under the map, never over it or in the toolbar", async () => {
    const wrapper = await openOnMap();
    expect(wrapper.get(testid('day-map')).get(testid('day-map-note')).text()).toBe(
      'Updated just now',
    );
    expect(wrapper.find(testid('attendance-updated')).exists()).toBe(false);
    expect(wrapper.get(testid('attendance-tools')).text()).not.toMatch(/Updated/);
  });
});

describe('with no location laid out', () => {
  const NONE = { ...LAID_OUT, floorplans: [] };

  it('says so, with Open the layout for a person who may change the setup', async () => {
    marketNow = market({}, NONE);
    const wrapper = await openOnMap();
    expect(words(wrapper, 'attendance-map-none')).toBe(
      'No location has a layout yet. Open the layout',
    );
    expect(wrapper.get(testid('attendance-map-layout-link')).attributes('href')).toContain(
      '/markets/market-1/',
    );
    expect(wrapper.find(testid('day-map')).exists()).toBe(false);
    // Every seated vendor is then at a table on no layout, which the line above says already.
    expect(wrapper.find(testid('attendance-map-off-layout')).exists()).toBe(false);
  });

  it('with no link for a person who may not', async () => {
    marketNow = market({ actionRefusals: answersRefusing(MarketAction.ChangeSetup) }, NONE);
    const wrapper = await openOnMap();
    expect(words(wrapper, 'attendance-map-none')).toBe('No location has a layout yet.');
    expect(wrapper.find(testid('attendance-map-layout-link')).exists()).toBe(false);
  });

  it('a layout with no scale is not laid out', async () => {
    marketNow = market(
      {},
      { ...LAID_OUT, floorplans: [{ ...LAID_OUT.floorplans[0], scalePxPerUnit: null }] },
    );
    const wrapper = await openOnMap();
    expect(wrapper.find(testid('attendance-map-none')).exists()).toBe(true);
  });
});

describe('a Viewer', () => {
  it('reads the map and opens the drawer, and nothing on the map writes', async () => {
    marketNow = market({ actionRefusals: VIEWER_ANSWERS });
    const wrapper = await openOnMap();
    expect(fillOf(wrapper, 't1')).toBe('var(--layout-section-1-fill)');
    expect(wrapper.find(testid('attendance-check-in')).exists()).toBe(false);
    await tableOf(wrapper, 't1').trigger('click');
    await tableOf(wrapper, 't4').trigger('click');
    expect(route.query.vendor).toBe(ANA);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});

describe("the map's note", () => {
  function mapAlone(props: Record<string, unknown> = {}) {
    return mount(AttendanceMap, {
      attachTo: document.body,
      props: {
        market: marketNow,
        rows: day().data.roster,
        date: TODAY,
        openVendor: null,
        hereWithoutSeat: 0,
        ...props,
      },
    });
  }

  it("stands the read time it is given under the map, as the day map's note", () => {
    const wrapper = mapAlone({ updated: 'Updated just now' });
    expect(wrapper.get(testid('day-map')).get(testid('day-map-note')).text()).toBe(
      'Updated just now',
    );
  });

  it('draws no note when it is given none', () => {
    const wrapper = mapAlone();
    expect(wrapper.find(testid('day-map-note')).exists()).toBe(false);
  });
});
