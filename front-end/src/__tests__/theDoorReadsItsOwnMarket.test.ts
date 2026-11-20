// @vitest-environment happy-dom
/**
 * The door reads its own market (T277 ticket 11, T421): Attendance moved from market A to market B
 * while A's reads or writes are out.
 *
 * A check-in tapped on A whose refusal landed after the organizer moved to B said "That check-in
 * was not recorded." on B's roster, of a vendor B may not even have. Each roster read and each
 * check-in now belongs to the market it was made on (`useServerRead`): an answer for A changes
 * nothing on B's page, and A's roster never stands under B's name, not even while B's is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { reactive, ref } from 'vue';

import AttendanceStatusView from '@/views/AttendanceStatusView.vue';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import { calendarToday } from '@/utils/marketGuide';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: marketRef, status: ref('loaded'), refresh: vi.fn() }),
}));
vi.mock('@/utils/vendorDetails', () => ({
  useVendorDetails: () => ({ loaded: { value: false }, load: vi.fn() }),
}));

const route = reactive({ params: { marketId: 'market-a' }, query: {} as Record<string, string> });
const TODAY = calendarToday();
const ANA = 'ana@example.com';
const BEN = 'ben@example.com';

function marketOf(id: string): Market {
  return {
    id,
    name: id,
    phase: MarketPhase.MarketDays,
    actionRefusals: answersRefusing(),
  } as unknown as Market;
}
const marketRef = ref<Market | null>(marketOf('market-a'));

function rosterOf(email: string) {
  return {
    data: {
      dates: [TODAY],
      roster: [
        {
          date: TODAY,
          vendorEmail: email,
          vendorName: '',
          tableCode: 'A1',
          tableChoice: 'Full Table',
          section: 'Main Hall',
          location: 'Main Hall',
          state: 'expected',
          checkedInTableCode: null,
          checkedInAt: null,
          checkedInBy: null,
          checkedInVia: null,
        },
      ],
    },
  };
}

function held<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

const rows = (w: VueWrapper) =>
  w.findAll('[data-testid="attendance-row"]').map((r) => r.attributes('data-vendor'));

async function open(): Promise<VueWrapper> {
  const wrapper = mount(AttendanceStatusView, {
    attachTo: document.body,
    global: {
      stubs: {
        MarketFrame: { template: '<div><slot /></div>' },
        VendorDrawer: true,
        DoorCodeScreen: true,
        VendorNotes: true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

async function moveTo(id: string) {
  route.params.marketId = id;
  marketRef.value = marketOf(id);
  await flushPromises();
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  route.params.marketId = 'market-a';
  route.query = {};
  marketRef.value = marketOf('market-a');
  localStorage.setItem('user', JSON.stringify({ email: 'org@example.com' }));
});
afterEach(() => localStorage.clear());

describe("market A's roster and writes never stand on market B's page", () => {
  it("A's roster read answering after the move to B is dropped, and B's page says Loading", async () => {
    const a = held<unknown>();
    const b = held<unknown>();
    api.get.mockImplementation((url: string) => {
      if (url === '/markets/market-a/attendance') return a.promise;
      if (url === '/markets/market-b/attendance') return b.promise;
      return Promise.resolve({ data: {} });
    });
    const w = await open();
    await moveTo('market-b');
    a.settle(rosterOf(ANA));
    await flushPromises();
    expect(rows(w)).toEqual([]);
    expect(w.text()).toContain('Loading');
    b.settle(rosterOf(BEN));
    await flushPromises();
    expect(rows(w)).toEqual([BEN]);
  });

  it("a check-in tapped on A whose refusal lands after the move to B says nothing on B's page", async () => {
    api.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/attendance') ? rosterOf(url.includes('-a/') ? ANA : BEN) : { data: {} },
      ),
    );
    const post = held<unknown>();
    api.post.mockReturnValue(post.promise);
    const w = await open();
    await w.get('[data-testid="attendance-check-in"]').trigger('click');
    await moveTo('market-b');
    post.fail(
      Object.assign(new AxiosError('refused'), {
        response: { status: 409, data: { error: 'Ana is not seated on that date.' } },
      }),
    );
    await flushPromises();
    expect(rows(w)).toEqual([BEN]);
    expect(w.find('.door-error').exists()).toBe(false);
  });

  it("a check-in tapped on A that answers after the move to B posts to A, and marks nothing on B's page", async () => {
    // Ana sells at both markets.
    api.get.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/attendance') ? rosterOf(ANA) : { data: {} }),
    );
    const post = held<unknown>();
    api.post.mockReturnValue(post.promise);
    const w = await open();
    await w.get('[data-testid="attendance-check-in"]').trigger('click');
    expect(api.post).toHaveBeenCalledWith('/markets/market-a/attendance', {
      vendorEmail: ANA,
      date: TODAY,
    });
    await moveTo('market-b');
    // A's write in flight holds nothing busy on B's roster.
    expect(w.get('[data-testid="attendance-check-in"]').attributes('disabled')).toBeUndefined();

    post.settle({ data: { message: 'Checked in', checkedInAt: '2099-08-01T09:41:00Z' } });
    await flushPromises();
    expect(rows(w)).toEqual([ANA]);
    expect(w.get('[data-testid="attendance-row-status"]').text()).toBe('Not checked in');
    expect(w.find('.door-error').exists()).toBe(false);
  });

  it('a check-in refused on A is not said again when the organizer comes back to A', async () => {
    api.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/attendance') ? rosterOf(url.includes('-a/') ? ANA : BEN) : { data: {} },
      ),
    );
    api.post.mockRejectedValue(
      Object.assign(new AxiosError('refused'), {
        response: { status: 409, data: { error: 'Ana is not seated on that date.' } },
      }),
    );
    const w = await open();
    await w.get('[data-testid="attendance-check-in"]').trigger('click');
    await flushPromises();
    expect(w.get('.door-error').text()).toContain('Ana is not seated on that date.');

    await moveTo('market-b');
    expect(rows(w)).toEqual([BEN]);
    await moveTo('market-a');
    expect(rows(w)).toEqual([ANA]);
    expect(w.find('.door-error').exists()).toBe(false);
  });
});
