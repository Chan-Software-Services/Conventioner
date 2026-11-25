/**
 * The e2e shards (T234) are dealt by measured minutes, not cut from the alphabetical list by test
 * count: Playwright's own `--shard` put the three people-at-scale files, whose names sort together,
 * on one shard, which ran 24 minutes of tests while another ran 6. Each shard deals the whole list
 * itself and runs its own hand, so the dealing must be the same on every runner and must hand every
 * spec file to exactly one shard.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BLEND_WEIGHT,
  blendTimings,
  checkShards,
  dealtBy,
  chooseTimings,
  chooseTimingsArtifacts,
  dealShards,
  type DealRecord,
  defaultSeconds,
  fileFilter,
  fileWeight,
  type GitHubReads,
  parseShard,
  parseTimings,
  publishedTimings,
  refreshTimings,
  mergeReports,
  passes,
  type Phase,
  secondsFromReports,
  SERIAL_PROJECT,
  serialFiles,
  shardStatus,
  shardSummary,
  specFiles,
  TIMINGS_ARTIFACT,
  TIMINGS_MARGIN_MS,
  timingsFile,
  timingsFromReports,
  trustedRun,
} from '../../scripts/e2e-shards';

const FILES = Array.from({ length: 40 }, (_, n) => `spec-${String(n).padStart(2, '0')}.spec.ts`);
/** Uneven, as the suite is: a few heavy files and many light ones. */
const SECONDS = Object.fromEntries(FILES.map((file, n) => [file, n % 7 === 0 ? 300 + n : 10 + n]));

/** A Playwright JSON report: one top-level suite per spec file, with nested suites and retries. */
function report(files: Record<string, number[][]>) {
  return {
    config: { rootDir: '/repo/front-end/e2e' },
    suites: Object.entries(files).map(([file, tests]) => ({
      title: file,
      file,
      specs: [],
      suites: [
        {
          title: 'a describe',
          file,
          specs: tests.map((durations, n) => ({
            title: `test ${n}`,
            file,
            tests: [{ results: durations.map((duration) => ({ duration })) }],
          })),
        },
      ],
    })),
  };
}

describe('dealShards', () => {
  it('hands every spec file to exactly one shard', () => {
    for (const total of [1, 4, 6, 7]) {
      const hands = dealShards(FILES, SECONDS, total);
      expect(hands).toHaveLength(total);
      const dealt = hands.flat();
      expect(dealt).toHaveLength(FILES.length);
      expect(new Set(dealt)).toEqual(new Set(FILES));
    }
  });

  it('deals the same hands whatever order the files are listed in', () => {
    const first = dealShards(FILES, SECONDS, 6);
    const reversed = dealShards([...FILES].reverse(), SECONDS, 6);
    const shuffled = dealShards(
      [...FILES].sort((a, b) => (a.slice(-9) < b.slice(-9) ? -1 : 1)),
      SECONDS,
      6,
    );
    expect(reversed).toEqual(first);
    expect(shuffled).toEqual(first);
    expect(dealShards(FILES, SECONDS, 6)).toEqual(first);
  });

  it('deals by measured time, so no shard runs far longer than the others', () => {
    const hands = dealShards(FILES, SECONDS, 6);
    const load = hands.map((hand) => hand.reduce((sum, file) => sum + SECONDS[file]!, 0));
    const heaviest = Math.max(...Object.values(SECONDS));
    // A greedy deal by time is within one file of the lightest shard.
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(heaviest);
  });

  it('spreads files whose names sort together', () => {
    const files = [...FILES, 'people-a.spec.ts', 'people-b.spec.ts', 'people-c.spec.ts'];
    const seconds = {
      ...SECONDS,
      'people-a.spec.ts': 900,
      'people-b.spec.ts': 900,
      'people-c.spec.ts': 900,
    };
    const hands = dealShards(files, seconds, 6);
    const holding = (file: string) => hands.findIndex((hand) => hand.includes(file));
    expect(
      new Set(['people-a', 'people-b', 'people-c'].map((p) => holding(`${p}.spec.ts`))).size,
    ).toBe(3);
  });

  it('runs each hand in alphabetical order', () => {
    for (const hand of dealShards(FILES, SECONDS, 6)) expect(hand).toEqual([...hand].sort());
  });

  it('weighs a file with no timing yet at the median of those measured', () => {
    expect(defaultSeconds(['a', 'b', 'c', 'new'], { a: 10, b: 30, c: 200 })).toBe(30);
    expect(defaultSeconds(['a', 'b', 'new'], { a: 10, b: 30 })).toBe(20);
    expect(defaultSeconds(['new'], {})).toBe(1);
    const files = [...FILES, 'brand-new.spec.ts'];
    expect(new Set(dealShards(files, SECONDS, 6).flat())).toEqual(new Set(files));
  });

  it('ignores a timing for a file no longer in the suite', () => {
    const hands = dealShards(FILES, { ...SECONDS, 'deleted.spec.ts': 10_000 }, 6);
    expect(hands).toEqual(dealShards(FILES, SECONDS, 6));
  });

  it('refuses a shard count below one, and a file listed twice', () => {
    expect(() => dealShards(FILES, SECONDS, 0)).toThrow();
    expect(() => dealShards([...FILES, FILES[0]!], SECONDS, 6)).toThrow(/twice/);
  });

  it('refuses a worker count below one', () => {
    expect(() => dealShards(FILES, SECONDS, 6, { workers: 0 })).toThrow(/worker/);
    expect(() => dealShards(FILES, SECONDS, 6, { workers: 1.5 })).toThrow(/worker/);
  });
});

/**
 * A shard runs its serial files at one worker and the rest at the parallel pass's workers, so a
 * file costs its shard's wall time its seconds when serial and its seconds over the workers when
 * parallel: the deal weighs each file by that share.
 */
describe('dealShards by wall time', () => {
  it('weighs a parallel file at half its seconds at two workers, and a serial one at its seconds', () => {
    const seconds = { 'a.spec.ts': 100, 'b.spec.ts': 120, 'c.spec.ts': 90 };
    const files = Object.keys(seconds);
    const weight = fileWeight(files, seconds, { serial: ['a.spec.ts'], workers: 2 });
    expect(files.map(weight)).toEqual([100, 60, 45]);
    // By seconds alone b leads and a waits on c; by wall time the serial a weighs most.
    expect(dealShards(files, seconds, 2)).toEqual([['b.spec.ts'], ['a.spec.ts', 'c.spec.ts']]);
    expect(dealShards(files, seconds, 2, { serial: ['a.spec.ts'], workers: 2 })).toEqual([
      ['a.spec.ts'],
      ['b.spec.ts', 'c.spec.ts'],
    ]);
  });

  it('deals as by seconds alone with no serial file at one worker', () => {
    for (const total of [1, 4, 6]) {
      expect(dealShards(FILES, SECONDS, total, { serial: [], workers: 1 })).toEqual(
        dealShards(FILES, SECONDS, total),
      );
      // At one worker a serial file and a parallel one cost the same, so the list changes nothing.
      expect(dealShards(FILES, SECONDS, total, { serial: FILES.slice(0, 5), workers: 1 })).toEqual(
        dealShards(FILES, SECONDS, total),
      );
    }
  });

  it('weighs a file with no timing yet at the median of those measured, divided when parallel', () => {
    const seconds = { 'a.spec.ts': 10, 'b.spec.ts': 30, 'c.spec.ts': 200 };
    const files = [...Object.keys(seconds), 'new.spec.ts'];
    expect(fileWeight(files, seconds, { workers: 2 })('new.spec.ts')).toBe(15);
    expect(fileWeight(files, seconds, { serial: ['new.spec.ts'], workers: 2 })('new.spec.ts')).toBe(
      30,
    );
    expect(fileWeight(files, seconds)('new.spec.ts')).toBe(30);
  });

  it("evens the shards' wall time over a hand of serial and parallel files", () => {
    const seconds = {
      'a-serial.spec.ts': 120,
      'b-serial.spec.ts': 100,
      'c.spec.ts': 200,
      'd.spec.ts': 160,
      'e.spec.ts': 120,
      'f.spec.ts': 80,
      'g.spec.ts': 60,
      'h.spec.ts': 40,
    };
    const files = Object.keys(seconds);
    const options = { serial: ['a-serial.spec.ts', 'b-serial.spec.ts'], workers: 2 };
    const hands = dealShards(files, seconds, 2, options);
    expect(hands).toEqual([
      ['a-serial.spec.ts', 'd.spec.ts', 'e.spec.ts', 'h.spec.ts'],
      ['b-serial.spec.ts', 'c.spec.ts', 'f.spec.ts', 'g.spec.ts'],
    ]);
    const weight = fileWeight(files, seconds, options);
    const wall = hands.map((hand) => hand.reduce((sum, file) => sum + weight(file), 0));
    expect(wall).toEqual([280, 270]);
    expect(Math.max(...wall) - Math.min(...wall)).toBeLessThanOrEqual(
      Math.max(...files.map(weight)),
    );
    // Dealt by seconds alone, the same files run 220 and 330 seconds of wall time.
    const bySeconds = dealShards(files, seconds, 2).map((hand) =>
      hand.reduce((sum, file) => sum + weight(file), 0),
    );
    expect(bySeconds).toEqual([220, 330]);
  });
});

describe('parseShard', () => {
  it('reads "current/total", 1-based', () => {
    expect(parseShard('3/6')).toEqual({ current: 3, total: 6 });
    for (const bad of ['0/6', '7/6', '3', 'a/b', '3/0', ''])
      expect(() => parseShard(bad)).toThrow();
  });
});

describe('fileFilter', () => {
  /** As Playwright reads a command-line filter: `/source/flags` is a regular expression. */
  function asPlaywrightReadsIt(filter: string): RegExp {
    const match = filter.match(/^\/(.*)\/([gi]*)$/);
    expect(match, 'the filter is in /source/flags form').not.toBeNull();
    return new RegExp(match![1]!, match![2]);
  }
  const root = '/repo/front-end/e2e';
  const paths = [
    `${root}/tables.spec.ts`,
    `${root}/the-tables.spec.ts`,
    `${root}/tables.spec.tsx`,
    `${root}/sub/tables.spec.ts`,
    `/other/front-end/e2e/tables.spec.ts`,
  ];

  it('matches only its own file, not one whose name ends the same', () => {
    const re = asPlaywrightReadsIt(fileFilter(root, 'tables.spec.ts'));
    expect(paths.filter((path) => re.test(path))).toEqual([`${root}/tables.spec.ts`]);
  });

  it('takes a file in a folder, and a name with a dot or a plus in it', () => {
    expect(asPlaywrightReadsIt(fileFilter(root, 'sub/tables.spec.ts')).test(paths[3]!)).toBe(true);
    const odd = asPlaywrightReadsIt(fileFilter(root, 'a+b.c.spec.ts'));
    expect(odd.test(`${root}/a+b.c.spec.ts`)).toBe(true);
    expect(odd.test(`${root}/aab.c.spec.ts`)).toBe(false);
    expect(odd.test(`${root}/a+bxc.spec.ts`)).toBe(false);
  });
});

describe('specFiles', () => {
  it('lists each spec file a Playwright report names, once, in order', () => {
    expect(specFiles(report({ 'b.spec.ts': [[1]], 'a.spec.ts': [[1]] }))).toEqual([
      'a.spec.ts',
      'b.spec.ts',
    ]);
  });
});

describe('secondsFromReports', () => {
  it("sums every attempt of every test by spec file, across the shards' reports", () => {
    const shard1 = report({ 'a.spec.ts': [[1500], [2000, 2500]], 'b.spec.ts': [[100]] });
    const shard2 = report({ 'c.spec.ts': [[60_000]] });
    expect(secondsFromReports([shard1, shard2])).toEqual({
      'a.spec.ts': 6,
      'b.spec.ts': 0.1,
      'c.spec.ts': 60,
    });
  });

  it('writes the files in alphabetical order, so a refresh diffs line by line', () => {
    const seconds = secondsFromReports([report({ 'z.spec.ts': [[1000]], 'a.spec.ts': [[1000]] })]);
    expect(Object.keys(seconds)).toEqual(['a.spec.ts', 'z.spec.ts']);
  });
});

describe('timingsFromReports', () => {
  const listed = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'];

  it('times every listed spec file from the reports', () => {
    const shard1 = report({ 'a.spec.ts': [[1000]], 'b.spec.ts': [[2000]] });
    const shard2 = report({ 'c.spec.ts': [[3000]] });
    expect(timingsFromReports(listed, [shard1, shard2])).toEqual({
      'a.spec.ts': 1,
      'b.spec.ts': 2,
      'c.spec.ts': 3,
    });
  });

  it("refuses when a shard's report is missing, naming each spec file it would drop", () => {
    // A shard that stopped before Playwright wrote its report uploads nothing, and its files would
    // fall back to the median, a heavy one dealt as a light one.
    const shard1 = report({ 'a.spec.ts': [[1000]] });
    expect(() => timingsFromReports(listed, [shard1])).toThrow(
      /2 listed spec files are in no report: b\.spec\.ts, c\.spec\.ts/,
    );
  });

  it('leaves out a reported spec file the suite no longer lists', () => {
    const shard1 = report({ 'a.spec.ts': [[1000]], 'b.spec.ts': [[2000]], 'c.spec.ts': [[1]] });
    const shard2 = report({ 'deleted.spec.ts': [[5000]] });
    expect(Object.keys(timingsFromReports(listed, [shard1, shard2]))).toEqual(listed);
  });
});

describe('refreshTimings', () => {
  const listed = ['a.spec.ts', 'b.spec.ts', 'new.spec.ts'];

  it("is one run's timings when given one run", () => {
    const run = [report({ 'a.spec.ts': [[1000]], 'b.spec.ts': [[2000]], 'new.spec.ts': [[3000]] })];
    expect(refreshTimings(listed, [run])).toEqual(timingsFromReports(listed, run));
  });

  it('blends the runs oldest first, a file new in a later run starting at its own time', () => {
    const older = [report({ 'a.spec.ts': [[10_000]], 'b.spec.ts': [[20_000]] })];
    const newer = [
      report({ 'a.spec.ts': [[20_000]], 'b.spec.ts': [[20_000]], 'new.spec.ts': [[5000]] }),
    ];
    expect(refreshTimings(listed, [older, newer])).toEqual({
      'a.spec.ts': 13,
      'b.spec.ts': 20,
      'new.spec.ts': 5,
    });
  });

  it('refuses when the newest run is not whole, as one run does', () => {
    const older = [report({ 'a.spec.ts': [[1000]], 'b.spec.ts': [[1000]], 'new.spec.ts': [[1]] })];
    const newer = [report({ 'a.spec.ts': [[1000]] })];
    expect(() => refreshTimings(listed, [older, newer])).toThrow(/in no report/);
  });
});

describe('parseTimings', () => {
  it("reads a file's seconds by spec file", () => {
    expect(parseTimings('{"a.spec.ts": 1.5, "b.spec.ts": 0}')).toEqual({
      'a.spec.ts': 1.5,
      'b.spec.ts': 0,
    });
  });

  it('refuses anything else, so a corrupt artifact is never dealt by', () => {
    for (const bad of [
      'not json',
      '[]',
      'null',
      '3',
      '{}',
      '{"a.spec.ts": "12"}',
      '{"a.spec.ts": -1}',
      '{"a.spec.ts": 1e999}',
      '{"a.spec.ts": null}',
    ])
      expect(() => parseTimings(bad), bad).toThrow();
  });
});

describe('blendTimings', () => {
  it(`weighs this run at ${BLEND_WEIGHT} against the timings it dealt by`, () => {
    expect(BLEND_WEIGHT).toBe(0.3);
    expect(blendTimings({ 'a.spec.ts': 100 }, { 'a.spec.ts': 200 }, ['a.spec.ts'])).toEqual({
      'a.spec.ts': 130,
    });
  });

  it('times a file new to the timings by this run alone, and keeps a file this run did not time', () => {
    expect(
      blendTimings({ 'old.spec.ts': 40 }, { 'new.spec.ts': 7.25 }, ['old.spec.ts', 'new.spec.ts']),
    ).toEqual({ 'new.spec.ts': 7.3, 'old.spec.ts': 40 });
  });

  it('leaves out a file not listed, and writes the files in alphabetical order', () => {
    const blended = blendTimings(
      { 'z.spec.ts': 1, 'gone.spec.ts': 5 },
      { 'a.spec.ts': 1, 'z.spec.ts': 1 },
      ['z.spec.ts', 'a.spec.ts'],
    );
    expect(Object.keys(blended)).toEqual(['a.spec.ts', 'z.spec.ts']);
  });

  it('refuses a listed file timed by neither', () => {
    expect(() => blendTimings({}, {}, ['a.spec.ts'])).toThrow(/a\.spec\.ts/);
  });
});

describe('chooseTimingsArtifacts', () => {
  const REPO = 7;
  // The run's creation as data, 2026-11-20T12:00:00Z, so each artifact's time is written from it.
  const CREATED_MS = Date.UTC(2026, 10, 20, 12);
  const created = new Date(CREATED_MS);
  const before = (minutes: number) =>
    new Date(CREATED_MS - minutes * 60_000).toISOString().replace('.000', '');
  function artifact(
    id: number,
    createdAt: string,
    workflowRun: { head_branch?: string; repository_id?: number; head_repository_id?: number } = {},
    extra: { name?: string; expired?: boolean } = {},
  ) {
    return {
      id,
      name: extra.name ?? TIMINGS_ARTIFACT,
      expired: extra.expired ?? false,
      created_at: createdAt,
      workflow_run: {
        id: id * 10,
        head_branch: 'dev',
        repository_id: REPO,
        head_repository_id: REPO,
        ...workflowRun,
      },
    };
  }
  const ids = (list: { id: number }[]) => list.map((a) => a.id);

  it('takes the newest made a margin before the run was created, whatever order they are listed in', () => {
    expect(TIMINGS_MARGIN_MS).toBe(10 * 60_000);
    const listed = [artifact(1, before(60)), artifact(3, before(11)), artifact(2, before(30))];
    expect(ids(chooseTimingsArtifacts(listed, REPO, created))).toEqual([3, 2, 1]);
  });

  it('skips one made within the margin or after the run was created, so a re-run picks the same', () => {
    const first = [artifact(1, before(30)), artifact(2, before(9))];
    const onARerun = [...first, artifact(3, before(-5)), artifact(4, before(-60 * 24))];
    expect(ids(chooseTimingsArtifacts(first, REPO, created))[0]).toBe(1);
    expect(ids(chooseTimingsArtifacts(onARerun, REPO, created))[0]).toBe(1);
  });

  it("takes a merge queue trial commit's, and none from another branch, a fork, another name or past its expiry", () => {
    const listed = [
      artifact(1, before(90), { head_branch: 'gh-readonly-queue/dev/pr-1-abc' }),
      artifact(2, before(80), { head_branch: 'feat/something' }),
      artifact(3, before(70), { head_branch: 'main' }),
      artifact(4, before(60), { head_repository_id: 99 }),
      artifact(5, before(50), {}, { name: 'e2e-results-shard-1' }),
      artifact(6, before(40), {}, { expired: true }),
      artifact(7, before(30), { repository_id: 99, head_repository_id: 99 }),
      artifact(8, before(20), { head_branch: 'gh-readonly-queue/main/pr-1-abc' }),
    ];
    expect(ids(chooseTimingsArtifacts(listed, REPO, created))).toEqual([1]);
  });

  it('takes none when none was made before the margin', () => {
    expect(chooseTimingsArtifacts([artifact(1, before(5))], REPO, created)).toEqual([]);
  });
});

describe('trustedRun', () => {
  const run = {
    id: 1,
    event: 'push',
    head_branch: 'dev',
    path: '.github/workflows/test.yml',
    repository: { id: 7 },
    head_repository: { id: 7 },
  };

  it("trusts the Test workflow's run on a push to dev, a schedule on dev or a merge queue trial commit", () => {
    expect(trustedRun(run, 7)).toBe(true);
    expect(trustedRun({ ...run, event: 'schedule' }, 7)).toBe(true);
    expect(
      trustedRun({ ...run, event: 'merge_group', head_branch: 'gh-readonly-queue/dev/pr-1' }, 7),
    ).toBe(true);
  });

  it('trusts no pull request, other branch, other workflow or other repository', () => {
    expect(trustedRun({ ...run, event: 'pull_request' }, 7)).toBe(false);
    expect(trustedRun({ ...run, event: 'workflow_dispatch' }, 7)).toBe(false);
    expect(trustedRun({ ...run, event: 'schedule', head_branch: 'main' }, 7)).toBe(false);
    expect(trustedRun({ ...run, head_branch: 'main' }, 7)).toBe(false);
    expect(trustedRun({ ...run, path: '.github/workflows/codeql.yml' }, 7)).toBe(false);
    expect(trustedRun({ ...run, head_repository: { id: 8 } }, 7)).toBe(false);
    expect(trustedRun(run, 8)).toBe(false);
  });
});

const COMMITTED_FILE = 'the committed scripts/e2e-shard-timings.json';

describe('checkShards', () => {
  const files = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts'];
  const timings: Record<string, number> = {
    'a.spec.ts': 4,
    'b.spec.ts': 3,
    'c.spec.ts': 2,
    'd.spec.ts': 1,
  };
  const SOURCE = "run 5's e2e-shard-timings";
  function shards(
    total = 2,
    source = SOURCE,
    dealtBy: Record<string, number> = timings,
    deal: Pick<DealRecord, 'serial' | 'workers'> = {},
  ) {
    return dealShards(files, dealtBy, total, deal).map((hand, n) => ({
      shard: n + 1,
      deal: {
        shard: n + 1,
        total,
        source,
        timings: dealtBy,
        files,
        hand,
        ...deal,
      } satisfies DealRecord,
      report: report(Object.fromEntries(hand.map((file) => [file, [[timings[file]! * 1000]]]))),
    }));
  }

  it('passes when the shards dealt alike and their reports hold every spec file once', () => {
    const { problems, seconds } = checkShards(shards());
    expect(problems).toEqual([]);
    expect(seconds).toEqual([5, 5]);
  });

  it('names a shard whose deal record or report is missing, as when its upload failed', () => {
    const [one, two] = shards();
    expect(checkShards([one!]).problems).toEqual([
      'shard 2/2 uploaded no deal record',
      'shard 2/2 uploaded no report',
      'b.spec.ts, c.spec.ts ran on no shard',
    ]);
    expect(checkShards([one!, { ...two!, report: undefined }]).problems).toContain(
      'shard 2/2 uploaded no report',
    );
  });

  it('names shards that dealt by different timings', () => {
    const [one] = shards();
    const [, two] = shards(2, 'the committed scripts/e2e-shard-timings.json', {
      ...timings,
      'd.spec.ts': 9,
    });
    expect(checkShards([one!, two!]).problems[0]).toMatch(
      /^the shards dealt by different timings: shard 1 by run 5's e2e-shard-timings; shard 2 by the committed/,
    );
  });

  it('passes shards that fell back to the committed file for different reasons', () => {
    // One shard's lookup failed while the others found no artifact: the same timings, so the same
    // hands, though the words of their source differ.
    const [one] = shards(
      2,
      `${COMMITTED_FILE} (no trusted e2e-shard-timings artifact made before 2026-11-20T11:50:00Z)`,
    );
    const [, two] = shards(2, `${COMMITTED_FILE} (GitHub's API failed: GitHub answered 502 to /x)`);
    expect(checkShards([one!, two!]).problems).toEqual([]);
  });

  it('names a spec file run twice or by no shard, and a report that holds other files than its hand', () => {
    const [one, two] = shards();
    const twice = { ...two!, report: report({ 'a.spec.ts': [[1]], 'b.spec.ts': [[1]] }) };
    expect(checkShards([one!, twice]).problems).toEqual([
      'shard 2/2 was dealt b.spec.ts, c.spec.ts but its report holds a.spec.ts, b.spec.ts',
      'a.spec.ts ran on more than one shard',
      'c.spec.ts ran on no shard',
    ]);
  });

  it('names shards that dealt by different serial files', () => {
    const [one] = shards(2, SOURCE, timings, { serial: ['a.spec.ts'], workers: 2 });
    const [, two] = shards(2, SOURCE, timings, { serial: ['a.spec.ts', 'b.spec.ts'], workers: 2 });
    expect(checkShards([one!, two!]).problems[0]).toBe(
      `the shards dealt by different serial files: shard 1 by ${SOURCE}, 1 serial file; ` +
        `shard 2 by ${SOURCE}, 2 serial files`,
    );
  });

  it('names shards that dealt by different worker counts', () => {
    const [one] = shards(2, SOURCE, timings, { serial: ['a.spec.ts'], workers: 2 });
    const [, two] = shards(2, SOURCE, timings, { serial: ['a.spec.ts'], workers: 3 });
    expect(checkShards([one!, two!]).problems[0]).toBe(
      `the shards dealt by different worker counts: shard 1 by ${SOURCE}, 2 workers; ` +
        `shard 2 by ${SOURCE}, 3 workers`,
    );
  });

  it('reads a deal record from before the passes as no serial file at one worker', () => {
    const [oldOne, oldTwo] = shards();
    expect(checkShards([oldOne!, oldTwo!]).problems).toEqual([]);
    const [, newTwo] = shards(2, SOURCE, timings, { serial: ['a.spec.ts'], workers: 2 });
    expect(checkShards([oldOne!, newTwo!]).problems[0]).toBe(
      'the shards dealt by different serial files and worker counts: ' +
        `shard 1 by ${SOURCE}, no serial file, 1 worker; shard 2 by ${SOURCE}, 1 serial file, 2 workers`,
    );
    const [, sameTwo] = shards(2, SOURCE, timings, { serial: [], workers: 1 });
    expect(checkShards([oldOne!, sameTwo!]).problems).toEqual([]);
  });

  it('refuses with no deal record at all', () => {
    expect(checkShards([]).problems).toEqual(['no shard uploaded a deal record']);
  });
});

describe('dealtBy', () => {
  const deal = (shard: number, source: string): DealRecord => ({
    shard,
    total: 3,
    source,
    timings: {},
    files: [],
    hand: [],
  });

  it('names the one source every shard dealt by', () => {
    expect(dealtBy([deal(1, 'A'), deal(2, 'A'), deal(3, 'A')])).toBe('A');
  });

  it('names each source and its shards when they differ', () => {
    expect(dealtBy([deal(3, 'A'), deal(1, 'A'), deal(2, 'B')])).toBe(
      'A (shards 1, 3); B (shard 2)',
    );
  });

  it('says when no shard recorded one', () => {
    expect(dealtBy([])).toBe('no timings any shard recorded');
  });
});

describe('publishedTimings', () => {
  it('blends the timings the run dealt by with what its shards measured', () => {
    const files = ['a.spec.ts', 'b.spec.ts'];
    const timings = { 'a.spec.ts': 10, 'b.spec.ts': 10 };
    const deal = (shard: number, hand: string[]): DealRecord => ({
      shard,
      total: 2,
      source: 'x',
      timings,
      files,
      hand,
    });
    expect(
      publishedTimings([
        { shard: 1, deal: deal(1, ['a.spec.ts']), report: report({ 'a.spec.ts': [[20_000]] }) },
        { shard: 2, deal: deal(2, ['b.spec.ts']), report: report({ 'b.spec.ts': [[10_000]] }) },
      ]),
    ).toEqual({ 'a.spec.ts': 13, 'b.spec.ts': 10 });
  });
});

describe('shardSummary', () => {
  it("names the timings' source, each shard's seconds and the spread", () => {
    const text = shardSummary("run 5's e2e-shard-timings", [600, 750.4, 700], []);
    expect(text).toContain("Dealt by run 5's e2e-shard-timings.");
    expect(text).toContain('| 2/3 | 750 |');
    expect(text).toContain('Spread: 150 seconds between the fastest and the slowest shard');
  });

  it('lists the problems the check found', () => {
    expect(shardSummary('x', [1], ['c.spec.ts ran on no shard'])).toContain(
      '- c.spec.ts ran on no shard',
    );
  });

  const phase = (name: Phase['name'], seconds: number): Phase => ({
    name,
    files: 3,
    seconds,
    status: 0,
  });

  it("gives each shard's serial and parallel pass, and the spread over their sum", () => {
    const text = shardSummary(
      'x',
      [600, 750.4, 700],
      [],
      [
        [phase('serial', 120.4), phase('parallel', 500)],
        [phase('parallel', 800)],
        [phase('serial', 100), phase('parallel', 650)],
      ],
    );
    expect(text).toContain('| Shard | Seconds of tests | Serial pass | Parallel pass |');
    expect(text).toContain('| 1/3 | 600 | 120 | 500 |');
    expect(text).toContain('| 2/3 | 750 | - | 800 |');
    expect(text).toContain('| 3/3 | 700 | 100 | 650 |');
    expect(text).toContain(
      "Spread: 180 seconds between the fastest and the slowest shard's passes (22% of the slowest).",
    );
  });

  it('gives a dash for a shard with no phases, and the spread by seconds of tests unless every shard has them', () => {
    const text = shardSummary(
      'x',
      [600, 750.4, 700],
      [],
      [[phase('serial', 120), phase('parallel', 500)], undefined, [phase('parallel', 650)]],
    );
    expect(text).toContain('| 2/3 | 750 | - | - |');
    expect(text).toContain('| 3/3 | 700 | - | 650 |');
    expect(text).toContain(
      'Spread: 150 seconds between the fastest and the slowest shard (20% of the slowest).',
    );
    expect(shardSummary('x', [600, 750], [])).toContain('| 2/2 | 750 | - | - |');
  });
});

describe('chooseTimings', () => {
  // GitHub's answers, written by hand in the shapes its REST API gives: this run, made at noon, the
  // list of `e2e-shard-timings` artifacts, each artifact's run, and the artifacts' contents.
  const REPOSITORY = 'owner/repo';
  const RUN = {
    id: 100,
    event: 'pull_request',
    head_branch: 'a-branch',
    path: '.github/workflows/test.yml',
    created_at: '2026-11-20T12:00:00Z',
    repository: { id: 7 },
    head_repository: { id: 7 },
  };
  const devRun = (id: number) => ({ ...RUN, id, event: 'push', head_branch: 'dev' });
  const artifact = (id: number, runId: number, createdAt: string) => ({
    id,
    name: TIMINGS_ARTIFACT,
    expired: false,
    created_at: createdAt,
    workflow_run: { id: runId, head_branch: 'dev', repository_id: 7, head_repository_id: 7 },
  });
  const COMMITTED = JSON.parse(readFileSync(timingsFile(), 'utf8'));

  function github(answers: {
    runs?: Record<number, unknown>;
    artifacts?: unknown[];
    texts?: Record<number, string>;
    failing?: string;
  }): GitHubReads & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      async json(path) {
        asked.push(path);
        if (answers.failing && path.includes(answers.failing))
          throw new Error('GitHub answered 503');
        if (path.startsWith(`/repos/${REPOSITORY}/actions/artifacts?name=${TIMINGS_ARTIFACT}`)) {
          // GitHub's pages of 100, newest first.
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
          const all = answers.artifacts ?? [];
          return { total_count: all.length, artifacts: all.slice((page - 1) * 100, page * 100) };
        }
        const run = /\/actions\/runs\/(\d+)$/.exec(path);
        const found = run ? { [RUN.id]: RUN, ...answers.runs }[Number(run[1])] : undefined;
        if (!found) throw new Error(`GitHub answered 404 to ${path}`);
        return found;
      },
      async artifactText(repository, id) {
        asked.push(`zip ${repository} ${id}`);
        if (answers.failing === 'zip') throw new Error('unzip exited 9');
        return answers.texts?.[id] ?? '';
      },
    };
  }

  it('takes the newest trusted artifact made ten minutes before this run was created', async () => {
    const gh = github({
      runs: { 51: devRun(51), 52: devRun(52) },
      artifacts: [
        artifact(902, 52, '2026-11-20T11:55:00Z'),
        artifact(901, 51, '2026-11-20T11:40:00Z'),
        artifact(900, 51, '2026-11-20T09:00:00Z'),
      ],
      texts: { 901: '{"a.spec.ts": 12.5}' },
    });
    expect(await chooseTimings(gh, REPOSITORY, '100')).toEqual({
      source: "run 51's e2e-shard-timings (artifact 901, made 2026-11-20T11:40:00Z)",
      timings: { 'a.spec.ts': 12.5 },
    });
    expect(gh.asked).toContain(`zip ${REPOSITORY} 901`);
  });

  it('reads on past a page of newer artifacts, as a re-run days later does', async () => {
    const newer = Array.from({ length: 150 }, (_, n) =>
      artifact(
        2000 - n,
        52,
        new Date(Date.parse('2026-11-23T00:00:00Z') - n * 60_000).toISOString(),
      ),
    );
    const gh = github({
      runs: { 51: devRun(51), 52: devRun(52) },
      artifacts: [...newer, artifact(901, 51, '2026-11-20T11:40:00Z')],
      texts: { 901: '{"a.spec.ts": 12.5}' },
    });
    expect((await chooseTimings(gh, REPOSITORY, '100')).source).toMatch(/\(artifact 901, /);
    expect(gh.asked.filter((path) => path.includes('artifacts?name'))).toHaveLength(2);
  });

  // GitHub lists artifacts by id, newest first, and ids are not quite in the order the artifacts
  // were made: one made 15 minutes later may list below the other.
  const madeAfterTheRun = (count: number, firstId: number) =>
    Array.from({ length: count }, (_, n) => artifact(firstId - n, 52, '2026-11-20T12:05:00Z'));

  it('takes the newest made before the margin when ids list an older one above it', async () => {
    const gh = github({
      runs: { 51: devRun(51) },
      artifacts: [
        ...madeAfterTheRun(99, 5000),
        artifact(1000, 51, '2026-11-20T11:00:00Z'),
        artifact(999, 51, '2026-11-20T11:30:00Z'),
        artifact(998, 51, '2026-11-20T08:00:00Z'),
      ],
      texts: { 999: '{"a.spec.ts": 1}', 1000: '{"a.spec.ts": 2}' },
    });
    expect((await chooseTimings(gh, REPOSITORY, '100')).source).toMatch(/\(artifact 999, /);
  });

  it('takes the same artifact whichever page boundary falls between them', async () => {
    const choose = async (newer: number) => {
      const gh = github({
        runs: { 51: devRun(51) },
        artifacts: [
          ...madeAfterTheRun(newer, 5000),
          artifact(1000, 51, '2026-11-20T11:00:00Z'),
          artifact(999, 51, '2026-11-20T11:30:00Z'),
          artifact(998, 51, '2026-11-20T08:00:00Z'),
        ],
        texts: { 999: '{"a.spec.ts": 1}', 1000: '{"a.spec.ts": 2}' },
      });
      return (await chooseTimings(gh, REPOSITORY, '100')).source;
    };
    const chosen = await Promise.all([98, 99, 100, 101].map(choose));
    expect(new Set(chosen).size).toBe(1);
    expect(chosen[0]).toMatch(/\(artifact 999, /);
  });

  it('passes over an artifact whose run is not a push to dev or a trial commit', async () => {
    const pullRequest = { ...RUN, id: 52, head_branch: 'dev' };
    const gh = github({
      runs: { 51: devRun(51), 52: pullRequest },
      artifacts: [
        artifact(902, 52, '2026-11-20T11:40:00Z'),
        artifact(901, 51, '2026-11-20T11:00:00Z'),
      ],
      texts: { 901: '{"a.spec.ts": 1}', 902: '{"a.spec.ts": 999}' },
    });
    expect((await chooseTimings(gh, REPOSITORY, '100')).source).toMatch(/^run 51's /);
  });

  it('falls back to the committed file with none made before the margin', async () => {
    const gh = github({
      runs: { 52: devRun(52) },
      artifacts: [artifact(902, 52, '2026-11-20T11:55:00Z')],
    });
    expect(await chooseTimings(gh, REPOSITORY, '100')).toEqual({
      source:
        'the committed scripts/e2e-shard-timings.json ' +
        '(no trusted e2e-shard-timings artifact made before 2026-11-20T11:50:00Z)',
      timings: COMMITTED,
    });
  });

  it('falls back to the committed file on a corrupt artifact, never trying an older one', async () => {
    const gh = github({
      runs: { 51: devRun(51) },
      artifacts: [
        artifact(901, 51, '2026-11-20T11:00:00Z'),
        artifact(900, 51, '2026-11-20T10:00:00Z'),
      ],
      texts: { 901: '{"a.spec.ts": "soon"}', 900: '{"a.spec.ts": 1}' },
    });
    const chosen = await chooseTimings(gh, REPOSITORY, '100');
    expect(chosen.source).toMatch(
      /^the committed scripts\/e2e-shard-timings\.json \(run 51's e2e-shard-timings \(artifact 901, made 2026-11-20T11:00:00Z\) could not be read: the timing of a\.spec\.ts is "soon", not seconds\)$/,
    );
    expect(chosen.timings).toEqual(COMMITTED);
    expect(gh.asked).not.toContain(`zip ${REPOSITORY} 900`);
  });

  it("falls back to the committed file when GitHub's API or the zip fails", async () => {
    for (const failing of ['/actions/runs/100', 'artifacts?name', '/actions/runs/51', 'zip']) {
      const gh = github({
        runs: { 51: devRun(51) },
        artifacts: [artifact(901, 51, '2026-11-20T11:00:00Z')],
        texts: { 901: '{"a.spec.ts": 1}' },
        failing,
      });
      const chosen = await chooseTimings(gh, REPOSITORY, '100');
      expect(chosen.source, failing).toMatch(/^the committed scripts\/e2e-shard-timings\.json \(/);
      expect(chosen.timings).toEqual(COMMITTED);
    }
  });

  it('deals by the committed file outside a GitHub Actions run, asking GitHub nothing', async () => {
    const gh = github({});
    expect((await chooseTimings(gh, undefined, undefined)).source).toBe(
      'the committed scripts/e2e-shard-timings.json (not in a GitHub Actions run)',
    );
    expect(gh.asked).toEqual([]);
  });
});

describe('serialFiles', () => {
  it("names the hand's files Playwright lists under the serial project, once each, in order", () => {
    const listed = {
      suites: [
        { file: 'b.spec.ts', specs: [{ tests: [{ projectName: SERIAL_PROJECT }] }] },
        { file: 'a.spec.ts', specs: [{ tests: [{ projectName: 'chromium' }] }] },
        {
          file: 'c.spec.ts',
          suites: [{ specs: [{ tests: [{ projectName: SERIAL_PROJECT }] }] }],
          specs: [{ tests: [{ projectName: SERIAL_PROJECT }] }],
        },
      ],
    };
    expect(serialFiles(listed)).toEqual(['b.spec.ts', 'c.spec.ts']);
  });
});

describe('passes', () => {
  it("runs the hand's serial files first, in the serial project, then the rest in the parallel one", () => {
    expect(
      passes(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts'], ['d.spec.ts', 'b.spec.ts']),
    ).toEqual([
      { name: 'serial', project: SERIAL_PROJECT, files: ['b.spec.ts', 'd.spec.ts'] },
      { name: 'parallel', project: 'chromium', files: ['a.spec.ts', 'c.spec.ts'] },
    ]);
  });

  it('leaves out a pass with no file', () => {
    expect(passes(['a.spec.ts', 'c.spec.ts'], ['b.spec.ts'])).toEqual([
      { name: 'parallel', project: 'chromium', files: ['a.spec.ts', 'c.spec.ts'] },
    ]);
    expect(passes(['b.spec.ts'], ['b.spec.ts'])).toEqual([
      { name: 'serial', project: SERIAL_PROJECT, files: ['b.spec.ts'] },
    ]);
    expect(passes([], ['b.spec.ts'])).toEqual([]);
  });

  it('puts every file of the hand in exactly one pass, and no file outside it', () => {
    const hand = ['e.spec.ts', 'a.spec.ts', 'c.spec.ts', 'b.spec.ts'];
    const run = passes(hand, ['b.spec.ts', 'x.spec.ts', 'e.spec.ts']).flatMap((pass) => pass.files);
    expect([...run].sort()).toEqual([...hand].sort());
  });
});

describe('shardStatus', () => {
  it('is 0 when every pass passed, and when no pass ran', () => {
    expect(shardStatus([0, 0])).toBe(0);
    expect(shardStatus([])).toBe(0);
  });

  it("is the first pass's failure, and a later pass's when the first passed", () => {
    expect(shardStatus([2, 1])).toBe(2);
    expect(shardStatus([0, 1])).toBe(1);
  });

  it('counts a pass ended by a signal, which has no status, as a failure', () => {
    expect(shardStatus([0, null])).toBe(1);
  });
});

describe('mergeReports', () => {
  it("joins the passes' files and sums their counts, so one report holds the shard's hand", () => {
    const serial = {
      ...report({ 'b.spec.ts': [[100]] }),
      errors: [{ message: 'one' }],
      stats: {
        startTime: '2026-11-24T00:00:00Z',
        duration: 10,
        expected: 1,
        unexpected: 0,
        flaky: 1,
        skipped: 0,
      },
    };
    const parallel = {
      ...report({ 'a.spec.ts': [[200]] }),
      errors: [],
      stats: {
        startTime: '2026-11-24T00:01:00Z',
        duration: 20,
        expected: 2,
        unexpected: 1,
        flaky: 0,
        skipped: 3,
      },
    };
    const merged = mergeReports([serial, parallel]);
    expect(specFiles(merged)).toEqual(['a.spec.ts', 'b.spec.ts']);
    expect(merged.config).toEqual(serial.config);
    expect(merged.errors).toEqual([{ message: 'one' }]);
    expect(merged.stats).toEqual({
      startTime: '2026-11-24T00:00:00Z',
      duration: 30,
      expected: 3,
      unexpected: 1,
      flaky: 1,
      skipped: 3,
    });
  });
});
