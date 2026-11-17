// @vitest-environment happy-dom
/**
 * The public map's list of the day's vendors (T422 ticket 09, T465), mounted alone: the named
 * vendors by name, each with their table and location, narrowed by the find field; a press asks
 * the page to open the vendor's table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import { mapListing } from '@/utils/publicMap';
import { ANSWER, TODAY } from './support/publicMapAnswer';

/** The page's address, whose `find` key holds the find field's words, as the router would. */
const routing = vi.hoisted(() => ({
  route: null as unknown as { query: Record<string, string> },
}));
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routing.route = reactive({ name: 'public-map', params: {}, query: {} });
  return {
    useRoute: () => routing.route,
    useRouter: () => ({
      replace: (to: { query: Record<string, string> }) => {
        routing.route.query = { ...to.query };
      },
    }),
  };
});

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  routing.route.query = {};
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function open(map: PublicMapAnswer = ANSWER, pickedTableId: string | null = null) {
  wrapper = mount(PublicMapVendors, {
    props: { map, date: TODAY, pickedTableId, pickedSeatKey: null, paints: new Map() },
    attachTo: document.body,
  });
  return wrapper;
}

const rows = () => wrapper!.findAll('[data-testid="public-map-vendors-row"]');

describe("the list of the day's vendors", () => {
  it('lists the named vendors by name, each with its table and location, and counts them', () => {
    const list = open();
    expect(rows().map((r) => r.text())).toEqual([
      'Acme CeramicsTable Gold row 2, Upper Hall',
      'Bee CandlesTable Gold row 2, Upper Hall',
      'Cog PrintsTable Silver aisle 1, Lower Hall',
      'Kiln & CoTable Gold row 1, Upper Hall',
    ]);
    expect(list.get('[data-testid="public-map-vendors-count"]').text()).toBe('4 vendors');
    expect(list.get('label[for]').text()).toBe('Find a vendor');
  });

  it('narrows as the find field is typed in, and does nothing on Enter', async () => {
    const list = open();
    const find = list.get('[data-testid="public-map-vendors-find"]');
    await find.setValue('cog');
    await flushPromises();
    expect(rows().map((r) => r.text())).toEqual(['Cog PrintsTable Silver aisle 1, Lower Hall']);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    find.element.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(list.emitted('open')).toBeUndefined();
  });

  it('asks the page to open a vendor when their row is pressed', async () => {
    const list = open();
    await rows()[2].get('button').trigger('click');
    expect(list.emitted('open')).toEqual([[mapListing(ANSWER, TODAY)[2]]]);
    expect(list.emitted('open')![0][0]).toMatchObject({ name: 'Cog Prints', tableId: 's1' });
  });

  it('marks the rows of the table picked as current', () => {
    open(ANSWER, 'g2');
    expect(rows().map((r) => r.get('button').attributes('aria-current') ?? null)).toEqual([
      'true',
      'true',
      null,
      null,
    ]);
  });

  it('says so when no vendor is listed for the day', () => {
    const list = open({ ...ANSWER, seats: [] });
    expect(list.get('[data-testid="public-map-vendors-empty"]').text()).toBe(
      'No vendors are listed for this day yet.',
    );
  });
});
