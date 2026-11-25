/**
 * The test map's recording (T349, `e2e/helpers/testMap.ts`): on the nightly Test run of `dev`'s tip
 * (or one started by hand), CI's shards write one line per test naming the app modules and API
 * calls its pages made, and the stretches of each module that ran. These are the pure parts: which
 * requests count, and how V8's nested block counts become the stretches that ran.
 */
import { describe, expect, it } from 'vitest';

import { coveredRanges, requestKey } from '../../e2e/helpers/testMap';

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
