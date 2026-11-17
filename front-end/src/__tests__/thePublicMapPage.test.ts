// @vitest-environment happy-dom
/**
 * The public map page (T422 ticket 09), `/<market-slug>/map`: anyone, signed out, picks a day and a
 * location, presses a table or finds a vendor by name, and reads the public name, website and
 * Instagram the organizer chose to publish. The day, the location and the table live in the
 * address; a market whose map is not open reads "Page not found", as an address naming nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import { publicDayLocations } from '@/components/daymap/dayMap';
import DayMap from '@/components/daymap/DayMap.vue';
import PublicMapBackdrop from '@/components/publicmap/PublicMapBackdrop.vue';
import PublicMapBubble from '@/components/publicmap/PublicMapBubble.vue';
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import { tablePaints } from '@/components/publicmap/publicMapPaint';
import { standsApart } from '@/utils/currentPlace';
import {
  dayInWords,
  instagramLink,
  mapListing,
  mapPlace,
  openingDate,
  shortDay,
  shownParts,
  tableCard,
  websiteLink,
  type PublicMapRead,
  type TableCard,
} from '@/utils/publicMap';
import PublicMapView from '@/views/PublicMapView.vue';
import { ANSWER, TODAY, TOMORROW } from './support/publicMapAnswer';

const fetchPublicMap = vi.fn<(slug: string) => Promise<PublicMapRead>>();
const fetchPublicMapImage = vi.fn<(slug: string, locationId: string) => Promise<Blob>>();
vi.mock('@/utils/publicMap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/publicMap')>()),
  fetchPublicMap: (slug: string) => fetchPublicMap(slug),
  fetchPublicMapImage: (slug: string, locationId: string) => fetchPublicMapImage(slug, locationId),
}));

/** The page's address: its slug and its query, which `replace` changes as the router would. */
const routing = vi.hoisted(() => ({
  route: null as unknown as {
    name: string;
    params: Record<string, string>;
    query: Record<string, string>;
  },
  replace: vi.fn(),
}));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routing.route = reactive({
    name: 'public-map',
    params: { marketSlug: 'harbour-night-market' },
    query: {} as Record<string, string>,
    hash: '',
    matched: [{ meta: { public: true, vendorFacing: true } }],
  });
  routing.replace.mockImplementation((to: { query: Record<string, string> }) => {
    routing.route.query = { ...to.query };
  });
  return {
    useRoute: () => routing.route,
    useRouter: () => ({ push: vi.fn(), replace: routing.replace }),
  };
});

const found = (map: PublicMapAnswer = ANSWER): PublicMapRead => ({
  map,
  notFound: false,
  failed: false,
});

// ── What the page reads, said plainly ────────────────────────────────────────

describe('the day the page opens on', () => {
  const dates = ['2099-06-05', '2099-06-06', '2099-06-12'];

  it('is the one the address asks for, when it is a market date', () => {
    expect(openingDate(dates, '2099-06-12', '2099-06-06')).toBe('2099-06-12');
  });

  it('is today when today is a market date, else the next, else the last', () => {
    expect(openingDate(dates, undefined, '2099-06-06')).toBe('2099-06-06');
    expect(openingDate(dates, undefined, '2099-06-07')).toBe('2099-06-12');
    expect(openingDate(dates, undefined, '2099-01-01')).toBe('2099-06-05');
    expect(openingDate(dates, undefined, '2099-07-01')).toBe('2099-06-12');
  });

  it('falls back from a date that is not a market date, or not a date at all', () => {
    expect(openingDate(dates, '2099-06-07', '2099-06-06')).toBe('2099-06-06');
    expect(openingDate(dates, 'soon', '2099-06-06')).toBe('2099-06-06');
  });
});

describe('a day in words', () => {
  it('is its weekday, day and month, short', () => {
    expect(dayInWords('2026-11-18')).toBe('Wed 18 Nov');
    expect(dayInWords('2026-11-01')).toBe('Sun 1 Nov');
  });
});

describe('a day as the day select says it', () => {
  it('is its month and day, read in UTC', () => {
    expect(shortDay('2026-11-17')).toBe('Nov 17');
    expect(shortDay('2026-01-01')).toBe('Jan 1');
    expect(shortDay('2026-12-31')).toBe('Dec 31');
  });

  it('is the text as it is when it is no date', () => {
    expect(shortDay('soon')).toBe('soon');
  });
});

describe('the place the address names', () => {
  it('is the day, the location and the table it carries', () => {
    expect(mapPlace(ANSWER, { date: TOMORROW, location: 'loc-lower', table: 's1' }, TODAY)).toEqual(
      { date: TOMORROW, locationId: 'loc-lower', tableId: 's1', half: null },
    );
  });

  it("opens the table's own location when the address names a table alone", () => {
    expect(mapPlace(ANSWER, { table: 's1' }, TODAY)).toEqual({
      date: TODAY,
      locationId: 'loc-lower',
      tableId: 's1',
      half: null,
    });
  });

  it('falls back from every value it does not know, without an error', () => {
    expect(
      mapPlace(ANSWER, { date: '1999-01-01', location: 'nowhere', table: 'x9' }, TODAY),
    ).toEqual({ date: TODAY, locationId: 'loc-upper', tableId: null, half: null });
    // A table at another location than the open one is no pick there.
    expect(mapPlace(ANSWER, { location: 'loc-upper', table: 's1' }, TODAY)).toEqual({
      date: TODAY,
      locationId: 'loc-upper',
      tableId: null,
      half: null,
    });
    expect(mapPlace(ANSWER, { date: ['a', 'b'] as unknown as string }, TODAY).date).toBe(TODAY);
  });

  it('carries the half named beside a table, left or right (T465)', () => {
    expect(mapPlace(ANSWER, { table: 'g2', half: 'left' }, TODAY).half).toBe('left');
    expect(mapPlace(ANSWER, { table: 'g2', half: 'right' }, TODAY).half).toBe('right');
    // Read whatever the day: the card shows the whole table on a day it is not split.
    expect(mapPlace(ANSWER, { date: TOMORROW, table: 'g2', half: 'right' }, TODAY).half).toBe(
      'right',
    );
  });

  it('reads no half that is no side, nor one with no table picked, without an error', () => {
    for (const half of ['middle', 'whole', '', 'LEFT', ['left', 'right']]) {
      expect(mapPlace(ANSWER, { table: 'g2', half: half as unknown as string }, TODAY)).toEqual({
        date: TODAY,
        locationId: 'loc-upper',
        tableId: 'g2',
        half: null,
      });
    }
    expect(mapPlace(ANSWER, { half: 'left' }, TODAY).half).toBeNull();
    expect(mapPlace(ANSWER, { table: 'x9', half: 'left' }, TODAY).half).toBeNull();
    expect(mapPlace(ANSWER, { location: 'loc-lower', table: 'g2', half: 'left' }, TODAY)).toEqual({
      date: TODAY,
      locationId: 'loc-lower',
      tableId: null,
      half: null,
    });
  });
});

describe('the links a seat is given', () => {
  it("are the website's address with its host for text", () => {
    expect(websiteLink('https://www.kiln-and-co.example/shop')).toEqual({
      href: 'https://www.kiln-and-co.example/shop',
      text: 'www.kiln-and-co.example',
    });
  });

  it('keep only an http or https address', () => {
    expect(websiteLink('javascript:alert(1)')).toBeNull();
    expect(websiteLink('data:text/html,hi')).toBeNull();
    expect(websiteLink('not a url')).toBeNull();
    expect(websiteLink(null)).toBeNull();
  });

  it("are Instagram's profile of the handle, read as @handle", () => {
    expect(instagramLink('example_acme')).toEqual({
      href: 'https://www.instagram.com/example_acme/',
      text: '@example_acme',
    });
  });

  it('keep only a handle of letters, digits, dots and underscores', () => {
    expect(instagramLink('a b')).toBeNull();
    expect(instagramLink('../evil')).toBeNull();
    expect(instagramLink('x'.repeat(31))).toBeNull();
    expect(instagramLink(null)).toBeNull();
  });
});

describe("the day's vendors", () => {
  it('are the named seats of the day at every location, by name, with table and location', () => {
    expect(mapListing(ANSWER, TODAY)).toEqual([
      {
        key: 'g2:left',
        name: 'Acme Ceramics',
        tableId: 'g2',
        code: 'Gold row 2',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
      },
      {
        key: 'g2:right',
        name: 'Bee Candles',
        tableId: 'g2',
        code: 'Gold row 2',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
      },
      {
        key: 's1:whole',
        name: 'Cog Prints',
        tableId: 's1',
        code: 'Silver aisle 1',
        locationId: 'loc-lower',
        locationName: 'Lower Hall',
      },
      {
        key: 'g1:whole',
        name: 'Kiln & Co',
        tableId: 'g1',
        code: 'Gold row 1',
        locationId: 'loc-upper',
        locationName: 'Upper Hall',
      },
    ]);
    expect(mapListing(ANSWER, TOMORROW).map((v) => v.name)).toEqual(['Dune Glass']);
  });
});

describe("a table's card", () => {
  it('holds its code and the seat at it', () => {
    const card = tableCard(ANSWER, TODAY, 'g1');
    expect(card?.code).toBe('Gold row 1');
    expect(card?.halves).toEqual([
      {
        side: 'whole',
        seat: expect.objectContaining({ name: 'Kiln & Co', instagram: 'example_kiln' }),
      },
    ]);
  });

  it("lists a shared table's halves left then right, a half with nobody free", () => {
    expect(tableCard(ANSWER, TODAY, 'g2')?.halves.map((h) => [h.side, h.seat?.name])).toEqual([
      ['left', 'Acme Ceramics'],
      ['right', 'Bee Candles'],
    ]);
    const leftOnly = {
      ...ANSWER,
      seats: ANSWER.seats.filter((s) => !(s.tableId === 'g2' && s.half === 'right')),
    };
    expect(tableCard(leftOnly, TODAY, 'g2')?.halves.map((h) => [h.side, h.seat?.name])).toEqual([
      ['left', 'Acme Ceramics'],
      ['right', undefined],
    ]);
  });

  it('holds no seat for a free table, and is none for a table not on the map', () => {
    expect(tableCard(ANSWER, TOMORROW, 'g1')?.halves).toEqual([{ side: 'whole', seat: null }]);
    expect(tableCard(ANSWER, TODAY, 'nope')).toBeNull();
  });
});

describe('the parts of a card shown for a half picked (T465)', () => {
  const shared = tableCard(ANSWER, TODAY, 'g2')!;
  const sides = (card: TableCard) => card.halves.map((h) => [h.side, h.seat?.name]);

  it('are the half alone when the table is split that day', () => {
    expect(sides(shownParts(shared, 'left'))).toEqual([['left', 'Acme Ceramics']]);
    expect(sides(shownParts(shared, 'right'))).toEqual([['right', 'Bee Candles']]);
    expect(shownParts(shared, 'right').code).toBe('Gold row 2');
  });

  it('are every part with no half picked', () => {
    expect(shownParts(shared, null)).toEqual(shared);
  });

  it('are the whole table when it is not split that day, as an old link names it', () => {
    const whole = tableCard(ANSWER, TOMORROW, 'g2')!;
    expect(shownParts(whole, 'right')).toEqual(whole);
    const kiln = tableCard(ANSWER, TODAY, 'g1')!;
    expect(shownParts(kiln, 'left')).toEqual(kiln);
  });

  it('are a free half alone, with nobody at it', () => {
    const rightFree = {
      ...ANSWER,
      seats: ANSWER.seats.filter((s) => !(s.tableId === 'g2' && s.half === 'right')),
    };
    expect(sides(shownParts(tableCard(rightFree, TODAY, 'g2')!, 'right'))).toEqual([
      ['right', undefined],
    ]);
  });
});

// ── The page ─────────────────────────────────────────────────────────────────

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  routing.route.query = {};
  routing.route.name = 'public-map';
  routing.route.params = { marketSlug: 'harbour-night-market' };
  routing.replace.mockClear();
  fetchPublicMap.mockReset();
  fetchPublicMapImage.mockReset();
  fetchPublicMapImage.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:map-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.setSystemTime(new Date(2099, 5, 5, 12));
  // The map's box, 1,200 by 900 px.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-testid') !== 'layout-map') return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, 0, 1200, 900);
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.title = 'Conventioner';
});

async function open(read: PublicMapRead = found(), query: Record<string, string> = {}) {
  routing.route.query = query;
  fetchPublicMap.mockResolvedValue(read);
  wrapper = mount(PublicMapView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const card = () => wrapper!.get('[data-testid="public-map-card"]');
const daySelect = () => wrapper!.get<HTMLSelectElement>('[data-testid="public-map-day-select"]');
const locationSelect = () =>
  wrapper!.get<HTMLSelectElement>('[data-testid="public-map-location-select"]');
const PAINTS = tablePaints(publicDayLocations(ANSWER, () => ''));
const pressTable = async (id: string, half?: 'left' | 'right') => {
  const target = half
    ? wrapper!.get(`[data-table-id="${id}"] [data-half="${half}"]`)
    : wrapper!.get(`[data-table-id="${id}"]`);
  await target.trigger('click');
  await flushPromises();
};

describe('a market whose map is not open', () => {
  it('reads "Page not found", and the bar falls back as on the vendor page', async () => {
    const page = await open({ map: null, notFound: true, failed: false });
    expect(fetchPublicMap).toHaveBeenCalledWith('harbour-night-market');
    expect(page.find('[data-testid="page-not-found"]').exists()).toBe(true);
    expect(page.find('[data-testid="public-map"]').exists()).toBe(false);
    expect(standsApart(routing.route as never)).toBe(false);
    page.unmount();
    wrapper = null;
    expect(standsApart(routing.route as never)).toBe(true);
  });
});

describe('a read that failed', () => {
  it('says the map could not be loaded, and Try again reads it again', async () => {
    const page = await open({ map: null, notFound: false, failed: true });
    expect(page.get('[data-testid="public-map-read-failed"]').text()).toContain(
      'The map could not be loaded.',
    );
    expect(standsApart(routing.route as never)).toBe(true);
    fetchPublicMap.mockResolvedValue(found());
    await page.get('[data-testid="public-map-retry"]').trigger('click');
    await flushPromises();
    expect(fetchPublicMap).toHaveBeenCalledTimes(2);
    expect(page.get('[data-testid="public-map-heading"]').text()).toBe('Harbour Night Market');
  });
});

describe('the page', () => {
  it('holds the heading, the day and hall selects, the hall and the list, in order', async () => {
    const page = await open();
    const order = [
      'public-map-heading',
      'public-map-subtitle',
      'public-map-day-select',
      'public-map-location-select',
      'public-map-hall',
      'day-map',
      'public-map-legend',
      'public-map-vendors',
    ].map((id) => page.get(`[data-testid="${id}"]`).element);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(page.get('[data-testid="public-map-heading"]').element.tagName).toBe('H1');
    expect(page.get('[data-testid="public-map-subtitle"]').text()).toBe('Vendor map');
    expect(page.find('[data-testid="public-map-days"]').exists()).toBe(false);
    expect(document.title).toBe('Harbour Night Market map');
  });

  it('draws the hall filling its box, with no switch and no legend list of its own', async () => {
    const page = await open();
    const hall = page.get('[data-testid="public-map-hall"]');
    expect(hall.get('[data-testid="day-map"]').classes()).toContain('day-map--fills');
    expect(page.find('[data-testid="day-map-locations"]').exists()).toBe(false);
    expect(page.find('[data-testid="day-map-legend"]').exists()).toBe(false);
    expect(page.getComponent(PublicMapBackdrop).props('locations')).toEqual(
      publicDayLocations(ANSWER, () => 'blob:map-image'),
    );
  });

  it("names the open hall's sections in the legend, and a free table on a day it has one", async () => {
    const page = await open();
    const items = () => page.findAll('[data-testid="public-map-legend-item"]');
    expect(page.get('[data-testid="public-map-legend"]').attributes('aria-label')).toBe('Legend');
    // Today Gold row 4 is free.
    expect(items().map((item) => [item.attributes('data-kind'), item.text()])).toEqual([
      ['section', 'Gold row'],
      ['free', 'Free table'],
    ]);
    // Lower Hall's one table is taken today: no "Free table".
    await locationSelect().setValue('loc-lower');
    await flushPromises();
    expect(items().map((item) => item.text())).toEqual(['Silver aisle']);
  });

  it('marks <html> as filling the window while it is mounted', async () => {
    const page = await open();
    expect(document.documentElement.classList.contains('fills-the-window')).toBe(true);
    page.unmount();
    wrapper = null;
    expect(document.documentElement.classList.contains('fills-the-window')).toBe(false);
  });

  it('gives the browser its own title back on leaving', async () => {
    const page = await open();
    page.unmount();
    wrapper = null;
    expect(document.title).toBe('Conventioner');
  });

  it('opens today in the day select, each market day read short', async () => {
    const page = await open();
    expect(daySelect().element.value).toBe(TODAY);
    expect(daySelect().attributes('name')).toBe('public-map-day');
    expect(daySelect().element.labels?.[0]?.textContent?.trim()).toBe('Market day');
    expect(
      daySelect()
        .findAll('option')
        .map((o) => [o.attributes('value'), o.text()]),
    ).toEqual([
      [TODAY, 'Jun 5'],
      [TOMORROW, 'Jun 6'],
    ]);
    expect(page.find('[data-testid="public-map-day"]').exists()).toBe(false);
  });

  it('offers the halls in the location select, and no select for one hall', async () => {
    const page = await open();
    expect(locationSelect().element.value).toBe('loc-upper');
    expect(locationSelect().attributes('name')).toBe('public-map-location');
    expect(locationSelect().element.labels?.[0]?.textContent?.trim()).toBe('Location');
    expect(
      locationSelect()
        .findAll('option')
        .map((o) => o.text()),
    ).toEqual(['Upper Hall', 'Lower Hall']);
    page.unmount();
    await open(found({ ...ANSWER, locations: ANSWER.locations.slice(0, 1) }));
    expect(wrapper!.find('[data-testid="public-map-location-select"]').exists()).toBe(false);
  });

  it("reads the open location's image through the client, as the layout page does", async () => {
    const page = await open();
    expect(fetchPublicMapImage).toHaveBeenCalledWith('harbour-night-market', 'loc-upper');
    expect(page.get('[data-testid="layout-map-image"]').attributes('href')).toBe('blob:map-image');
  });

  it('shows no card before a table is picked', async () => {
    const page = await open();
    expect(page.find('[data-testid="public-map-card"]').exists()).toBe(false);
    expect(page.text()).not.toContain('Press a table');
  });

  it("reads another market's map when the address moves to it, the page kept", async () => {
    const page = await open();
    fetchPublicMap.mockResolvedValue({
      map: { ...ANSWER, marketName: 'River Craft Fair' },
      notFound: false,
      failed: false,
    });
    fetchPublicMapImage.mockClear();
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:river-image');

    routing.route.params = { marketSlug: 'river-craft-fair' };
    await flushPromises();

    expect(fetchPublicMap).toHaveBeenLastCalledWith('river-craft-fair');
    expect(page.get('[data-testid="public-map-heading"]').text()).toBe('River Craft Fair');
    expect(fetchPublicMapImage).toHaveBeenCalledWith('river-craft-fair', 'loc-upper');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:map-image');
    expect(page.get('[data-testid="layout-map-image"]').attributes('href')).toBe(
      'blob:river-image',
    );
  });

  it('reads nothing more once the address leaves the page', async () => {
    await open();
    fetchPublicMap.mockClear();
    routing.route.name = 'vendor-page';
    routing.route.params = { marketSlug: 'harbour-night-market-2' };
    await flushPromises();
    expect(fetchPublicMap).not.toHaveBeenCalled();
  });
});

describe('pressing a table', () => {
  it("writes it to the address, and the card is mounted with the page's place", async () => {
    const page = await open();
    await pressTable('g1');
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g1' },
    });
    const part = page.getComponent(PublicMapTableCard);
    expect(part.props()).toEqual({
      card: tableCard(ANSWER, TODAY, 'g1'),
      day: 'Fri 5 Jun',
      hallName: 'Upper Hall',
      paint: PAINTS.get('g1'),
    });
    expect(card().get('h2').text()).toBe('Table Gold row 1');
    expect(card().text()).toContain('Kiln & Co');
  });

  it("picks a shared table's seated half alone, its side written beside the table (T465)", async () => {
    const page = await open();
    for (const half of ['left', 'right'] as const) {
      await pressTable('g2', half);
      expect(routing.replace).toHaveBeenLastCalledWith({
        query: { date: TODAY, location: 'loc-upper', table: 'g2', half },
      });
      expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
        shownParts(tableCard(ANSWER, TODAY, 'g2')!, half),
      );
      expect(page.getComponent(DayMap).props('picked')).toBe(`g2:${half}`);
      expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBe(`g2:${half}`);
      expect(page.getComponent(PublicMapBubble).props('anchor')).toEqual({ tableId: 'g2', half });
    }
    expect(card().findAll('[data-testid="public-map-card-half"]')).toHaveLength(1);
    expect(card().get('h3').text()).toBe('Right half');
    expect(card().text()).toContain('Bee Candles');
    expect(card().text()).not.toContain('Acme Ceramics');
  });

  it('writes no half for a whole table, and drops the half picked before', async () => {
    const page = await open(found(), { table: 'g2', half: 'left' });
    await pressTable('g1');
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g1' },
    });
    expect(page.getComponent(DayMap).props('picked')).toBe('g1');
    expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBeNull();
    expect(page.getComponent(PublicMapBubble).props('anchor')).toEqual({
      tableId: 'g1',
      half: 'whole',
    });
  });

  it('opens the whole table for a free half pressed, both its parts', async () => {
    const rightFree = {
      ...ANSWER,
      seats: ANSWER.seats.filter((s) => !(s.tableId === 'g2' && s.half === 'right')),
    };
    const page = await open(found(rightFree));
    await pressTable('g2', 'right');
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g2' },
    });
    expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
      tableCard(rightFree, TODAY, 'g2'),
    );
    expect(page.getComponent(DayMap).props('picked')).toBe('g2');
    expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBeNull();
  });
});

describe('a half in the address (T465)', () => {
  it('opens that half alone, outlined, and its vendor ringed', async () => {
    const page = await open(found(), { table: 'g2', half: 'left' });
    expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
      shownParts(tableCard(ANSWER, TODAY, 'g2')!, 'left'),
    );
    expect(card().get('h3').text()).toBe('Left half');
    expect(page.getComponent(DayMap).props('picked')).toBe('g2:left');
    expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBe('g2:left');
  });

  it('shows the whole table on a day it is not split, outlined whole, with no error', async () => {
    const page = await open(found(), { date: TOMORROW, table: 'g2', half: 'right' });
    expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
      tableCard(ANSWER, TOMORROW, 'g2'),
    );
    expect(page.getComponent(DayMap).props('picked')).toBe('g2');
    expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBeNull();
    expect(page.getComponent(PublicMapBubble).props('anchor')).toEqual({
      tableId: 'g2',
      half: 'whole',
    });
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows the whole table for a half that is no side, with no error', async () => {
    const page = await open(found(), { table: 'g2', half: 'middle' });
    expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
      tableCard(ANSWER, TODAY, 'g2'),
    );
    expect(page.getComponent(DayMap).props('picked')).toBe('g2');
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('outlines the whole table for a half with nobody at it, its card saying it is free', async () => {
    const rightFree = {
      ...ANSWER,
      seats: ANSWER.seats.filter((s) => !(s.tableId === 'g2' && s.half === 'right')),
    };
    const page = await open(found(rightFree), { table: 'g2', half: 'right' });
    expect(card().text()).toContain('Right half');
    expect(card().text()).toContain('This half is free on Fri 5 Jun.');
    expect(page.getComponent(DayMap).props('picked')).toBe('g2');
    expect(page.getComponent(PublicMapVendors).props('pickedSeatKey')).toBeNull();
    expect(page.getComponent(PublicMapBubble).props('anchor')).toEqual({
      tableId: 'g2',
      half: 'right',
    });
  });

  it('keeps the half on a change of day', async () => {
    await open(found(), { location: 'loc-upper', table: 'g2', half: 'right' });
    await daySelect().setValue(TOMORROW);
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TOMORROW, location: 'loc-upper', table: 'g2', half: 'right' },
    });
  });

  it('drops the half with the table, on a change of hall and on Close', async () => {
    await open(found(), { table: 'g2', half: 'right' });
    await locationSelect().setValue('loc-lower');
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-lower' },
    });
    routing.route.query = { table: 'g2', half: 'right' };
    await flushPromises();
    await wrapper!.get('[data-testid="public-map-card-close"]').trigger('click');
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper' },
    });
  });

  it('keeps every other key of the query, and writes no half key it did not read', async () => {
    await open(found(), { table: 'g2', half: 'middle', utm: 'qr' });
    await daySelect().setValue(TOMORROW);
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { utm: 'qr', date: TOMORROW, location: 'loc-upper', table: 'g2' },
    });
  });

  it("Close from a half's card gives the focus back to that half", async () => {
    const page = await open(found(), { table: 'g2', half: 'right' });
    const close = page.get<HTMLButtonElement>('[data-testid="public-map-card-close"]');
    close.element.focus();
    await close.trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(
      page.get('[data-table-id="g2"] [data-half="right"]').element,
    );
  });
});

describe('the address', () => {
  it('opens the day, the location and the table it carries', async () => {
    const page = await open(found(), { date: TOMORROW, location: 'loc-lower', table: 's1' });
    expect(daySelect().element.value).toBe(TOMORROW);
    expect(locationSelect().element.value).toBe('loc-lower');
    expect(page.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Lower Hall layout, 1 table',
    );
    expect(card().get('h2').text()).toBe('Table Silver aisle 1');
    expect(page.findAll('[data-testid="layout-map-read"]')).toHaveLength(1);
  });

  it('falls back from values it does not know, saying no error', async () => {
    const page = await open(found(), { date: 'later', location: 'nowhere', table: 'x9' });
    expect(daySelect().element.value).toBe(TODAY);
    expect(page.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Upper Hall layout, 4 tables',
    );
    expect(page.find('[data-testid="public-map-card"]').exists()).toBe(false);
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('changes the day with replace, keeping the location and the table', async () => {
    await open(found(), { location: 'loc-upper', table: 'g1' });
    await daySelect().setValue(TOMORROW);
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TOMORROW, location: 'loc-upper', table: 'g1' },
    });
    expect(card().text()).toBe('Table Gold row 1Upper HallThis table is free on Sat 6 Jun.');
  });

  it('changes the location with replace, dropping a table that is not there', async () => {
    await open(found(), { table: 'g1' });
    await locationSelect().setValue('loc-lower');
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-lower' },
    });
    expect(fetchPublicMapImage).not.toHaveBeenCalledWith('harbour-night-market', 'loc-lower');
  });
});

describe("the list of the day's vendors", () => {
  it("is mounted with the page's day and table", async () => {
    const page = await open(found(), { table: 'g2' });
    expect(page.getComponent(PublicMapVendors).props()).toEqual({
      map: ANSWER,
      date: TODAY,
      pickedTableId: 'g2',
      pickedSeatKey: null,
      paints: PAINTS,
    });
    await daySelect().setValue(TOMORROW);
    await flushPromises();
    expect(page.getComponent(PublicMapVendors).props('date')).toBe(TOMORROW);
  });

  it("opens a vendor's location and picks their table", async () => {
    const page = await open();
    const cog = mapListing(ANSWER, TODAY).find((vendor) => vendor.name === 'Cog Prints')!;
    page.getComponent(PublicMapVendors).vm.$emit('open', cog);
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-lower', table: 's1' },
    });
    expect(page.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Lower Hall layout, 1 table',
    );
    expect(card().text()).toContain('Cog Prints');
    expect(page.getComponent(PublicMapTableCard).props('paint')).toEqual(PAINTS.get('s1'));
  });

  it('writes the half of a vendor at a shared table, and none for a whole seat (T465)', async () => {
    const page = await open();
    const named = (name: string) => mapListing(ANSWER, TODAY).find((v) => v.name === name)!;
    page.getComponent(PublicMapVendors).vm.$emit('open', named('Bee Candles'));
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g2', half: 'right' },
    });
    expect(card().text()).toContain('Bee Candles');
    expect(card().text()).not.toContain('Acme Ceramics');
    page.getComponent(PublicMapVendors).vm.$emit('open', named('Kiln & Co'));
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g1' },
    });
  });
});

// ── The card's place, closing it, and a vendor out of view (T465 ticket 05) ──

/** A window narrower than the sheet's two columns, its `matchMedia` answering not wide until
 *  `widen` says the window grew. */
function narrowWindow() {
  const heard: ((event: { matches: boolean }) => void)[] = [];
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        matches: false,
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          heard.push(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          heard.splice(heard.indexOf(listener), 1),
      }) as unknown as MediaQueryList,
  );
  return {
    heard,
    widen: () => heard.forEach((listener) => listener({ matches: true })),
  };
}

const side = () => wrapper!.get('.public-map__side');
const escape = (on: EventTarget = document.body) =>
  on.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );

describe("the card's place", () => {
  it('is the speech bubble in the hall at a desk, one card in the page', async () => {
    const page = await open(found(), { table: 'g1' });
    expect(page.findAll('[data-testid="public-map-card"]')).toHaveLength(1);
    const bubble = page.get('[data-testid="public-map-hall"] [data-testid="public-map-bubble"]');
    expect(bubble.find('[data-testid="public-map-card"]').exists()).toBe(true);
    expect(side().find('[data-testid="public-map-card"]').exists()).toBe(false);
    expect(page.getComponent(PublicMapBubble).props('anchor')).toEqual({
      tableId: 'g1',
      half: 'whole',
    });
  });

  it('is placed again whenever the day map shows another part of the hall', async () => {
    const page = await open(found(), { table: 'g1' });
    const moved = () => page.getComponent(PublicMapBubble).props('moved');
    const before = moved();
    page.getComponent(DayMap).vm.$emit('viewed');
    await flushPromises();
    expect(moved()).toBe(before + 1);
  });

  it("is the vendor panel's top in a narrower window, and the bubble once it widens", async () => {
    const window = narrowWindow();
    const page = await open(found(), { table: 'g1' });
    expect(page.findAll('[data-testid="public-map-card"]')).toHaveLength(1);
    expect(side().find('[data-testid="public-map-card"]').exists()).toBe(true);
    expect(page.find('[data-testid="public-map-bubble-layer"]').exists()).toBe(false);
    window.widen();
    await flushPromises();
    expect(page.findAll('[data-testid="public-map-card"]')).toHaveLength(1);
    expect(
      page.find('[data-testid="public-map-bubble"] [data-testid="public-map-card"]').exists(),
    ).toBe(true);
    page.unmount();
    wrapper = null;
    expect(window.heard).toHaveLength(0);
  });

  it('is the bubble in a window with no matchMedia', async () => {
    vi.stubGlobal('matchMedia', undefined);
    try {
      const page = await open(found(), { table: 'g1' });
      expect(
        page.find('[data-testid="public-map-bubble"] [data-testid="public-map-card"]').exists(),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('closing the card', () => {
  it('Close drops the table from the address, and gives the focus back to the table', async () => {
    const page = await open(found(), { table: 'g1' });
    const close = page.get<HTMLButtonElement>('[data-testid="public-map-card-close"]');
    close.element.focus();
    await close.trigger('click');
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper' },
    });
    expect(page.find('[data-testid="public-map-card"]').exists()).toBe(false);
    expect(document.activeElement).toBe(page.get('[data-table-id="g1"]').element);
  });

  it('Escape closes it at any width, leaving the focus where it was outside the card', async () => {
    narrowWindow();
    const page = await open(found(), { table: 'g1' });
    escape();
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper' },
    });
    expect(page.find('[data-testid="public-map-card"]').exists()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('Escape from inside the card gives the focus back to the table', async () => {
    const page = await open(found(), { table: 'g1' });
    const close = page.get<HTMLButtonElement>('[data-testid="public-map-card-close"]');
    close.element.focus();
    escape(close.element);
    await flushPromises();
    expect(document.activeElement).toBe(page.get('[data-table-id="g1"]').element);
  });

  it('Escape does nothing once something else has handled it', async () => {
    await open(found(), { table: 'g1' });
    const handled = (event: Event) => event.preventDefault();
    document.body.addEventListener('keydown', handled);
    try {
      escape();
      await flushPromises();
    } finally {
      document.body.removeEventListener('keydown', handled);
    }
    expect(routing.replace).not.toHaveBeenCalled();
  });

  it('Escape in a combobox whose list is open closes the list, not the card', async () => {
    const page = await open(found(), { table: 'g1' });
    const field = document.createElement('input');
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-expanded', 'true');
    document.body.append(field);
    try {
      field.focus();
      escape(field);
      await flushPromises();
      expect(routing.replace).not.toHaveBeenCalled();
      expect(page.find('[data-testid="public-map-card"]').exists()).toBe(true);
      // Its list shut, Escape closes the card.
      field.setAttribute('aria-expanded', 'false');
      escape(field);
      await flushPromises();
      expect(page.find('[data-testid="public-map-card"]').exists()).toBe(false);
    } finally {
      field.remove();
    }
  });

  it('Escape does nothing with no card, nor once the page has left', async () => {
    const page = await open();
    escape();
    await flushPromises();
    expect(routing.replace).not.toHaveBeenCalled();
    page.unmount();
    wrapper = null;
    routing.route.query = { table: 'g1' };
    escape();
    await flushPromises();
    expect(routing.replace).not.toHaveBeenCalled();
  });
});

describe('a vendor opened from the list', () => {
  /** The hall and the map 1,200 by 900 px at the window's top-left, Gold row 1 drawn at `g1`. */
  function drawn(g1: DOMRect) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute('data-testid');
      if (id === 'layout-map' || id === 'public-map-hall') return new DOMRect(0, 0, 1200, 900);
      if (this.getAttribute('data-table-id') === 'g1') return g1;
      return new DOMRect(0, 0, 0, 0);
    });
  }
  const viewWidth = () =>
    Number(wrapper!.get('[data-testid="layout-map"]').attributes('viewBox')!.split(' ')[2]);
  const kiln = () => mapListing(ANSWER, TODAY).find((vendor) => vendor.name === 'Kiln & Co')!;

  it('fits the map first when their table is out of view', async () => {
    const page = await open();
    const whole = viewWidth();
    await page.get('[data-testid="day-map-zoom-in"]').trigger('click');
    expect(viewWidth()).toBeLessThan(whole);
    drawn(new DOMRect(1500, 300, 40, 20));
    page.getComponent(PublicMapVendors).vm.$emit('open', kiln());
    await flushPromises();
    expect(viewWidth()).toBeCloseTo(whole);
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TODAY, location: 'loc-upper', table: 'g1' },
    });
  });

  it('keeps the zoom when their table is in view', async () => {
    const page = await open();
    await page.get('[data-testid="day-map-zoom-in"]').trigger('click');
    const zoomed = viewWidth();
    drawn(new DOMRect(500, 300, 40, 20));
    page.getComponent(PublicMapVendors).vm.$emit('open', kiln());
    await flushPromises();
    expect(viewWidth()).toBeCloseTo(zoomed);
  });
});
