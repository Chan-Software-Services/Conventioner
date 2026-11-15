/**
 * A speed limit in this suite counts the work, never the clock (`support/mathCalls.ts`): the count
 * is of the calls made to `Math`'s functions, and `Math` is its own again afterwards.
 */
import { describe, expect, it } from 'vitest';
import { mathCalls } from './support/mathCalls';

describe('the count of calls to Math', () => {
  it('counts each call the work makes, and gives back what the work returned', () => {
    const { calls, result } = mathCalls(() => Math.hypot(3, 4) + Math.max(1, 2) + Math.floor(0.5));
    expect(calls).toBe(3);
    expect(result).toBe(7);
  });

  it('counts the same work the same, run after run', () => {
    const work = () => Array.from({ length: 100 }, (_, i) => Math.sqrt(i));
    expect(mathCalls(work).calls).toBe(100);
    expect(mathCalls(work).calls).toBe(100);
  });

  it('leaves Math as it found it, after work that throws as after work that returns', () => {
    const before = Object.getOwnPropertyDescriptors(Math);
    mathCalls(() => Math.abs(-1));
    expect(Object.getOwnPropertyDescriptors(Math)).toEqual(before);
    expect(() =>
      mathCalls(() => {
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(Object.getOwnPropertyDescriptors(Math)).toEqual(before);
    expect(Math.hypot).toBe(before.hypot.value);
  });

  it('is the only speed limit: no test in the unit suite, and no helper of one, reads the clock', () => {
    // Every file the suite runs and every helper beside this one. This file is not in its own
    // glob, so the pattern below does not find itself.
    const sources = import.meta.glob(
      ['../**/*.{test,spec}.{ts,tsx}', './support/**/*.ts', './helpers/**/*.ts'],
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(200);
    const clock = /performance\.(now|mark|measure)|hrtime|Date\.now\(|\.getTime\(|console\.time/;
    const reads = Object.entries(sources).flatMap(([path, source]) =>
      source
        .split('\n')
        .map((line, i) => (clock.test(line) ? `${path}:${i + 1}: ${line.trim()}` : ''))
        .filter(Boolean),
    );
    // A line listed here reads the clock. Where it times work, count the work with `mathCalls`.
    // Where it is a date as data, write the date out (`new Date('2026-03-01T10:00:00Z')`), which
    // reads the same on every run.
    expect(reads).toEqual([]);
  });
});
