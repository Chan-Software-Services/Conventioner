// @vitest-environment node
/**
 * The E2E suite's Mongo session thread holds one mongosh, which can die between two scripts, as
 * when the Mongo container restarts. The script that next reaches it must be answered with an
 * error and the one after it given a fresh mongosh; and a session thread that itself dies must be
 * dropped, so the next `mongoEval` starts a fresh one rather than waiting out its whole wait, and
 * the death must not take the test process down with it.
 *
 * A stand-in `docker` on the PATH plays mongosh: on its first run it does what the test asks, and
 * on each later run it starts, answers one script with `42`, and ends.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';

const THREAD = resolve(process.cwd(), 'e2e/helpers/mongoSession.ts');

let folder: string | null = null;

afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = null;
});

/** A folder holding the stand-in `docker`, its first run doing `firstRun` once it has the nonce. */
function standInDocker(firstRun: string): string {
  folder = mkdtempSync(join(tmpdir(), 'mongo-session-'));
  const docker = join(folder, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh
for last; do :; done
nonce=$(printf '%s\\n' "$last" | grep -oE '[0-9a-f-]{36} ready' | cut -d' ' -f1)
if mkdir "$0.first" 2>/dev/null; then
${firstRun}
fi
echo "$nonce ready"
read -r line
echo 42
echo "$nonce ok"
`,
  );
  chmodSync(docker, 0o755);
  return folder;
}

const onPath = (bin: string) => `${bin}${delimiter}${process.env.PATH ?? ''}`;

it.runIf(process.platform !== 'win32')(
  'answers a script written to a mongosh that died with an error, then the next from a fresh one',
  async () => {
    // Its stdin closed before it says it is ready, so the first script's write fails with EPIPE
    // while the process lingers and no `exit` has yet been seen.
    const bin = standInDocker(`exec 0<&-\necho "$nonce ready"\nexec sleep 30`);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1: replies, port2 } = new MessageChannel();
    const worker = new Worker(THREAD, {
      workerData: {
        container: 'stand-in',
        uri: 'mongodb://127.0.0.1:1/none',
        startMs: 10_000,
        scriptMs: 5_000,
        signal,
        replies: port2,
      },
      transferList: [port2],
      env: { ...process.env, PATH: onPath(bin) },
    });
    const errors: unknown[] = [];
    worker.on('error', (error) => errors.push(error));
    const ask = async (script: string) => {
      Atomics.store(signal, 0, 0);
      worker.postMessage({ kind: 'eval', script });
      expect(await Atomics.waitAsync(signal, 0, 0, 8_000).value).toBe('ok');
      return receiveMessageOnPort(replies)?.message;
    };
    try {
      expect(await ask('1')).toEqual({
        ok: false,
        error: expect.stringMatching(/^mongosh's stdin failed: .*EPIPE/),
      });
      expect(await ask('2')).toEqual({ ok: true, output: '42' });
      expect(errors).toEqual([]);
    } finally {
      replies.close();
      await worker.terminate();
    }
  },
  20_000,
);

it.runIf(process.platform !== 'win32')(
  'drops a session thread that died, and starts a fresh one for the next script',
  async () => {
    // An answer the thread cannot read, which throws in it and ends it.
    const bin = standInDocker(`echo "$nonce error {"\nexec sleep 5`);
    const saved = { PATH: process.env.PATH, E2E_MONGO_CONTAINER: process.env.E2E_MONGO_CONTAINER };
    process.env.PATH = onPath(bin);
    process.env.E2E_MONGO_CONTAINER = 'stand-in';
    try {
      const { mongoEval, startMongoSession } = await import('../../e2e/helpers/mongo');
      await expect(startMongoSession()).rejects.toThrow(/the Mongo session thread died/);
      expect(mongoEval('40 + 2')).toBe('42');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
  20_000,
);
