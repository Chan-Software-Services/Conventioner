/**
 * The Assignments page's tables read their own market (T277 ticket 11, T421): the page moved from
 * market A to market B while A's tables are still out.
 *
 * A jump through history keeps the page, and its read on a watch of the market id took every answer
 * that came back, so A's tables, names and placeable vendors, landing after B's, stood under B's
 * name, and so did A's refusal. The tables are now one keyed read (`useServerRead`): a move drops
 * the last market's tables in the same tick and says "Loading tables…", and only the newest read of
 * the open market lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { nextTick, reactive, ref } from 'vue';

import PlacementDialog from '@/components/PlacementDialog.vue';
import ResultSeat from '@/components/ResultSeat.vue';
import ResultView from '@/views/ResultView.vue';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import type { MarketTableRow } from '@/utils/resultFilters';
import type { PlaceableVendor } from '@/utils/placementChange';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

const route = reactive({ params: { marketId: 'market-a' }, query: {} });
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
const opened = vi.hoisted(() => ({ market: null as unknown }));
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: opened.market, status: ref('ready'), refresh: vi.fn() }),
}));
vi.mock('@/utils/vendorDetails', () => ({
  useVendorDetails: () => ({ loaded: { value: false }, load: vi.fn() }),
}));

const DATE = '2099-08-01';

function market(id: string): Market {
  return {
    id,
    name: id === 'market-a' ? 'Market A' : 'Market B',
    phase: MarketPhase.Assignment,
    allocation: 'none',
    assignRefusalReason: null,
    actionRefusals: answersRefusing(),
    setupObject: { marketDates: [{ date: DATE }], sections: [], tiers: [], locations: [] },
    assignmentObject: { vendorAssignments: [] },
  } as unknown as Market;
}

/** `count` tables in one section, each held by `occupant`, coded by the market they belong to. */
function tables(prefix: string, occupant: string | null, count = 1): MarketTableRow[] {
  return Array.from({ length: count }, (_, i) => ({
    date: DATE,
    assignment: occupant ? [occupant] : [],
    assignmentSlots: [occupant, occupant],
    location: 'Main Hall',
    section: 'Main Hall',
    tableChoice: occupant ? 'Full Table' : '',
    tableCode: `${prefix} ${i + 1}`,
    tier: 'Gold',
  }));
}

interface TablesAnswer {
  rows: MarketTableRow[];
  vendorNames: Record<string, string>;
  vendors: PlaceableVendor[];
}

/** A tables read held open until the test answers or refuses it. */
interface Held {
  url: string;
  answer: (data: TablesAnswer) => void;
  refuse: (error: unknown) => void;
}
let reads: Held[] = [];

function readOf(id: string, nth = 0): Held {
  const held = reads.filter((read) => read.url === `/markets/${id}/tables`)[nth];
  if (!held) throw new Error(`no read ${nth} of ${id}`);
  return held;
}

/** Market A's tables: Ana at table "A 1", with her name, and her as the one to place. */
const A_TABLES: TablesAnswer = {
  rows: tables('A', 'ana@example.com'),
  vendorNames: { 'ana@example.com': 'Ana Atrium' },
  vendors: [{ email: 'ana@example.com', name: 'Ana Atrium' } as unknown as PlaceableVendor],
};
/** Market B's tables: one empty table "B 1", and Ben to place. */
const B_TABLES: TablesAnswer = {
  rows: tables('B', null),
  vendorNames: { 'ben@example.com': 'Ben Basement' },
  vendors: [{ email: 'ben@example.com', name: 'Ben Basement' } as unknown as PlaceableVendor],
};

function refusal(sentence: string): AxiosError {
  return Object.assign(new AxiosError('refused'), {
    response: { status: 403, data: { error: sentence } },
  });
}

const MarketFrame = { emits: ['retry'], template: '<div><slot /></div>' };

enableAutoUnmount(beforeEach);

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify('organizer@example.com'));
  route.params.marketId = 'market-a';
  opened.market = ref(market('market-a'));
  reads = [];
  api.get.mockReset().mockImplementation(
    (url: string) =>
      new Promise((answer, refuse) => {
        if (!url.endsWith('/tables')) return refuse(new Error(`unexpected read ${url}`));
        reads.push({ url, answer: (data) => answer({ data }), refuse });
      }),
  );
});

function mountTables(stubs: Record<string, unknown> = {}): VueWrapper {
  return mount(ResultView, {
    global: {
      stubs: {
        MarketFrame,
        ResultSummary: true,
        VendorDrawer: true,
        PlacementDialog: true,
        ResultSeat: true,
        ...stubs,
      },
    },
  });
}

/** Moves the page to market B, as a jump through history does: the page is kept. */
function moveToB(): void {
  route.params.marketId = 'market-b';
  (opened.market as { value: Market }).value = market('market-b');
}

function tableCodes(w: VueWrapper): string[] {
  return w
    .findAll('[data-testid="tables-table-row"]')
    .map((row) => String(row.attributes('data-table-code')));
}

describe('the tables read their own market', () => {
  it("never shows A's tables, names or vendors when A's answer lands after B's", async () => {
    const w = mountTables();
    await flushPromises();
    moveToB();
    await flushPromises();

    readOf('market-b').answer(B_TABLES);
    await flushPromises();
    readOf('market-a').answer(A_TABLES);
    await flushPromises();

    expect(tableCodes(w)).toEqual(['B 1']);
    w.findComponent(ResultSeat).vm.$emit('open');
    await flushPromises();
    const dialog = w.findComponent(PlacementDialog);
    expect(dialog.props('vendors')).toEqual(B_TABLES.vendors);
    expect(dialog.props('vendorNames')).toEqual(B_TABLES.vendorNames);
    expect(dialog.props('tableCode')).toBe('B 1');
  });

  it("drops A's tables in the same tick it moves, says it is loading, then shows B's", async () => {
    const w = mountTables();
    readOf('market-a').answer(A_TABLES);
    await flushPromises();
    expect(tableCodes(w)).toEqual(['A 1']);

    moveToB();
    await nextTick();

    expect(tableCodes(w)).toEqual([]);
    expect(w.get('.status-message').text()).toBe('Loading tables…');

    readOf('market-b').answer(B_TABLES);
    await flushPromises();
    expect(tableCodes(w)).toEqual(['B 1']);
    expect(w.find('.status-message').exists()).toBe(false);
  });

  it("never says A's refusal on B", async () => {
    const w = mountTables();
    await flushPromises();
    moveToB();
    await flushPromises();

    readOf('market-b').answer(B_TABLES);
    readOf('market-a').refuse(refusal('You may not read market A.'));
    await flushPromises();

    expect(w.text()).not.toContain('You may not read market A.');
    expect(w.find('[data-testid="tables-read-failed"]').exists()).toBe(false);
    expect(tableCodes(w)).toEqual(['B 1']);
  });

  it("says the open market's own refusal, and Try again reads it again", async () => {
    const w = mountTables();
    readOf('market-a').refuse(refusal('You may not read market A.'));
    await flushPromises();

    expect(w.text()).toContain('You may not read market A.');

    await w.get('[data-testid="tables-read-failed"] button').trigger('click');
    await flushPromises();
    expect(reads.filter((read) => read.url === '/markets/market-a/tables')).toHaveLength(2);
    readOf('market-a', 1).answer(A_TABLES);
    await flushPromises();
    expect(w.text()).not.toContain('You may not read market A.');
    expect(tableCodes(w)).toEqual(['A 1']);
  });

  it("forgets A's section folds on the move to B", async () => {
    const w = mountTables({ ResultFilterBar: true });
    readOf('market-a').answer({ ...A_TABLES, rows: tables('A', null, 21) });
    await flushPromises();
    await w.get('[data-testid="tables-show-all"]').trigger('click');
    expect(w.get('[data-testid="tables-show-all"]').text()).toBe('Show fewer');

    moveToB();
    await flushPromises();
    readOf('market-b').answer({ ...B_TABLES, rows: tables('B', null, 21) });
    await flushPromises();

    expect(w.get('[data-testid="tables-show-all"]').text()).toBe('Show all 21 tables');
    expect(tableCodes(w)).toHaveLength(20);
  });

  it('keeps the tables when a re-read fails, says so, and hides it while the next is out', async () => {
    const w = mountTables({
      MarketFrame: {
        emits: ['retry'],
        template:
          '<div><button data-testid="frame-retry" @click="$emit(\'retry\')">Try again</button><slot /></div>',
      },
    });
    readOf('market-a').answer(A_TABLES);
    await flushPromises();

    await w.get('[data-testid="frame-retry"]').trigger('click');
    readOf('market-a', 1).refuse(new AxiosError('offline'));
    await flushPromises();

    expect(tableCodes(w)).toEqual(['A 1']);
    expect(w.get('[data-testid="tables-read-failed"]').text()).toContain(
      'Could not update. The tables are as they were last read.',
    );

    await w.get('[data-testid="frame-retry"]').trigger('click');
    expect(w.find('[data-testid="tables-read-failed"]').exists()).toBe(false);
    expect(tableCodes(w)).toEqual(['A 1']);
    readOf('market-a', 2).answer(B_TABLES);
    await flushPromises();
    expect(w.find('[data-testid="tables-read-failed"]').exists()).toBe(false);
  });

  it('asks again who is signed in on Try again, and reads once they are', async () => {
    localStorage.removeItem('user');
    const w = mountTables();
    await flushPromises();
    expect(w.text()).toContain('You must be signed in to view tables.');

    localStorage.setItem('user', JSON.stringify('organizer@example.com'));
    await w.get('[data-testid="tables-retry"]').trigger('click');
    expect(reads).toHaveLength(1);
    readOf('market-a').answer(A_TABLES);
    await flushPromises();

    expect(w.text()).not.toContain('You must be signed in to view tables.');
    expect(tableCodes(w)).toEqual(['A 1']);
  });

  it('says it must be signed in, and reads nothing, with nobody signed in', async () => {
    localStorage.removeItem('user');
    const w = mountTables();
    await flushPromises();

    expect(w.text()).toContain('You must be signed in to view tables.');
    expect(reads).toHaveLength(0);
  });

  it('says the market id is missing, and reads nothing, with none in the address', async () => {
    route.params.marketId = '';
    const w = mountTables();
    await flushPromises();

    expect(w.text()).toContain('Missing market id.');
    expect(reads).toHaveLength(0);
  });
});
