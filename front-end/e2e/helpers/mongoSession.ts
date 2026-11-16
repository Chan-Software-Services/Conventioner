/**
 * The worker thread `mongo.ts` starts in each process of the suite, holding one mongosh in the
 * stack's Mongo container for that process, started again only when a script runs out its time or
 * mongosh ends: one `docker exec`, one mongosh start, one connection, where each script once paid
 * all three. It runs the scripts one at a time, in the order they come.
 *
 * Run by Node itself, not Playwright's loader, so it imports Node's modules, `typescript` and
 * `.ts` files named whole.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { asLoadedFile, readAnswer, sessionLoop, type Answer } from './mongoScript.ts';

/** What `mongo.ts` hands the thread when it starts it. */
export interface SessionData {
  container: string;
  uri: string;
  startMs: number;
  scriptMs: number;
  /** Set to 1, and notified, once `replies` holds a script's answer. */
  signal: Int32Array;
  replies: MessagePort;
}

/** A request from `mongo.ts`: start the session ahead of the first script, or run one. */
export type Request = { kind: 'start' } | { kind: 'eval'; script: string };

const data = workerData as SessionData;

class Session {
  private readonly nonce = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private printed = '';
  private complaints = '';
  private waiting: ((answer: Answer) => void) | null = null;
  ended = false;

  constructor() {
    this.child = spawn('docker', [
      'exec',
      '-i',
      data.container,
      'mongosh',
      data.uri,
      '--quiet',
      '--eval',
      sessionLoop(this.nonce),
    ]);
    this.child.stdout.setEncoding('utf-8');
    this.child.stderr.setEncoding('utf-8');
    this.child.stdout.on('data', (text: string) => {
      this.printed += text;
      this.answer();
    });
    this.child.stderr.on('data', (text: string) => {
      this.complaints = (this.complaints + text).slice(-2000);
    });
    this.child.on('error', (error) => this.end(`docker could not be run: ${error.message}`));
    this.child.on('exit', (code, signal) =>
      this.end(`mongosh ended (${signal ?? `exit ${code}`}): ${this.complaints.trim()}`),
    );
  }

  /** Waits for mongosh to have connected and be reading scripts. */
  started(): Promise<Answer> {
    return this.next(data.startMs, 'start');
  }

  run(script: string): Promise<Answer> {
    this.child.stdin.write(`${JSON.stringify({ file: asLoadedFile(script) })}\n`);
    return this.next(data.scriptMs, 'run the script');
  }

  stop(): void {
    this.ended = true;
    this.child.kill();
  }

  private next(ms: number, what: string): Promise<Answer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        // Whether the script still runs is unknown, so the next one gets a session of its own.
        this.stop();
        resolve({ ok: false, error: `mongosh did not ${what} within ${ms / 1000} s` });
      }, ms);
      this.waiting = (answer) => {
        clearTimeout(timer);
        this.waiting = null;
        resolve(answer);
      };
      this.answer();
    });
  }

  private answer(): void {
    if (!this.waiting) return;
    const read = readAnswer(this.printed, this.nonce);
    if (!read) return;
    this.printed = read.rest;
    this.waiting(read.answer);
  }

  private end(why: string): void {
    this.ended = true;
    this.waiting?.({ ok: false, error: why });
  }
}

let session: Session | null = null;

/** The live session, started if there is none or the last one ended. */
async function live(): Promise<Session | Answer> {
  if (session && !session.ended) return session;
  const fresh = new Session();
  const started = await fresh.started();
  if (!started.ok) {
    fresh.stop();
    return { ok: false, error: `the Mongo session did not start: ${started.error}` };
  }
  session = fresh;
  return fresh;
}

async function handle(request: Request): Promise<Answer> {
  const current = await live();
  if (!(current instanceof Session)) return current;
  return request.kind === 'start' ? { ok: true, output: '' } : current.run(request.script);
}

let queue: Promise<unknown> = Promise.resolve();

parentPort?.on('message', (request: Request) => {
  queue = queue.then(async () => {
    const answer = await handle(request).catch((error: unknown): Answer => ({
      ok: false,
      error: String(error),
    }));
    if (request.kind === 'start') {
      parentPort?.postMessage(answer);
      return;
    }
    data.replies.postMessage(answer);
    Atomics.store(data.signal, 0, 1);
    Atomics.notify(data.signal, 0);
  });
});
