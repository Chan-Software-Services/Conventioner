/**
 * The test map's recording (T349): what each E2E test reached, written beside a normal run.
 *
 * On only when `TEST_MAP_OUT` names a directory, which CI's shards set on the nightly Test run
 * alone (or one started by hand); with it unset `withTheTestMap` hands back the `test` it was
 * given, so every other run, a pull request's, the merge queue's and a push's, is untouched.
 * When on, every spec's `test` (through `fixtures.ts`) also records, per test:
 *
 *  - every request each browser context makes under `/src/` (the app's modules, which Vite's dev
 *    server serves one by one, each at its file's path) and `/api/` (the pages' own API calls);
 *  - every call of an API request context (`request`, `page.request`, `context.request`,
 *    `playwright.request.newContext()`), which is how Node's helpers seed and read the stack, a
 *    call straight to the back end keyed as the dev server's proxy keys it;
 *  - the V8 block coverage of each page's `/src/` modules (through a DevTools session of its own,
 *    Chromium), as the stretches that ran, taken before a page or its context closes;
 *  - its start and end on the wall clock, so the build can audit the back end's own log
 *    (`docker compose logs --timestamps`) for request lines no test recorded.
 *
 * and appends one JSON line for it to `records-<workerIndex>.jsonl` in `TEST_MAP_OUT`, a file a
 * worker, so two workers' lines never interleave; a retry is a line of its own. What a worker's
 * contexts and calls reach between two of its tests (a `beforeAll` seeding, a worker fixture)
 * counts for no test: it is a `"between"` line of its own, with its window, which the build's
 * audit reads, since at two workers it reaches the back end inside the other worker's test.
 * `scripts/test_map.py build` turns the lines into the map
 * (`docs/implementation/testing/the-test-map.md`).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  test as playwrightTest,
} from '@playwright/test';

import { stack } from './stack';

type Range = { startOffset: number; endOffset: number; count: number };
type CoveredFunction = { ranges: readonly Range[] };
type Stretch = [number, number];

/**
 * The stretches of a module's source that ran, sorted and joined, from V8's block coverage of its
 * functions: each range counts its own executions, and a range inside another overrides it for its
 * own stretch, so a block that never ran is a hole in the function around it.
 */
export function coveredRanges(functions: readonly CoveredFunction[]): Stretch[] {
  const ranges = functions
    .flatMap((f) => f.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const out: Stretch[] = [];
  const ran = (start: number, end: number, count: number) => {
    if (end <= start || count <= 0) return;
    const last = out[out.length - 1];
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  };
  const open: Range[] = [];
  let at = 0;
  const close = () => {
    const done = open.pop()!;
    ran(at, done.endOffset, done.count);
    at = Math.max(at, done.endOffset);
  };
  for (const range of ranges) {
    while (open.length && open[open.length - 1]!.endOffset <= range.startOffset) close();
    if (open.length) ran(at, range.startOffset, open[open.length - 1]!.count);
    at = Math.max(at, range.startOffset);
    open.push(range);
  }
  while (open.length) close();
  return out;
}

function union(a: readonly Stretch[], b: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const [start, end] of [...a, ...b].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * What a request counts as: an app module by its path (`/src/App.vue`), an API call by its method
 * and path (`GET /api/markets/m-1`), each without its query; anything else, null. A URL at
 * `backendOrigin`, the back end's own address, is an API call keyed at `/api` and its path, as the
 * dev server's proxy, which takes `/api` off, keys the same call from a page.
 */
export function requestKey(method: string, url: string, backendOrigin?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  if (backendOrigin !== undefined && parsed.origin === backendOrigin) {
    return `${method} /api${path}`;
  }
  if (path.startsWith('/src/')) return path;
  if (path.startsWith('/api/')) return `${method} ${path}`;
  return null;
}

/** The file a worker appends its records to, in the `TEST_MAP_OUT` directory. */
export function recordsFile(dir: string, workerIndex: number): string {
  return join(dir, `records-${workerIndex}.jsonl`);
}

type Recording = { requests: Set<string>; coverage: Map<string, Stretch[]> };
type Between = { start: number; requests: Set<string> };

/** The test running now, in this worker; null between tests. */
let recording: Recording | null = null;
/** What this worker reaches between two of its tests, once it records; null in a test. */
let between: Between | null = null;

/** Where a request made now counts: the running test, else the stretch between tests. */
function counting(): { requests: Set<string> } | null {
  return recording ?? between;
}

/** Starts the stretch between two tests (or before the first), which counts for no test. */
export function startBetween(): Between {
  between = { start: Date.now(), requests: new Set() };
  return between;
}

/** Ends the stretch between tests, handing it back. */
export function endBetween(): Between | null {
  const ended = between;
  between = null;
  return ended;
}

/** Starts recording a test, which every request from here on counts for. */
export function startRecording(): Recording {
  recording = { requests: new Set(), coverage: new Map() };
  return recording;
}

/** Ends the test's recording, handing it back; nothing counts for a test until the next starts. */
export function endRecording(): Recording | null {
  const ended = recording;
  recording = null;
  return ended;
}

const started = new WeakSet<Page>();
const stopped = new WeakSet<Page>();
const attached = new WeakSet<BrowserContext>();
const patched = new WeakSet<Browser>();
/** The contexts attached during the running test, so a context it never closed is read too. */
let contexts = new Set<BrowserContext>();

/**
 * Each recording page's own DevTools session, which its V8 coverage is taken through.
 *
 * Not `page.coverage`: Playwright's fetches the source of every script the page parses, as it is
 * parsed, and keeps it to hand back at the end. Vite's dev server serves each module as a script
 * of its own, so a page load is hundreds of those round trips: a run recorded through it took some
 * 40% longer in CI than one that recorded nothing, and a test of twenty page loads overran its 30
 * seconds. The map reads only each script's address and the blocks that ran, so this session asks
 * for nothing else.
 */
const sessions = new WeakMap<Page, CDPSession>();

async function startPage(page: Page) {
  if (started.has(page)) return;
  started.add(page);
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    // With the debugger off, V8 counts some functions only whole, so a block in them that never ran
    // (an untaken `catch`, an early `return`) reads as run; on, it counts every block, as
    // `page.coverage` did. Skipping pauses keeps a `debugger;` statement from stopping the page.
    await session.send('Debugger.enable');
    await session.send('Debugger.setSkipAllPauses', { skip: true });
    sessions.set(page, session);
  } catch {
    // A page closing as it opens has nothing to record.
  }
  const close = page.close.bind(page);
  page.close = async (options) => {
    await stopPage(page);
    return close(options);
  };
}

async function stopPage(page: Page) {
  const session = sessions.get(page);
  if (!session || stopped.has(page) || page.isClosed()) return;
  stopped.add(page);
  let entries: { url: string; functions: CoveredFunction[] }[];
  try {
    ({ result: entries } = await session.send('Profiler.takePreciseCoverage'));
    await session.send('Profiler.stopPreciseCoverage');
    await session.detach();
  } catch {
    return; // the page or its context went first
  }
  const into = recording;
  if (!into) return;
  for (const entry of entries) {
    const path = requestKey('GET', entry.url);
    if (!path?.startsWith('/src/')) continue;
    // A style module is a script of its own at the same path, with offsets into its own source.
    const key = new URL(entry.url).search.includes('type=style') ? `${path}?style` : path;
    into.coverage.set(key, union(into.coverage.get(key) ?? [], coveredRanges(entry.functions)));
  }
}

async function stopContext(context: BrowserContext) {
  await Promise.all(context.pages().map((page) => stopPage(page)));
}

function attach(context: BrowserContext) {
  contexts.add(context);
  if (attached.has(context)) return;
  attached.add(context);
  context.on('request', (request) => {
    const key = requestKey(request.method(), request.url());
    const into = counting();
    if (key && into) into.requests.add(key);
  });
  context.on('page', (page) => void startPage(page));
  for (const page of context.pages()) void startPage(page);
  const close = context.close.bind(context);
  context.close = async (options) => {
    await stopContext(context);
    return close(options);
  };
}

function patchBrowser(browser: Browser) {
  if (patched.has(browser)) return;
  patched.add(browser);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    attach(context);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await newPage(options);
    attach(page.context());
    await startPage(page);
    return page;
  };
}

type Fetch = APIRequestContext['fetch'];
const wrapped = new WeakSet<object>();
/** The back end's own address, at which an API call keys as the proxy keys it. */
let backEnd: string | undefined;

/**
 * Counts every call of the API request context class that `context` is one of for the test
 * running when the call started, or for the stretch between tests, keyed by its response's URL
 * (`requestKey`, at `backendOrigin`).
 *
 * The class's `get`, `post`, `put`, `patch`, `delete` and `head` all call its `fetch` (Playwright
 * 1.65; `theTestMapRecords.test.ts` fails should `get` or `post` stop doing so), so wrapping that
 * once counts every context's calls, the `request` fixture's, `page.request`'s and each
 * `playwright.request.newContext()`'s alike. A call that throws counts for none, and one started
 * with no test running counts for no test, only for the stretch between tests when one is open;
 * one answered after its test ended counts for the test it started in.
 */
export function recordApiCalls(context: APIRequestContext, backendOrigin: string): void {
  backEnd = new URL(backendOrigin).origin;
  const prototype = Object.getPrototypeOf(context) as { fetch: Fetch };
  if (wrapped.has(prototype)) return;
  wrapped.add(prototype);
  const fetch = prototype.fetch;
  prototype.fetch = async function (
    this: APIRequestContext,
    urlOrRequest,
    options,
  ): Promise<APIResponse> {
    const into = counting();
    const response = await fetch.call(this, urlOrRequest, options);
    const method =
      options?.method ?? (typeof urlOrRequest === 'string' ? 'GET' : urlOrRequest.method());
    const key = requestKey(method.toUpperCase(), response.url(), backEnd);
    if (key && into) into.requests.add(key);
    return response;
  };
}

type Test = typeof playwrightTest;

/** Appends what a worker reached between two of its tests, unless it reached nothing. */
function appendBetween(file: string, ended: Between | null) {
  if (!ended?.requests.size) return;
  const line = { between: true, start: ended.start, end: Date.now() };
  appendFileSync(file, `${JSON.stringify({ ...line, requests: [...ended.requests].sort() })}\n`);
}

/** `base`, recording the test map into `TEST_MAP_OUT` when it is set, else `base` itself. */
export function withTheTestMap(base: Test): Test {
  const out = process.env.TEST_MAP_OUT;
  if (!out) return base;
  mkdirSync(out, { recursive: true });
  return base.extend<{ testMapRecording: void }, { testMapBrowser: void; testMapApiCalls: void }>({
    testMapBrowser: [
      async ({ browser }, use) => {
        patchBrowser(browser);
        await use();
      },
      { scope: 'worker', auto: true },
    ],
    testMapApiCalls: [
      async ({ playwright }, use, workerInfo) => {
        // The back end's address as `fixtures.ts` reads it, once the worker runs.
        const backendOrigin = process.env.BACKEND_URL || stack().backendURL;
        const context = await playwright.request.newContext();
        recordApiCalls(context, backendOrigin);
        await context.dispose();
        startBetween();
        await use();
        // After the last test's `afterAll`.
        appendBetween(recordsFile(out, workerInfo.workerIndex), endBetween());
      },
      { scope: 'worker', auto: true },
    ],
    testMapRecording: [
      async ({}, use, testInfo) => {
        const file = recordsFile(out, testInfo.workerIndex);
        appendBetween(file, endBetween());
        startRecording();
        contexts = new Set();
        const start = Date.now();
        await use();
        await Promise.all([...contexts].map((context) => stopContext(context)));
        const end = Date.now();
        const mine = endRecording()!;
        startBetween();
        appendFileSync(
          file,
          `${JSON.stringify({
            spec: testInfo.titlePath[0],
            title: testInfo.titlePath.slice(1).join(' › '),
            status: testInfo.status,
            retry: testInfo.retry,
            start,
            end,
            requests: [...mine.requests].sort(),
            coverage: Object.fromEntries(mine.coverage),
          })}\n`,
        );
      },
      { auto: true },
    ],
    context: async ({ context }, use) => {
      attach(context);
      await use(context);
      await stopContext(context);
    },
  });
}
