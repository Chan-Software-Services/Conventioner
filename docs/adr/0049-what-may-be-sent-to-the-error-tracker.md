---
layer: implementation
kind: adr
describes:
  - back-end/error_tracking.py
  - front-end/src/utils/errorTrackingClient.ts
verified: 2026-11-25
sources:
  - T255
  - T584
status: accepted
---

# What may be sent to the error tracker

## Context

When something broke in production nobody heard of it: a 500 left one log line, which Vercel's Hobby plan keeps for about an hour, the paths that log and go on said nothing to anybody, and an error in a browser went only to that browser's console.
Sentry's Developer plan keeps an error for 30 days, groups repeats and emails Daniel about a new one, so the back end and the front end each send their errors to a Sentry project of their own, in Sentry's US region.

What reaches Sentry leaves Conventioner, as what reaches TypeSafe does ([ADR 0007](0007-what-may-be-sent-to-hosted-typesafe.md)), and the requests an error happens in carry what [ADR 0018](0018-what-of-an-applicants-answers-the-market-may-keep.md) keeps on the market alone: an applicant's answers and address.
A vendor's address is in some of the app's own addresses (`/markets/<id>/payments/<address>`, `?vendor=<address>`), a password-reset or verification token in others (`?token=`), and an exception's message may quote whatever a library was given.
The SDKs' defaults send all of it: sentry-sdk 3.0's collect the signed-in person, every stack frame's variables and source lines, and send every log line from INFO up as a Sentry Log, the user agent with it.

## Decision

**An event is built from the allowlist below, field by field, never by deleting what an SDK added, so a field a later SDK adds is dropped until this ADR allows it.**

The back end may send:

- the exception's qualified type, never its message, the rule its logs already keep ([an exception never reaches a client](../implementation/conventions/an-exception-never-reaches-a-client.md)), for each exception it was chained from too;
- each frame's file, module, function, line number and whether it is the app's;
- the request's method, and the route's rule (`/markets/<market_id>/payments/<path:vendor_email>`) with only `market_id`, `market_slug` and `org_id` filled in, those three values also as tags;
- a log line's words, template and formatted, with every address replaced by `[address]`, its level and its logger's name;
- an informational log line as a breadcrumb under the same rule;
- the environment, the release (the build's commit) and the SDK's name and version.

The front end may send:

- the error's type, and its message with every address replaced and every URL's query and fragment taken off, cut at 300 characters: a browser's error is nearly always a `TypeError`, unreadable without its words, and the front end's errors quote no library's input as the back end's may;
- each frame's file address (the built chunk), function, line and column, and whether it is the app's;
- the route's pattern (`/markets/:marketId/vendors`) with only `marketId` and `marketSlug` filled in, as the request's URL on the page's origin, the pattern itself as the transaction, and the route's name, `marketId` and `marketSlug` as tags, an address in either replaced;
- how the error was caught (`vue`, `onerror`, `unhandledrejection`, `csp`), as a tag;
- the environment (the build's mode), the release (the build's commit, from its `version.json`), and the SDK's name and version, with the packages and settings the SDK adds as it writes the envelope, `infer_ip: never` among them;
- for a Content-Security-Policy violation, as a warning: the effective directive, the blocked resource reduced to its origin (or the browser's own keyword, as `inline`, `eval` or `data`), whether the policy blocked it or a report-only policy only would have, the violating script's address without its query or fragment and with every address replaced (the page's route pattern, filled as above, when the violation is in the page itself), and its line and column; never the stack the SDK attaches to a message, which is only the tracker's own.

Neither side ever sends a request or response body, a query string, a cookie, a header, the signed-in person or any user field, an IP address, a variable, an exception frame's source lines, a breadcrumb that is not a log line, a value of a URL variable other than the named ones, or a violation's `sample`, which may hold a script's first characters.
Nor does a request the back end makes to another service carry anything of the tracker: the SDK's `sentry-trace` and `baggage` headers, which name the release and the environment, are never attached.

**An address** is any run of characters with no space, `@`, `/`, `<`, `>`, quote, comma or semicolon, then `@`, then a host with at least one dot; both sides replace it by the same rule.

**The DSN is optional, never a boot or a build requirement.**
`SENTRY_DSN` is read through `configured_secret` like `TYPESAFE_API_KEY`, so a blank or published placeholder is none, and none means the back end never imports the SDK; with no `VITE_SENTRY_DSN` a front-end build has no Sentry chunk at all.
A DSN's key is Sentry's public client key, which every browser that loads the front end receives anyway: it is not a secret.

## Consequences

- [`back-end/error_tracking.py`](../../back-end/error_tracking.py) is the only back-end file that imports `sentry_sdk`, and only once a DSN is set; it builds every event, and [the error tracking module](../implementation/modules/error-tracking.md) says where each kind of event starts and how it is sent before Vercel freezes the function.
- [`front-end/src/utils/errorTracking.ts`](../../front-end/src/utils/errorTracking.ts) catches the browser's errors and its policy violations, reducing a violation to the fields above as it is caught, and [`front-end/src/utils/errorTrackingClient.ts`](../../front-end/src/utils/errorTrackingClient.ts), a chunk of its own, builds and sends each event; with no `VITE_SENTRY_DSN` the build drops both.
- The front end's policy allows Sentry's US ingest hosts in `connect-src`, and a `VITE_SENTRY_DSN` on any other host fails the build.
- A log line's words are sent, so a warning or error line names what it means to say, never a value it was not written to name; no log line formats a library exception's message but the CSV import's `csv.Error`, whose words name a limit, never a cell, and [`test_no_log_line_carries_an_exceptions_message.py`](../../back-end/tests/test_no_log_line_carries_an_exceptions_message.py) fails one that does.
  A line that formats `traceback_without_messages`, as the floorplan upload's and deletion's do, carries the app's own code lines with its frames, which hold no value.
  A library's own warning and error lines are events too, their words sent with only every address replaced, and the guard reads only this repository's code: Flask-Session, for one, logs a session it could not serialise with its exception's message.
- Sentry keeps an event 30 days: what is sent outlives any log, so a new field is a change to this ADR first.
- An event that the allowlist leaves less readable is read with the code beside it: the frames say where, the rule says which route, and the tags say which market.
- Each Sentry project has "Prevent Storing of IP Addresses" ticked ([operations](../OPERATIONS.md#setting-up-sentry)), so Sentry's own ingestion records none either.

## Considered and rejected

- **The SDKs' defaults with a scrubber after them**: a denylist, which an SDK upgrade defeats by adding a field; the prototype's defaults sent a fixture address, answer, cookie and token through Sentry Logs, frame variables and the log entry's arguments.
- **Sentry's server-side data scrubbing alone**: it runs after the data has left Conventioner.
- **A front-end `report-uri` or `report-to` for policy violations**: a browser's report carries the page's whole address, its tokens and a vendor's address with it, and `vercel.json` is static, so it could not follow whether a DSN is set; the browser's `securitypolicyviolation` event, read by the tracker, is reduced before anything leaves.
- **The exception's message on the back end**: a library's message may quote the document it refused or the address it was given.
- **Sentry Logs, tracing, profiling, session replay**: none is needed to hear of an error, and each sends more of the request.

## Evidence

The back end's settings were prototyped against sentry-sdk 3.0.0 with a transport that recorded every envelope item: with the defaults, a fixture address, answer, cookie and token each reached an item; with these settings and the allowlist none did, while the exception's type, its frames and the route's rule did.
[`back-end/tests/test_the_error_tracker_is_sent_no_value.py`](../../back-end/tests/test_the_error_tracker_is_sent_no_value.py) holds the back end to that through the real app: the items a raising route, the health check and log lines make are serialised and searched for each fixture value.
[`front-end/src/__tests__/theErrorTrackerIsSentNoValue.test.ts`](../../front-end/src/__tests__/theErrorTrackerIsSentNoValue.test.ts) holds the front end to it the same way, through a real app and router: every envelope an error makes is searched for a fixture address and token in the page's address and the error's message.
[`front-end/src/__tests__/aPolicyViolationReachesTheErrorTracker.test.ts`](../../front-end/src/__tests__/aPolicyViolationReachesTheErrorTracker.test.ts) does the same for a violation, whose `sample`, blocked address and page address hold fixture values; a production build walked in Chromium with a script from an unallowed origin injected sent one such warning and none of them.
