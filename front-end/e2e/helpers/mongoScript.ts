import ts from 'typescript';

/**
 * What the suite's one mongosh session runs (`mongoSession.ts`), and how a script and its answer
 * cross into and out of it. Kept apart from the session so a unit test reads it without a stack.
 *
 * A script is the mongosh dialect `mongosh --eval` ran: shell calls awaited without `await`,
 * `print`, `EJSON`, `ObjectId`. Running each with `--eval` started a fresh mongosh in the Mongo
 * container, a whole Node runtime, for every call; on a loaded CI runner one such start passed the
 * call's 10 seconds and failed a spec whose retry then passed. The session starts mongosh once and
 * hands it each script as a file to `load()`, which awaits the shell calls as `--eval` did.
 */

/** Where a script's last value is left for the session to print, as `--eval` printed it. */
const RESULT = 'globalThis.__mongoEvalResult';

/**
 * The file a script is loaded from: the script in a block of its own, so its `const`s do not meet
 * the next script's in the one session, and the value of its last statement, when that is an
 * expression, kept for printing. `load()` prints nothing and returns `true`, where `--eval`
 * printed that value: a count, a field read, a stringified document.
 */
export function asLoadedFile(script: string): string {
  const source = ts.createSourceFile(
    'script.js',
    script,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const last = source.statements.at(-1);
  if (!last || !ts.isExpressionStatement(last)) return `{\n${script}\n}\n`;
  const start = last.expression.getStart(source);
  const end = last.expression.end;
  return (
    `{\n${script.slice(0, start)}${RESULT} = (${script.slice(start, end)})` +
    `${script.slice(end)}\n}\n`
  );
}

/**
 * The script mongosh runs for the whole session, given by `--eval`: it reads one request a line
 * from its stdin, `{"file": <asLoadedFile's text>}`, writes it to a file in the container, loads
 * it and deletes it, prints what it printed and its last value, then a line naming the session's
 * `nonce` and how the script ended. It ends when its stdin does, which is when the process that
 * started it exits.
 *
 * Its stdin is read with a blocking `readSync`, so no request is read while one runs.
 */
export function sessionLoop(nonce: string): string {
  return `
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const decoder = new StringDecoder('utf8');
const chunk = Buffer.alloc(1 << 16);
const file = '/tmp/mongo-eval-' + process.pid + '.js';
let pending = '';
function nextLine() {
  for (;;) {
    const at = pending.indexOf('\\n');
    if (at >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      return line;
    }
    let read;
    try {
      read = fs.readSync(0, chunk, 0, chunk.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { sleep(5); continue; }
      throw e;
    }
    if (read === 0) return null;
    pending += decoder.write(chunk.subarray(0, read));
  }
}
print(${JSON.stringify(`${nonce} ready`)});
for (let line = nextLine(); line !== null; line = nextLine()) {
  fs.writeFileSync(file, JSON.parse(line).file);
  ${RESULT} = undefined;
  try {
    load(file);
    if (${RESULT} !== undefined) print(${RESULT});
    print(${JSON.stringify(`${nonce} ok`)});
  } catch (e) {
    print(${JSON.stringify(`${nonce} error `)} + JSON.stringify(String(e)));
  } finally {
    fs.rmSync(file, { force: true });
  }
}
`;
}

/** How one script ended, read from the session's output. */
export type Answer = { ok: true; output: string } | { ok: false; error: string };

/**
 * The first answer in what the session has printed so far, and what follows it, or null while the
 * answer is still to come. The output is everything before the answer's line, trimmed, as
 * `mongoEval` has always returned it.
 */
export function readAnswer(
  printed: string,
  nonce: string,
): { answer: Answer; rest: string } | null {
  const at = printed.indexOf(`${nonce} `);
  if (at < 0) return null;
  const lineEnd = printed.indexOf('\n', at);
  if (lineEnd < 0) return null;
  const output = printed.slice(0, at).trim();
  const ending = printed.slice(at + nonce.length + 1, lineEnd);
  const rest = printed.slice(lineEnd + 1);
  if (ending === 'ok' || ending === 'ready') return { answer: { ok: true, output }, rest };
  const error = ending.startsWith('error ') ? (JSON.parse(ending.slice(6)) as string) : ending;
  return { answer: { ok: false, error: output ? `${error}\n${output}` : error }, rest };
}
