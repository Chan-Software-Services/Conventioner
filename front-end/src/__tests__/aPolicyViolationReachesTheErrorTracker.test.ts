// @vitest-environment happy-dom
/**
 * The first Content-Security-Policy violation of each directive and blocked origin in a page load
 * reaches Sentry as one warning, with only what ADR 0049 allows of it (T584).
 *
 * The browser fires `securitypolicyviolation` on the document for every load the policy refuses or,
 * under a report-only policy, would refuse. Each case installs the tracker on a real app and router
 * with `VITE_SENTRY_DSN` stubbed and a transport that records every envelope, then dispatches the
 * event the browser would. happy-dom has no `SecurityPolicyViolationEvent`, so the case builds one
 * with the fields a browser gives it; the walk of the production build in a real browser is in the
 * task's build note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  MAX_EVENTS_PER_PAGE,
  installErrorTracking,
  type InstalledErrorTracking,
} from '@/utils/errorTracking';
import { events, expectNowhere, recording, sent } from './support/recordedEnvelopes';

const KEY = 'fixturepublickey';
// Built from its parts, so no line reads as an email address.
const DSN = `https://${KEY}@o1.ingest.us.sentry.io/7`;
const ADDRESS = 'Vendor.Fixture+market@Mail.Example.COM';
const TOKEN = 'fixture-reset-token-4f1c9a';
const SAMPLE = 'fixtureSampleOfAnInlineScript';
const BLOCKED_ORIGIN = 'https://scripts.example.net';

type Violation = Pick<
  SecurityPolicyViolationEvent,
  | 'effectiveDirective'
  | 'violatedDirective'
  | 'blockedURI'
  | 'sourceFile'
  | 'lineNumber'
  | 'columnNumber'
  | 'sample'
  | 'disposition'
  | 'documentURI'
  | 'referrer'
  | 'originalPolicy'
  | 'statusCode'
>;

/** The page's own address, query and all, as a browser would name it in a violation. */
function pageAddress(): string {
  return window.location.href;
}

/** A violation as Chromium reports a script from an origin the policy does not allow. */
function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    effectiveDirective: 'script-src-elem',
    violatedDirective: 'script-src-elem',
    blockedURI: `${BLOCKED_ORIGIN}/widget.js?vendor=${encodeURIComponent(ADDRESS)}`,
    sourceFile: `${window.location.origin}/assets/index-fixture.js?v=${TOKEN}`,
    lineNumber: 12,
    columnNumber: 34,
    sample: SAMPLE,
    disposition: 'enforce',
    documentURI: pageAddress(),
    referrer: pageAddress(),
    originalPolicy: "default-src 'self'",
    statusCode: 200,
    ...overrides,
  };
}

function dispatchViolation(fields: Partial<Violation> = {}) {
  document.dispatchEvent(
    Object.assign(new Event('securitypolicyviolation'), violation(fields)) as Event,
  );
}

const Page = defineComponent({ render: () => h('div') });

let app: App;
let installed: InstalledErrorTracking | null;

async function install(at: string) {
  // The browser names the page's own address in a violation, so the page is there too.
  window.history.replaceState(null, '', at);
  app = createApp(Page);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Page },
      { path: '/reset-password', name: 'reset-password', component: Page },
      { path: '/markets/:marketId/payments/:vendorEmail', name: 'payments', component: Page },
    ],
  });
  installed = installErrorTracking(app, router, { transport: recording });
  app.use(router);
  await router.push(at);
  await router.isReady();
}

beforeEach(() => {
  sent.length = 0;
  installed = null;
  vi.stubEnv('VITE_SENTRY_DSN', DSN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  installed?.remove();
  app?.unmount();
  window.history.replaceState(null, '', '/');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a policy violation', () => {
  it('sends one warning naming the directive and the blocked origin', async () => {
    await install('/');
    dispatchViolation();
    await installed!.flush();

    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event!.level).toBe('warning');
    expect(event!.message).toBe(
      `Content-Security-Policy blocked script-src-elem from ${BLOCKED_ORIGIN}`,
    );
    expect(event!.tags).toEqual({
      caught_by: 'csp',
      route_name: 'home',
      csp_directive: 'script-src-elem',
      csp_blocked: BLOCKED_ORIGIN,
    });
    expect(event!.contexts).toEqual({
      violation: {
        source_file: `${window.location.origin}/assets/index-fixture.js`,
        line: 12,
        column: 34,
      },
    });
    expect(event).not.toHaveProperty('exception');
  });

  it('under a report-only policy says the policy would block it', async () => {
    await install('/');
    dispatchViolation({ disposition: 'report' });
    await installed!.flush();

    expect(events()[0]!.message).toBe(
      `Content-Security-Policy would block script-src-elem from ${BLOCKED_ORIGIN}`,
    );
  });

  it("holds only the allowlist's fields", async () => {
    await install('/');
    dispatchViolation();
    await installed!.flush();

    expect(Object.keys(events()[0]!).sort()).toEqual(
      [
        'contexts',
        'environment',
        'event_id',
        'level',
        'message',
        'platform',
        'request',
        'sdk',
        'tags',
        'timestamp',
        'transaction',
      ].sort(),
    );
  });

  it("carries no sample, no blocked address's query, and none of the page's address", async () => {
    await install(`/reset-password?token=${TOKEN}`);
    dispatchViolation();
    await installed!.flush();

    expect(events()).toHaveLength(1);
    expect(events()[0]!.request).toEqual({ url: `${window.location.origin}/reset-password` });
    expectNowhere(SAMPLE);
    expectNowhere(TOKEN);
    expectNowhere(ADDRESS);
    expectNowhere('token=');
    expectNowhere('vendor=');
    expectNowhere('widget.js');
    expectNowhere("default-src 'self'");
  });

  it("names an inline script in the page by the route, never the page's address", async () => {
    const page = `/markets/m-1/payments/${ADDRESS}`;
    await install(`${page}?token=${TOKEN}`);
    dispatchViolation({ blockedURI: 'inline', sourceFile: pageAddress(), lineNumber: 3 });
    await installed!.flush();

    const [event] = events();
    expect(event!.message).toBe('Content-Security-Policy blocked script-src-elem from inline');
    expect(event!.tags!.csp_blocked).toBe('inline');
    expect(event!.contexts).toEqual({
      violation: {
        source_file: `${window.location.origin}/markets/m-1/payments/:vendorEmail`,
        line: 3,
        column: 34,
      },
    });
    expectNowhere(ADDRESS);
    expectNowhere(TOKEN);
  });

  it.each([
    ['eval', 'eval'],
    ['data', 'data'],
    ['data:text/javascript,alert(1)', 'data'],
    [`blob:${BLOCKED_ORIGIN}/0f1e2d3c`, BLOCKED_ORIGIN],
    ['', 'none'],
    ['not a keyword or an address', 'unreadable'],
  ])('reduces a blocked %j to %j', async (blockedURI, blocked) => {
    await install('/');
    dispatchViolation({ blockedURI });
    await installed!.flush();

    expect(events()[0]!.tags!.csp_blocked).toBe(blocked);
  });

  it('replaces an address in the script that broke it', async () => {
    await install('/');
    dispatchViolation({
      sourceFile: `https://cdn.example.net/${encodeURIComponent(ADDRESS)}/a.js#${TOKEN}`,
    });
    await installed!.flush();

    expect((events()[0]!.contexts!.violation as Record<string, unknown>).source_file).toBe(
      'https://cdn.example.net/[address]/a.js',
    );
    expectNowhere(ADDRESS);
    expectNowhere(TOKEN);
  });

  it('with no script named sends no place', async () => {
    await install('/');
    // As Chromium names a script a debugger added, which has no file of its own.
    dispatchViolation({ sourceFile: '', lineNumber: 5, columnNumber: 19 });
    await installed!.flush();

    expect(events()[0]).not.toHaveProperty('contexts');
  });
});

describe('repeated violations', () => {
  it('send one event for five identical ones', async () => {
    await install('/');
    for (let i = 0; i < 5; i += 1) dispatchViolation({ lineNumber: i + 1 });
    await installed!.flush();

    expect(events()).toHaveLength(1);
  });

  it('send one event for each directive and each blocked origin', async () => {
    await install('/');
    dispatchViolation();
    dispatchViolation({ effectiveDirective: 'img-src', blockedURI: `${BLOCKED_ORIGIN}/a.png` });
    dispatchViolation({ blockedURI: 'https://other.example.net/b.js' });
    dispatchViolation({ blockedURI: `${BLOCKED_ORIGIN}/another.js` });
    await installed!.flush();

    expect(events().map((event) => event.message)).toEqual([
      `Content-Security-Policy blocked script-src-elem from ${BLOCKED_ORIGIN}`,
      `Content-Security-Policy blocked img-src from ${BLOCKED_ORIGIN}`,
      'Content-Security-Policy blocked script-src-elem from https://other.example.net',
    ]);
  });

  it(`count toward the ${MAX_EVENTS_PER_PAGE} events of a page load`, async () => {
    await install('/');
    for (let i = 0; i < MAX_EVENTS_PER_PAGE - 1; i += 1) {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error(`error ${i}`) }));
      await installed!.flush();
    }
    dispatchViolation();
    dispatchViolation({ effectiveDirective: 'img-src' });
    await installed!.flush();

    expect(events()).toHaveLength(MAX_EVENTS_PER_PAGE);
    expect(events().filter((event) => event.tags!.caught_by === 'csp')).toHaveLength(1);
  });
});

describe('the listener', () => {
  it('is not added with no DSN', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const listen = vi.spyOn(document, 'addEventListener');
    await install('/');
    dispatchViolation();

    expect(installed).toBeNull();
    expect(listen).not.toHaveBeenCalledWith('securitypolicyviolation', expect.anything());
  });

  it('is taken off by remove', async () => {
    await install('/');
    installed!.remove();
    dispatchViolation();
    await installed!.flush();

    expect(sent).toEqual([]);
  });
});
