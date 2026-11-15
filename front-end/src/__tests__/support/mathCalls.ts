/**
 * How much arithmetic a piece of geometry does, counted and not timed: the number of calls it makes
 * to `Math`'s functions (`hypot`, `min`, `max`, `cos` and the rest). The same code on the same
 * input makes the same calls on any machine, however busy, where a clock reads the machine's other
 * work too; so a speed limit in the unit suite is a limit on this count, measured once and given
 * room, and a change that makes the code look at markedly more (a search that loses its bound, a
 * check that loses its nearness test) passes it by a wide margin.
 *
 * It counts only what goes through `Math`: work that calls none of its functions is not seen.
 */
export function mathCalls<T>(work: () => T): { calls: number; result: T } {
  const names = Object.getOwnPropertyNames(Math) as (keyof Math)[];
  const kept = new Map<keyof Math, PropertyDescriptor>();
  let calls = 0;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(Math, name)!;
    const real: unknown = descriptor.value;
    if (typeof real !== 'function') continue;
    kept.set(name, descriptor);
    Object.defineProperty(Math, name, {
      ...descriptor,
      value: (...args: unknown[]) => {
        calls += 1;
        return (real as (...args: unknown[]) => unknown)(...args);
      },
    });
  }
  try {
    const result = work();
    return { calls, result };
  } finally {
    for (const [name, descriptor] of kept) Object.defineProperty(Math, name, descriptor);
  }
}
