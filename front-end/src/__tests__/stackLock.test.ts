// @vitest-environment node
/**
 * The lock two workers of one stack take before a seed step whose state every spec file shares
 * (`e2e/helpers/stackLock.ts`): a step that reads the stack and then writes what it found missing
 * is safe only when no other worker does the same between the read and the write. Against a real
 * directory under the OS temp dir, in Node, since the lock is a directory made there.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lockPath, withLock } from '../../e2e/helpers/stackLock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stack-lock-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withLock', () => {
  it('runs two holders of one lock one after the other, never together', async () => {
    const path = join(dir, 'lock');
    const events: string[] = [];
    const holder = (name: string) =>
      withLock(
        path,
        async () => {
          events.push(`${name} in`);
          await pause(50);
          events.push(`${name} out`);
          return name;
        },
        { pollMs: 5 },
      );
    const answers = await Promise.all([holder('a'), holder('b')]);
    expect(answers).toEqual(['a', 'b']);
    expect(events).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('lets a second holder read what the first wrote, as a seed step that finds its state made', async () => {
    const path = join(dir, 'lock');
    let made = 0;
    const ensure = () =>
      withLock(
        path,
        async () => {
          const found = made > 0;
          await pause(20);
          if (!found) made += 1;
        },
        { pollMs: 5 },
      );
    await Promise.all([ensure(), ensure(), ensure()]);
    expect(made).toBe(1);
  });

  it('releases the lock when the body throws', async () => {
    const path = join(dir, 'lock');
    await expect(
      withLock(path, async () => {
        throw new Error('the seed failed');
      }),
    ).rejects.toThrow('the seed failed');
    await expect(withLock(path, async () => 'next')).resolves.toBe('next');
  });

  it('takes over a lock older than the stale age, as one a killed worker left', async () => {
    const path = join(dir, 'lock');
    mkdirSync(path);
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    await expect(withLock(path, async () => 'taken', { staleMs: 5_000 })).resolves.toBe('taken');
  });

  it('fails, naming the lock, when a fresh lock is held past the wait', async () => {
    const path = join(dir, 'lock');
    mkdirSync(path);
    await expect(
      withLock(path, async () => 'never', { pollMs: 5, waitMs: 50, staleMs: 60_000 }),
    ).rejects.toThrow(path);
  });
});

describe('lockPath', () => {
  it('gives one stack and name one path, and another stack or name another', () => {
    const one = lockPath('https://127.0.0.1:5121', 'the screens organization', dir);
    expect(lockPath('https://127.0.0.1:5121', 'the screens organization', dir)).toBe(one);
    expect(lockPath('https://127.0.0.1:5122', 'the screens organization', dir)).not.toBe(one);
    expect(lockPath('https://127.0.0.1:5121', 'the test organization', dir)).not.toBe(one);
    expect(one.startsWith(dir)).toBe(true);
  });
});
