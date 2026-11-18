// @vitest-environment happy-dom
/**
 * The market page (T469), at the market's own address `/<market>`, for anyone, signed in or out:
 * the public map while the server says it is open, the application call while the market takes
 * applications, and otherwise a notice of where it stands, each with a way to the vendor's side at
 * `/<market>/vendor`. Mounted under the app's own router, as a visitor reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { defineComponent, h } from 'vue';
import { RouterView } from 'vue-router';
import router from '@/router';
import MarketPublicView from '@/views/MarketPublicView.vue';
import { IntakeMode, MarketPhase } from '@/assets/types/datatypes';
import { api } from '@/utils/api';
import { standsApart } from '@/utils/currentPlace';
import {
  APPLICATIONS_CLOSED,
  MAP_NOT_PUBLISHED,
  MARKET_ENDED,
  marketPageNotice,
  marketPageShows,
  type VendorPageInfo,
} from '@/utils/vendorPage';

/** The map and the vendor page stand in for themselves: each is tested on its own. */
const stand = vi.hoisted(() => ({ mapMounts: [] as string[] }));
vi.mock('@/views/PublicMapView.vue', async () => {
  const { defineComponent, h, onMounted } = await import('vue');
  const { useRoute } = await import('vue-router');
  return {
    default: defineComponent({
      name: 'PublicMapView',
      setup() {
        const route = useRoute();
        onMounted(() => stand.mapMounts.push(String(route.params.marketSlug)));
        return () => h('div', { 'data-testid': 'public-map' }, 'The map');
      },
    }),
  };
});
vi.mock('@/views/VendorPage.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({ setup: () => () => h('div', { 'data-testid': 'vendor-page' }) }),
  };
});

const SESSION_KEY = 'conventioner.applicantSession';

function pageOf(overrides: Partial<VendorPageInfo> = {}): VendorPageInfo {
  return {
    marketName: 'Spring Market',
    intakeMode: IntakeMode.Form,
    phase: MarketPhase.Applications,
    takesApplications: true,
    resultsPublished: false,
    marketDates: ['2099-08-01', '2099-08-02'],
    ended: false,
    rememberUntil: '2099-08-01',
    mapOpen: false,
    ...overrides,
  };
}

const config = { headers: {} } as InternalAxiosRequestConfig;

/** A request that never answered, as axios rejects it: no response at all. */
const neverAnswered = () => new AxiosError('Network Error', 'ERR_NETWORK', config, {});

/** A request the server answered with this status. */
function answered(status: number): AxiosError {
  const response = { data: {}, status, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, {}, response);
}

/** What the server holds for each slug: a page, or the error its read rejects with. */
let pages: Record<string, VendorPageInfo | AxiosError | Promise<VendorPageInfo>> = {};
let reads: string[] = [];

function serve() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    const slug = /^\/public\/markets\/([^/]+)\/vendor-page$/.exec(url)?.[1];
    if (!slug) throw new Error(`No read of ${url} is expected`);
    reads.push(slug);
    const held = pages[slug] ?? answered(404);
    if (held instanceof AxiosError) throw held;
    return { data: await held };
  });
}

let wrapper: VueWrapper | null = null;

async function visit(path: string): Promise<VueWrapper> {
  await router.push(path);
  wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), {
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
}

const find = (testid: string) => wrapper!.find(`[data-testid="${testid}"]`);
const text = (testid: string) => find(testid).text();
/** Its text as a reader reads it, the template's own runs of whitespace one space. */
const words = (testid: string) => text(testid).replace(/\s+/g, ' ');

beforeEach(() => {
  pages = { 'spring-market': pageOf() };
  reads = [];
  stand.mapMounts = [];
  sessionStorage.clear();
  serve();
});

afterEach(async () => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  await router.push('/login');
});

describe('what the market page shows, in this order', () => {
  it.each<[string, Partial<VendorPageInfo>, ReturnType<typeof marketPageShows>]>([
    ['the map, whenever the server says it is open', { mapOpen: true }, 'map'],
    [
      'the map before the call, for a market open to both',
      { mapOpen: true, takesApplications: true },
      'map',
    ],
    [
      'the map in an archived market, if the server ever says so',
      { mapOpen: true, phase: MarketPhase.Archived },
      'map',
    ],
    ['the call while a form market takes applications', { takesApplications: true }, 'call'],
    [
      'a notice for a market that imports its vendors',
      { intakeMode: IntakeMode.Csv, takesApplications: true },
      'notice',
    ],
    ['a notice once applications stop', { takesApplications: false }, 'notice'],
  ])('%s', (_name, overrides, shows) => {
    expect(marketPageShows(pageOf(overrides))).toBe(shows);
  });

  it.each<[string, Partial<VendorPageInfo>, string]>([
    [
      'archived, after it ran',
      { phase: MarketPhase.Archived, ended: true, resultsPublished: true },
      MARKET_ENDED,
    ],
    ['archived, without running', { phase: MarketPhase.Archived, ended: false }, MARKET_ENDED],
    [
      'results out, the map off',
      { phase: MarketPhase.Offers, resultsPublished: true },
      MAP_NOT_PUBLISHED,
    ],
    [
      'market days, the map off',
      { phase: MarketPhase.MarketDays, resultsPublished: true },
      MAP_NOT_PUBLISHED,
    ],
    ['applications stopped', { takesApplications: false }, APPLICATIONS_CLOSED],
    [
      'in Assignment',
      { phase: MarketPhase.Assignment, takesApplications: false },
      APPLICATIONS_CLOSED,
    ],
    [
      'in Offers before results',
      { phase: MarketPhase.Offers, takesApplications: false },
      APPLICATIONS_CLOSED,
    ],
  ])('says %s: the right line', (_name, overrides, line) => {
    expect(marketPageNotice(pageOf({ takesApplications: false, ...overrides }))).toBe(line);
  });

  it('words each line as decided', () => {
    expect([APPLICATIONS_CLOSED, MAP_NOT_PUBLISHED, MARKET_ENDED]).toEqual([
      'Applications are closed.',
      "The map isn't published yet.",
      'This market has ended.',
    ]);
  });
});

describe('the application call', () => {
  it("names the market, its dates and that applications are open, with Apply and sign-in to the vendor's side", async () => {
    await visit('/spring-market');

    expect(find('market-page-call').exists()).toBe(true);
    expect(wrapper!.get('h1').text()).toBe('Spring Market');
    expect(text('market-page-name')).toBe('Spring Market');
    const dates = find('market-page-dates');
    expect(dates.attributes('aria-label')).toBe('Market dates');
    expect(dates.findAll('li').map((li) => li.text())).toEqual([
      'Saturday, August 1, 2099',
      'Sunday, August 2, 2099',
    ]);
    expect(words('market-page-call')).toContain('Applications are open.');
    expect(text('market-page-apply')).toBe('Apply');
    expect(find('market-page-apply').attributes('href')).toBe('/spring-market/vendor');
    expect(words('market-page-call')).toContain('Already applied? Sign in');
    expect(text('market-page-sign-in')).toBe('Sign in');
    expect(find('market-page-sign-in').attributes('href')).toBe('/spring-market/vendor');
  });

  it('lists no dates for a market that has none', async () => {
    pages['spring-market'] = pageOf({ marketDates: [] });
    await visit('/spring-market');

    expect(find('market-page-call').exists()).toBe(true);
    expect(find('market-page-dates').exists()).toBe(false);
  });

  it('opens the vendor page from Apply', async () => {
    await visit('/spring-market');

    await find('market-page-apply').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('vendor-page');
    expect(router.currentRoute.value.path).toBe('/spring-market/vendor');
  });
});

describe('a notice', () => {
  it.each<[string, Partial<VendorPageInfo>, string]>([
    ['closed', { takesApplications: false }, 'Applications are closed.'],
    [
      'map not published',
      { takesApplications: false, phase: MarketPhase.Offers, resultsPublished: true },
      "The map isn't published yet.",
    ],
    [
      'ended',
      { takesApplications: false, phase: MarketPhase.Archived, ended: true },
      'This market has ended.',
    ],
  ])(
    '%s: names the market and its dates, says where it stands and links the vendor page',
    async (_name, overrides, line) => {
      pages['spring-market'] = pageOf(overrides);
      await visit('/spring-market');

      expect(find('market-page-call').exists()).toBe(false);
      expect(find('market-page-notice').exists()).toBe(true);
      expect(text('market-page-name')).toBe('Spring Market');
      expect(find('market-page-dates').findAll('li')).toHaveLength(2);
      expect(text('market-page-notice-line')).toBe(line);
      expect(text('market-page-vendor-link')).toBe('Vendor sign-in');
      expect(find('market-page-vendor-link').attributes('href')).toBe('/spring-market/vendor');
    },
  );

  it('says "Your vendor page" to a tab signed in for this market', async () => {
    pages['spring-market'] = pageOf({ takesApplications: false });
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        marketId: 'market-1',
        marketSlug: 'spring-market',
        applicantEmail: 'vendor@example.com',
        token: 'a-token',
      }),
    );
    await visit('/spring-market');

    expect(text('market-page-vendor-link')).toBe('Your vendor page');
  });

  it('says Vendor sign-in to a tab signed in for another market', async () => {
    pages['spring-market'] = pageOf({ takesApplications: false });
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        marketId: 'market-2',
        marketSlug: 'other-market',
        applicantEmail: 'vendor@example.com',
        token: 'a-token',
      }),
    );
    await visit('/spring-market');

    expect(text('market-page-vendor-link')).toBe('Vendor sign-in');
  });
});

describe('the map', () => {
  it('is the whole page, with no wrapper of its own, while the server says it is open', async () => {
    pages['spring-market'] = pageOf({ mapOpen: true, takesApplications: false });
    await visit('/spring-market');

    expect(wrapper!.findComponent(MarketPublicView).element).toBe(find('public-map').element);
    expect(stand.mapMounts).toEqual(['spring-market']);
  });

  it("is mounted afresh for another market's map", async () => {
    pages['spring-market'] = pageOf({ mapOpen: true });
    pages['other-market'] = pageOf({ marketName: 'Other Market', mapOpen: true });
    await visit('/spring-market');

    await router.push('/other-market');
    await flushPromises();

    expect(stand.mapMounts).toEqual(['spring-market', 'other-market']);
  });
});

describe('while it reads, and when the read does not find or does not answer', () => {
  it('says Loading… and never prints the slug back before it knows the market is real', async () => {
    pages['spring-market'] = new Promise(() => {});
    await visit('/spring-market');

    expect(text('market-page-loading')).toBe('Loading…');
    expect(wrapper!.text()).not.toContain('spring-market');
  });

  it('reads "Page not found" for a market the read does not find, and tells the app bar', async () => {
    await visit('/no-such-market');

    expect(find('market-page-not-found').find('[data-testid="page-not-found"]').exists()).toBe(
      true,
    );
    expect(wrapper!.text()).not.toContain('no-such-market');
    expect(standsApart(router.currentRoute.value)).toBe(false);
  });

  it('takes "Page not found" back on leaving', async () => {
    await visit('/no-such-market');

    await router.push('/markets');
    await flushPromises();

    expect(standsApart(router.resolve('/no-such-market'))).toBe(true);
  });

  it.each([
    ['never answered', neverAnswered],
    ['answered 500', () => answered(500)],
  ])(
    'says the page could not be loaded when the read %s, and Try again reads again',
    async (_name, failure) => {
      pages['spring-market'] = failure();
      await visit('/spring-market');

      expect(find('market-page-not-found').exists()).toBe(false);
      expect(find('market-page-call').exists()).toBe(false);
      expect(find('market-page-read-failed').find('p').text()).toBe(
        'This page could not be loaded. Check your connection and try again.',
      );
      expect(text('market-page-retry')).toBe('Try again');
      expect(standsApart(router.currentRoute.value)).toBe(true);

      pages['spring-market'] = pageOf();
      await find('market-page-retry').trigger('click');
      await flushPromises();

      expect(reads).toEqual(['spring-market', 'spring-market']);
      expect(find('market-page-call').exists()).toBe(true);
    },
  );
});

describe('moving between markets in the app', () => {
  it("reads the second market afresh, and drops the first's answer that arrives after", async () => {
    let answerFirst: (page: VendorPageInfo) => void = () => {};
    pages['spring-market'] = new Promise((resolve) => (answerFirst = resolve));
    pages['other-market'] = pageOf({ marketName: 'Other Market' });
    await visit('/spring-market');

    await router.push('/other-market');
    await flushPromises();
    answerFirst(pageOf());
    await flushPromises();

    expect(reads).toEqual(['spring-market', 'other-market']);
    expect(text('market-page-name')).toBe('Other Market');
    expect(wrapper!.text()).not.toContain('Spring Market');
  });

  it("clears the first market's page while the second's reads", async () => {
    pages['other-market'] = new Promise(() => {});
    await visit('/spring-market');

    await router.push('/other-market');
    await flushPromises();

    expect(find('market-page-loading').exists()).toBe(true);
    expect(wrapper!.text()).not.toContain('Spring Market');
  });
});

describe('a door code on the open page', () => {
  it('goes on to the vendor page, holding the code', async () => {
    await visit('/spring-market');

    await router.push('/spring-market?door=C0DE');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('vendor-page');
    expect(router.currentRoute.value.query).toEqual({ door: 'C0DE' });
    expect(find('vendor-page').exists()).toBe(true);
  });
});
