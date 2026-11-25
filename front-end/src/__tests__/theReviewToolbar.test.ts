/**
 * The review's toolbar (T466, release walk F7): one row over both views, drawn by the tab.
 *
 * The view switch and the published status stand at its start, and the open view's read time,
 * Refresh and, on the All view, Export at its end, from the read state each view exposes rather than
 * buttons each view drew in its own rows. The review-closed line is gone; while applications are
 * open, the line saying what arrives and the reviewers line stand under the tools, in the view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';

import MarketApplicationsTab from '@/components/market/MarketApplicationsTab.vue';
import {
  ApplicationStatus,
  IntakeMode,
  MarketPhase,
  type Application,
  type Market,
} from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { applicationsAllSeed } from '@/utils/vendorExport';
import { answersRefusing } from './support/servedAnswers';
import { answeredWith, servedReview } from './support/servedReview';

const ME = 'ana@example.com';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const fetchMarketApplications = vi.fn();
/** Reactive, as the router's own route is, and following every `replace`. */
const route = reactive({ query: {} as Record<string, string> });

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(async ({ query }: { query: Record<string, string> }) => {
      route.query = query;
    }),
  }),
  useRoute: () => route,
}));
vi.mock('@/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api')>()),
  api,
}));
vi.mock('@/utils/applicantApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/applicantApi')>()),
  fetchMarketApplications: (id: string) => fetchMarketApplications(id),
}));
vi.mock('@/utils/signedIn', () => ({ signedInEmail: () => ME }));

function application(id: string): Application {
  return {
    id,
    marketId: 'm1',
    applicantEmail: `${id}@vendor.test`,
    status: ApplicationStatus.Open,
    formData: {},
    submittedAt: '2026-09-15T14:20:18.000Z',
    reviewer: null,
    ...servedReview('open'),
  } as unknown as Application;
}

const STORED = [application('jo'), application('al')];

function market(extra: Partial<Market> = {}, refused: MarketAction[] = []): Market {
  return {
    id: 'm1',
    slug: 'spring',
    phase: MarketPhase.Applications,
    intakeMode: IntakeMode.Form,
    roles: {},
    applicationForm: { fields: [] },
    reviewTeam: { reviewers: [] },
    actionRefusals: answersRefusing(...refused),
    publishWaitsReason: null,
    ...extra,
  } as unknown as Market;
}

/** A verdict's write, answered when the test says. */
let verdictAnswers: Array<() => void> = [];

beforeEach(() => {
  setActivePinia(createPinia());
  route.query = {};
  verdictAnswers = [];
  for (const call of Object.values(api)) call.mockReset().mockResolvedValue({ data: {} });
  fetchMarketApplications
    .mockReset()
    .mockImplementation(async () => STORED.map((app) => ({ ...app })));
  api.post.mockImplementation(async (url: string) =>
    url.endsWith('/review/next') ? { data: { application: { ...STORED[0] } } } : { data: {} },
  );
  api.put.mockImplementation((url: string, body: { status?: ApplicationStatus }) => {
    const id = /applications\/([^/]+)\/review$/.exec(url)?.[1];
    if (!id || !body.status) return Promise.resolve({ data: { held: true } });
    return new Promise((resolve) =>
      verdictAnswers.push(() =>
        resolve({
          data: {
            application: answeredWith(
              STORED.find((app) => app.id === id)!,
              body.status!,
            ),
            undoSeconds: 120,
          },
        }),
      ),
    );
  });
});

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function tab(on: Market = market()) {
  mounted = mount(MarketApplicationsTab, {
    props: { market: on, visible: true },
    attachTo: document.body,
    global: {
      stubs: {
        VendorDrawer: {
          template: '<div><slot name="actions" /></div>',
          methods: { entryFor: () => null, loadNotes: () => undefined },
        },
        ExportVendorsDialog: {
          name: 'ExportVendorsDialog',
          props: ['open', 'seed', 'marketId'],
          template: '<div />',
        },
        FollowUpDialog: true,
      },
    },
  });
  await flushPromises();
  return mounted;
}

const toolbar = (wrapper: VueWrapper) => wrapper.get('[data-testid="applications-toolbar"]');
const inToolbar = (wrapper: VueWrapper, id: string) =>
  toolbar(wrapper).find(`[data-testid="${id}"]`);
/** Whether `first` comes before `second` in the document. */
const before = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the toolbar on the All view', () => {
  it('draws the read time, Refresh and then Export at its end, and the view draws none', async () => {
    const wrapper = await tab();

    const end = toolbar(wrapper).get('.tool-row__end');
    const refresh = end.get('[data-testid="applications-refresh"]');
    const exportButton = end.get('[data-testid="applications-all-export-button"]');
    expect(end.find('[data-testid="applications-updated"]').text()).toBe('Updated just now');
    expect(before(refresh.element, exportButton.element)).toBe(true);
    expect(exportButton.classes()).toEqual(
      expect.arrayContaining(['btn', 'btn--secondary', 'btn--compact']),
    );

    const view = wrapper.get('[data-testid="applications-all"]');
    expect(view.find('[data-testid="applications-refresh"]').exists()).toBe(false);
    expect(view.find('[data-testid="applications-all-export-button"]').exists()).toBe(false);
  });

  it('offers no Export to someone the Export CSV row refuses', async () => {
    const wrapper = await tab(market({}, [MarketAction.ExportCsv]));

    expect(inToolbar(wrapper, 'applications-refresh').exists()).toBe(true);
    expect(inToolbar(wrapper, 'applications-all-export-button').exists()).toBe(false);
  });

  it("opens the view's export on what the view shows", async () => {
    route.query = { status: 'undecided' };
    const wrapper = await tab();

    await inToolbar(wrapper, 'applications-all-export-button').trigger('click');

    const dialog = wrapper.findComponent({ name: 'ExportVendorsDialog' });
    expect(dialog.props('open')).toBe(true);
    expect(dialog.props('seed')).toEqual(applicationsAllSeed({ filter: 'undecided', mine: false }));
  });

  it('reads the list again, and says a failed re-read under Refresh', async () => {
    const wrapper = await tab();
    expect(fetchMarketApplications).toHaveBeenCalledTimes(1);

    fetchMarketApplications.mockRejectedValueOnce(new Error('offline'));
    await inToolbar(wrapper, 'applications-refresh').trigger('click');
    await flushPromises();

    expect(fetchMarketApplications).toHaveBeenCalledTimes(2);
    expect(inToolbar(wrapper, 'applications-refresh-error').text()).toBe(
      'Could not refresh. The list is as it was last read.',
    );
  });

  it('disables Refresh while its own read is out', async () => {
    const wrapper = await tab();
    fetchMarketApplications.mockReturnValueOnce(new Promise(() => undefined));

    await inToolbar(wrapper, 'applications-refresh').trigger('click');

    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeDefined();
  });

  it('disables Refresh while a verdict saves', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    const wrapper = await tab();
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    expect(verdictAnswers).toHaveLength(1);
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeDefined();

    verdictAnswers[0]!();
    await flushPromises();
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeUndefined();
  });
});

describe('the toolbar on One by one', () => {
  beforeEach(() => {
    route.query = { view: 'one' };
  });

  it('draws the read time and Refresh where the All view does, and no Export', async () => {
    const wrapper = await tab();

    const end = toolbar(wrapper).get('.tool-row__end');
    expect(end.find('[data-testid="applications-updated"]').text()).toBe('Updated just now');
    expect(end.find('[data-testid="applications-refresh"]').exists()).toBe(true);
    expect(end.find('[data-testid="applications-all-export-button"]').exists()).toBe(false);
    const panel = wrapper.get('[data-testid="app-monitor-panel"]');
    expect(panel.find('[data-testid="applications-refresh"]').exists()).toBe(false);
  });

  it('reads the list again from the toolbar', async () => {
    const wrapper = await tab();
    const reads = fetchMarketApplications.mock.calls.length;

    await inToolbar(wrapper, 'applications-refresh').trigger('click');
    await flushPromises();

    expect(fetchMarketApplications.mock.calls.length).toBe(reads + 1);
  });

  it('disables Refresh while a verdict saves', async () => {
    const wrapper = await tab();
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-testid="app-monitor-approve-button"]').trigger('click');
    expect(verdictAnswers).toHaveLength(1);
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeDefined();

    verdictAnswers[0]!();
    await flushPromises();
    expect(inToolbar(wrapper, 'applications-refresh').attributes('disabled')).toBeUndefined();
  });

  it('draws no Refresh until the first read lands', async () => {
    fetchMarketApplications.mockReturnValue(new Promise(() => undefined));
    const wrapper = await tab();

    expect(wrapper.find('[data-testid="app-monitor-loading"]').exists()).toBe(true);
    expect(inToolbar(wrapper, 'applications-refresh').exists()).toBe(false);
  });
});

describe('the view switch', () => {
  it('is one segmented choice at the start, named and described by the hidden hint', async () => {
    const wrapper = await tab();

    const start = toolbar(wrapper).get('.tool-row__start');
    const group = start.get('[data-testid="applications-view"]');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-label')).toBe('How do you want to review?');
    expect(group.attributes('aria-describedby')).toBe('review-views-hint');
    const hint = wrapper.get('#review-views-hint');
    expect(hint.classes()).toContain('visually-hidden');
    expect(hint.text()).toContain('All lists every application');
    expect(group.get('[data-testid="applications-view-all"]').attributes('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps the focus on the switch across a change of view', async () => {
    const wrapper = await tab();

    const one = wrapper.get<HTMLButtonElement>('[data-testid="applications-view-one"]');
    one.element.focus();
    await one.trigger('click');
    await flushPromises();

    expect(route.query.view).toBe('one');
    expect(wrapper.find('[data-testid="app-monitor-panel"]').exists()).toBe(true);
    expect(document.activeElement).toBe(one.element);
    expect(inToolbar(wrapper, 'applications-refresh').exists()).toBe(true);
    expect(inToolbar(wrapper, 'applications-all-export-button').exists()).toBe(false);

    const all = wrapper.get<HTMLButtonElement>('[data-testid="applications-view-all"]');
    all.element.focus();
    await all.trigger('click');
    await flushPromises();

    expect(document.activeElement).toBe(all.element);
    expect(inToolbar(wrapper, 'applications-all-export-button').exists()).toBe(true);
  });

  it('is pinned with the toolbar, over the view', async () => {
    const wrapper = await tab();

    const block = wrapper.get('[data-testid="applications-tools"]');
    expect(block.find('[data-testid="applications-toolbar"]').exists()).toBe(true);
    expect(block.find('[data-testid="applications-all"]').exists()).toBe(false);
  });
});

describe('the published status', () => {
  it('stands after the view switch from the assignment, quiet, with a dot', async () => {
    const wrapper = await tab(
      market({
        phase: MarketPhase.Assignment,
        resultsPublished: true,
        verdictsSettledReason: 'Tables are allocated.',
      }),
    );

    const badge = inToolbar(wrapper, 'applications-published-badge');
    expect(badge.text()).toBe('Results published · vendors can see them');
    expect(badge.find('[aria-hidden="true"]').exists()).toBe(true);
    expect(before(wrapper.get('[data-testid="applications-view"]').element, badge.element)).toBe(
      true,
    );
  });

  it('is not drawn in market days', async () => {
    const wrapper = await tab(
      market({
        phase: MarketPhase.MarketDays,
        resultsPublished: true,
        verdictsSettledReason: 'The market is live.',
      }),
    );

    expect(wrapper.find('[data-testid="applications-published-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="applications-publish-button"]').exists()).toBe(false);
  });

  it('is the Publish results button before results go out', async () => {
    const wrapper = await tab(
      market({ phase: MarketPhase.Assignment, verdictsSettledReason: 'Tables are allocated.' }),
    );

    expect(inToolbar(wrapper, 'applications-publish-button').text()).toBe('Publish results');
    expect(inToolbar(wrapper, 'applications-publish-hint').exists()).toBe(true);
  });
});

describe('the lines above the review', () => {
  it.each([MarketPhase.Assignment, MarketPhase.Offers, MarketPhase.MarketDays])(
    'says no review-closed line in %s',
    async (phase) => {
      const reason = 'The review is closed: tables are allocated.';
      const wrapper = await tab(market({ phase, verdictsSettledReason: reason }));

      expect(wrapper.find('[data-testid="market-setup-applications-condition"]').exists()).toBe(
        false,
      );
      expect(wrapper.text()).not.toContain(reason);
      // Nothing is left of the lines' block to take a gap over the rows.
      expect(wrapper.get('.applications-lead').element.children).toHaveLength(0);
    },
  );

  it('stand under the tools, first over the All view’s rows, while applications are open', async () => {
    // Sam reviews, so Ana lands on every application rather than on a share of none.
    const wrapper = await tab(
      market({ reviewTeam: { reviewers: [{ email: 'sam@example.com', able: true }] } }),
    );

    const block = wrapper.get('[data-testid="applications-tools"]');
    expect(block.find('[data-testid="market-setup-applications-condition"]').exists()).toBe(false);
    const view = wrapper.get('[data-testid="applications-all"]');
    const condition = view.get('[data-testid="market-setup-applications-condition"]');
    expect(condition.text()).toBe(
      'This market is open for applications. New ones keep arriving here.',
    );
    const reviewers = view.get('[data-testid="reviewers"]');
    expect(before(condition.element, reviewers.element)).toBe(true);
    // Under the find field and the filters, over the rows and their select-all line.
    const list = view.get('[data-testid="applications-all-list"]');
    expect(before(list.get('input').element, condition.element)).toBe(true);
    expect(
      before(reviewers.element, view.get('[data-testid="applications-all-select-all"]').element),
    ).toBe(true);
  });

  it('stand first in One by one', async () => {
    route.query = { view: 'one' };
    const wrapper = await tab(
      market({
        applicationsStopped: true,
        reviewTeam: { reviewers: [{ email: ME, able: true }] },
      }),
    );

    const panel = wrapper.get('[data-testid="app-monitor-panel"]');
    const lead = [...panel.element.firstElementChild!.children];
    expect(lead.map((line) => line.getAttribute('data-testid'))).toEqual([
      'market-setup-applications-condition',
      'reviewers',
    ]);
    expect(lead[0]!.textContent?.trim()).toBe(
      'This market is not taking applications. No new ones will arrive.',
    );
  });
});

describe('before the view has mounted', () => {
  it('fills the toolbar’s end in the same tick', async () => {
    mounted = mount(MarketApplicationsTab, {
      props: { market: market(), visible: true },
      global: { stubs: { VendorDrawer: true, ExportVendorsDialog: true, FollowUpDialog: true } },
    });
    await nextTick();

    expect(inToolbar(mounted, 'applications-refresh').exists()).toBe(true);
  });
});
