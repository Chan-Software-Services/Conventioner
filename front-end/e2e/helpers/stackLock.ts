import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
 * back end, holding an `owner` file: the holder's process id and a token of its own. A holder
 * makes it whole under another name and renames it into place, which either lands or fails, at
 * once, for every process on the machine, where a shard's workers run, since a directory never
 * replaces one that holds a file; and it removes it only while the token there is its own.
 *
 * A lock is judged by its holder, never by its age: a waiter takes it over once the holder's
 * process is gone, as when a worker was killed, or a hook timed out inside the body (Playwright
 * replaces the worker, so its `finally` never runs), so the retry waits only until the old worker
 * has exited, never for a stale age. The takeover is made under a second lock, `<lock>.reap`, and
 * removes the lock only when its owner is still the one judged gone, so a waiter that judged it
 * never removes one another waiter made meanwhile. A release or a takeover first moves the lock
 * aside, renaming it in one step to a name of its own, and removes it under that name: a removal
 * by the lock's own name would leave it an empty directory for a moment, which a waiter's rename
 * would land on, and the removal would then fail on the waiter's lock. A live holder is waited on
 * for `waitMs`, then the waiter fails naming the lock. `global-setup.ts` clears the stack's locks
 * before a run.
 */
export interface LockTiming {
  /** How often a waiter looks again. */
  pollMs?: number;
  /** How long a waiter waits on a live holder before it fails. */
  waitMs?: number;
}

const POLL_MS = 100;
const WAIT_MS = 60_000;
const OWNER = 'owner';

const key = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The directory that holds every lock of the stack whose back end is `backend`. */
export function stackLocksDir(backend: string, dir: string = tmpdir()): string {
  return join(dir, `conventioner-e2e-locks-${key(backend)}`);
}

/** The lock directory for `name` on the stack whose back end is `backend`. */
export function lockPath(backend: string, name: string, dir: string = tmpdir()): string {
  return join(stackLocksDir(backend, dir), key(name));
}

/** The owner a lock names, `<pid> <token>`, or null when there is none to read. */
function ownerOf(path: string): string | null {
  try {
    return readFileSync(join(path, OWNER), 'utf8');
  } catch {
    return null;
  }
}

/** Whether the process that wrote `owner` still runs. */
function holderRuns(owner: string): boolean {
  const pid = Number(owner.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Make the lock at `path` as `owner`, whole, or answer false when another holds it. */
function take(path: string, owner: string): boolean {
  const staging = `${path}.${randomBytes(8).toString('hex')}`;
  mkdirSync(staging);
  writeFileSync(join(staging, OWNER), owner);
  try {
    renameSync(staging, path);
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

/** Remove the lock at `path`: move it aside in one step, then remove it under its new name. */
function remove(path: string): void {
  const aside = `${path}.${randomBytes(8).toString('hex')}.gone`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  rmSync(aside, { recursive: true, force: true });
}

/** Remove the lock at `path` when it still names `judged`, a holder gone; true when removed. */
function reap(path: string, judged: string): boolean {
  const reaping = `${path}.reap`;
  try {
    mkdirSync(reaping);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    if (ownerOf(path) !== judged) return false;
    remove(path);
    return true;
  } finally {
    rmSync(reaping, { recursive: true, force: true });
  }
}

/** Run `body` holding the lock at `path`, waiting while another holder has it. */
export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  { pollMs = POLL_MS, waitMs = WAIT_MS }: LockTiming = {},
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const owner = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  while (!take(path, owner)) {
    const held = ownerOf(path);
    if (held !== null && !holderRuns(held) && reap(path, held)) continue;
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: waited ${waitMs} ms for the lock ${path}, still held by ${held ?? 'another worker'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await body();
  } finally {
    if (ownerOf(path) === owner) remove(path);
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
 * the run: a lock then standing was left by an earlier run, and so may a takeover's `.reap` lock
 * or a lock moved aside be, which a waiter killed in its few file calls would leave.
 */
export function clearStackLocks(dir: string = tmpdir()): void {
  rmSync(stackLocksDir(stackBackend(), dir), { recursive: true, force: true });
}
