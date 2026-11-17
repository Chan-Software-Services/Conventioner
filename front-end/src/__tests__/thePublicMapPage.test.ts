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
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import { standsApart } from '@/utils/currentPlace';
import {
  dayInWords,
  instagramLink,
  mapListing,
  mapPlace,
  openingDate,
  tableCard,
  websiteLink,
  type PublicMapRead,
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

describe('the place the address names', () => {
  it('is the day, the location and the table it carries', () => {
    expect(mapPlace(ANSWER, { date: TOMORROW, location: 'loc-lower', table: 's1' }, TODAY)).toEqual(
      { date: TOMORROW, locationId: 'loc-lower', tableId: 's1' },
    );
  });

  it("opens the table's own location when the address names a table alone", () => {
    expect(mapPlace(ANSWER, { table: 's1' }, TODAY)).toEqual({
      date: TODAY,
      locationId: 'loc-lower',
      tableId: 's1',
    });
  });

  it('falls back from every value it does not know, without an error', () => {
    expect(
      mapPlace(ANSWER, { date: '1999-01-01', location: 'nowhere', table: 'x9' }, TODAY),
    ).toEqual({ date: TODAY, locationId: 'loc-upper', tableId: null });
    // A table at another location than the open one is no pick there.
    expect(mapPlace(ANSWER, { location: 'loc-upper', table: 's1' }, TODAY)).toEqual({
      date: TODAY,
      locationId: 'loc-upper',
      tableId: null,
    });
    expect(mapPlace(ANSWER, { date: ['a', 'b'] as unknown as string }, TODAY).date).toBe(TODAY);
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

// ── The page ─────────────────────────────────────────────────────────────────

let wrapper: VueWrapper | null = null;
const scrolled = vi.fn();

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
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
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
  it('holds the heading, the days, the map with its legend, the card and the list, in order', async () => {
    const page = await open();
    const order = [
      'public-map-heading',
      'public-map-days',
      'day-map',
      'public-map-card',
      'public-map-vendors',
    ].map((id) => page.get(`[data-testid="${id}"]`).element);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(page.get('[data-testid="public-map-heading"]').element.tagName).toBe('H1');
    expect(page.get('[data-testid="public-map-subtitle"]').text()).toBe('Map');
    expect(page.findAll('[data-testid="day-map-legend-item"]').map((i) => i.text())).toEqual([
      'Taken',
      'Free',
    ]);
    expect(document.title).toBe('Harbour Night Market map');
  });

  it('gives the browser its own title back on leaving', async () => {
    const page = await open();
    page.unmount();
    wrapper = null;
    expect(document.title).toBe('Conventioner');
  });

  it('opens today, its day button pressed, each day in words', async () => {
    const page = await open();
    const days = page.findAll('[data-testid="public-map-day"]');
    expect(days.map((d) => d.text())).toEqual(['Fri 5 Jun', 'Sat 6 Jun']);
    expect(days.map((d) => d.attributes('aria-pressed'))).toEqual(['true', 'false']);
  });

  it("reads the open location's image through the client, as the layout page does", async () => {
    const page = await open();
    expect(fetchPublicMapImage).toHaveBeenCalledWith('harbour-night-market', 'loc-upper');
    expect(page.get('[data-testid="layout-map-image"]').attributes('href')).toBe('blob:map-image');
  });

  it('says what to do before a table is picked', async () => {
    await open();
    expect(card().text()).toBe('Press a table, or find a vendor below.');
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
      paint: null,
    });
    expect(card().get('h2').text()).toBe('Table Gold row 1');
    expect(card().text()).toContain('Kiln & Co');
  });

  it('opens the card of a shared table whichever half is pressed', async () => {
    const page = await open();
    for (const half of ['left', 'right'] as const) {
      await pressTable('g2', half);
      expect(page.getComponent(PublicMapTableCard).props('card')).toEqual(
        tableCard(ANSWER, TODAY, 'g2'),
      );
    }
  });
});

describe('the address', () => {
  it('opens the day, the location and the table it carries', async () => {
    const page = await open(found(), { date: TOMORROW, location: 'loc-lower', table: 's1' });
    expect(page.get('[data-testid="public-map-day"][aria-pressed="true"]').text()).toBe(
      'Sat 6 Jun',
    );
    expect(page.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Lower Hall layout, 1 table',
    );
    expect(card().get('h2').text()).toBe('Table Silver aisle 1');
    expect(page.findAll('[data-testid="layout-map-read"]')).toHaveLength(1);
  });

  it('falls back from values it does not know, saying no error', async () => {
    const page = await open(found(), { date: 'later', location: 'nowhere', table: 'x9' });
    expect(page.get('[data-testid="public-map-day"][aria-pressed="true"]').text()).toBe(
      'Fri 5 Jun',
    );
    expect(page.get('[data-testid="layout-map"]').attributes('aria-label')).toBe(
      'Upper Hall layout, 4 tables',
    );
    expect(card().text()).toBe('Press a table, or find a vendor below.');
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('changes the day with replace, keeping the location and the table', async () => {
    const page = await open(found(), { location: 'loc-upper', table: 'g1' });
    await page.findAll('[data-testid="public-map-day"]')[1].trigger('click');
    await flushPromises();
    expect(routing.replace).toHaveBeenLastCalledWith({
      query: { date: TOMORROW, location: 'loc-upper', table: 'g1' },
    });
    expect(card().text()).toBe('Table Gold row 1This table is free on Sat 6 Jun.');
  });

  it('changes the location with replace, dropping a table that is not there', async () => {
    const page = await open(found(), { table: 'g1' });
    await page.get('[data-testid="day-map-locations"] button:nth-child(2)').trigger('click');
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
      paints: new Map(),
    });
    await page.findAll('[data-testid="public-map-day"]')[1].trigger('click');
    await flushPromises();
    expect(page.getComponent(PublicMapVendors).props('date')).toBe(TOMORROW);
  });

  it("opens a vendor's location, picks their table and brings the map into view", async () => {
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
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts.at(-1)).toBe(page.get('[data-testid="public-map-map"]').element);
  });
});
