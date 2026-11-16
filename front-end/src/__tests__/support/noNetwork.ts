/**
 * A unit test makes no network call.
 *
 * happy-dom sends a request a test leaves unstubbed for real, to its page's address,
 * `http://localhost:3000`, where nothing listens: the request fails with an `ECONNREFUSED` that
 * names no test, the screen under test reads it as a failed request, and the test may still pass.
 * The setup refuses each such request instead, with an error that names it, and fails the test
 * that sent it.
 */
import { expect } from 'vitest';

export interface SentRequest {
  /** The method and the address, as the code under test asked for them. */
  request: string;
  /** The test that was running when it was sent. */
  test: string;
}

let sent: SentRequest[] = [];

function refuse(method: string, url: unknown): Error {
  const request = `${method.toUpperCase()} ${String(url)}`;
  sent.push({ request, test: expect.getState().currentTestName ?? '(no test)' });
  return new Error(`a unit test sent ${request}: stub it`);
}

function refuseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const isRequest = typeof input === 'object' && 'url' in input;
  const method = init?.method ?? (isRequest ? input.method : 'GET');
  return Promise.reject(refuse(method, isRequest ? input.url : input));
}

/** Refuse every request sent by XHR (axios's adapter here) or `fetch`. */
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
}

/** The requests refused since this was last called, emptied. */
export function takeSentRequests(): SentRequest[] {
  const taken = sent;
  sent = [];
  return taken;
}
