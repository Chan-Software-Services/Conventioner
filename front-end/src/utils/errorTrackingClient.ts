import {
  BrowserClient,
  Scope,
  dedupeIntegration,
  defaultStackParser,
  linkedErrorsIntegration,
  makeFetchTransport,
  type ErrorEvent,
  type Event,
  type EventHint,
  type Exception,
  type StackFrame,
} from '@sentry/browser';
import type { TrackedItem, TrackedRoute, TrackedViolation } from '@/utils/errorTracking';

/**
 * The SDK's side of the front end's error tracking (docs/implementation/modules/error-tracking.md),
 * reached only by `errorTracking.ts`'s `import()`, so it and the SDK are a chunk of their own that
 * a page loads after it has painted, or at its first error.
 *
 * It makes a client and a scope of its own rather than the SDK's global `init`, so nothing else in
 * the page reports through it, and turns off every integration but linking a cause to its error and
 * dropping a repeat: no breadcrumbs, no console capture, no handlers of its own, no sessions, no
 * HTTP context. Every event is built from ADR 0049's allowlist by `allowedEvent`, field by field,
 * so a field a later SDK adds to the event is never sent; only what the SDK adds to `sdk` as it
 * writes the envelope (its integrations, packages and settings) goes with it, as the ADR allows.
 */

/** The transport `BrowserClient` takes, which a test replaces with one that records. */
export type Transport = NonNullable<ConstructorParameters<typeof BrowserClient>[0]['transport']>;

export interface ErrorTrackingClient {
  /**
   * Sends one caught error, or a policy violation as a warning titled by `violationTitle`;
   * resolves once it is sent or dropped, and never rejects.
   */
  send(item: TrackedItem): Promise<void>;
}

/** How long `send` waits for its event to leave. */
const SEND_TIMEOUT_MS = 2000;

/** An error's message is cut here, after its addresses are replaced. */
export const MESSAGE_LIMIT = 300;

/**
 * An address, by the rule the back end's `error_tracking.ADDRESS` keeps: a run with no space, `@`,
 * `/`, `<`, `>`, quote, comma or semicolon, then `@`, then a host with at least one dot.
 */
const ADDRESS = /[^\s@/<>"',;]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** A URL's query and fragment, which may hold a token or an address. */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

/** `text` with every address replaced and every URL's query taken off. */
export function withoutAddresses(text: string): string {
  return text.replace(URL_QUERY, '$1').replace(ADDRESS, '[address]');
}

function message(text: string | undefined): string | undefined {
  return text === undefined ? undefined : withoutAddresses(text).slice(0, MESSAGE_LIMIT);
}

/** The route's pattern with only `marketId` and `marketSlug` filled in. */
function routePath(route: TrackedRoute): string | null {
  if (!route.pattern) return null;
  const filled = route.pattern.replace(
    /:(marketId|marketSlug)(?:\([^)]*\))?[?*+]?/g,
    (pattern, name: 'marketId' | 'marketSlug') =>
      route[name] === null ? pattern : encodeURIComponent(withoutAddresses(route[name]!)),
  );
  return filled;
}

/** `text` with its percent-escapes read, so an escaped address is found too. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A violation's title, which Sentry groups its events by: one issue per directive and origin. */
export function violationTitle(violation: TrackedViolation): string {
  const verb = violation.disposition === 'report' ? 'would block' : 'blocked';
  return `Content-Security-Policy ${verb} ${violation.directive} from ${violation.blocked}`;
}

/**
 * Where the violation happened: the script's address, or the page's route for the page itself,
 * and its line and column; `null` when the browser named no file.
 */
function violationContext(item: TrackedItem & { caughtBy: 'csp' }): Record<string, unknown> | null {
  const { violation } = item;
  const path = routePath(item.route);
  const sourceFile = violation.inPage
    ? path === null
      ? null
      : `${window.location.origin}${path}`
    : violation.sourceFile === null
      ? null
      : withoutAddresses(decoded(violation.sourceFile));
  // A line and a column say nothing without the file they are in.
  if (sourceFile === null) return null;
  return {
    source_file: sourceFile,
    ...(violation.line !== null ? { line: violation.line } : {}),
    ...(violation.column !== null ? { column: violation.column } : {}),
  };
}

function allowedFrame(frame: StackFrame): StackFrame {
  return {
    filename: frame.filename === undefined ? undefined : withoutAddresses(frame.filename),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

function allowedException(value: Exception): Exception {
  const frames = value.stacktrace?.frames;
  return {
    type: value.type,
    value: message(value.value),
    ...(frames ? { stacktrace: { frames: frames.map(allowedFrame) } } : {}),
  };
}

function definedTags(tags: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).flatMap(([key, value]) =>
      value === null ? [] : [[key, withoutAddresses(value)]],
    ),
  );
}

/**
 * The event ADR 0049 allows, built anew from the SDK's and the item it was caught as; a policy
 * violation adds its directive and blocked origin as tags and where it happened as a context.
 */
export function allowedEvent(event: Event, item: TrackedItem): ErrorEvent {
  const path = routePath(item.route);
  // A violation's stack, which the browser client attaches to a message, is only the tracker's.
  const values = item.caughtBy === 'csp' ? undefined : event.exception?.values;
  const context = item.caughtBy === 'csp' ? violationContext(item) : null;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    ...(values ? { exception: { values: values.map(allowedException) } } : {}),
    ...(event.message !== undefined ? { message: message(event.message) } : {}),
    ...(path !== null
      ? { request: { url: `${window.location.origin}${path}` }, transaction: item.route.pattern! }
      : {}),
    tags: definedTags({
      caught_by: item.caughtBy,
      route_name: item.route.name,
      market_id: item.route.marketId,
      market_slug: item.route.marketSlug,
      ...(item.caughtBy === 'csp'
        ? { csp_directive: item.violation.directive, csp_blocked: item.violation.blocked }
        : {}),
    }),
    ...(context !== null ? { contexts: { violation: context } } : {}),
    environment: event.environment,
    ...(event.release ? { release: event.release } : {}),
    ...(event.sdk ? { sdk: { name: event.sdk.name, version: event.sdk.version } } : {}),
  };
}

/** The commit this build was made from, from its `version.json`, or none if it cannot be read. */
async function buildCommit(): Promise<string | undefined> {
  try {
    const answer = await fetch('/version.json', { cache: 'no-store' });
    if (!answer.ok) return undefined;
    const { commit } = (await answer.json()) as { commit?: unknown };
    return typeof commit === 'string' && commit ? commit : undefined;
  } catch {
    return undefined;
  }
}

/** Makes the client, which reads the release once before sending anything. */
export async function startErrorTrackingClient(
  dsn: string,
  transport: Transport = makeFetchTransport,
): Promise<ErrorTrackingClient> {
  const release = await buildCommit();
  const client = new BrowserClient({
    dsn,
    release,
    environment: import.meta.env.MODE,
    transport,
    stackParser: defaultStackParser,
    // A client made by hand has no integrations but these, unlike the SDK's `init`.
    integrations: [linkedErrorsIntegration(), dedupeIntegration()],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    sendClientReports: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event: ErrorEvent, hint: EventHint) =>
      hint.data ? allowedEvent(event, hint.data as TrackedItem) : null,
  });
  const scope = new Scope();
  scope.setClient(client);
  client.init();

  return {
    async send(item) {
      if (item.caughtBy === 'csp') {
        scope.captureMessage(violationTitle(item.violation), 'warning', { data: item });
      } else {
        scope.captureException(item.error, { data: item });
      }
      try {
        await client.flush(SEND_TIMEOUT_MS);
      } catch {
        // An event that could not be sent is lost, never retried.
      }
    },
  };
}
