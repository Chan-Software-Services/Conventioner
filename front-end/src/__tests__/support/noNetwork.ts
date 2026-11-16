/**
 * A happy-dom unit test makes no network call.
 *
 * happy-dom sends a request a test leaves unstubbed for real, to its page's address,
 * `http://localhost:3000`, or to the app's `VITE_FLASK_HOST`, where nothing listens: the request
 * fails with an `ECONNREFUSED` that names no test, the screen under test reads it as a failed
 * request, and the test may still pass. The setup refuses each such request sent by XHR or `fetch`
 * instead, with an error that names it, and fails the test that sent it, or the file, for a request
 * sent after its last test.
 *
 * A navigation (`location.assign`, a link followed, a form submitted) goes past the refusal,
 * through happy-dom's own fetch: a test that navigates stubs it, as `pageFailed.ts`'s tests do. A
 * test that runs in Node (`@vitest-environment node`) has no window, and nothing here refuses its
 * `fetch`.
 */
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

export interface SentRequest {
  /** The method and the address, as the code under test asked for them. */
  request: string;
  /** The test that was running when it was sent, if one was. */
  test?: string;
}

let sent: SentRequest[] = [];
/** The test running now; `expect`'s own name outlives its test, into the next `beforeAll`. */
let running: string | undefined;

function refuse(method: string, url: unknown): Error {
  const request = `${method.toUpperCase()} ${String(url)}`;
  sent.push(running === undefined ? { request } : { request, test: running });
  return new Error(`a unit test sent ${request}: stub it`);
}

function refuseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const isRequest = typeof input === 'object' && 'url' in input;
  const method = init?.method ?? (isRequest ? input.method : 'GET');
  return Promise.reject(refuse(method, isRequest ? input.url : input));
}

/**
 * Refuse every request sent by XHR (axios's adapter here) or `fetch`, and fail each test that sent
 * one, and each file that sent one after its last test. For the setup to call, once a file.
 */
export function refuseRequests(): void {
  if (typeof window === 'undefined') return;
  const opened = new WeakMap<XMLHttpRequest, [string, string | URL]>();
  const xhr = window.XMLHttpRequest.prototype;
  const open = xhr.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
  xhr.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    opened.set(this, [method, url]);
    open.call(this, method, url, ...rest);
  } as XMLHttpRequest['open'];
  xhr.send = function (this: XMLHttpRequest) {
    const [method, url] = opened.get(this) ?? ['GET', '(unopened)'];
    throw refuse(method, url);
  };
  window.fetch = refuseFetch;
  globalThis.fetch = refuseFetch;

  beforeEach(() => {
    running = expect.getState().currentTestName;
  });
  afterEach(() => {
    running = undefined;
    failOnSentRequests();
  });
  afterAll(failOnSentRequests);
}

/** The requests refused since this was last called, emptied. */
export function takeSentRequests(): SentRequest[] {
  const taken = sent;
  sent = [];
  return taken;
}

/** Throw, naming each request refused since the last check and where it was sent, if any was. */
export function failOnSentRequests(): void {
  const taken = takeSentRequests();
  if (!taken.length) return;
  const named = taken
    .map(({ request, test }) => `${request} (${test ? `in "${test}"` : 'outside any test'})`)
    .join(', ');
  throw new Error(
    `A unit test makes no network call, but these requests were sent: ${named}: stub them.`,
  );
}
