// @vitest-environment node
/**
 * The test map's recording (T349, `e2e/helpers/testMap.ts`): on a push to `dev`, CI's shards write
 * one line per test naming the app modules its pages loaded and the API calls its pages and its
 * Node helpers made, and the stretches of each module that ran, each worker to a file of its own.
 * These are the pure parts (which requests count, which file a worker writes, how V8's nested
 * block counts become the stretches that ran) and the wrapped API request context, against a
 * real one from `playwright-core` and a local server. In Node, since the request context is.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request, type APIRequestContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  coveredRanges,
  endBetween,
  endRecording,
  recordApiCalls,
  recordsFile,
  requestKey,
  startBetween,
  startRecording,
} from '../../e2e/helpers/testMap';

const block = (startOffset: number, endOffset: number, count: number) => ({
  startOffset,
  endOffset,
  count,
});

describe('requestKey', () => {
  it("keeps an app module's path, without the query Vite adds", () => {
    expect(requestKey('GET', 'http://127.0.0.1:5173/src/App.vue')).toBe('/src/App.vue');
    expect(requestKey('GET', 'http://127.0.0.1:5173/src/App.vue?vue&type=style&index=0')).toBe(
      '/src/App.vue',
    );
    expect(requestKey('GET', 'http://127.0.0.1:5173/src/main.ts?t=1794672960000')).toBe(
      '/src/main.ts',
    );
  });

  it("keeps an API call's method and path, without its query", () => {
    expect(requestKey('POST', 'http://127.0.0.1:5173/api/markets')).toBe('POST /api/markets');
    expect(requestKey('GET', 'http://127.0.0.1:5173/api/markets/m-1/history?group=All')).toBe(
      'GET /api/markets/m-1/history',
    );
  });

  it('leaves out everything else: dependencies, Vite itself, other origins, data', () => {
    expect(requestKey('GET', 'http://127.0.0.1:5173/node_modules/.vite/deps/vue.js')).toBeNull();
    expect(requestKey('GET', 'http://127.0.0.1:5173/@vite/client')).toBeNull();
    expect(requestKey('GET', 'http://127.0.0.1:5173/')).toBeNull();
    expect(requestKey('GET', 'http://127.0.0.1:5173/srcset.png')).toBeNull();
    expect(requestKey('GET', 'data:image/png;base64,AAAA')).toBeNull();
    expect(requestKey('GET', 'not a url')).toBeNull();
  });

  const backEnd = 'http://127.0.0.1:5071';

  it("keys a call straight to the back end as the dev server's proxy keys the same call", () => {
    expect(requestKey('GET', `${backEnd}/markets/m-1/history?group=All`, backEnd)).toBe(
      'GET /api/markets/m-1/history',
    );
    expect(requestKey('POST', `${backEnd}/markets`, backEnd)).toBe('POST /api/markets');
    expect(requestKey('GET', `${backEnd}/`, backEnd)).toBe('GET /api/');
  });

  it("reads no back-end path as an app module, and another origin's as before", () => {
    expect(requestKey('GET', `${backEnd}/src/App.vue`, backEnd)).toBe('GET /api/src/App.vue');
    expect(requestKey('GET', 'http://127.0.0.1:5071/markets')).toBeNull();
    expect(requestKey('GET', 'http://127.0.0.1:5081/markets', backEnd)).toBeNull();
    expect(requestKey('GET', 'https://127.0.0.1:5071/markets', backEnd)).toBeNull();
    expect(requestKey('GET', 'http://127.0.0.1:5193/api/markets', backEnd)).toBe(
      'GET /api/markets',
    );
    expect(requestKey('GET', 'http://127.0.0.1:5193/src/App.vue', backEnd)).toBe('/src/App.vue');
  });
});

describe('recordsFile', () => {
  it("is a file of the worker's own in the directory, so no two live workers append to one", () => {
    expect(recordsFile('/w/test-map', 0)).toBe('/w/test-map/records-0.jsonl');
    expect(recordsFile('/w/test-map', 1)).toBe('/w/test-map/records-1.jsonl');
    expect(recordsFile('/w/test-map/', 12)).toBe('/w/test-map/records-12.jsonl');
  });
});

describe("a Node helper's API calls", () => {
  let server: Server;
  let origin: string;
  let context: APIRequestContext;
  /** Answers the held request, once it has come. */
  let release: () => void = () => {};
  let held: Promise<void>;

  beforeAll(async () => {
    let arrived = () => {};
    held = new Promise((resolve) => (arrived = resolve));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      if (req.url?.startsWith('/slow')) {
        release = () => res.end('late');
        arrived();
        return;
      }
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The recorder wraps the class through a context it makes and disposes, as the worker
    // fixture does, so a context made later, as each test's `request` is, is counted too.
    const first = await request.newContext();
    recordApiCalls(first, origin);
    await first.dispose();
    context = await request.newContext();
  });

  afterAll(async () => {
    endRecording();
    endBetween();
    await context?.dispose();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('counts a get and a post for the test running, by their keys at the back end', async () => {
    const running = startRecording();
    expect((await context.get(`${origin}/markets?group=All`)).status()).toBe(200);
    expect((await context.post(`${origin}/markets/m-1/history`, { data: {} })).status()).toBe(201);
    expect(endRecording()).toBe(running);
    expect([...running.requests].sort()).toEqual([
      'GET /api/markets',
      'POST /api/markets/m-1/history',
    ]);
  });

  it('counts a call for the test it started in, though it is answered after that test ended', async () => {
    const first = startRecording();
    const call = context.get(`${origin}/slow`);
    await held;
    endRecording();
    const next = startRecording();
    release();
    expect(await (await call).text()).toBe('late');
    endRecording();
    expect([...first.requests]).toEqual(['GET /api/slow']);
    expect([...next.requests]).toEqual([]);
  });

  it('counts a call made with no test running for none', async () => {
    endRecording();
    await context.put(`${origin}/markets/m-1`);
    const next = startRecording();
    endRecording();
    expect([...next.requests]).toEqual([]);
  });

  it('counts a call between tests for the stretch between them, never for a test', async () => {
    endRecording();
    const gap = startBetween();
    await context.put(`${origin}/markets/m-1`);
    expect(endBetween()).toBe(gap);
    const next = startRecording();
    await context.get(`${origin}/markets`);
    endRecording();
    expect([...gap.requests]).toEqual(['PUT /api/markets/m-1']);
    expect([...next.requests]).toEqual(['GET /api/markets']);
  });

  it('counts a call that throws for none, and throws as it would', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const running = startRecording();
    await expect(context.delete(`http://127.0.0.1:${port}/markets/m-1`)).rejects.toThrow();
    endRecording();
    expect([...running.requests]).toEqual([]);
  });
});

describe('coveredRanges', () => {
  it('is a function that ran, but for a block inside it that did not', () => {
    expect(coveredRanges([{ ranges: [block(0, 100, 1), block(20, 30, 0)] }])).toEqual([
      [0, 20],
      [30, 100],
    ]);
  });

  it('is nothing of a function that never ran', () => {
    expect(coveredRanges([{ ranges: [block(0, 100, 0)] }])).toEqual([]);
  });

  it('counts a block that ran inside one that did not, inside one that did', () => {
    expect(
      coveredRanges([{ ranges: [block(0, 100, 1), block(10, 50, 0), block(20, 30, 2)] }]),
    ).toEqual([
      [0, 10],
      [20, 30],
      [50, 100],
    ]);
  });

  it('keeps a gap between two blocks that did not run', () => {
    expect(
      coveredRanges([{ ranges: [block(0, 100, 1), block(10, 20, 0), block(30, 40, 0)] }]),
    ).toEqual([
      [0, 10],
      [20, 30],
      [40, 100],
    ]);
  });

  it('merges the functions of a module into one sorted list, joining stretches that touch', () => {
    // The module's code ran but for 40-90, inside which two functions of their own ran.
    expect(
      coveredRanges([
        { ranges: [block(50, 80, 1)] },
        { ranges: [block(0, 200, 1), block(40, 90, 0)] },
        { ranges: [block(80, 90, 3)] },
      ]),
    ).toEqual([
      [0, 40],
      [50, 200],
    ]);
  });
});
