/**
 * The Vendors list and its drawer read where a vendor came from and their review state as the
 * server serves them (`origin`, `review.state`; ADR 0037), never from the stored status or from
 * who added them (T277 P7).
 *
 * A vendor added by hand whose answers arrived since, by an import or their own save, is an
 * applicant: no "Added" chip, and their dates within reach are their answers' (E38/F08/S02), while
 * the drawer still says who added them. "Rejected only" lists every rejected application, a
 * person's, a rule's and the old offers flow's `cancelled` alike, as the Applications tab does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import VendorsView from '@/views/VendorsView.vue';
import VendorIdentity from '@/components/VendorIdentity.vue';
import type { Market } from '@/assets/types/datatypes';
import { MARKET_ID, serveMarket } from './support/marketScreen';
import { servedReview } from './support/servedReview';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const route = vi.hoisted(() => ({
  name: 'market-vendors',
  params: { marketId: 'market-1' },
  query: {} as Record<string, string>,
  matched: [],
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRoute: () => route,
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/applicantApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/applicantApi')>();
  return { ...actual, fetchMarketApplications: vi.fn(() => Promise.resolve(APPLICATIONS)) };
});
vi.mock('@/utils/signedIn', () => ({ signedInEmail: () => 'owner@market.test' }));

const DATES = ['2026-11-20', '2026-11-21', '2026-11-22'];
const ADDED_BY = { addedBy: { email: 'alex@market.test' }, addedAt: '2026-11-01T09:00:00' };
/** Answers asking for one of the market's three days. */
const ONE_DAY = { essential_available_dates: [DATES[0]] };

const APPLICATIONS = [
  // Added by hand, then imported: an applicant, though the record of adding stays.
  {
    id: 'app-lee',
    applicantEmail: 'lee@vendor.test',
    status: 'reviewer_approved',
    ...ADDED_BY,
    ...servedReview('approved', { origin: 'imported' }),
    formData: ONE_DAY,
  },
  // Added by hand and never applied: every market day.
  {
    id: 'app-kit',
    applicantEmail: 'kit@vendor.test',
    status: 'reviewer_approved',
    ...ADDED_BY,
    ...servedReview('approved', { origin: 'added' }),
    formData: {},
  },
  {
    id: 'app-pat',
    applicantEmail: 'pat@vendor.test',
    status: 'reviewer_rejected',
    ...servedReview('rejected'),
    formData: ONE_DAY,
  },
  {
    id: 'app-ray',
    applicantEmail: 'ray@vendor.test',
    status: 'reviewer_rejected',
    verdictBy: { kind: 'rule', rule: 'missing_answers' },
    ...servedReview('rejected'),
    formData: ONE_DAY,
  },
  // The old offers flow's, which the server reads as a person's rejection until the migration.
  {
    id: 'app-cal',
    applicantEmail: 'cal@vendor.test',
    status: 'cancelled',
    ...servedReview('rejected'),
    formData: ONE_DAY,
  },
  // Added by hand, then rejected.
  {
    id: 'app-dot',
    applicantEmail: 'dot@vendor.test',
    status: 'reviewer_rejected',
    ...ADDED_BY,
    ...servedReview('rejected', { origin: 'added' }),
    formData: {},
  },
];

const NEEDING_A_TABLE = ['lee@vendor.test', 'kit@vendor.test'];

const MARKET = {
  id: MARKET_ID,
  name: 'Riverside Spring',
  phase: 'assignment',
  roles: {},
  setupObject: {
    marketDates: DATES.map((date) => ({ date })),
    tiers: [],
    locations: [],
    sections: [],
    priority: [],
    assignmentOptions: { maxAssignmentsPerVendor: null },
  },
  assignmentObject: { vendorAssignments: [{ date: DATES[0] }], assignmentDate: null },
  applicationForm: { fields: [] },
} as unknown as Market;

function served(url: string) {
  if (url.endsWith('/assignment-statistics')) {
    return Promise.resolve({ data: { unassignedVendors: NEEDING_A_TABLE } });
  }
  if (url.endsWith('/tables')) {
    return Promise.resolve({
      data: {
        rows: [],
        vendorNames: {},
        vendors: APPLICATIONS.map(({ applicantEmail }) => ({
          email: applicantEmail,
          needsATable: NEEDING_A_TABLE.includes(applicantEmail),
        })),
      },
    });
  }
  return Promise.resolve({ data: {} });
}

async function mounted() {
  serveMarket(api.get, MARKET as unknown as Record<string, unknown>, served);
  const wrapper = mount(VendorsView, {
    shallow: true,
    global: {
      stubs: { MarketFrame: false, ListFrame: false, VendorDrawer: false, EmailAddress: false },
    },
  });
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-testid="vendor-date-count"]').length).toBeGreaterThan(0);
  });
  return wrapper;
}

/** Each listed vendor's row, by their address. */
function rowOf(wrapper: Awaited<ReturnType<typeof mounted>>, email: string) {
  const row = wrapper
    .findAll('[data-testid="vendors-list-item"]')
    .find((item) => item.findComponent(VendorIdentity).props('email') === email);
  if (!row) throw new Error(`No row for ${email}`);
  return row;
}

const chips = (row: ReturnType<typeof rowOf>) =>
  row.findAll('[data-testid="vendors-list-status"]').map((chip) => chip.text());

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  route.query = {};
});

describe('a vendor added by hand whose answers arrived since', () => {
  it('shows no "Added" chip, where one who never applied does', async () => {
    const wrapper = await mounted();

    expect(chips(rowOf(wrapper, 'lee@vendor.test'))).not.toContain('Added');
    expect(chips(rowOf(wrapper, 'kit@vendor.test'))).toContain('Added');
  });

  it('is counted by their answers, where one who never applied needs every market day', async () => {
    const wrapper = await mounted();

    expect(rowOf(wrapper, 'lee@vendor.test').get('[data-testid="vendor-date-count"]').text()).toBe(
      '0 of 1 date',
    );
    expect(rowOf(wrapper, 'kit@vendor.test').get('[data-testid="vendor-date-count"]').text()).toBe(
      '0 of 3 dates',
    );
  });

  it('is still said in the drawer to have been added, and by whom', async () => {
    route.query = { vendor: 'lee@vendor.test' };
    const wrapper = await mounted();

    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="vendors-detail-giver"]').text()).toMatch(
        /^Added by alex@market\.test, /,
      );
    });
  });
});

describe('"Rejected only"', () => {
  it('lists every rejected application, whoever gave it and whatever its stored spelling', async () => {
    route.query = { show: 'rejected' };
    const wrapper = await mounted();

    expect(
      wrapper.findAllComponents(VendorIdentity).map((identity) => identity.props('email')),
    ).toEqual(['pat@vendor.test', 'ray@vendor.test', 'cal@vendor.test', 'dot@vendor.test']);
  });
});
