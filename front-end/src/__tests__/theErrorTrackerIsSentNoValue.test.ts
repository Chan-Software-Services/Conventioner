// @vitest-environment happy-dom
/**
 * The front end's errors reach Sentry with only what ADR 0049 allows (T584).
 *
 * Each case installs the tracker on a real app and router, with `VITE_SENTRY_DSN` stubbed and the
 * SDK's transport replaced by one that records every envelope it is given, so a case reads exactly
 * what would leave the browser. A case that looks for a value searches every envelope whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createTransport, type Event, type Exception } from '@sentry/browser';
import {
  MAX_EVENTS_PER_PAGE,
  QUEUE_LIMIT,
  installErrorTracking,
  loadErrorTrackingAfterFirstPaint,
  type ErrorTrackingForTests,
  type InstalledErrorTracking,
} from '@/utils/errorTracking';
import type { Transport } from '@/utils/errorTrackingClient';

const KEY = 'fixturepublickey';
// Built from its parts, so no line reads as an email address.
const DSN = `https://${KEY}@o1.ingest.us.sentry.io/7`;
const ADDRESS = 'Vendor.Fixture+market@Mail.Example.COM';
const TOKEN = 'fixture-reset-token-4f1c9a';
const COMMIT = 'fixturecommit0123456789';

interface Envelope {
  header: Record<string, unknown>;
  items: { header: { type: string }; payload: Record<string, unknown> }[];
}

let sent: string[] = [];

const recording: Transport = (options) =>
  createTransport(options, async (request) => {
    sent.push(
      typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body),
    );
    return { statusCode: 200 };
  });

function envelopes(): Envelope[] {
  return sent.map((body) => {
    const [header, ...rest] = body.split('\n').filter(Boolean);
    const items: Envelope['items'] = [];
    for (let i = 0; i < rest.length; i += 2) {
      items.push({ header: JSON.parse(rest[i]!), payload: JSON.parse(rest[i + 1]!) });
    }
    return { header: JSON.parse(header!), items };
  });
}

function events(): Event[] {
  return envelopes().flatMap((each) =>
    each.items.filter((item) => item.header.type === 'event').map((item) => item.payload as Event),
  );
}

/** The first exception an event names. */
function firstException(event: Event): Exception {
  return event.exception!.values![0]!;
}

/** Each spelling of `value` an envelope could hold it in. */
function spellings(value: string): string[] {
  return [
    value,
    value.toLowerCase(),
    encodeURIComponent(value),
    encodeURIComponent(value).toLowerCase(),
  ];
}

function expectNowhere(value: string) {
  const everything = sent.join('\n');
  for (const spelling of spellings(value)) expect(everything).not.toContain(spelling);
}

const Page = defineComponent({ render: () => h('div') });

let app: App;
let router: Router;
let installed: InstalledErrorTracking | null;
let root: HTMLElement;

function routerFor() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Page },
      { path: '/markets/:marketId/vendors', name: 'market-vendors', component: Page },
      { path: '/reset-password', name: 'reset-password', component: Page },
      { path: '/:marketSlug', name: 'vendor-page', component: Page },
    ],
  });
}

async function install(at: string, testing: ErrorTrackingForTests = {}, component = Page) {
  app = createApp(component);
  router = routerFor();
  installed = installErrorTracking(app, router, { transport: recording, ...testing });
  app.use(router);
  await router.push(at);
  await router.isReady();
}

function mount() {
  root = document.createElement('div');
  document.body.append(root);
  app.mount(root);
}

function dispatchError(error: Error) {
  window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
}

function dispatchRejection(reason: unknown) {
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
}

beforeEach(() => {
  sent = [];
  installed = null;
  vi.stubEnv('VITE_SENTRY_DSN', DSN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ commit: COMMIT }), { status: 200 })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  installed?.remove();
  app?.unmount();
  root?.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an error caught in the page', () => {
  it('in a component render sends one event, caught by vue', async () => {
    const breakTheRender = (): never => {
      throw new TypeError('the render broke');
    };
    const Broken = defineComponent({
      render() {
        breakTheRender();
        return h('div');
      },
    });
    await install('/', {}, Broken);
    mount();
    await installed!.flush();

    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(firstException(event!)).toMatchObject({
      type: 'TypeError',
      value: 'the render broke',
    });
    expect(event!.tags).toEqual({ caught_by: 'vue', route_name: 'home' });
    expect(console.error).toHaveBeenCalledWith(expect.any(TypeError));
  });

  it('as an error event sends one event, caught by onerror', async () => {
    await install('/');
    dispatchError(new RangeError('a script let go'));
    await installed!.flush();

    expect(events()).toHaveLength(1);
    expect(firstException(events()[0]!)).toMatchObject({ type: 'RangeError' });
    expect(events()[0]!.tags!.caught_by).toBe('onerror');
  });

  it('as an unhandled rejection sends one event, caught by unhandledrejection', async () => {
    await install('/');
    dispatchRejection(new Error('nobody handled this'));
    await installed!.flush();

    expect(events()).toHaveLength(1);
    expect(firstException(events()[0]!)).toMatchObject({ value: 'nobody handled this' });
    expect(events()[0]!.tags!.caught_by).toBe('unhandledrejection');
  });

  it('before the client has loaded is sent once it has', async () => {
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const load = vi.fn(async () => {
      await arrived;
      return import('@/utils/errorTrackingClient');
    });
    await install('/', { load });
    dispatchError(new Error('during start-up'));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);

    arrive();
    await installed!.flush();
    expect(events()).toHaveLength(1);
    expect(firstException(events()[0]!).value).toBe('during start-up');
  });

  it('names the release from version.json, and none when it cannot be read', async () => {
    await install('/');
    dispatchError(new Error('with a release'));
    await installed!.flush();
    expect(events()[0]!.release).toBe(COMMIT);
    expect(events()[0]!.environment).toBe('test');

    installed!.remove();
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await install('/');
    dispatchError(new Error('without a release'));
    await installed!.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0]).not.toHaveProperty('release');
  });
});

describe('an event', () => {
  it("from a vendor's address in the page's query carries no address and no query", async () => {
    await install(`/markets/m-1/vendors?vendor=${encodeURIComponent(ADDRESS)}`);
    dispatchError(new Error('on the vendors page'));
    await installed!.flush();

    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event!.request).toEqual({ url: `${window.location.origin}/markets/m-1/vendors` });
    expect(event!.transaction).toBe('/markets/:marketId/vendors');
    expect(event!.tags).toEqual({
      caught_by: 'onerror',
      route_name: 'market-vendors',
      market_id: 'm-1',
    });
    expectNowhere(ADDRESS);
    expectNowhere('vendor=');
  });

  it('from a reset link carries no token and no query', async () => {
    await install(`/reset-password?token=${TOKEN}`);
    dispatchError(new Error('on the reset page'));
    await installed!.flush();

    expect(events()).toHaveLength(1);
    expect(events()[0]!.request).toEqual({ url: `${window.location.origin}/reset-password` });
    expectNowhere(TOKEN);
    expectNowhere('token=');
  });

  it('from an address typed as a market slug carries [address], not the address', async () => {
    await install(`/${encodeURIComponent(ADDRESS)}`);
    dispatchError(new Error('on a vendor page'));
    await installed!.flush();

    expect(events()[0]!.transaction).toBe('/:marketSlug');
    expect(events()[0]!.tags!.market_slug).toBe('[address]');
    expectNowhere(ADDRESS);
  });

  it("replaces an address in the error's message, and every URL's query", async () => {
    await install('/');
    dispatchError(
      new Error(`no payment for ${ADDRESS} at https://conventioner.example.com/a?token=${TOKEN}`),
    );
    await installed!.flush();

    expect(firstException(events()[0]!).value).toBe(
      'no payment for [address] at https://conventioner.example.com/a',
    );
    expectNowhere(ADDRESS);
    expectNowhere(TOKEN);
  });

  it('cuts a long message at 300 characters', async () => {
    await install('/');
    dispatchError(new Error('x'.repeat(1000)));
    await installed!.flush();

    expect(firstException(events()[0]!).value).toHaveLength(300);
  });

  it("holds only the allowlist's fields, and each frame only its place", async () => {
    await install('/markets/m-1/vendors');
    dispatchError(new Error('read every field'));
    await installed!.flush();

    const [envelope] = envelopes();
    expect(envelope!.items.map((item) => item.header.type)).toEqual(['event']);
    const [event] = events();
    expect(Object.keys(event!).sort()).toEqual(
      [
        'environment',
        'event_id',
        'exception',
        'level',
        'platform',
        'release',
        'request',
        'sdk',
        'tags',
        'timestamp',
        'transaction',
      ].sort(),
    );
    // The SDK adds its packages and settings after the allowlist, as it writes the envelope;
    // `infer_ip: never` tells Sentry to record no address from the request either.
    expect(event!.sdk).toEqual({
      name: 'sentry.javascript.browser',
      version: expect.any(String),
      integrations: [],
      packages: [{ name: 'npm:@sentry/browser', version: expect.any(String) }],
      settings: { infer_ip: 'never' },
    });
    expect(envelope!.header).toEqual({
      event_id: event!.event_id,
      sent_at: expect.any(String),
      sdk: { name: 'sentry.javascript.browser', version: expect.any(String) },
    });
    const frames = firstException(event!).stacktrace!.frames! as Record<string, unknown>[];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(['colno', 'filename', 'function', 'in_app', 'lineno']).toEqual(
        expect.arrayContaining(Object.keys(frame)),
      );
    }
  });

  it("leaves the page's own requests as they were", async () => {
    const { fetch: before } = window;
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    await install('/');
    dispatchError(new Error('after the client started'));
    await installed!.flush();

    expect(window.fetch).toBe(before);
    expect(XMLHttpRequest.prototype.open).toBe(open);
    expect(XMLHttpRequest.prototype.send).toBe(send);
  });
});

describe('what is never sent', () => {
  it.each([
    [
      'Chromium',
      'Failed to fetch dynamically imported module: https://conventioner.io/assets/a.js',
    ],
    ['Safari', 'Importing a module script failed.'],
    ['Firefox', 'error loading dynamically imported module: https://conventioner.io/assets/a.js'],
  ])("%s's failed fetch of a page's code", async (_browser, words) => {
    await install('/');
    dispatchRejection(new TypeError(words));
    dispatchError(new TypeError(words));
    await installed!.flush();

    expect(sent).toEqual([]);
  });

  it(`more than ${MAX_EVENTS_PER_PAGE} events in one page load`, async () => {
    await install('/');
    dispatchError(new Error('error number 0'));
    await installed!.flush();
    for (let i = 1; i < 25; i += 1) dispatchError(new Error(`error number ${i}`));
    await installed!.flush();

    expect(events()).toHaveLength(MAX_EVENTS_PER_PAGE);
  });

  it(`more than ${QUEUE_LIMIT} errors waiting for the client`, async () => {
    await install('/');
    for (let i = 0; i < 15; i += 1) dispatchError(new Error(`waiting number ${i}`));
    await installed!.flush();

    expect(events().map((event) => firstException(event).value)).toEqual(
      Array.from({ length: QUEUE_LIMIT }, (_, i) => `waiting number ${i}`),
    );
  });

  it('anything once the chunk could not be fetched, and nothing is thrown', async () => {
    const load = vi.fn(() => Promise.reject(new TypeError('Failed to load the chunk')));
    await install('/', { load });
    dispatchError(new Error('the first'));
    await expect(installed!.flush()).resolves.toBeUndefined();
    dispatchError(new Error('the second'));
    await installed!.flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });
});

describe('with no DSN', () => {
  it.each([[undefined], [''], ['   ']])('installs nothing (%j)', async (dsn) => {
    vi.stubEnv('VITE_SENTRY_DSN', dsn);
    const listen = vi.spyOn(window, 'addEventListener');
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const load = vi.fn();
    await install('/', { load });
    loadErrorTrackingAfterFirstPaint();

    expect(installed).toBeNull();
    expect(app.config.errorHandler).toBeUndefined();
    expect(listen).not.toHaveBeenCalledWith('error', expect.anything());
    expect(listen).not.toHaveBeenCalledWith('unhandledrejection', expect.anything());
    expect(frame).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the client', () => {
  it('loads after the first contentful paint, and then a task', async () => {
    const observers: { callback: PerformanceObserverCallback; disconnected: boolean }[] = [];
    class FakeObserver {
      static supportedEntryTypes = ['paint'];
      private readonly entry: { callback: PerformanceObserverCallback; disconnected: boolean };
      constructor(callback: PerformanceObserverCallback) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe(options: PerformanceObserverInit) {
        expect(options).toEqual({ type: 'paint', buffered: true });
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    const paints = (...names: string[]) =>
      ({ getEntriesByName: (name: string) => names.filter((each) => each === name) }) as never;
    const load = vi.fn(() => import('@/utils/errorTrackingClient'));
    await install('/', { load });
    loadErrorTrackingAfterFirstPaint();
    expect(observers).toHaveLength(1);

    observers[0]!.callback(paints('first-paint'), observers[0] as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).not.toHaveBeenCalled();

    observers[0]!.callback(paints('first-contentful-paint'), observers[0] as never);
    expect(observers[0]!.disconnected).toBe(true);
    expect(load).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(1);
    await installed!.flush();
    expect(sent).toEqual([]);
  });

  it('loads after a frame and a task in a browser with no paint timing', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const load = vi.fn(() => import('@/utils/errorTrackingClient'));
    await install('/', { load });
    loadErrorTrackingAfterFirstPaint();
    expect(frames).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();

    frames[0]!(0);
    expect(load).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(1);

    dispatchError(new Error('after it loaded'));
    await installed!.flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(1);
  });

  it('loads at the first error, and not again after the first paint', async () => {
    const load = vi.fn(() => import('@/utils/errorTrackingClient'));
    await install('/', { load });
    dispatchError(new Error('before the paint'));
    expect(load).toHaveBeenCalledTimes(1);
    loadErrorTrackingAfterFirstPaint();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await installed!.flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(1);
  });
});
