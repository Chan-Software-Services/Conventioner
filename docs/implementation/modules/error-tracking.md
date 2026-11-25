---
layer: implementation
kind: module
describes:
  - back-end/error_tracking.py
  - back-end/tests/test_the_error_tracker_is_sent_no_value.py
verified: 2026-11-25
sources:
  - T255
  - T584
---

# Error tracking

The back end sends its errors to Sentry when `SENTRY_DSN` is set, and only what [ADR 0049](../../adr/0049-what-may-be-sent-to-the-error-tracker.md) allows.
With no DSN, nothing here changes how the app runs.

## The back end

[`back-end/error_tracking.py`](../../../back-end/error_tracking.py) is the only back-end file that imports `sentry_sdk`, and only inside `start()` once a DSN is set: importing the SDK costs Active CPU on every cold start.

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

## Why

- [ADR 0049](../../adr/0049-what-may-be-sent-to-the-error-tracker.md): what may be sent, and why each field.
- [An exception never reaches a client](../conventions/an-exception-never-reaches-a-client.md): the one 500, and no log line carrying an exception's message.
- [Operations](../../OPERATIONS.md#setting-up-sentry): the DSNs, and setting Sentry up.
