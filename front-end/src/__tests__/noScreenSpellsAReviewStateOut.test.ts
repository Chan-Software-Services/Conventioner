/**
 * No screen works an application's review state out from its stored status (ADR 0037).
 *
 * The review queue, the All view's filters, the card's "dealt to" warning, the verdict lines and
 * the Stats tab each held their own list of statuses, and could disagree with the server and with
 * each other: an old spelling of open, a status the old offers flow left behind, a reviewer
 * removed from the team. The server now serves each application's state (`review`), and every
 * screen reads it.
 *
 * This reads the source, as `noScreenComparesARole.test.ts` does, so the next file that spells a
 * state out again fails here, by name. The status's own labels and tones (`utils/verdicts.ts`) and
 * its type (`assets/types/datatypes.ts`) name every status, and are left out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';

const SRC = resolvePath(process.cwd(), 'src');
const LEFT_OUT = ['assets/types/datatypes.ts', 'utils/verdicts.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|vue)$/.test(entry) ? [path] : [];
  });
}

/** What spelling a state out looks like, each by name. */
const SPELLINGS: Array<[string, RegExp]> = [
  // The old spelling of open, which only the migration and the label table still name.
  ['names the old spelling of open', /ApplicationStatus\.UnderReview\b|['"`]under_review['"`]/],
  // The lists the screens decided a state by, before the server served it.
  [
    'declares a list of statuses for a state',
    /\b(const|let|var)\s+(AWAITING|UNDECIDED|VERDICTS)\b/,
  ],
];

function spellingsIn(source: string): string[] {
  return SPELLINGS.filter(([, pattern]) => pattern.test(source)).map(([what]) => what);
}

describe('no screen spells a review state out', () => {
  const files = sourceFiles(SRC)
    .map((file) => relative(SRC, file))
    .filter((file) => !LEFT_OUT.includes(file));

  it('reads the source it claims to', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('utils/reviewQueue.ts');
    expect(files).toContain('components/application/ApplicationMonitor.vue');
  });

  it('no source file works a state out from the status', () => {
    const offenders = files.flatMap((file) =>
      spellingsIn(readFileSync(join(SRC, file), 'utf8')).map((what) => `${file}: ${what}`),
    );

    expect(offenders).toEqual([]);
  });

  it('would catch one that did, in each shape', () => {
    expect(spellingsIn('if (a.status === ApplicationStatus.UnderReview) {')).toEqual([
      'names the old spelling of open',
    ]);
    expect(spellingsIn("const open = ['open', 'under_review'];")).toEqual([
      'names the old spelling of open',
    ]);
    expect(spellingsIn('const AWAITING: readonly string[] = [ApplicationStatus.Open];')).toEqual([
      'declares a list of statuses for a state',
    ]);
    expect(spellingsIn('const UNDECIDED = [];')).toEqual([
      'declares a list of statuses for a state',
    ]);
    expect(spellingsIn('let VERDICTS = [];')).toEqual(['declares a list of statuses for a state']);
    expect(spellingsIn("if (a.review.state === 'open') {")).toEqual([]);
  });
});
