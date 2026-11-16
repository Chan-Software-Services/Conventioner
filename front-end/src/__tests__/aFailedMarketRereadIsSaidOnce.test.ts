import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

/**
 * A failed re-read of the open market is said once, by the frame, for every market screen (T421):
 * nothing on screen said it before, so a dropped connection left the organizer reading an old
 * market as the server's. What is shown stays; the line goes as soon as a re-read lands.
 */
type Pending = {
  url: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};
const calls: Pending[] = [];

vi.mock('@/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api')>()),
  api: {
    get: (url: string) => new Promise((resolve, reject) => calls.push({ url, resolve, reject })),
  },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => ({ name: 'market-vendors', params: { marketId: 'm1' }, matched: [] }),
}));

import MarketFrame from '@/components/MarketFrame.vue';
import { useMarketStore } from '@/stores/market';

const SAID = 'Could not update the market. It is shown as it was last read.';

const apiMarket = (id: string) => ({
  data: {
    market: {
      id,
      name: `Market ${id}`,
      creationDate: '2026-01-01T00:00:00Z',
      roles: {},
      modificationList: [],
      assignmentObject: { vendorAssignments: [] },
      phase: 'market_days',
    },
  },
});
const httpError = (status: number) => ({ isAxiosError: true, response: { status } });
const offline = { isAxiosError: true, message: 'Network Error' };

/** A market screen: the frame around the store's market, as every screen holds it. */
function mountScreen() {
  const retried = vi.fn();
  const Screen = defineComponent({
    setup() {
      const store = useMarketStore();
      return () =>
        h(
          MarketFrame,
          { market: store.market, onRetry: retried },
          { default: () => h('div', { 'data-testid': 'the-page' }, 'The page') },
        );
    },
  });
  const wrapper = mount(Screen, {
    global: { stubs: { MarketBar: true, PhaseRail: true, MarketPages: true } },
  });
  return { wrapper, retried };
}

const line = (wrapper: ReturnType<typeof mountScreen>['wrapper']) =>
  wrapper.find('[data-testid="market-reread-failed"]');

/** Open m1, answered, then fail its re-read in transit. */
async function aFailedReread() {
  const store = useMarketStore();
  const opened = store.open('m1');
  calls[0].resolve(apiMarket('m1'));
  await opened;
  const again = store.refresh();
  calls[1].reject(offline);
  await again;
  await flushPromises();
  return store;
}

describe('a failed re-read of the market is said once', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    calls.length = 0;
  });

  it('is not said while the market reads as the server has it', async () => {
    const { wrapper } = mountScreen();
    const store = useMarketStore();
    const opened = store.open('m1');
    calls[0].resolve(apiMarket('m1'));
    await opened;
    await flushPromises();

    expect(wrapper.find('[data-testid="the-page"]').exists()).toBe(true);
    expect(line(wrapper).exists()).toBe(false);
  });

  it('says it once, in red words a reader is told of, above the page it keeps', async () => {
    const { wrapper } = mountScreen();
    await aFailedReread();

    expect(wrapper.findAll('[data-testid="market-reread-failed"]')).toHaveLength(1);
    expect(line(wrapper).attributes('role')).toBe('alert');
    expect(line(wrapper).find('p').text()).toBe(SAID);
    expect(line(wrapper).find('[data-testid="market-reread-retry"]').text()).toBe('Try again');
    expect(wrapper.find('[data-testid="the-page"]').exists()).toBe(true);
    // Under the pinned block, above the page.
    const html = wrapper.html();
    expect(html.indexOf('market-reread-failed')).toBeGreaterThan(html.indexOf('market-frame'));
    expect(html.indexOf('market-reread-failed')).toBeLessThan(html.indexOf('the-page'));
  });

  it('keeps it said while the next re-read is out, and drops it when one lands', async () => {
    const { wrapper } = mountScreen();
    const store = await aFailedReread();

    const next = store.refresh();
    await flushPromises();
    expect(store.status).toBe('refreshing');
    expect(line(wrapper).exists()).toBe(true);

    calls[2].resolve(apiMarket('m1'));
    await next;
    await flushPromises();
    expect(line(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-testid="the-page"]').exists()).toBe(true);
  });

  it('is not said on a re-read out after one that landed', async () => {
    const { wrapper } = mountScreen();
    const store = useMarketStore();
    const opened = store.open('m1');
    calls[0].resolve(apiMarket('m1'));
    await opened;

    void store.refresh();
    await flushPromises();
    expect(store.status).toBe('refreshing');
    expect(line(wrapper).exists()).toBe(false);
  });

  it('Try again re-reads the market and asks the screen to read its own again', async () => {
    const { wrapper, retried } = mountScreen();
    await aFailedReread();

    await line(wrapper).find('[data-testid="market-reread-retry"]').trigger('click');

    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe('/markets/m1');
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it('is never said of a market that failed to arrive: that is the arrival’s alone', async () => {
    const { wrapper } = mountScreen();
    const store = useMarketStore();
    const opened = store.open('m1');
    calls[0].reject(offline);
    await opened;
    await flushPromises();

    expect(store.status).toBe('failed');
    expect(line(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-testid="market-arrival-failed"]').exists()).toBe(true);
  });

  it('is never said of a market that has gone, even after a failed re-read of it', async () => {
    const { wrapper } = mountScreen();
    const store = await aFailedReread();

    const next = store.refresh();
    calls[2].reject(httpError(404));
    await next;
    await flushPromises();

    expect(store.status).toBe('missing');
    expect(line(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-testid="market-arrival-missing"]').exists()).toBe(true);
  });

  it('is not carried to the next market, which reads failed alone when it fails to arrive', async () => {
    const { wrapper } = mountScreen();
    const store = await aFailedReread();

    const other = store.open('m2');
    calls[2].reject(offline);
    await other;
    await flushPromises();

    expect(store.status).toBe('failed');
    expect(line(wrapper).exists()).toBe(false);
    expect(wrapper.find('[data-testid="market-arrival-failed"]').exists()).toBe(true);
  });
});
