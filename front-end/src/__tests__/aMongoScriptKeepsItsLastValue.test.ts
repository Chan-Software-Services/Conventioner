/**
 * The E2E suite runs its Mongo scripts in one long-lived mongosh session, each loaded as a file,
 * where `mongosh --eval` once started a fresh mongosh for every one. A spec reads what the script
 * printed and the value of its last expression, as `--eval` printed it, so the file must keep that
 * value, keep each script's names to itself, and the session's answers must be told apart. An
 * idle session must wait for its next script without polling, in the very container whose CPU a
 * loaded runner starves.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { asLoadedFile, readAnswer, sessionLoop } from '../../e2e/helpers/mongoScript';

describe('asLoadedFile', () => {
  it('keeps the value of a last expression for the session to print', () => {
    expect(asLoadedFile(`db.users.findOne({ email: 'a@example.com' }).status`)).toBe(
      `{\nglobalThis.__mongoEvalResult = (db.users.findOne({ email: 'a@example.com' }).status)\n}\n`,
    );
  });

  it('keeps only the last statement, after the ones before it and before its own comment', () => {
    const script = `const market = db.markets.findOne({ id: 'm1' });\nmarket.name; // the name`;
    expect(asLoadedFile(script)).toBe(
      `{\nconst market = db.markets.findOne({ id: 'm1' });\n` +
        `globalThis.__mongoEvalResult = (market.name); // the name\n}\n`,
    );
  });

  it('keeps no value when the script ends in a statement that is not an expression', () => {
    const script = `try { db.attendance.insertOne({ a: 1 }); print('stored twice') }\ncatch (e) { print(e.code) }`;
    expect(asLoadedFile(script)).toBe(`{\n${script}\n}\n`);
  });

  it('closes its block on a line of its own, after a script that ends in a comment', () => {
    expect(asLoadedFile(`const a = 1; // nothing more`)).toBe(
      `{\nconst a = 1; // nothing more\n}\n`,
    );
  });

  it('wraps a script of a sequence or an assignment whole', () => {
    expect(asLoadedFile(`a = 1, b = 2`)).toBe(
      `{\nglobalThis.__mongoEvalResult = (a = 1, b = 2)\n}\n`,
    );
  });

  it('leaves an empty script empty', () => {
    expect(asLoadedFile('')).toBe(`{\n\n}\n`);
  });
});

describe('readAnswer', () => {
  const NONCE = 'n0nce';

  it('waits for the line that ends the answer', () => {
    expect(readAnswer('', NONCE)).toBeNull();
    expect(readAnswer('3\n', NONCE)).toBeNull();
    expect(readAnswer(`3\n${NONCE} o`, NONCE)).toBeNull();
  });

  it('returns what was printed before it, trimmed, and keeps what follows', () => {
    expect(readAnswer(`\n  3\n${NONCE} ok\nnext`, NONCE)).toEqual({
      answer: { ok: true, output: '3' },
      rest: 'next',
    });
  });

  it('reads the session starting as an answer with no output', () => {
    expect(readAnswer(`${NONCE} ready\n`, NONCE)).toEqual({
      answer: { ok: true, output: '' },
      rest: '',
    });
  });

  it('reads a failed script as its error, with what it printed first', () => {
    const error = JSON.stringify('MongoServerError: E11000 duplicate key error');
    expect(readAnswer(`seeded\n${NONCE} error ${error}\n`, NONCE)).toEqual({
      answer: { ok: false, error: 'MongoServerError: E11000 duplicate key error\nseeded' },
      rest: '',
    });
  });

  it('answers each script in turn when two answers arrive together', () => {
    const first = readAnswer(`1\n${NONCE} ok\n2\n${NONCE} ok\n`, NONCE);
    expect(first?.answer).toEqual({ ok: true, output: '1' });
    expect(readAnswer(first!.rest, NONCE)?.answer).toEqual({ ok: true, output: '2' });
  });
});

/**
 * The session's loop run by plain Node, with mongosh's `print`, `load` and `sleep` stood in for, and
 * its stdin a pipe left non-blocking, as mongosh leaves it. It is sent one script only after a pause.
 */
function runTheLoop(nonce: string, pauseMs: number) {
  const standIns = `
    const nodeFs = require('fs');
    const nodeVm = require('vm');
    process.stdin; // Node, as mongosh does, makes a piped fd 0 non-blocking
    globalThis.stdinFlags = nodeFs.readFileSync('/proc/self/fdinfo/0', 'utf8').match(/flags:\\s*(\\d+)/)[1];
    globalThis.sleeps = 0;
    globalThis.sleep = (ms) => {
      sleeps += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    globalThis.print = (...values) => nodeFs.writeSync(1, values.join(' ') + '\\n');
    globalThis.load = (file) => nodeVm.runInThisContext(nodeFs.readFileSync(file, 'utf8'));
    process.on('exit', () => nodeFs.writeSync(2, JSON.stringify({ stdinFlags, sleeps })));
  `;
  // Through `cat`, so the loop's stdin is a pipe, as `docker exec -i` gives mongosh, where Node
  // would give a child a socket.
  const child = spawn('sh', [
    '-c',
    'cat | "$0" -e "$1"',
    process.execPath,
    standIns + sessionLoop(nonce),
  ]);
  let printed = '';
  let said = '';
  child.stdout.on('data', (text: Buffer) => (printed += text.toString()));
  child.stderr.on('data', (text: Buffer) => (said += text.toString()));
  setTimeout(() => {
    child.stdin.write(`${JSON.stringify({ file: asLoadedFile('40 + 2') })}\n`);
    child.stdin.end();
  }, pauseMs);
  return new Promise<{ code: number | null; printed: string; said: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, printed, said })),
  );
}

describe('sessionLoop', () => {
  it.runIf(process.platform === 'linux')(
    'waits for the next script without polling a non-blocking stdin, then answers it',
    async () => {
      const nonce = 'n0nce';
      const { code, printed, said } = await runTheLoop(nonce, 300);
      expect(code, said).toBe(0);
      const { stdinFlags, sleeps } = JSON.parse(said) as { stdinFlags: string; sleeps: number };
      // O_NONBLOCK, octal 04000: the loop was given the stdin mongosh leaves it.
      expect(parseInt(stdinFlags, 8) & 0o4000).toBe(0o4000);
      expect(sleeps).toBe(0);
      const ready = readAnswer(printed, nonce);
      expect(ready?.answer).toEqual({ ok: true, output: '' });
      expect(readAnswer(ready!.rest, nonce)?.answer).toEqual({ ok: true, output: '42' });
    },
  );
});
