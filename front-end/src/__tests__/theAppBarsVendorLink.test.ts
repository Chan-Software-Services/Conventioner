// @vitest-environment happy-dom
/**
 * The app bar's way to the vendor's side (T469): on the market page at `/<market>`, once it has
 * answered found, in every stage (the call, a notice, the map), the bar's logo-alone row carries
 * "Vendor sign-in", or "Your vendor page" for a tab signed in for that market, to
 * `/<market>/vendor`. It never shows while the page reads, after a failed read, on "Page not found",
 * on the vendor page itself or on an organizer's route. Mounted as the shell places it, the bar over
 * the app's own router view, so the market page tells the bar as a visitor's would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createPinia } from 'pinia';
import { defineComponent, h, ref } from 'vue';
import { RouterView } from 'vue-router';
import router from '@/router';
import AppBar from '@/components/AppBar.vue';
import { IntakeMode, MarketPhase } from '@/assets/types/datatypes';
import { useApplicationStore } from '@/stores/application';
import { api } from '@/utils/api';
import type { VendorPageInfo } from '@/utils/vendorPage';

/** The map and the vendor page stand in for themselves: each is tested on its own. */
vi.mock('@/views/PublicMapView.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({ setup: () => () => h('div', { 'data-testid': 'public-map' }) }),
  };
});
vi.mock('@/views/VendorPage.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({ setup: () => () => h('div', { 'data-testid': 'vendor-page' }) }),
  };
});

const SESSION_KEY = 'conventioner.applicantSession';
const ORGANIZER = 'organizer@example.com';

function pageOf(overrides: Partial<VendorPageInfo> = {}): VendorPageInfo {
  return {
    marketName: 'Spring Market',
    intakeMode: IntakeMode.Form,
    phase: MarketPhase.Applications,
    takesApplications: true,
    resultsPublished: false,
    marketDates: ['2099-08-01'],
    ended: false,
    rememberUntil: '2099-08-01',
    mapOpen: false,
    ...overrides,
  };
}

const config = { headers: {} } as InternalAxiosRequestConfig;

/** A request the server answered with this status, or none at all. */
function answered(status: number | null): AxiosError {
  if (status === null) return new AxiosError('Network Error', 'ERR_NETWORK', config, {});
  const response = { data: {}, status, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, {}, response);
}

/** What the server holds for each slug: a page, or the error its read rejects with. */
let pages: Record<string, VendorPageInfo | AxiosError | Promise<VendorPageInfo>> = {};

function serve() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    const slug = /^\/public\/markets\/([^/]+)\/vendor-page$/.exec(url)?.[1];
    if (!slug) return { data: [] };
    const held = pages[slug] ?? answered(404);
    if (held instanceof AxiosError) throw held;
    return { data: await held };
  });
}

let wrapper: VueWrapper | null = null;

/** Open `path` as a visitor, or as `user`, an organizer signed in to the app. */
async function visit(path: string, user: string | null = null): Promise<VueWrapper> {
  if (user) localStorage.setItem('user', JSON.stringify({ email: user }));
  await router.push(path);
  wrapper = mount(defineComponent({ setup: () => () => [h(AppBar), h(RouterView)] }), {
    global: { plugins: [router, createPinia()], provide: { user: ref(user) } },
  });
  await flushPromises();
  return wrapper;
}

const link = () => wrapper!.find('[data-testid="app-bar-vendor-link"]');

function signInFor(marketSlug: string) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      marketId: `${marketSlug}-id`,
      marketSlug,
      applicantEmail: 'vendor@example.com',
      token: 'a-token',
    }),
  );
}

beforeEach(() => {
  pages = { 'spring-market': pageOf() };
  sessionStorage.clear();
  serve();
});

afterEach(async () => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  localStorage.clear();
  await router.push('/login');
});

describe('on the market page, once it found its market', () => {
  it.each<[string, Partial<VendorPageInfo>]>([
    ['the call', {}],
    ['a notice', { takesApplications: false }],
    ['the map', { mapOpen: true, takesApplications: false }],
  ])('reads "Vendor sign-in" to the vendor page on %s', async (_name, overrides) => {
    pages['spring-market'] = pageOf(overrides);
    await visit('/spring-market');

    expect(link().text()).toBe('Vendor sign-in');
    expect(link().attributes('href')).toBe('/spring-market/vendor');
  });

  it('reads "Your vendor page" to a tab signed in for this market', async () => {
    signInFor('spring-market');
    await visit('/spring-market');

    expect(link().text()).toBe('Your vendor page');
    expect(link().attributes('href')).toBe('/spring-market/vendor');
  });

  it('reads "Vendor sign-in" once the tab\'s sign-in ends while the page stands', async () => {
    signInFor('spring-market');
    await visit('/spring-market');

    useApplicationStore().clearSession();
    await flushPromises();

    expect(link().text()).toBe('Vendor sign-in');
  });

  it('reads "Vendor sign-in" to a tab signed in for another market', async () => {
    signInFor('other-market');
    await visit('/spring-market');

    expect(link().text()).toBe('Vendor sign-in');
  });

  it('shows to a signed-in organizer too, whose bar stands apart there', async () => {
    await visit('/spring-market', ORGANIZER);

    expect(wrapper!.find('[data-testid="app-bar-account-button"]').exists()).toBe(false);
    expect(link().text()).toBe('Vendor sign-in');
  });

  it('opens the vendor page', async () => {
    await visit('/spring-market');

    await link().trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('vendor-page');
    expect(router.currentRoute.value.path).toBe('/spring-market/vendor');
    expect(link().exists()).toBe(false);
  });
});

describe('nowhere else', () => {
  it('is absent while the market page reads', async () => {
    pages['spring-market'] = new Promise(() => {});
    await visit('/spring-market');

    expect(wrapper!.find('[data-testid="market-page-loading"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it.each([
    ['never answered', null],
    ['answered 500', 500],
  ])('is absent after a read that %s', async (_name, status) => {
    pages['spring-market'] = answered(status);
    await visit('/spring-market');

    expect(wrapper!.find('[data-testid="market-page-read-failed"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it('is absent on "Page not found"', async () => {
    await visit('/no-such-market');

    expect(wrapper!.find('[data-testid="market-page-not-found"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it("is absent while another market's page reads, after a move in the app", async () => {
    pages['other-market'] = new Promise(() => {});
    await visit('/spring-market');
    expect(link().exists()).toBe(true);

    await router.push('/other-market');
    await flushPromises();

    expect(link().exists()).toBe(false);
  });

  it("goes to the second market's vendor page once its page found it", async () => {
    pages['other-market'] = pageOf({ marketName: 'Other Market' });
    await visit('/spring-market');

    await router.push('/other-market');
    await flushPromises();

    expect(link().attributes('href')).toBe('/other-market/vendor');
  });

  it('is absent while the market page reads again, opened anew after leaving it', async () => {
    await visit('/spring-market', ORGANIZER);
    await router.push('/markets');
    await flushPromises();

    pages['spring-market'] = new Promise(() => {});
    await router.push('/spring-market');
    await flushPromises();

    expect(wrapper!.find('[data-testid="market-page-loading"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it('is absent while the market page reads again, moved back to in the app', async () => {
    pages['other-market'] = new Promise(() => {});
    await visit('/spring-market');
    await router.push('/other-market');
    await flushPromises();

    pages['spring-market'] = new Promise(() => {});
    await router.push('/spring-market');
    await flushPromises();

    expect(wrapper!.find('[data-testid="market-page-loading"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it('is absent on the vendor page', async () => {
    await visit('/spring-market/vendor');

    expect(wrapper!.find('[data-testid="vendor-page"]').exists()).toBe(true);
    expect(link().exists()).toBe(false);
  });

  it.each(['/markets', '/organizations', '/markets/m1/setup'])(
    "is absent on the organizer's %s",
    async (path) => {
      await visit(path, ORGANIZER);

      expect(router.currentRoute.value.path).toBe(path);
      expect(wrapper!.find('[data-testid="app-bar-account-button"]').exists()).toBe(true);
      expect(link().exists()).toBe(false);
    },
  );

  it('is absent once the market page is left for an organizer route', async () => {
    await visit('/spring-market', ORGANIZER);
    expect(link().exists()).toBe(true);

    await router.push('/markets');
    await flushPromises();

    expect(link().exists()).toBe(false);
  });
});
