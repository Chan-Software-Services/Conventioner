---
layer: implementation
kind: module
describes:
  - back-end/error_tracking.py
  - back-end/tests/test_the_error_tracker_is_sent_no_value.py
  - front-end/src/utils/errorTracking.ts
  - front-end/src/utils/errorTrackingClient.ts
  - front-end/src/__tests__/theErrorTrackerIsSentNoValue.test.ts
  - front-end/src/__tests__/theBuildChecksItsErrorTrackerDsn.test.ts
  - front-end/src/__tests__/aPolicyViolationReachesTheErrorTracker.test.ts
  - front-end/src/__tests__/support/recordedEnvelopes.ts
verified: 2026-11-25
sources:
  - T255
  - T584
---

# Error tracking

The back end sends its errors to Sentry when `SENTRY_DSN` is set, and the front end when its build sets `VITE_SENTRY_DSN`, each to a Sentry project of its own and only what [ADR 0049](../../adr/0049-what-may-be-sent-to-the-error-tracker.md) allows.
With no DSN, nothing here changes how the app runs.

## The back end

[`back-end/error_tracking.py`](../../../back-end/error_tracking.py) is the only back-end file that imports `sentry_sdk`, and only once `start()` has found a DSN: importing the SDK costs Active CPU on every cold start.

- `start()` reads `SENTRY_DSN` through `configured_secret`, so a blank or published placeholder is no DSN and it returns having imported nothing.
  A DSN the SDK cannot read logs one warning naming `SENTRY_DSN` and the exception's type, and tracking stays off: the DSN is optional, so it never stops a boot.
  A second call does nothing.
  `app.py` calls it right after `logging.basicConfig`, before the first boot check.
- `install(app)` adds the `after_request` flush, whether or not tracking is on; `app.py` calls it beside `install_error_answers`.
- `report(error)` sends one exception; `client_errors.answer_unexpected` calls it for every 500, before it logs.
- `NAMED_VIEW_ARGS` (`market_id`, `market_slug`, `org_id`) is the one list of URL variables an event or a log line may name; `client_errors` logs a 500 by it too, so the two never differ.
- `FLUSH_TIMEOUT_SECONDS`, 2, bounds the wait for a request's events.
- `stop()` is the tests': it closes the client, removes the handler and forgets the start.

**Where each event starts.**
An unexpected exception is `report()`'s one event: with a handler registered for `Exception`, Flask never sends `got_request_exception`, so the Flask integration never sees one, and the `client_errors` logger is ignored for events, so its log line is not a second.
A warning or error log line is an event, captured by a root handler at `WARNING`; the `/healthz` 503's `logger.exception` is one, of level `error`, with the exception's type and no message.
An informational line is a breadcrumb on the next event.
`werkzeug`'s request lines, which carry paths, queries and addresses, are never either.

**Sent before the response leaves.**
Vercel freezes a function once it has answered, so `before_send` marks the request (`g.error_tracked`) and the `after_request` flush sends its events, waiting at most `FLUSH_TIMEOUT_SECONDS`; Flask runs it for an error handler's 500 too.
A request with no event never calls flush, so it pays nothing.
An event that cannot be sent in time is lost, never retried.

**A boot refusal is sent before its import fails.**
Each boot check logs at `CRITICAL` and raises, and nothing in the process runs after.
sentry-sdk 3.0's logging hook captures a line only after the logger's own handlers have run, so a flush in a handler beside it would find nothing queued; the root handler, a subclass of the SDK's `EventHandler`, captures the line itself and then flushes when it is `CRITICAL`.
The SDK's `LoggingIntegration` is kept for breadcrumbs alone (`event_level=None`), and `level=None` keeps Sentry Logs off.

**Every event is built from the allowlist** (`_allowed_event`), never trimmed from the SDK's: the exception's type, module and frames (file, module, function, line, whether in the app), the log line's template and formatted words with every address replaced (`without_addresses`), its level and logger, log breadcrumbs under the same rule, the request's method and the route's rule with only the named variables filled in, those as tags, the rule as the transaction, and the environment (`VERCEL_ENV`, else `development`), the release (`BUILD_COMMIT`, when set) and the SDK's name and version.
The SDK's own `data_collection` is set to collect nothing as well, and the integrations that switch themselves on for an installed library are off, so pymongo's query breadcrumbs never start.
`trace_propagation_targets=[]` keeps the SDK's `sentry-trace` and `baggage` headers off every request the back end makes to Resend, Discord, Google or TypeSafe, which by default would carry the release and the environment.

**The suite never sends.**
`tests/conftest.py` removes `SENTRY_DSN` before anything imports the app, so a developer's exported DSN reaches no test.
[`back-end/tests/test_the_error_tracker_is_sent_no_value.py`](../../../back-end/tests/test_the_error_tracker_is_sent_no_value.py) starts the tracker with a fixture DSN and a transport that records every envelope item and holds it until flushed, drives the real app's test client and real log lines, and searches every item for a fixture address, answer and token; it also proves the flushes, the one event per 500 and per 503, that no item but an event is ever sent, and that with no DSN a fresh process never imports the SDK.

## The front end

Two modules, so the SDK never weighs on the first page.
[`front-end/src/utils/errorTracking.ts`](../../../front-end/src/utils/errorTracking.ts) is in the entry chunk: it catches each error, notes the route, and queues it.
[`front-end/src/utils/errorTrackingClient.ts`](../../../front-end/src/utils/errorTrackingClient.ts) holds `@sentry/browser` and is reached only by the first module's `import()`, so it and the SDK are a chunk of their own, about 21 KB gzipped, never the entry and never a `modulepreload` of `index.html`.

- `installErrorTracking(app, router)` sets Vue's `app.config.errorHandler` (which still calls `console.error`, as Vue's default does), adds `error` and `unhandledrejection` listeners on `window`, and a `securitypolicyviolation` listener on `document`.
  `main.ts` calls it before `app.use(router)`, so an error in the first navigation is caught.
  Each error becomes an item: the error, how it was caught (`vue`, `onerror`, `unhandledrejection`), and the route at that moment (its pattern, its name, `marketId` and `marketSlug`).
- **A policy violation** becomes an item caught as `csp`, reduced as it is caught (`violationOf`), so the browser's event, its `sample` and the page's address with it, is never held: the effective directive, the blocked resource's origin or the browser's keyword for it (`inline`, `eval`, `data`; `none` for an empty one, `unreadable` for anything else), whether the policy blocked it (`enforce`) or a report-only one would have (`report`), the script's address with no query or fragment, or a mark that it is the page itself, and its line and column.
  The browser fires the event for every refused load, so the first of each pair of directive and blocked origin in a page load is kept and the rest dropped before they are queued; each kept one counts toward the 20.
- `loadErrorTrackingAfterFirstPaint()`, called after `app.mount`, loads the client once the browser reports its `first-contentful-paint`, then one task later.
  The shell paints nothing until its session probe has answered, well after `mount`, so a frame after `mount` came before the paint in a walk of the build; a browser with no paint timing waits one frame and a task instead.
  An error loads the client at once, whichever comes first.
- Both read `VITE_SENTRY_DSN` where they are called, spelled out in each rather than in a helper: a build with no DSN folds the check to `undefined` and drops the rest of each function, the `import()` with it, which it does not do through a call; such a build has no Sentry chunk and installs nothing.
- **The caps.** At most `QUEUE_LIMIT`, 10, items wait for the client, and at most `MAX_EVENTS_PER_PAGE`, 20, are sent in one page load; the rest are dropped, so a page failing in a loop spends little of the month's quota.
- **The failed fetch of a page's code is never sent**: Chromium's, Safari's and Firefox's words for it are dropped before they are queued, since `pageFailed.ts` already answers it and every deploy makes some open tab meet it.
- **A chunk that cannot be fetched** (offline, or a deploy replaced it) leaves tracking off for that page load: the queue is dropped, nothing is retried, and nothing is thrown.

**The client** makes a `BrowserClient` and a `Scope` of its own, never the SDK's global `init`, so nothing else in the page reports through it.
A client made by hand has no integrations but those it is given: `linkedErrorsIntegration` and `dedupeIntegration`, so no breadcrumbs, no console capture, no handlers of the SDK's own, no sessions, no HTTP context, and no instrumentation of the page's `fetch` or `XMLHttpRequest`, so the app's own requests carry no `sentry-trace` or `baggage` header.
Its `dataCollection` collects nothing, `sendClientReports` is off, and `beforeBreadcrumb` drops every breadcrumb.
It reads `/version.json` once for the release, none if that fails, and sends each item, flushing it at once.
`beforeSend` builds the event anew from the allowlist (`allowedEvent`): the exception's type, its message through `withoutAddresses` (the back end's address rule, and every URL's query taken off) cut at `MESSAGE_LIMIT`, 300, the frames' file, function, line, column and whether in the app, the route's pattern with only `marketId` and `marketSlug` filled in on the page's origin as the request's URL and the pattern as the transaction, `caught_by`, `route_name`, `market_id` and `market_slug` as tags, and the environment (`import.meta.env.MODE`), the release and the SDK's name and version.
A violation is sent with `captureMessage` as a `warning` titled `Content-Security-Policy blocked <directive> from <origin>` (`would block` under a report-only policy, `violationTitle`), so Sentry makes one issue of each pair; `allowedEvent` gives it no exception (the SDK's attached stack is only the tracker's own frames), `csp_directive` and `csp_blocked` as tags, and a `violation` context with the script's `source_file` (with every address replaced, and for a violation in the page itself the route's filled pattern on the page's origin), `line` and `column`, none of them when the browser named no file.
`location.href`, which holds a reset token or a vendor's address on some pages, is never read.

**The build checks the DSN.**
`assertErrorTrackerDsn` in [`front-end/vite.config.ts`](../../../front-end/vite.config.ts), beside the other build checks, fails a set `VITE_SENTRY_DSN` that is not `https://<key>@<host>/<project id>`, or whose host no `connect-src` source of `vercel.json`'s policy allows (an exact host, or a `*.` pattern matched as the policy matches it), naming the variable; the policy allows `https://*.ingest.us.sentry.io`, Sentry's US region.
So the DSN, the chunk and the policy agree by construction, and a mismatch fails a build rather than every event.

**How it is tested.**
[`theErrorTrackerIsSentNoValue.test.ts`](../../../front-end/src/__tests__/theErrorTrackerIsSentNoValue.test.ts) installs the tracker on a real app and router in happy-dom with `VITE_SENTRY_DSN` stubbed and the transport replaced, through `installErrorTracking`'s test-only third argument, by one that records each envelope; it proves one event per caught error, an error before the client loaded sent once it has, no address, token or query of the page's address or the message in any envelope, the event's exact fields, the caps, the after-deploy words, the rejected chunk, the load after the first paint, and nothing installed with no DSN.
[`aPolicyViolationReachesTheErrorTracker.test.ts`](../../../front-end/src/__tests__/aPolicyViolationReachesTheErrorTracker.test.ts) dispatches the event the browser would, built by hand since happy-dom has none, and proves one warning with the directive, the origin and the exact fields, no `sample`, blocked address, page address or query in any envelope, each keyword's reduction, one event for five repeats and one for each directive and origin, the count toward the 20, and no listener with no DSN.
Both read what was sent through [`support/recordedEnvelopes.ts`](../../../front-end/src/__tests__/support/recordedEnvelopes.ts), a transport that records each envelope.
[`theBuildChecksItsErrorTrackerDsn.test.ts`](../../../front-end/src/__tests__/theBuildChecksItsErrorTrackerDsn.test.ts) loads `vite.config.ts` as a build does with a blank, a US, a malformed and an unallowed DSN.
A DSN in a test is built from its parts (`` `https://${KEY}@...` ``), so no line reads as an email address to the real-data hooks.

## Why

- [ADR 0049](../../adr/0049-what-may-be-sent-to-the-error-tracker.md): what may be sent, and why each field.
- [An exception never reaches a client](../conventions/an-exception-never-reaches-a-client.md): the one 500, and no log line carrying an exception's message.
- [Operations](../../OPERATIONS.md#setting-up-sentry): the DSNs, and setting Sentry up.
