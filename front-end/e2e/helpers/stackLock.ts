import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stack } from './stack';

/**
 * A lock the workers of one stack share, for a seed step whose state every spec file shares: a
 * step that reads the stack and then writes what it found missing (an account, the screens'
 * organization, a place in it, an invitation) is safe at two workers only when no other worker
 * does the same between its read and its write, since the second write is refused, or lands
 * twice. The step runs under the lock and reads again inside it, so a second caller waits, then
 * finds the state the first made and writes nothing.
 *
 * The lock is a directory under the OS temp dir, keyed by the stack's back end and the lock's
 * name: making a directory either makes it or fails, at once, for every process on the machine,
 * which is where a shard's workers run. A lock older than `staleMs` is one a killed worker left,
 * and is taken over; a body holds it for seconds.
 */
export interface LockTiming {
  /** How long a lock may stand before it is taken as left by a killed worker. */
  staleMs?: number;
  /** How often a waiter looks again. */
  pollMs?: number;
  /** How long a waiter waits before it fails. */
  waitMs?: number;
}

const STALE_MS = 120_000;
const POLL_MS = 100;

/** The lock directory for `name` on the stack whose back end is `backend`. */
export function lockPath(backend: string, name: string, dir: string = tmpdir()): string {
  const key = createHash('sha256').update(`${backend}\n${name}`).digest('hex').slice(0, 16);
  return join(dir, `conventioner-e2e-lock-${key}`);
}

/** The lock's age in milliseconds, or null when it is gone. */
function age(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Run `body` holding the lock at `path`, waiting while another holder has it. */
export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  { staleMs = STALE_MS, pollMs = POLL_MS, waitMs = STALE_MS + 30_000 }: LockTiming = {},
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = age(path);
    if (held !== null && held > staleMs) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: waited ${waitMs} ms for the lock ${path}, still held by another worker`,
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

/**
 * Run `body` holding the lock `name` on this run's stack, keyed by its back end's own address
 * (`BACKEND_URL`, as `fixtures.ts` reads it), whichever address the caller reaches it by.
 */
export function withStackLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  const backend = process.env.BACKEND_URL || stack().backendURL;
  return withLock(lockPath(backend, name), body);
}
