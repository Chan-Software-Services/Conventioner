/**
 * `mongoEval` blocks on the E2E suite's Mongo session thread until it answers. A thread that cannot
 * load its modules must still answer, with why, at once: otherwise the run's first script, in its
 * global setup, waits out its whole wait and fails saying only that the thread did not answer.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';

const THREAD = resolve(process.cwd(), 'e2e/helpers/mongoSession.ts');

let folder: string | null = null;

afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = null;
});

it('answers a script with the module it could not load, at once', async () => {
  // The thread alone, with no `mongoScript.ts` beside it to load.
  folder = mkdtempSync(join(tmpdir(), 'mongo-session-'));
  const thread = join(folder, 'mongoSession.ts');
  copyFileSync(THREAD, thread);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1: replies, port2 } = new MessageChannel();
  const worker = new Worker(thread, {
    workerData: {
      container: 'no-container',
      uri: 'mongodb://127.0.0.1:1/none',
      startMs: 60_000,
      scriptMs: 10_000,
      signal,
      replies: port2,
    },
    transferList: [port2],
  });
  try {
    worker.postMessage({ kind: 'eval', script: '1' });
    expect(Atomics.wait(signal, 0, 0, 10_000)).toBe('ok');
    expect(receiveMessageOnPort(replies)?.message).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^the Mongo session thread could not load its modules: .*ERR_MODULE_NOT_FOUND.*mongoScript\.ts/,
      ),
    });
  } finally {
    replies.close();
    await worker.terminate();
  }
});
