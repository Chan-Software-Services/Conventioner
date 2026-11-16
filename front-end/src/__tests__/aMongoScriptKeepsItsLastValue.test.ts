/**
 * The E2E suite runs its Mongo scripts in one long-lived mongosh session, each loaded as a file,
 * where `mongosh --eval` once started a fresh mongosh for every one. A spec reads what the script
 * printed and the value of its last expression, as `--eval` printed it, so the file must keep that
 * value, keep each script's names to itself, and the session's answers must be told apart.
 */
import { describe, expect, it } from 'vitest';

import { asLoadedFile, readAnswer } from '../../e2e/helpers/mongoScript';

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
