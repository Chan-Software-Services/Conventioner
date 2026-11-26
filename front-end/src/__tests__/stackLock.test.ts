// @vitest-environment node
/**
 * The lock two workers of one stack take before a seed step whose state every spec file shares
 * (`e2e/helpers/stackLock.ts`): a step that reads the stack and then writes what it found missing
 * is safe only when no other worker does the same between the read and the write. Against a real
 * directory under the OS temp dir, in Node, since the lock is a directory made there.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearStackLocks, lockPath, stackLocksDir, withLock } from '../../e2e/helpers/stackLock';

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

  it('never removes a lock another holds, however old, so two waiters never both hold it', async () => {
    // A waiter that read a lock as old and then removed it could remove the one another waiter
    // had just made in its place, and both would run; so a waiter only waits, whatever its age.
    const path = join(dir, 'lock');
    mkdirSync(path);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    const events: string[] = ['a in'];
    setTimeout(() => {
      events.push('a out');
      rmSync(path, { recursive: true, force: true });
    }, 100);
    await withLock(
      path,
      async () => {
        events.push('b in');
      },
      { pollMs: 5, waitMs: 1_000 },
    );
    expect(events).toEqual(['a in', 'a out', 'b in']);
  });

  it('fails, naming the lock, when a fresh lock is held past the wait', async () => {
    const path = join(dir, 'lock');
    mkdirSync(path);
    await expect(withLock(path, async () => 'never', { pollMs: 5, waitMs: 50 })).rejects.toThrow(
      path,
    );
    expect(existsSync(path)).toBe(true);
  });

  it("makes the stack's lock directory when it is not there yet", async () => {
    const path = lockPath('https://127.0.0.1:5121', 'the screens organization', dir);
    await expect(withLock(path, async () => 'held')).resolves.toBe('held');
    expect(existsSync(path)).toBe(false);
  });
});

describe('clearStackLocks', () => {
  const saved = process.env.BACKEND_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = saved;
  });

  it("removes every lock of this run's stack, and no other stack's", () => {
    process.env.BACKEND_URL = 'https://127.0.0.1:5121';
    const mine = lockPath('https://127.0.0.1:5121', 'the screens organization', dir);
    const another = lockPath('https://127.0.0.1:5131', 'the screens organization', dir);
    mkdirSync(mine, { recursive: true });
    mkdirSync(another, { recursive: true });
    clearStackLocks(dir);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(another)).toBe(true);
  });

  it('passes when the stack holds no lock', () => {
    process.env.BACKEND_URL = 'https://127.0.0.1:5121';
    expect(() => clearStackLocks(dir)).not.toThrow();
  });
});

describe('lockPath', () => {
  it('gives one stack and name one path, and another stack or name another', () => {
    const one = lockPath('https://127.0.0.1:5121', 'the screens organization', dir);
    expect(lockPath('https://127.0.0.1:5121', 'the screens organization', dir)).toBe(one);
    expect(lockPath('https://127.0.0.1:5122', 'the screens organization', dir)).not.toBe(one);
    expect(lockPath('https://127.0.0.1:5121', 'the test organization', dir)).not.toBe(one);
    expect(one.startsWith(stackLocksDir('https://127.0.0.1:5121', dir))).toBe(true);
    expect(stackLocksDir('https://127.0.0.1:5121', dir).startsWith(dir)).toBe(true);
  });
});
