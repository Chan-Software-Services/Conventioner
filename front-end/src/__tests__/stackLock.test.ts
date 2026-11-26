// @vitest-environment node
/**
 * The lock two workers of one stack take before a seed step whose state every spec file shares
 * (`e2e/helpers/stackLock.ts`): a step that reads the stack and then writes what it found missing
 * is safe only when no other worker does the same between the read and the write. Against a real
 * directory under the OS temp dir, in Node, since the lock is a directory made there.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A hook run after the lock reads a lock's owner, so a test can put another waiter's step between
// that read and what the lock does next.
const fsHooks = vi.hoisted(() => ({
  afterOwnerRead: undefined as ((file: string) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const answer = actual.readFileSync(...args);
      fsHooks.afterOwnerRead?.(String(args[0]));
      return answer;
    }) as typeof actual.readFileSync,
  };
});

import { clearStackLocks, lockPath, stackLocksDir, withLock } from '../../e2e/helpers/stackLock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stack-lock-test-'));
});
afterEach(() => {
  fsHooks.afterOwnerRead = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A lock at `path` as its holder `owner` makes it: a directory holding its `owner` file. */
function plant(path: string, owner: string, minutesOld = 0): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner'), owner);
  if (minutesOld) {
    const old = new Date(Date.now() - minutesOld * 60_000);
    utimesSync(path, old, old);
  }
}

/** This test process's own id, so a planted owner's process runs. */
const LIVE = `${process.pid} a-live-holder`;
/** The id of a process that has run and exited, so a planted owner's process is gone. */
const GONE = `${spawnSync(process.execPath, ['-e', '']).pid} a-killed-worker`;

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

  it('waits on a holder whose process runs, however old its lock, and never removes it', async () => {
    const path = join(dir, 'lock');
    plant(path, LIVE, 10);
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

  it("takes over at once a lock whose holder's process is gone, as a timed-out hook leaves", async () => {
    const path = join(dir, 'lock');
    plant(path, GONE);
    const started = Date.now();
    await expect(withLock(path, async () => 'taken', { pollMs: 5, waitMs: 1_000 })).resolves.toBe(
      'taken',
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(existsSync(path)).toBe(false);
  });

  it('never lets a waiter remove a lock another waiter took between its two steps', async () => {
    const path = join(dir, 'lock');
    plant(path, GONE);
    const events: string[] = [];
    fsHooks.afterOwnerRead = (file) => {
      if (file !== join(path, 'owner')) return;
      fsHooks.afterOwnerRead = undefined;
      // Waiter A takes the dead holder's lock over and holds it, between B's read of its owner
      // and B's next step.
      rmSync(path, { recursive: true, force: true });
      plant(path, LIVE);
      events.push('a in');
      setTimeout(() => {
        events.push('a out');
        rmSync(path, { recursive: true, force: true });
      }, 100);
    };
    await withLock(
      path,
      async () => {
        events.push('b in');
      },
      { pollMs: 5, waitMs: 1_000 },
    );
    expect(events).toEqual(['a in', 'a out', 'b in']);
  });

  it('leaves, on its release, a lock another holder made in its place', async () => {
    const path = join(dir, 'lock');
    await withLock(path, async () => {
      // Another holder's lock stands in this one's place by the time the body ends.
      rmSync(path, { recursive: true, force: true });
      plant(path, LIVE);
    });
    expect(readFileSync(join(path, 'owner'), 'utf8')).toBe(LIVE);
  });

  it('fails, naming the lock, when a holder whose process runs holds it past the wait', async () => {
    const path = join(dir, 'lock');
    plant(path, LIVE);
    await expect(withLock(path, async () => 'never', { pollMs: 5, waitMs: 50 })).rejects.toThrow(
      path,
    );
    expect(readFileSync(join(path, 'owner'), 'utf8')).toBe(LIVE);
  });

  it('leaves nothing behind once its holders are done', async () => {
    const path = lockPath('https://127.0.0.1:5121', 'the screens organization', dir);
    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        withLock(path, async () => pause(20).then(() => name), { pollMs: 5 }),
      ),
    );
    expect(readdirSync(stackLocksDir('https://127.0.0.1:5121', dir))).toEqual([]);
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
