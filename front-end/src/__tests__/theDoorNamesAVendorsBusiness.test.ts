// @vitest-environment happy-dom
/**
 * The door names a vendor's business (T502).
 *
 * An organizer at the door finds a vendor by the name on their name tag, and for some that is a
 * business name. Attendance shows it as a second, smaller line under the vendor's name: in their
 * row, in their drawer's head and on the printed roster, and both of its searches find them by it.
 * It is never the name a vendor is called by, and a vendor with none has the row they had before,
 * with no empty line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive, ref } from 'vue';

import AttendanceStatusView from '@/views/AttendanceStatusView.vue';
import DoorRosterPrint, { type PrintedRow } from '@/components/DoorRosterPrint.vue';
import VendorDrawer from '@/components/VendorDrawer.vue';
import VendorIdentity from '@/components/VendorIdentity.vue';
import VendorNameButton from '@/components/VendorNameButton.vue';
import { MarketPhase, type Application, type Market } from '@/assets/types/datatypes';
import { BUSINESS_NAME_KEY, FULL_NAME_KEY } from '@/utils/essentialFields';
import { calendarToday } from '@/utils/marketGuide';
import { useVendorDetails } from '@/utils/vendorDetails';
import { vendorMatches } from '@/utils/vendorIdentity';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const fetchMarketApplications = vi.hoisted(() => vi.fn());

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
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: ref(MARKET), status: ref('loaded'), refresh: vi.fn() }),
}));

const route = reactive({ params: { marketId: 'market-1' }, query: {} as Record<string, string> });

const TODAY = calendarToday();
const ANA = 'ana@example.com';
const BEN = 'ben@example.com';
const CY = 'cy@example.com';
const ED = 'ed@example.com';
const NAMES = { [ANA]: 'Ana Clay', [BEN]: 'Ben Wood' };

const MARKET = {
  id: 'market-1',
  name: 'Spring Market',
  phase: MarketPhase.MarketDays,
  actionRefusals: answersRefusing(),
} as unknown as Market;

const testid = (id: string) => `[data-testid="${id}"]`;

enableAutoUnmount(afterEach);

describe('a search by the business name', () => {
  const BUSINESSES = { [ANA]: 'Paper & Pine' };

  it('finds a vendor by a part of it, in any case', () => {
    expect(vendorMatches('pine', ANA, NAMES, {}, BUSINESSES)).toBe(true);
    expect(vendorMatches('PAPER &', ANA, NAMES, {}, BUSINESSES)).toBe(true);
  });

  it('finds nobody by a business name that is not theirs', () => {
    expect(vendorMatches('pine', BEN, NAMES, {}, BUSINESSES)).toBe(false);
  });

  it('is asked only where the page gives the business names', () => {
    expect(vendorMatches('pine', ANA, NAMES)).toBe(false);
    expect(vendorMatches('pine', ANA, NAMES, {})).toBe(false);
  });
});

describe("a vendor's identity", () => {
  /** The identity's lines as they are drawn, top to bottom, by test id. */
  const lines = (wrapper: VueWrapper) =>
    wrapper
      .findAll('.vendor-identity > *')
      .map((line) => [line.attributes('data-testid'), line.text()]);

  it('draws the business name between the name and the address, its whole text in its title', () => {
    const wrapper = mount(VendorIdentity, {
      props: { email: ANA, names: NAMES, business: 'Paper & Pine' },
    });

    expect(lines(wrapper)).toEqual([
      ['vendor-identity-name', 'Ana Clay'],
      ['vendor-identity-business', 'Paper & Pine'],
      ['vendor-identity-email', ANA],
    ]);
    expect(wrapper.get(testid('vendor-identity-business')).attributes('title')).toBe(
      'Paper & Pine',
    );
  });

  it('draws it under the address of a vendor whose application stored no name', () => {
    const wrapper = mount(VendorIdentity, {
      props: { email: CY, names: NAMES, business: 'Cy Ceramics' },
    });

    expect(lines(wrapper)).toEqual([
      ['vendor-identity-name', CY],
      ['vendor-identity-business', 'Cy Ceramics'],
    ]);
  });

  it.each([
    ['none is given', undefined],
    ['it is empty', ''],
    ['it is only spaces', '   '],
  ])('draws no such line when %s', (_when, business) => {
    const wrapper = mount(VendorIdentity, { props: { email: ANA, names: NAMES, business } });

    expect(wrapper.find(testid('vendor-identity-business')).exists()).toBe(false);
    expect(lines(wrapper)).toEqual([
      ['vendor-identity-name', 'Ana Clay'],
      ['vendor-identity-email', ANA],
    ]);
  });

  it("the name that opens the drawer carries it, and is still named by the vendor's name", () => {
    const wrapper = mount(VendorNameButton, {
      props: { email: ANA, names: NAMES, business: 'Paper & Pine', testid: 'vendor' },
    });

    expect(wrapper.get(testid('vendor-identity-business')).text()).toBe('Paper & Pine');
    expect(wrapper.get(testid('vendor')).text().startsWith('Ana Clay')).toBe(true);
  });
});

describe('the printed roster', () => {
  const printedRow = (email: string, name: string, business?: string): PrintedRow => ({
    key: email,
    email,
    name,
    table: 'Table A1',
    here: null,
    ...(business === undefined ? {} : { business }),
  });

  function print(seated: PrintedRow[]): VueWrapper {
    return mount(DoorRosterPrint, {
      props: {
        marketName: 'Spring Market',
        date: TODAY,
        expected: seated.length,
        seated,
        unseated: [],
        unseatedHeading: '',
      },
      global: { stubs: { teleport: true } },
    });
  }

  /** What the Vendor cell of a row prints, line by line. */
  const vendorCell = (wrapper: VueWrapper, email: string) =>
    wrapper
      .findAll(`${testid('attendance-print-row')}[data-vendor="${email}"] td:nth-child(2) > *`)
      .map((line) => [line.attributes('data-testid'), line.text()]);

  it('prints the business name under the name, whole', () => {
    const long = 'Paper & Pine Stationery, Letterpress and Hand-bound Notebooks of the North Shore';
    const wrapper = print([printedRow(ANA, 'Ana Clay', long)]);

    expect(vendorCell(wrapper, ANA)).toEqual([
      ['attendance-print-name', 'Ana Clay'],
      ['attendance-print-business', long],
      ['attendance-print-email', ANA],
    ]);
  });

  it('prints nothing for a vendor with none', () => {
    const wrapper = print([printedRow(BEN, 'Ben Wood', ''), printedRow(CY, '')]);

    expect(wrapper.find(testid('attendance-print-business')).exists()).toBe(false);
    expect(vendorCell(wrapper, BEN)).toEqual([
      ['attendance-print-name', 'Ben Wood'],
      ['attendance-print-email', BEN],
    ]);
  });
});

describe('Attendance', () => {
  function row(email: string, name: string, tableCode: string | null, more: object = {}) {
    return {
      date: TODAY,
      vendorEmail: email,
      vendorName: name,
      vendorFullName: name,
      tableCode,
      tableChoice: tableCode ? 'Full Table' : null,
      section: tableCode ? 'Main Hall' : null,
      location: tableCode ? 'Main Hall' : null,
      state: 'expected',
      checkedInTableCode: null,
      checkedInAt: null,
      checkedInBy: null,
      checkedInVia: null,
      ...more,
    };
  }

  /** Ana and Ed trade under a business name, Ed here with no table; Cy's is `""`; Ben's row comes
   *  from a server that serves no such field. */
  const ROSTER = {
    dates: [TODAY],
    roster: [
      row(ANA, 'Ana Clay', 'A1', { vendorBusinessName: 'Paper & Pine' }),
      row(BEN, 'Ben Wood', 'A2'),
      row(CY, 'Cy Reed', 'A3', { vendorBusinessName: '' }),
      row(ED, 'Ed Stone', null, {
        vendorBusinessName: "Ed's Eggs",
        state: 'here_without_seat',
        checkedInTableCode: 'A9',
        checkedInAt: '2099-08-01T09:41:00Z',
      }),
    ],
  };

  async function open(query: Record<string, string> = {}): Promise<VueWrapper> {
    route.query = query;
    const wrapper = mount(AttendanceStatusView, {
      attachTo: document.body,
      global: {
        stubs: {
          MarketFrame: { template: '<div><slot /></div>' },
          AttendanceMap: true,
          VendorDrawer: true,
          DoorCodeScreen: true,
          VendorNotes: true,
          teleport: true,
        },
      },
    });
    await flushPromises();
    return wrapper;
  }

  const rowOf = (wrapper: VueWrapper, email: string) =>
    wrapper.get(`${testid('attendance-row')}[data-vendor="${email}"]`);
  const shown = (wrapper: VueWrapper) =>
    wrapper.findAll(testid('attendance-row')).map((one) => one.attributes('data-vendor'));

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.setItem('user', JSON.stringify({ email: 'org@example.com' }));
    api.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/markets/market-1/attendance' ? ROSTER : {} }),
    );
    fetchMarketApplications.mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows a vendor's business name under their name, in the name that opens their drawer", async () => {
    const wrapper = await open();
    const name = rowOf(wrapper, ANA).get(testid('attendance-vendor'));

    expect(name.get(testid('vendor-identity-name')).text()).toBe('Ana Clay');
    expect(name.get(testid('vendor-identity-business')).text()).toBe('Paper & Pine');
  });

  it('shows it on a row with no table too', async () => {
    const wrapper = await open();

    expect(rowOf(wrapper, ED).get(testid('vendor-identity-business')).text()).toBe("Ed's Eggs");
  });

  it.each([
    ['whose business name is empty', CY],
    ['whose row an older server served without one', BEN],
  ])('draws no such line for a vendor %s', async (_which, email) => {
    const wrapper = await open();

    expect(rowOf(wrapper, email).find(testid('vendor-identity-business')).exists()).toBe(false);
  });

  it.each([
    ['a part of it', 'pine'],
    ['any case', 'PAPER & P'],
    ['words with spaces round them', '  paper '],
  ])("the list's search finds a vendor by their business name: %s", async (_how, words) => {
    const wrapper = await open();

    await wrapper.get(testid('attendance-search')).setValue(words);

    expect(shown(wrapper)).toEqual([ANA]);
  });

  describe("the map's search", () => {
    const field = (wrapper: VueWrapper) => wrapper.get(testid('attendance-map-search-input'));
    /** Each option as it reads: the vendor, then its detail. */
    const options = (wrapper: VueWrapper) =>
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

    it('finds a vendor by a part of their business name, in any case, and names the person', async () => {
      const wrapper = await open({ view: 'map' });

      await type(wrapper, 'PINE');

      expect(options(wrapper)).toEqual([['Ana Clay', 'Paper & Pine, Table A1, a whole table']]);
    });

    it('says the business name before where they sit, and only where they sit of a vendor with none', async () => {
      const wrapper = await open({ view: 'map' });

      await field(wrapper).trigger('click');

      expect(options(wrapper)).toEqual([
        ['Ana Clay', 'Paper & Pine, Table A1, a whole table'],
        ['Ben Wood', 'Table A2, a whole table'],
        ['Cy Reed', 'Table A3, a whole table'],
        ['Ed Stone', "Ed's Eggs, No table"],
      ]);
    });
  });

  it('prints the business name on the roster, and none for a vendor without one', async () => {
    const wrapper = await open();
    const printedBusiness = (email: string) =>
      wrapper
        .get(`${testid('attendance-print-row')}[data-vendor="${email}"]`)
        .find(testid('attendance-print-business'));

    expect(printedBusiness(ANA).text()).toBe('Paper & Pine');
    expect(printedBusiness(ED).text()).toBe("Ed's Eggs");
    expect(printedBusiness(BEN).exists()).toBe(false);
    expect(printedBusiness(CY).exists()).toBe(false);
  });
});

describe("the vendor drawer's head", () => {
  const application = (email: string, formData: Record<string, unknown>) =>
    ({
      id: `app-${email}`,
      marketId: 'market-1',
      applicantEmail: email,
      status: 'approved',
      formData,
      submittedAt: '2026-09-15T14:20:18+00:00',
      updatedAt: '2026-09-15T14:20:18+00:00',
    }) as unknown as Application;

  /** The head's lines under the eyebrow, by test id. */
  const head = () =>
    [...document.querySelectorAll('[data-testid="vendors-detail-head"] .detail-title-wrap > *')]
      .slice(1)
      .map((line) => [line.getAttribute('data-testid'), line.textContent?.trim()]);

  async function openOn(email: string): Promise<VueWrapper> {
    const details = useVendorDetails(ref('market-1'), ref(MARKET));
    const wrapper = mount(VendorDrawer, {
      attachTo: document.body,
      props: { market: MARKET, details, email, tab: 'application' },
    });
    await flushPromises();
    return wrapper;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    document.body.innerHTML = '';
    for (const call of Object.values(api)) call.mockResolvedValue({ data: {} });
    fetchMarketApplications.mockResolvedValue([
      application(ANA, { [FULL_NAME_KEY]: 'Ana Clay', [BUSINESS_NAME_KEY]: ' Paper & Pine ' }),
      application(BEN, { [FULL_NAME_KEY]: 'Ben Wood' }),
      // An organizer removed it: their update reads as "".
      application(CY, { [FULL_NAME_KEY]: 'Cy Reed', [BUSINESS_NAME_KEY]: '' }),
    ]);
  });

  it('shows the business name under the title and before the address, its whole text in its title', async () => {
    await openOn(ANA);

    expect(head()).toEqual([
      ['vendors-detail-title', 'Ana Clay'],
      ['vendors-detail-business', 'Paper & Pine'],
      ['vendors-detail-email', ANA],
    ]);
    expect(document.querySelector(testid('vendors-detail-business'))?.getAttribute('title')).toBe(
      'Paper & Pine',
    );
  });

  it.each([
    ['who gave none', BEN, 'Ben Wood'],
    ['whose business name an organizer removed', CY, 'Cy Reed'],
  ])('shows no such line for a vendor %s', async (_which, email, name) => {
    await openOn(email);

    expect(head()).toEqual([
      ['vendors-detail-title', name],
      ['vendors-detail-email', email],
    ]);
  });
});
