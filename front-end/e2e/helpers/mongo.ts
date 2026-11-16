import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from 'node:worker_threads';
import { mongoContainer } from './containerNames';
import type { Answer } from './mongoScript';
import type { Request, SessionData } from './mongoSession';

/** The stack's database, as reached from inside its own Mongo container. */
const MONGO_URI = 'mongodb://admin:secret@localhost:27017/conventioner?authSource=admin';

/**
 * How long mongosh may take to start in the container and connect, once a process: a loaded CI
 * runner has taken longer than a script's whole budget for it.
 */
const START_MS = 60_000;

/** How long one script's own database work may take, once the session is up. */
const SCRIPT_MS = 10_000;

interface Thread {
  worker: Worker;
  signal: Int32Array;
  replies: MessagePort;
}

let thread: Thread | null = null;

/** The session's thread (`mongoSession.ts`), started on first use and kept for the process. */
function sessionThread(): Thread {
  if (thread) return thread;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1: replies, port2 } = new MessageChannel();
  const data: SessionData = {
    container: mongoContainer(),
    uri: MONGO_URI,
    startMs: START_MS,
    scriptMs: SCRIPT_MS,
    signal,
    replies: port2,
  };
  const worker = new Worker(new URL('./mongoSession.ts', import.meta.url), {
    workerData: data,
    transferList: [port2],
  });
  // The process ends when its tests do, and the session with it: mongosh reads to the end of its
  // stdin, which closes as the process exits.
  worker.unref();
  replies.unref();
  const started: Thread = { worker, signal, replies };
  worker.on('exit', () => {
    if (thread === started) thread = null;
  });
  thread = started;
  return started;
}

/**
 * Start the session ahead of the first script, so its one start is not counted against a test
 * (`fixtures.ts` starts it for each worker process).
 */
export async function startMongoSession(): Promise<void> {
  const { worker } = sessionThread();
  const answer = await new Promise<Answer>((resolve) => {
    worker.once('message', resolve);
    worker.postMessage({ kind: 'start' } satisfies Request);
  });
  if (!answer.ok) throw new Error(`mongoEval: ${answer.error}`);
}

/**
 * Run a script against the stack's database and return what it printed, and the value of its last
 * statement when that is an expression, trimmed, as `mongosh --eval` printed them.
 *
 * For what no endpoint does: an applicant's submission before there was a submit endpoint, a
 * document shaped as an older build wrote it, a token only an email carries. The one place the
 * suite reaches into Mongo, so the container and the address are said once - they were copied
 * into fifteen files.
 *
 * Every script of a process runs in one mongosh in the stack's Mongo container (`mongoSession.ts`),
 * started once, where each once started a mongosh of its own: a loaded CI runner took more than a
 * script's 10 seconds to start one, and failed a spec on it. A script keeps its names to itself.
 * It blocks until the script has run, as the suite's callers expect.
 */
export function mongoEval(script: string): string {
  const { worker, signal, replies } = sessionThread();
  Atomics.store(signal, 0, 0);
  worker.postMessage({ kind: 'eval', script } satisfies Request);
  // The thread answers within START_MS and SCRIPT_MS; this wait is for a thread that cannot.
  if (Atomics.wait(signal, 0, 0, START_MS + SCRIPT_MS + 5_000) === 'timed-out') {
    void worker.terminate();
    thread = null;
    throw new Error('mongoEval: the Mongo session thread did not answer');
  }
  const answer = receiveMessageOnPort(replies)?.message as Answer | undefined;
  if (!answer) throw new Error('mongoEval: the Mongo session thread answered nothing');
  if (!answer.ok)
    throw new Error(`mongoEval: ${answer.error}\nin the script: ${script.slice(0, 500)}`);
  return answer.output;
}
