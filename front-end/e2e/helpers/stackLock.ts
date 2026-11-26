import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stack } from './stack';

/**
 * A lock the workers of one stack share, for a seed step whose state every spec file shares: a
 * step that reads the stack and then writes what it found missing (the screens' organization, a
 * place in it, an invitation) is safe at two workers only when no other worker does the same
 * between its read and its write, since the second write is refused, or lands twice. The step
 * runs under the lock and reads again inside it, so a second caller waits, then finds the state
 * the first made and writes nothing.
 *
 * The lock is a directory under the OS temp dir, in a directory of the stack's own keyed by its
 * back end: making a directory either makes it or fails, at once, for every process on the
 * machine, which is where a shard's workers run. No waiter ever removes a lock, however old,
 * since a waiter that read it as old may remove one another waiter has just made; a lock a killed
 * worker left is cleared by the next run's `global-setup.ts`, before any worker starts, and
 * within the run its waiters fail, naming it, once they have waited `waitMs`.
 */
export interface LockTiming {
  /** How often a waiter looks again. */
  pollMs?: number;
  /** How long a waiter waits before it fails: past any body's seconds, short of a hook's 120 s. */
  waitMs?: number;
}

const POLL_MS = 100;
const WAIT_MS = 60_000;

const key = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The directory that holds every lock of the stack whose back end is `backend`. */
export function stackLocksDir(backend: string, dir: string = tmpdir()): string {
  return join(dir, `conventioner-e2e-locks-${key(backend)}`);
}

/** The lock directory for `name` on the stack whose back end is `backend`. */
export function lockPath(backend: string, name: string, dir: string = tmpdir()): string {
  return join(stackLocksDir(backend, dir), key(name));
}

/** Run `body` holding the lock at `path`, waiting while another holder has it. */
export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  { pollMs = POLL_MS, waitMs = WAIT_MS }: LockTiming = {},
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: waited ${waitMs} ms for the lock ${path}, still held by another worker, or left by ` +
          'one that was killed (the next run clears it)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await body();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

/** This run's stack's back end, by its own address (`BACKEND_URL`, as `fixtures.ts` reads it). */
function stackBackend(): string {
  return process.env.BACKEND_URL || stack().backendURL;
}

/**
 * Run `body` holding the lock `name` on this run's stack, keyed by its back end's own address,
 * whichever address the caller reaches it by.
 */
export function withStackLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  return withLock(lockPath(stackBackend(), name), body);
}

/**
 * Remove every lock of this run's stack, for `global-setup.ts`, which runs before any worker of
 * the run: a lock then standing was left by a worker of an earlier run that was killed holding it.
 */
export function clearStackLocks(dir: string = tmpdir()): void {
  rmSync(stackLocksDir(stackBackend(), dir), { recursive: true, force: true });
}
