// @vitest-environment happy-dom
/**
 * Stats reads its own market (T277 ticket 11, T421): the page moved from market A to market B, and
 * back to A, while A's count is still out.
 *
 * A jump through history keeps the page, and its guard compared only the market on screen, so the
 * first A answer, landing after the second, stood over it, and so did a failure of it. The figures
 * are now one keyed read (`useServerRead`): a move drops the last market's figures in the same
 * tick, only the newest read of the open market lands, and the failure said is that read's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { nextTick, reactive, ref } from 'vue';

import StatsView from '@/views/StatsView.vue';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import type { MarketStats } from '@/utils/marketStats';
import { answersRefusing } from './support/servedAnswers';

const route = reactive({ params: { marketId: 'market-a' }, query: {} as Record<string, string> });
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const marketRef = ref<Market | null>({
  id: 'market-a',
  name: 'Market A',
  phase: MarketPhase.Applications,
  actionRefusals: answersRefusing(),
} as unknown as Market);
vi.mock('@/utils/openMarket', () => ({ useOpenMarket: () => ({ market: marketRef }) }));
const fetchMarketStats = vi.hoisted(() => vi.fn());
vi.mock('@/utils/marketStats', () => ({ fetchMarketStats }));

/** A read held open until the test answers or refuses it. */
interface Held {
  id: string;
  answer: (stats: MarketStats) => void;
  refuse: (error: unknown) => void;
}
let reads: Held[] = [];

/** A market's figures, `total` applications in all. */
function figures(total: number): MarketStats {
  return {
    applicants: {
      total,
      addedByHand: 0,
      states: { open: total, follow_up: 0, approved: 0, rejected: 0 },
      submittedAt: [],
      openedAt: null,
      closedAt: null,
    },
    answers: { questions: [], groups: { all: total, approved: 0, assigned: 0 } },
    room: null,
    fill: null,
    checkIn: null,
    headlines: { placements: null, money: null },
  } as unknown as MarketStats;
}

function refusal(): AxiosError {
  return Object.assign(new AxiosError('refused'), { response: { status: 404, data: {} } });
}

const MarketFrame = {
  emits: ['retry'],
  template:
    '<div><button data-testid="frame-retry" @click="$emit(\'retry\')">Try again</button><slot /></div>',
};

enableAutoUnmount(afterEach);
afterEach(() => {
  route.params.marketId = 'market-a';
  reads = [];
  fetchMarketStats.mockReset();
});

function mountStats(): VueWrapper {
  fetchMarketStats.mockImplementation(
    (id: string) =>
      new Promise<MarketStats>((answer, refuse) => {
        reads.push({ id, answer, refuse });
      }),
  );
  return mount(StatsView, { global: { stubs: { MarketFrame, RouterLink: true } } });
}

/** What "Who applied" says: its total, its counting line or its failure. */
function whoApplied(w: VueWrapper): string {
  for (const id of ['stats-error', 'stats-counting', 'stats-applicants-total']) {
    const line = w.find(`[data-testid="${id}"]`);
    if (line.exists()) return `${id}: ${line.text()}`;
  }
  return '';
}

describe('Stats reads its own market', () => {
  it('A, B, then A again: the first A answer, landing after the second, is dropped', async () => {
    const w = mountStats();
    route.params.marketId = 'market-b';
    await flushPromises();
    route.params.marketId = 'market-a';
    await flushPromises();
    expect(reads.map((read) => read.id)).toEqual(['market-a', 'market-b', 'market-a']);

    reads[2]!.answer(figures(7));
    await flushPromises();
    reads[0]!.answer(figures(3));
    reads[1]!.answer(figures(5));
    await flushPromises();

    expect(whoApplied(w)).toBe('stats-applicants-total: 7 applications in all');
  });

  it("drops the last market's figures in the same tick it moves, and counts the next", async () => {
    const w = mountStats();
    reads[0]!.answer(figures(3));
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-applicants-total: 3 applications in all');

    route.params.marketId = 'market-b';
    await nextTick();
    expect(whoApplied(w)).toBe('stats-counting: Counting…');

    reads[1]!.answer(figures(5));
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-applicants-total: 5 applications in all');
  });

  it("says no failure of another market's read, nor of an overtaken one", async () => {
    const w = mountStats();
    for (const id of ['market-b', 'market-a', 'market-b']) {
      route.params.marketId = id;
      await flushPromises();
    }
    expect(reads.map((read) => read.id)).toEqual(['market-a', 'market-b', 'market-a', 'market-b']);
    reads[0]!.refuse(refusal());
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-counting: Counting…');

    reads[3]!.answer(figures(5));
    await flushPromises();
    reads[1]!.refuse(refusal());
    reads[2]!.refuse(refusal());
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-applicants-total: 5 applications in all');
  });

  it("says the open market's failed count, and the frame's Try again counts again", async () => {
    const w = mountStats();
    reads[0]!.refuse(refusal());
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-error: The figures could not be counted.');
    expect(w.get('[data-testid="stats-error"]').attributes('role')).toBe('alert');

    await w.get('[data-testid="frame-retry"]').trigger('click');
    expect(whoApplied(w)).toBe('stats-counting: Counting…');
    expect(reads.map((read) => read.id)).toEqual(['market-a', 'market-a']);
    reads[1]!.answer(figures(4));
    await flushPromises();
    expect(whoApplied(w)).toBe('stats-applicants-total: 4 applications in all');
  });
});
