import type { App } from 'vue';
import type { Router } from 'vue-router';
import type { ErrorTrackingClient, Transport } from '@/utils/errorTrackingClient';

/**
 * The front end's errors reach Sentry when the build sets `VITE_SENTRY_DSN`, and only what ADR 0049
 * allows (docs/implementation/modules/error-tracking.md).
 *
 * This module is in the entry chunk, so it stays small: it catches each error and each policy
 * violation, notes the route it happened on and queues it. The SDK is in `errorTrackingClient.ts`, reached only by the `import()`
 * below, which a build with no DSN drops with the branch around it, so that build has no Sentry
 * chunk at all. The client is loaded after the first paint, or at the first error, whichever comes
 * first.
 */

/** How an error was caught, which an event names. */
export type CaughtBy = 'vue' | 'onerror' | 'unhandledrejection' | 'csp';

/** The route an error happened on: its pattern, its name and the two variables an event may fill. */
export interface TrackedRoute {
  pattern: string | null;
  name: string | null;
  marketId: string | null;
  marketSlug: string | null;
}

/**
 * A Content-Security-Policy violation, reduced to what ADR 0049 allows of it as it is caught, so
 * the browser's event, its `sample` and the page's address with it, is never held.
 */
export interface TrackedViolation {
  /** The policy refused the load (`enforce`), or a report-only policy would have (`report`). */
  disposition: 'enforce' | 'report';
  /** The effective directive, as `script-src-elem`. */
  directive: string;
  /** The blocked resource's origin, or the browser's keyword for it (`inline`, `eval`, `data`). */
  blocked: string;
  /** The violating script's address with no query or fragment; `null` for the page itself. */
  sourceFile: string | null;
  /** The violation is in the page itself, an inline script or attribute, not a script file. */
  inPage: boolean;
  line: number | null;
  column: number | null;
}

/** One caught error or violation, as the client sends it. */
export type TrackedItem =
  | { error: unknown; caughtBy: Exclude<CaughtBy, 'csp'>; route: TrackedRoute }
  | { violation: TrackedViolation; caughtBy: 'csp'; route: TrackedRoute };

/** At most this many errors wait for the client to load; the rest are dropped. */
export const QUEUE_LIMIT = 10;

/** At most this many events are sent in one page load, so a page failing in a loop spends little. */
export const MAX_EVENTS_PER_PAGE = 20;

/**
 * The words each browser uses when a page's code could not be fetched, which `pageFailed.ts`
 * already answers; after every deploy some open tab meets it, so it is never sent.
 */
const PAGE_CODE_NOT_FETCHED = [
  'Failed to fetch dynamically imported module', // Chromium
  'Importing a module script failed', // Safari
  'error loading dynamically imported module', // Firefox
];

/** What a test may give in place of the SDK's transport and the chunk's import. */
export interface ErrorTrackingForTests {
  transport?: Transport;
  load?: () => Promise<typeof import('@/utils/errorTrackingClient')>;
}

/** What `installErrorTracking` installed, for a test to wait on and take away. */
export interface InstalledErrorTracking {
  /** Resolves once every error caught so far has been sent, or dropped. */
  flush(): Promise<void>;
  /** Removes the handlers and forgets the client. */
  remove(): void;
}

interface Tracker {
  load(): void;
}

let tracker: Tracker | null = null;

function routeOf(router: Router): TrackedRoute {
  const route = router.currentRoute.value;
  const param = (name: string) => {
    const value = route.params[name];
    return typeof value === 'string' ? value : null;
  };
  return {
    pattern: route.matched.at(-1)?.path ?? null,
    name: typeof route.name === 'string' ? route.name : null,
    marketId: param('marketId'),
    marketSlug: param('marketSlug'),
  };
}

/** A directive's or a keyword's spelling; anything else a browser puts there is not sent. */
const KEYWORD = /^[a-z][a-z-]*$/;

/**
 * A blocked resource reduced to its origin, or the browser's keyword for it (`inline`, `eval`,
 * `data`, `blob`), so its path and query, which may name a vendor or a token, are never held.
 */
function blockedOrigin(blockedURI: string): string {
  if (!blockedURI) return 'none';
  if (KEYWORD.test(blockedURI)) return blockedURI;
  try {
    const url = new URL(blockedURI);
    if (url.origin !== 'null') return url.origin;
    return url.host ? `${url.protocol}//${url.host}` : url.protocol.slice(0, -1);
  } catch {
    return 'unreadable';
  }
}

/** A script's address with no query or fragment, `null` if none or unreadable. */
function scriptAddress(sourceFile: string): string | null {
  if (!sourceFile) return null;
  try {
    const url = new URL(sourceFile);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function violationOf(event: SecurityPolicyViolationEvent): TrackedViolation {
  const source = scriptAddress(event.sourceFile);
  const page = `${window.location.origin}${window.location.pathname}`;
  const inPage = source === page;
  const position = (value: number) => (Number.isInteger(value) && value > 0 ? value : null);
  return {
    disposition: event.disposition === 'report' ? 'report' : 'enforce',
    directive: KEYWORD.test(event.effectiveDirective) ? event.effectiveDirective : 'unreadable',
    blocked: blockedOrigin(event.blockedURI),
    sourceFile: inPage ? null : source,
    inPage,
    line: position(event.lineNumber),
    column: position(event.columnNumber),
  };
}

function isPageCodeNotFetched(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return PAGE_CODE_NOT_FETCHED.some((words) => message.includes(words));
}

/**
 * Catch every error a component, a script or a promise lets go of, and every load the page's
 * Content-Security-Policy refuses; with no DSN nothing at all.
 * `main.ts` calls it before the router is installed, so an error in the first navigation is caught.
 */
export function installErrorTracking(
  app: App,
  router: Router,
  testing: ErrorTrackingForTests = {},
): InstalledErrorTracking | null {
  // Read here, not at import, so a test can stub it, and spelled out in each function rather
  // than in a helper: with no DSN the build folds this to `undefined` and drops the rest of the
  // function, the client's `import()` with it, which it does not do through a call.
  const configured = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!configured) return null;
  const dsn: string = configured;

  let queue: TrackedItem[] = [];
  let accepted = 0;
  let client: ErrorTrackingClient | null = null;
  let loading: Promise<void> | null = null;
  let off = false;
  const sending: Promise<void>[] = [];

  function load(): void {
    if (loading) return;
    const importClient = testing.load ?? (() => import('@/utils/errorTrackingClient'));
    loading = importClient()
      .then((module) => module.startErrorTrackingClient(dsn, testing.transport))
      .then((started) => {
        if (off) return;
        client = started;
        for (const item of queue) sending.push(started.send(item));
        queue = [];
      })
      .catch(() => {
        // The chunk could not be fetched (offline, or a deploy replaced it): tracking stays off
        // for this page load, and nothing is retried or thrown.
        off = true;
        queue = [];
      });
  }

  function track(error: unknown, caughtBy: Exclude<CaughtBy, 'csp'>): void {
    if (isPageCodeNotFetched(error)) return;
    accept({ error, caughtBy, route: routeOf(router) });
  }

  function accept(item: TrackedItem): void {
    if (off || accepted >= MAX_EVENTS_PER_PAGE) return;
    if (client) {
      accepted += 1;
      sending.push(client.send(item));
      return;
    }
    if (queue.length >= QUEUE_LIMIT) return;
    accepted += 1;
    queue.push(item);
    load();
  }

  const onError = (event: ErrorEvent) => track(event.error ?? event.message, 'onerror');
  const onRejection = (event: PromiseRejectionEvent) => track(event.reason, 'unhandledrejection');
  // One event a page load for each directive and blocked origin: a page that loads a refused
  // script on every render would otherwise spend its 20 on one violation.
  const violations = new Set<string>();
  const onViolation = (event: SecurityPolicyViolationEvent) => {
    const violation = violationOf(event);
    const key = `${violation.directive} ${violation.blocked}`;
    if (violations.has(key)) return;
    violations.add(key);
    accept({ violation, caughtBy: 'csp', route: routeOf(router) });
  };

  app.config.errorHandler = (error) => {
    // What Vue does with an error when no handler is set.
    console.error(error);
    track(error, 'vue');
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // The browser fires it on the document for every load the policy refuses, or would refuse.
  document.addEventListener('securitypolicyviolation', onViolation);
  tracker = { load };

  return {
    async flush() {
      await loading;
      await Promise.all(sending);
    },
    remove() {
      off = true;
      app.config.errorHandler = undefined;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('securitypolicyviolation', onViolation);
      tracker = null;
    },
  };
}

/**
 * Load the client once the page has first painted content. The shell paints nothing until its
 * session probe has answered, well after `mount`, so a frame after `mount` comes before that paint;
 * the browser's own `first-contentful-paint` entry says when it came, and `buffered` gives it even
 * if it came first. A browser with no paint timing waits one animation frame, then a task. With no
 * DSN, or before `installErrorTracking`, it does nothing. An error before then loads it at once.
 */
export function loadErrorTrackingAfterFirstPaint(): void {
  if (!import.meta.env.VITE_SENTRY_DSN?.trim() || !tracker) return;
  const { load } = tracker;
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('paint')
  ) {
    requestAnimationFrame(() => setTimeout(load, 0));
    return;
  }
  const observer = new PerformanceObserver((list) => {
    if (list.getEntriesByName('first-contentful-paint').length === 0) return;
    observer.disconnect();
    setTimeout(load, 0);
  });
  observer.observe({ type: 'paint', buffered: true });
}
