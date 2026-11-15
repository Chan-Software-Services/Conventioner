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

  it('is the only speed limit: no test in the unit suite reads the clock to time its work', () => {
    const sources = import.meta.glob('./**/*.{test,spec}.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const clock = new RegExp(
      ['performance', 'now'].join('\\.') + '|hrtime|' + 'Date\\.now\\(\\) *-',
    );
    const timed = Object.entries(sources)
      .filter(([, source]) => clock.test(source))
      .map(([path]) => path);
    // AttendanceStatusView's is a comment on why it puts the real timers back.
    expect(timed).toEqual(['./AttendanceStatusView.test.ts']);
  });
});
