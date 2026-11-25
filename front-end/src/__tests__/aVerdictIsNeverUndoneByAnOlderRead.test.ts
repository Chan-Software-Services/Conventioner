/**
 * The All view reads its own market, and a verdict is never undone by an older read (T277 ticket 11,
 * T421 ticket 06).
 *
 * A re-read asked before a verdict, served before the server wrote it and answering after it, put
 * the application back as undecided on screen (T244); a list read of market A answering after a
 * move to market B put A's applications under B's name. The list is one keyed read now: a verdict
 * holds it, so a read asked before or during the verdict never lands, and the verdict ends in one
 * re-read; an answer for a market no longer open is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import ApplicationsAll from '@/components/application/ApplicationsAll.vue';
import { ApplicationStatus, type Application, type Market } from '@/assets/types/datatypes';
import { MarketAction } from '@/utils/marketActions';
import { statusLabel } from '@/utils/verdicts';
import { answersRefusing } from './support/servedAnswers';
import { pressRefresh, toolsOf } from './support/reviewViewTools';
import { answeredWith, servedReview } from './support/servedReview';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const route = await vi.hoisted(async () => {
  const { reactive } = await import('vue');
  return reactive({ query: {} as Record<string, string> });
});
const fetchMarketApplications = vi.fn();

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
  return { ...actual, fetchMarketApplications: (id: string) => fetchMarketApplications(id) };
});
vi.mock('@/utils/signedIn', () => ({ signedInEmail: () => 'ana@example.com' }));

const VERDICT_AT = '2026-11-01T10:00:00+00:00';

function application(
  id: string,
  marketId: string,
  status = ApplicationStatus.Open,
  served = servedReview('open'),
): Application {
  return {
    ...served,
    id,
    marketId,
    applicantEmail: `${id}@vendor.test`,
    status,
    formData: {},
    submittedAt: '2026-09-15T14:20:18.000Z',
    verdictAt: null,
  } as unknown as Application;
}

function market(id: string): Market {
  return {
    id,
    phase: 'applications',
    roles: {},
    applicationForm: { fields: [] },
    actionRefusals: {
      ...answersRefusing(),
      [MarketAction.GiveVerdicts]: null,
      [MarketAction.ChangeVerdicts]: null,
    },
  } as unknown as Market;
}

/** What the server holds, by market, as each write leaves it. */
let stored: Record<string, Application[]> = {};

/** A read answered when the test says, with what the server held when it served the read. */
interface Held {
  marketId: string;
  answer: () => void;
  refuse: (reason: unknown) => void;
}
let held: Held[] = [];
/** Hold every read from now on, rather than answer it at once. */
let holding = false;

beforeEach(() => {
  setActivePinia(createPinia());
  route.query = {};
  held = [];
  holding = false;
  stored = {
    m1: [application('jo', 'm1'), application('al', 'm1')],
    m2: [application('bo', 'm2')],
  };
  fetchMarketApplications.mockReset().mockImplementation((id: string) => {
    // Served now: the answer is what the server holds at this moment, whenever it arrives.
    const served = (stored[id] ?? []).map((app) => ({ ...app }));
    if (!holding) return Promise.resolve(served);
    return new Promise((resolve, reject) =>
      held.push({ marketId: id, answer: () => resolve(served), refuse: reject }),
    );
  });
  for (const call of Object.values(api)) call.mockReset().mockResolvedValue({ data: {} });
  api.put.mockImplementation(async (url: string, body: { status: ApplicationStatus }) => {
    const [, marketId, id] = /\/markets\/([^/]+)\/applications\/([^/]+)\/review/.exec(url)!;
    stored[marketId!] = stored[marketId!]!.map((app) =>
      app.id === id ? { ...answeredWith(app, body.status), verdictAt: VERDICT_AT } : app,
    );
    return {
      data: { application: stored[marketId!]!.find((app) => app.id === id), undoSeconds: 120 },
    };
  });
});

let mounted: VueWrapper | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function allView(on = market('m1')) {
  mounted = mount(ApplicationsAll, {
    props: { market: on },
    global: {
      stubs: {
        VendorDrawer: {
          template: '<div><slot name="actions" /></div>',
          methods: { entryFor: () => null, loadNotes: () => undefined },
        },
        ExportVendorsDialog: true,
        FollowUpDialog: true,
      },
    },
  });
  await flushPromises();
  return mounted;
}

const rowOf = (wrapper: VueWrapper, id: string) =>
  wrapper
    .findAll('[data-testid="applications-all-row"]')
    .find((row) => row.text().includes(`${id}@vendor.test`));
const rowsShown = (wrapper: VueWrapper) =>
  wrapper.findAll('[data-testid="applications-all-row"]').map((row) => row.text());

describe('a verdict', () => {
  it('is not undone on screen by a re-read asked before it and answering after it', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    const wrapper = await allView();
    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.Open));

    // Refresh is out, served before the verdict: it holds jo as open.
    holding = true;
    await pressRefresh(wrapper);
    expect(held).toHaveLength(1);
    holding = false;

    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    await flushPromises();
    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.ReviewerRejected));

    held[0]!.answer();
    await flushPromises();

    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.ReviewerRejected));
    expect(rowOf(wrapper, 'jo')!.text()).not.toContain(statusLabel(ApplicationStatus.Open));
  });

  it('ends in one re-read of the list, which shows what the server holds since', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    const wrapper = await allView();
    fetchMarketApplications.mockClear();
    // Another reviewer approved al meanwhile: only a re-read of the list shows it.
    stored.m1 = stored.m1!.map((app) =>
      app.id === 'al'
        ? { ...app, status: ApplicationStatus.ReviewerApproved, ...servedReview('approved') }
        : app,
    );

    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    await flushPromises();

    // The list's one re-read, and the drawer's read of the vendor's details.
    expect(fetchMarketApplications.mock.calls).toEqual([['m1'], ['m1']]);
    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.ReviewerRejected));
    expect(rowOf(wrapper, 'al')!.text()).toContain(statusLabel(ApplicationStatus.ReviewerApproved));
  });

  it('made on A and answering after the move to B marks nothing on B and offers no undo', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    stored.m2 = [application('jo', 'm2')];
    const wrapper = await allView();
    let answerVerdict!: () => void;
    const real = api.put.getMockImplementation()!;
    api.put.mockImplementationOnce(
      (...args: Parameters<typeof real>) =>
        new Promise((resolve) => (answerVerdict = () => resolve(real(...args)))),
    );

    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    await wrapper.setProps({ market: market('m2') });
    await flushPromises();
    answerVerdict();
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith(
      '/markets/m1/applications/jo/review',
      expect.objectContaining({ status: ApplicationStatus.ReviewerRejected }),
    );
    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.Open));
    expect(wrapper.find('[data-testid="applications-all-drawer-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="applications-all-undo"]').exists()).toBe(false);
  });
});

describe('the half-minute re-read', () => {
  afterEach(() => vi.useRealTimers());

  it('asks nothing while a verdict is out, and goes on after the verdict’s own re-read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    route.query = { vendor: 'jo@vendor.test' };
    const wrapper = await allView();
    let answerVerdict!: () => void;
    const real = api.put.getMockImplementation()!;
    api.put.mockImplementationOnce(
      (...args: Parameters<typeof real>) =>
        new Promise((resolve) => (answerVerdict = () => resolve(real(...args)))),
    );
    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    fetchMarketApplications.mockClear();

    vi.advanceTimersByTime(30_000);
    expect(fetchMarketApplications).not.toHaveBeenCalled();

    answerVerdict();
    await flushPromises();
    // The list's re-read that ends the verdict, and the drawer's read of the vendor's details.
    expect(fetchMarketApplications).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    expect(fetchMarketApplications).toHaveBeenCalledTimes(3);
    expect(rowOf(wrapper, 'jo')!.text()).toContain(statusLabel(ApplicationStatus.ReviewerRejected));
  });

  it('is followed by another read when reviewers are dealt anew while it is out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wrapper = await allView();
    fetchMarketApplications.mockClear();
    holding = true;
    vi.advanceTimersByTime(30_000);
    expect(fetchMarketApplications).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ dealt: 1 });
    await flushPromises();

    expect(fetchMarketApplications).toHaveBeenCalledTimes(2);
  });

  it('leaves Refresh enabled while it is out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wrapper = await allView();
    holding = true;
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(held).toHaveLength(1);

    expect(toolsOf(wrapper).freshness.refreshing).toBe(false);
  });
});

describe('Refresh', () => {
  it('stays enabled while a verdict’s own re-read is out', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    const wrapper = await allView();
    holding = true;

    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    await flushPromises();
    expect(held.length).toBeGreaterThan(0);

    expect(toolsOf(wrapper).freshness.refreshing).toBe(false);
  });

  it('is disabled while its own read is out', async () => {
    const wrapper = await allView();
    holding = true;

    await pressRefresh(wrapper);
    await flushPromises();

    expect(held).toHaveLength(1);
    expect(toolsOf(wrapper).freshness.refreshing).toBe(true);
  });
});

describe('the list', () => {
  it('never shows A’s applications after a move to B, even when A’s read answers last', async () => {
    holding = true;
    const wrapper = await allView();
    await wrapper.setProps({ market: market('m2') });
    await flushPromises();
    expect(held.map((read) => read.marketId)).toEqual(['m1', 'm2']);

    held[1]!.answer();
    await flushPromises();
    held[0]!.answer();
    await flushPromises();

    expect(rowsShown(wrapper)).toHaveLength(1);
    expect(rowsShown(wrapper)[0]).toContain('bo@vendor.test');
  });

  it('says it is loading on arriving at another market, never the last market’s rows', async () => {
    const wrapper = await allView();
    expect(rowsShown(wrapper)).toHaveLength(2);

    holding = true;
    await wrapper.setProps({ market: market('m2') });

    expect(rowsShown(wrapper)).toHaveLength(0);
    expect(wrapper.find('[data-testid="applications-all-list-loading"]').exists()).toBe(true);
    held[0]!.answer();
    await flushPromises();
    expect(rowsShown(wrapper)[0]).toContain('bo@vendor.test');
  });

  it('never says A’s refusal on B', async () => {
    holding = true;
    const wrapper = await allView();
    await wrapper.setProps({ market: market('m2') });
    held[1]!.answer();
    await flushPromises();

    // A's read refused late: B's list stands, and no failure is said.
    held[0]!.refuse({
      isAxiosError: true,
      response: { status: 500, data: { error: 'Market A could not be read.' } },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="applications-read-failed"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Market A could not be read.');
    expect(rowsShown(wrapper)[0]).toContain('bo@vendor.test');
  });
});

describe('an update of a vendor’s answers saved on A', () => {
  it('answering after the move to B adds no row to B and changes none of B’s', async () => {
    mounted = mount(ApplicationsAll, {
      props: { market: market('m1') },
      global: {
        stubs: {
          VendorDrawer: {
            name: 'VendorDrawer',
            emits: ['infoUpdated'],
            template: '<div><slot name="actions" /></div>',
            methods: { entryFor: () => null, loadNotes: () => undefined },
          },
          ExportVendorsDialog: true,
          FollowUpDialog: true,
        },
      },
    });
    await flushPromises();
    const wrapper = mounted;
    await wrapper.setProps({ market: market('m2') });
    await flushPromises();
    expect(rowsShown(wrapper)).toHaveLength(1);

    const saved = application('jo', 'm1');
    holding = true;
    wrapper.findComponent({ name: 'VendorDrawer' }).vm.$emit('infoUpdated', saved);
    await flushPromises();

    expect(rowsShown(wrapper)).toHaveLength(1);
    expect(rowsShown(wrapper)[0]).toContain('bo@vendor.test');
    expect(rowOf(wrapper, 'bo')!.text()).toContain(statusLabel(ApplicationStatus.Open));
  });
});

describe('what a verdict on A offers', () => {
  it('is withdrawn on the move to B: no Undo of A’s verdict on B, and none sent to B', async () => {
    route.query = { vendor: 'jo@vendor.test' };
    stored.m2 = [application('jo', 'm2')];
    const wrapper = await allView();
    await wrapper.get('[data-testid="applications-all-reject"]').trigger('click');
    await flushPromises();
    // The drawer closed: the undo is offered over the list.
    route.query = {};
    await flushPromises();
    expect(wrapper.find('[data-testid="applications-all-undo"]').exists()).toBe(true);

    await wrapper.setProps({ market: market('m2') });
    await flushPromises();

    expect(wrapper.find('[data-testid="applications-all-undo"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="applications-all-drawer-undo"]').exists()).toBe(false);
    expect(api.post).not.toHaveBeenCalledWith(
      expect.stringContaining('/markets/m2/'),
      expect.anything(),
    );
  });

  it('is withdrawn on the move to B: no done line of A’s selection on B', async () => {
    api.post.mockImplementation(async (url: string, body: { applications: { id: string }[] }) =>
      url.endsWith('/applications/verdicts')
        ? {
            data: { written: body.applications.map((app) => app.id), skipped: [], undoSeconds: 30 },
          }
        : { data: {} },
    );
    mounted = mount(ApplicationsAll, {
      props: { market: market('m1') },
      global: {
        stubs: {
          VendorDrawer: {
            template: '<div><slot name="actions" /></div>',
            methods: { entryFor: () => null, loadNotes: () => undefined },
          },
          AppDialog: {
            props: ['open'],
            emits: ['submit'],
            template:
              '<div v-if="open"><button data-testid="confirm" @click="$emit(\'submit\')" /></div>',
          },
          ExportVendorsDialog: true,
          FollowUpDialog: true,
        },
      },
    });
    await flushPromises();
    const wrapper = mounted;
    for (const row of wrapper.findAll('[data-testid="applications-all-row"]')) {
      await row.get('[data-testid="applications-all-tick"]').setValue(true);
    }
    await wrapper.get('[data-testid="applications-all-selection-approve"]').trigger('click');
    await wrapper.get('[data-testid="confirm"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="applications-all-result"]').exists()).toBe(true);

    await wrapper.setProps({ market: market('m2') });
    await flushPromises();

    expect(wrapper.find('[data-testid="applications-all-result"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="applications-all-result-undo"]').exists()).toBe(false);
  });
});
