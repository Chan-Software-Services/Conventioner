// @vitest-environment happy-dom
/**
 * The vendors' reads belong to their market (T421, T277 ticket 11): a screen moved from market A to
 * market B while A's reads are out never shows A's vendors, names, notes or payments under B's
 * name, and says it is loading on arriving at B.
 *
 * The Payments and Attendance cases are T421's probes. They and the Vendors cases failed on `dev`
 * before the vendor details, the notes and the payments read through `useServerRead`, but for
 * Payments waiting for B's names, which held already (T284) and stands as a regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, defineComponent, reactive, ref } from 'vue';

import AttendanceStatusView from '@/views/AttendanceStatusView.vue';
import PaymentsView from '@/views/PaymentsView.vue';
import VendorsView from '@/views/VendorsView.vue';
import { MarketPhase, type Application, type Market } from '@/assets/types/datatypes';
import { PREFERRED_NAME_KEY } from '@/utils/essentialFields';
import { calendarToday } from '@/utils/marketGuide';
import { useVendorDetails } from '@/utils/vendorDetails';
import { useVendorNotes } from '@/utils/vendorNotes';
import type { MarketPayments } from '@/utils/paymentsPage';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const fetchMarketApplications = vi.hoisted(() => vi.fn());
const loadMarketPayments = vi.hoisted(() => vi.fn());
const route = reactive({
  name: 'market-vendors',
  params: { marketId: 'market-a' },
  query: {} as Record<string, string>,
  matched: [],
});

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/applicantApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/applicantApi')>();
  return { ...actual, fetchMarketApplications: (id: string) => fetchMarketApplications(id) };
});
vi.mock('@/utils/paymentsPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/paymentsPage')>();
  return { ...actual, loadMarketPayments: (id: string) => loadMarketPayments(id) };
});
vi.mock('@/utils/signedIn', () => ({ signedInEmail: () => 'org@example.com' }));
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({
    market: computed(() => marketOf(String(route.params.marketId))),
    status: ref('ready'),
    refresh: vi.fn(),
  }),
}));
vi.mock('@/utils/vendorDrawer', () => ({
  useVendorDrawer: () => ({
    email: ref(null),
    tab: ref('application'),
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
  }),
}));

const TODAY = calendarToday();
/** Ana sells at both markets. */
const ANA = 'ana@example.com';
const BEN = 'ben@example.com';

function marketOf(id: string): Market {
  return {
    id,
    name: id,
    phase: MarketPhase.MarketDays,
    roles: {},
    setupObject: { marketDates: [{ date: TODAY }] },
    applicationForm: { fields: [] },
    actionRefusals: answersRefusing(),
  } as unknown as Market;
}

function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

const never = () => new Promise<never>(() => {});

function applicationOf(email: string, name: string): Application {
  return {
    id: `app-${email}`,
    applicantEmail: email,
    status: 'reviewer_approved',
    formData: { [PREFERRED_NAME_KEY]: name },
  } as unknown as Application;
}

function paymentsOf(...emails: string[]): MarketPayments {
  const figures = { owedCents: 3000, paidCents: 0, stillOwedCents: 3000, paidMoreCents: 0 };
  return {
    currency: 'CAD',
    offersPaymentStates: true,
    totals: figures,
    byTier: [{ tier: 'Gold', ...figures }],
    byDate: [{ date: TODAY, ...figures }],
    vendors: emails.map((email) => ({
      email,
      owedCents: 3000,
      paidCents: 0,
      balanceState: 'owes',
      compares: true,
    })),
  } as unknown as MarketPayments;
}

/** The placements reads, served at once and empty, for any market. */
function placementsServed(url: string): Promise<unknown> | null {
  if (url.endsWith('/assignment-statistics')) return Promise.resolve({ data: {} });
  if (url.endsWith('/tables')) return Promise.resolve({ data: { rows: [], vendorNames: {} } });
  return null;
}

async function moveTo(id: string): Promise<void> {
  route.params.marketId = id;
  await flushPromises();
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  route.params.marketId = 'market-a';
  route.query = {};
  localStorage.setItem('user', JSON.stringify({ email: 'org@example.com' }));
  api.get.mockImplementation((url: string) => placementsServed(url) ?? never());
});
afterEach(() => localStorage.clear());

describe('Payments never shows another market', () => {
  async function openPayments(): Promise<VueWrapper> {
    const wrapper = mount(PaymentsView, {
      attachTo: document.body,
      global: {
        stubs: {
          MarketFrame: { template: '<div><slot name="pinned" /><slot /></div>' },
          NothingAssigned: true,
          RouterLink: true,
          VendorDrawer: true,
        },
      },
    });
    await flushPromises();
    return wrapper;
  }
  const emails = (w: VueWrapper) =>
    w.findAll('[data-testid="payments-row"]').map((r) => r.attributes('data-email'));

  it("drops A's payments answering after the move to B", async () => {
    const a = held<MarketPayments>();
    const b = held<MarketPayments>();
    loadMarketPayments.mockImplementation((id: string) =>
      id === 'market-a' ? a.promise : b.promise,
    );
    fetchMarketApplications.mockResolvedValue([]);
    const w = await openPayments();
    await moveTo('market-b');
    b.settle(paymentsOf(BEN));
    await flushPromises();
    a.settle(paymentsOf(ANA));
    await flushPromises();
    expect(emails(w)).toEqual([BEN]);
  });

  it("says it is loading on arriving at B, never A's figures", async () => {
    loadMarketPayments.mockImplementation((id: string) =>
      id === 'market-a' ? Promise.resolve(paymentsOf(ANA)) : never(),
    );
    fetchMarketApplications.mockResolvedValue([]);
    const w = await openPayments();
    expect(emails(w)).toEqual([ANA]);
    route.params.marketId = 'market-b';
    await w.vm.$nextTick();
    expect(w.text()).toContain('Loading payments…');
    expect(emails(w)).toEqual([]);
  });

  it("waits for B's names, never drawing B's list under A's", async () => {
    const namesB = held<Application[]>();
    loadMarketPayments.mockImplementation((id: string) =>
      Promise.resolve(id === 'market-a' ? paymentsOf(ANA) : paymentsOf(ANA, BEN)),
    );
    fetchMarketApplications.mockImplementation((id: string) =>
      id === 'market-a' ? Promise.resolve([applicationOf(ANA, 'Ana at A')]) : namesB.promise,
    );
    const w = await openPayments();
    expect(w.text()).toContain('Ana at A');
    await moveTo('market-b');
    expect(w.find('[data-testid="payments-vendors-loading"]').exists()).toBe(true);
    expect(w.text()).not.toContain('Ana at A');
    namesB.settle([applicationOf(ANA, 'Ana at B'), applicationOf(BEN, 'Ben at B')]);
    await flushPromises();
    expect(emails(w)).toEqual([ANA, BEN]);
    expect(w.text()).toContain('Ana at B');
    expect(w.text()).not.toContain('Ana at A');
  });
});

describe('Vendors never shows another market', () => {
  async function openVendors(): Promise<VueWrapper> {
    const wrapper = mount(VendorsView, {
      attachTo: document.body,
      shallow: true,
      global: {
        stubs: {
          MarketFrame: { template: '<div><slot name="pinned" /><slot /></div>' },
          ListFrame: false,
          ScrollBox: false,
          Unwrapped: false,
          EmailAddress: false,
          VendorIdentity: false,
        },
      },
    });
    await flushPromises();
    return wrapper;
  }
  const listed = (w: VueWrapper) =>
    w.findAll('[data-testid="vendors-list-item"]').map((item) => item.text());

  it("drops A's vendors answering after the move to B", async () => {
    const a = held<Application[]>();
    const b = held<Application[]>();
    fetchMarketApplications.mockImplementation((id: string) =>
      id === 'market-a' ? a.promise : b.promise,
    );
    const w = await openVendors();
    await moveTo('market-b');
    b.settle([applicationOf(BEN, 'Ben at B')]);
    await flushPromises();
    a.settle([applicationOf(ANA, 'Ana at A')]);
    await flushPromises();
    expect(listed(w).join(' ')).toContain('Ben at B');
    expect(listed(w).join(' ')).not.toContain('Ana at A');
  });

  it("says it is loading on arriving at B, never A's vendors", async () => {
    fetchMarketApplications.mockImplementation((id: string) =>
      id === 'market-a' ? Promise.resolve([applicationOf(ANA, 'Ana at A')]) : never(),
    );
    const w = await openVendors();
    expect(listed(w).join(' ')).toContain('Ana at A');
    route.params.marketId = 'market-b';
    await w.vm.$nextTick();
    expect(w.text()).toContain('Loading vendors…');
    expect(w.text()).not.toContain('Ana at A');
  });

  it("never says A's refusal on B's page", async () => {
    let failA!: (error: unknown) => void;
    const refusedA = new Promise<Application[]>((_resolve, reject) => (failA = reject));
    fetchMarketApplications.mockImplementation((id: string) =>
      id === 'market-a' ? refusedA : Promise.resolve([applicationOf(BEN, 'Ben at B')]),
    );
    const w = await openVendors();
    await moveTo('market-b');
    failA(new Error("Market A's refusal"));
    await flushPromises();
    expect(w.text()).not.toContain('The vendors could not be loaded.');
    expect(listed(w).join(' ')).toContain('Ben at B');
  });
});

describe("the door never shows another market's notes", () => {
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

  it("A's vendor notes answering after the move to B are never shown on B's rows", async () => {
    const notesA = held<unknown>();
    api.get.mockImplementation((url: string) => {
      if (url === '/markets/market-a/vendor-notes') return notesA.promise;
      if (url === '/markets/market-b/vendor-notes') return never();
      if (url.endsWith('/attendance')) return Promise.resolve(rosterOf(ANA));
      return placementsServed(url) ?? Promise.resolve({ data: {} });
    });
    const w = mount(AttendanceStatusView, {
      attachTo: document.body,
      global: {
        stubs: {
          MarketFrame: { template: '<div><slot /></div>' },
          VendorDrawer: true,
          DoorCodeScreen: true,
          VendorNotes: { props: ['entry'], template: '<i class="notes">{{ entry?.note }}</i>' },
        },
      },
    });
    await flushPromises();
    await moveTo('market-b');
    notesA.settle({
      data: {
        notes: {
          [ANA]: {
            request: '',
            note: "Market A's note",
            noteEditedBy: null,
            noteEditedAt: null,
            fromSheet: null,
            requestHandledAt: null,
            requestHandledBy: null,
          },
        },
      },
    });
    await flushPromises();
    // Ana sells at both markets: B's row must not carry A's note.
    expect(w.find('[data-testid="attendance-row"]').exists()).toBe(true);
    expect(w.text()).not.toContain("Market A's note");
  });
});

describe("the drawer's vendors and notes", () => {
  function detailsOn(id: { value: string }) {
    let held!: ReturnType<typeof useVendorDetails>;
    let notes!: ReturnType<typeof useVendorNotes>;
    mount(
      defineComponent({
        setup() {
          const marketId = computed(() => id.value);
          held = useVendorDetails(
            marketId,
            computed(() => marketOf(marketId.value)),
          );
          notes = useVendorNotes(marketId);
          return () => null;
        },
      }),
    );
    return { details: held, notes };
  }

  it('read the vendors only once asked, as the drawer asks on opening', async () => {
    fetchMarketApplications.mockResolvedValue([applicationOf(ANA, 'Ana at A')]);
    const { details } = detailsOn(ref('market-a'));
    await flushPromises();
    expect(fetchMarketApplications).not.toHaveBeenCalled();
    expect(details.loaded.value).toBe(false);
    await details.load();
    expect(fetchMarketApplications).toHaveBeenCalledWith('market-a');
    expect(details.vendorNames.value).toEqual({ [ANA]: 'Ana at A' });
  });

  it("drop the last market's vendors and notes in the same tick as the move", async () => {
    fetchMarketApplications.mockResolvedValue([applicationOf(ANA, 'Ana at A')]);
    api.get.mockImplementation((url: string) =>
      url.endsWith('/vendor-notes')
        ? Promise.resolve({ data: { notes: { [ANA]: { note: "Market A's note" } } } })
        : (placementsServed(url) ?? never()),
    );
    const id = ref('market-a');
    const { details, notes } = detailsOn(id);
    await details.load();
    await flushPromises();
    expect(details.rows.value.map((row) => row.email)).toEqual([ANA]);
    expect(notes.entryFor(ANA)?.note).toBe("Market A's note");
    id.value = 'market-b';
    expect(details.rows.value).toEqual([]);
    expect(details.loaded.value).toBe(false);
    expect(notes.entryFor(ANA)).toBeUndefined();
  });

  it('keep the applications and say why when where the vendors sit is refused', async () => {
    fetchMarketApplications.mockResolvedValue([applicationOf(ANA, 'Ana at A')]);
    api.get.mockImplementation((url: string) =>
      url.endsWith('/tables')
        ? Promise.reject(new Error('refused'))
        : (placementsServed(url) ?? never()),
    );
    const { details } = detailsOn(ref('market-a'));
    await details.load();
    expect(details.loaded.value).toBe(true);
    expect(details.placementsRead.value).toBe(false);
    expect(details.rows.value.map((row) => row.email)).toEqual([ANA]);
    expect(details.loadError.value).toBe('Where the vendors sit could not be read.');
  });
});
