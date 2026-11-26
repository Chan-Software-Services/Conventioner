/**
 * The e2e shards (T234): deals the Playwright spec files to CI's shards by measured time, runs one
 * shard's hand, and keeps the timings fresh from CI's own runs.
 *
 * Playwright's own `--shard` cuts the alphabetical list of spec files into runs of equal test count,
 * whatever the tests cost: on its first six-shard run the three people-at-scale files, whose names
 * sort together, all landed on one shard, which ran 24 minutes of tests while another ran 6. Here
 * every shard lists the suite itself, deals each spec file to the shard with the least wall time so
 * far, heaviest first, and runs its own hand. A file weighs its timing when it is on the serial list,
 * which runs one file at a time, and its timing over the parallel pass's workers when it is not. The
 * dealing depends only on the list, the timings, the serial list and the workers, so every runner
 * given the same ones deals the same hands, and each file is in exactly one. A spec file with no
 * timing yet weighs the median of those measured, divided as any other.
 *
 * The timings refresh themselves, with no hand step. In CI each shard first takes them with
 *
 *   node scripts/e2e-shards.ts timings <out file>
 *
 * which picks the newest `e2e-shard-timings` artifact made at least ten minutes before its own run
 * was created, by a Test run on a push to `dev` or a merge queue trial commit.
 * A run's creation time stays the same on every re-run, and an artifact never changes once made,
 * so every shard of a run, and every re-run of one, picks the same artifact. With no such artifact,
 * a corrupt one, or GitHub's API failing, it falls back to the committed `e2e-shard-timings.json`
 * with a warning and never fails. Then it runs its hand, as CI's `e2e-shard` job does:
 *
 *   node scripts/e2e-shards.ts --shard=3/5 --timings=<that file>
 *
 * and writes its deal record (`test-results/e2e-deal.json`: the timings' source, the timings,
 * whether it dealt the whole suite or a named list, how many spec files Playwright listed, the files
 * it dealt from, its hand, the serial files and the workers) beside Playwright's report. Without
 * `--timings` it deals by the committed file. With `--specs=<file>`, a JSON array of spec file names
 * relative to `testDir`, it deals those files alone, by the same timings, and fails before running
 * anything on a name Playwright does not list; CI passes it on a pull request whose selection named
 * specs. It runs its hand in two passes, both whatever the first's result: the files of the serial
 * list (`e2e/serialSpecs.ts`), which need the stack to themselves, at one worker, then the rest at
 * the config's workers (`E2E_WORKERS`). Each pass keeps its own output folder and HTML report
 * (`test-results/<pass>/`, `playwright-report/<pass>/`); `test-results/results.json` is their JSON
 * reports merged, and `test-results/e2e-phases.json` each pass's name, file count, wall seconds and
 * exit status. Once every shard has passed, CI's `e2e` job runs
 *
 *   node scripts/e2e-shards.ts check <dir of the shards' artifacts> [--publish=<file> | --named=<file>]
 *
 * which fails unless every shard dealt the whole suite, all by the same timings, serial files and
 * workers, and their reports hold every listed spec file exactly once. With `--named=<file>`, a list
 * as `--specs` takes, it demands instead that every shard dealt exactly those files, so only a run
 * that is asked for a selection passes on one. It writes each shard's seconds, its passes' wall
 * seconds and the spread to the job summary, opening with what ran when the check passes, and with
 * `--publish` writes the next timings: the ones the run dealt by, blended with what it measured. A
 * run that publishes timings is never a pull request's, so the two flags never come together.
 *
 * The committed file is only the fallback. Refresh it by hand from CI runs' reports, each run's
 * `e2e-results-shard-*` artifacts in a folder of their own, oldest first, the newest whole:
 *
 *   gh run download <run id> -R Chan-Software-Services/Conventioner -p 'e2e-results-shard-*' -D <dir>
 *   node scripts/e2e-shards.ts refresh <dir>...
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each spec file's measured seconds, its path relative to Playwright's `testDir`. */
export type Timings = Readonly<Record<string, number>>;

/** The committed timings, beside this script; resolved when used, so a unit test can import it. */
export const timingsFile = () => join(import.meta.dirname, 'e2e-shard-timings.json');

/** The weight of a file with no timing: the median of the files measured, or 1 when none are. */
export function defaultSeconds(files: readonly string[], seconds: Timings): number {
  const known = files
    .map((file) => seconds[file])
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (known.length === 0) return 1;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 1 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
}

/** What a shard's passes make of its hand: which files run in the serial pass, and how many
 * workers run the rest. */
export interface DealOptions {
  /** The serial list's files, which run one at a time; none when left out. */
  serial?: Iterable<string>;
  /** The parallel pass's workers; one when left out. */
  workers?: number;
}

/**
 * Each file's share of its shard's wall time: its seconds when it runs in the serial pass, one at a
 * time, and its seconds over the workers when it runs in the parallel pass, beside others. A file
 * with no timing takes the median of those measured before that division.
 */
export function fileWeight(
  files: readonly string[],
  seconds: Timings,
  { serial = [], workers = 1 }: DealOptions = {},
): (file: string) => number {
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`a worker count of ${workers}`);
  const isSerial = new Set(serial);
  const fallback = defaultSeconds(files, seconds);
  return (file) => (seconds[file] ?? fallback) / (isSerial.has(file) ? 1 : workers);
}

/**
 * The spec files dealt to `total` shards: heaviest first by their share of a shard's wall time
 * (`fileWeight`), each to the shard with the least so far (the lowest-numbered on a tie), ties
 * between files broken by name, so the hands depend on the files, their timings, the serial list and
 * the workers alone, never on the order the files were listed in. One deal over both passes' files,
 * not one per pass, so it evens each shard's two passes summed. Each hand runs in alphabetical
 * order. With no serial file and one worker it deals by the timings alone.
 */
export function dealShards(
  files: readonly string[],
  seconds: Timings,
  total: number,
  options: DealOptions = {},
): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`a shard count of ${total}`);
  const unique = new Set(files);
  if (unique.size !== files.length) {
    const twice = files.find((file, n) => files.indexOf(file) !== n);
    throw new Error(`${twice} is listed twice`);
  }
  const weight = fileWeight(files, seconds, options);
  const order = [...unique].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const hands: string[][] = Array.from({ length: total }, () => []);
  const load: number[] = Array.from({ length: total }, () => 0);
  for (const file of order) {
    const lightest = load.indexOf(Math.min(...load));
    hands[lightest]!.push(file);
    load[lightest]! += weight(file);
  }
  return hands.map((hand) => hand.sort());
}

/** `--shard`'s "current/total", 1-based. */
export function parseShard(value: string): { current: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || current < 1 || current > total) {
    throw new Error(`--shard takes "current/total", 1-based, as 3/6, not "${value}"`);
  }
  return { current, total };
}

/** The files a shard deals from: every listed file, or the named ones, with each named file
 * Playwright does not list (any makes the shard fail before it runs). */
export function filesToDeal(
  listed: readonly string[],
  named: readonly string[] | undefined,
): { scope: 'whole' | 'named'; files: string[]; unlisted: string[] } {
  if (named === undefined) return { scope: 'whole', files: [...listed], unlisted: [] };
  const files = sorted(named);
  const suite = new Set(listed);
  return { scope: 'named', files, unlisted: files.filter((file) => !suite.has(file)) };
}

/** Escapes a path for a regular expression, its slashes too, since the filter is `/source/`. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * A Playwright command-line filter matching the one spec file and no other: Playwright reads an
 * argument as an unanchored regular expression over the file's absolute path, so the bare name
 * `tables.spec.ts` would run `the-tables.spec.ts` as well.
 */
export function fileFilter(rootDir: string, file: string): string {
  return `/^${escape(`${rootDir.replace(/\/$/, '')}/${file}`)}$/`;
}

interface ReportSuite {
  file?: string;
  specs?: { tests?: { projectName?: string; results?: { duration?: number }[] }[] }[];
  suites?: ReportSuite[];
}

/** A Playwright JSON report's run-wide counts; `startTime` is when the run began. */
interface ReportStats {
  startTime?: string;
  duration?: number;
  expected?: number;
  unexpected?: number;
  flaky?: number;
  skipped?: number;
}

interface Report {
  config?: { rootDir?: string; workers?: number };
  suites?: ReportSuite[];
  errors?: unknown[];
  stats?: ReportStats;
}

/**
 * The Playwright project of the spec files that share state no second worker may touch while they
 * run (`playwright.config.ts`): a shard runs them first, at one worker, then the rest at the
 * config's workers.
 */
export const SERIAL_PROJECT = 'chromium-serial';

/** Whether a suite, or one inside it, holds a test of `project`. */
function holdsProject(suite: ReportSuite, project: string): boolean {
  return (
    (suite.specs ?? []).some((spec) => (spec.tests ?? []).some((t) => t.projectName === project)) ||
    (suite.suites ?? []).some((inner) => holdsProject(inner, project))
  );
}

/** The spec files a Playwright list names under the serial project, each once, in order. */
export function serialFiles(report: Report): string[] {
  return specFiles({
    suites: (report.suites ?? []).filter((suite) => holdsProject(suite, SERIAL_PROJECT)),
  });
}

/** The Playwright project of every spec file not in the serial list. */
export const PARALLEL_PROJECT = 'chromium';

/** One of a shard's runs of Playwright: its name, its project and the hand's files it runs. */
export interface Pass {
  name: 'serial' | 'parallel';
  project: string;
  files: string[];
}

/**
 * A shard's passes over its hand: the serial files first, then the rest, each in its hand's order
 * and each left out when it has no file, so every file of the hand runs in exactly one pass.
 */
export function passes(hand: readonly string[], serial: Iterable<string>): Pass[] {
  const isSerial = new Set(serial);
  return [
    {
      name: 'serial' as const,
      project: SERIAL_PROJECT,
      files: hand.filter((f) => isSerial.has(f)),
    },
    {
      name: 'parallel' as const,
      project: PARALLEL_PROJECT,
      files: hand.filter((f) => !isSerial.has(f)),
    },
  ].filter((pass) => pass.files.length > 0);
}

/** One pass as a shard ran it, in `test-results/e2e-phases.json`: its file count, wall seconds and
 * exit status (`null` when a signal ended it). */
export interface Phase {
  name: Pass['name'];
  files: number;
  seconds: number;
  status: number | null;
}

/**
 * A shard's exit status from its passes', in the order they ran: the first that failed, else 0. A
 * pass ended by a signal has no status, and fails.
 */
export function shardStatus(statuses: readonly (number | null)[]): number {
  for (const status of statuses) if (status !== 0) return status ?? 1;
  return 0;
}

/**
 * One report of a shard's passes, as the `e2e` job and the flaky step read it: every pass's files
 * and errors, the counts and durations summed, the first pass's config and start.
 */
export function mergeReports(reports: readonly Report[]): Report {
  const sum = (key: Exclude<keyof ReportStats, 'startTime'>) =>
    reports.reduce((total, report) => total + (report.stats?.[key] ?? 0), 0);
  return {
    config: reports[0]?.config,
    suites: reports.flatMap((report) => report.suites ?? []),
    errors: reports.flatMap((report) => report.errors ?? []),
    stats: {
      startTime: reports[0]?.stats?.startTime,
      duration: sum('duration'),
      expected: sum('expected'),
      unexpected: sum('unexpected'),
      flaky: sum('flaky'),
      skipped: sum('skipped'),
    },
  };
}

/** The spec files a Playwright JSON report names, each once, in alphabetical order. */
export function specFiles(report: Report): string[] {
  return [...new Set((report.suites ?? []).map((suite) => suite.file!))].sort();
}

/** Every attempt's milliseconds in a suite and the suites inside it. */
function milliseconds(suite: ReportSuite): number {
  let sum = 0;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) sum += result.duration ?? 0;
    }
  }
  for (const inner of suite.suites ?? []) sum += milliseconds(inner);
  return sum;
}

/**
 * Each spec file's seconds over the shards' reports, every attempt counted, since a retry takes
 * the shard's time too; to a tenth of a second, the files in alphabetical order.
 */
export function secondsFromReports(reports: readonly Report[]): Record<string, number> {
  const sums = new Map<string, number>();
  for (const report of reports) {
    for (const suite of report.suites ?? []) {
      sums.set(suite.file!, (sums.get(suite.file!) ?? 0) + milliseconds(suite));
    }
  }
  return Object.fromEntries(
    [...sums.keys()].sort().map((file) => [file, Math.round(sums.get(file)! / 100) / 10]),
  );
}

/**
 * The timings a refresh writes: each spec file the suite lists, timed from the reports. A shard
 * that stopped before Playwright wrote its report uploads none, and its files would then drop out
 * of the timings and be dealt at the median, a heavy file as a light one, so a listed file in no
 * report refuses the refresh, naming each. A reported file the suite no longer lists is left out.
 */
export function timingsFromReports(
  listed: readonly string[],
  reports: readonly Report[],
): Record<string, number> {
  const seconds = secondsFromReports(reports);
  const missing = listed.filter((file) => !(file in seconds));
  if (missing.length > 0) {
    throw new Error(
      `${counted(missing.length, 'listed spec file')} ${missing.length === 1 ? 'is' : 'are'} ` +
        `in no report: ${missing.join(', ')}. ` +
        "Download every shard's report from one run of this suite.",
    );
  }
  return Object.fromEntries([...listed].sort().map((file) => [file, seconds[file]!]));
}

/** How much of a run's own measure goes into the timings it publishes; the rest is the timings it
 * dealt by. Measured over twelve runs on dev and the merge queue: one run's timings alone left the
 * next run's shards about 200 seconds apart, a weight of 0.3 about 130, since a file's time moves by
 * a fifth from run to run. */
export const BLEND_WEIGHT = 0.3;

/** The artifact every passing push to `dev` and merge queue trial commit publishes. */
export const TIMINGS_ARTIFACT = 'e2e-shard-timings';

/** How long before its own run was created an artifact must have been made for a shard to take it:
 * far longer than an upload takes, so an artifact being uploaded as the first shard looks is never
 * one a later shard can see and the first could not. */
export const TIMINGS_MARGIN_MS = 10 * 60_000;

/** The committed fallback, as the deal record and the summary name it. */
const COMMITTED = 'the committed scripts/e2e-shard-timings.json';

/** Rounds seconds to a tenth, as the timings are written. */
const tenth = (seconds: number) => Math.round(seconds * 10) / 10;

/** A list's spec files in alphabetical order, each once. */
const sorted = (files: Iterable<string>) => [...new Set(files)].sort();

/** A count and its noun, in the singular for one: "1 spec file", "2 spec files". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Timings read from JSON, refusing anything but a non-empty object of finite, non-negative seconds. */
export function parseTimings(text: string): Timings {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the timings are not an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error('the timings are empty');
  for (const [file, seconds] of entries) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`the timing of ${file} is ${JSON.stringify(seconds)}, not seconds`);
    }
  }
  return value as Timings;
}

/**
 * The next timings of the listed files: a file this run measured blends its measure, at
 * `BLEND_WEIGHT`, with its earlier timing, or is its measure alone when it had none; a file this
 * run did not measure keeps its earlier timing. A file not listed is left out.
 */
export function blendTimings(
  previous: Timings,
  measured: Timings,
  listed: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    sorted(listed).map((file) => {
      const now = measured[file];
      const before = previous[file];
      if (now === undefined && before === undefined) throw new Error(`${file} has no timing`);
      if (now === undefined) return [file, before!];
      if (before === undefined) return [file, tenth(now)];
      return [file, tenth(BLEND_WEIGHT * now + (1 - BLEND_WEIGHT) * before)];
    }),
  );
}

/**
 * The timings a hand refresh writes from several runs' reports, oldest first: each run blended into
 * the ones before it, as CI publishes them run after run. The newest must be whole, as
 * `timingsFromReports` requires of one run.
 */
export function refreshTimings(
  listed: readonly string[],
  runs: readonly (readonly Report[])[],
): Record<string, number> {
  const newest = timingsFromReports(listed, runs.at(-1) ?? []);
  let timings: Record<string, number> = {};
  for (const run of runs.slice(0, -1)) {
    const measured = secondsFromReports(run);
    timings = blendTimings(timings, measured, Object.keys({ ...timings, ...measured }));
  }
  return blendTimings(timings, newest, listed);
}

/** An entry of GitHub's list of a repository's artifacts. */
export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: {
    id?: number;
    head_branch?: string;
    repository_id?: number;
    head_repository_id?: number;
  };
}

/** The parts of a GitHub workflow run a shard reads. */
export interface WorkflowRun {
  id: number;
  event: string;
  head_branch: string | null;
  path: string;
  created_at?: string;
  repository: { id: number };
  head_repository: { id: number } | null;
}

/** A branch whose Test run may publish the timings: `dev`, or a merge queue trial commit's. */
const publishingBranch = (branch: string | null | undefined) =>
  branch === 'dev' || (branch ?? '').startsWith('gh-readonly-queue/dev/');

/**
 * The timings artifacts a run may deal by, best first: named `TIMINGS_ARTIFACT`, not expired, made
 * in this repository on `dev` or a merge queue branch, and at least `TIMINGS_MARGIN_MS` before the
 * run was created; newest first, then by id. An artifact made later is left out, so a re-run of the
 * run, however late, picks the same.
 */
export function chooseTimingsArtifacts(
  artifacts: readonly Artifact[],
  repositoryId: number,
  runCreatedAt: Date,
): Artifact[] {
  const latest = runCreatedAt.getTime() - TIMINGS_MARGIN_MS;
  return artifacts
    .filter(
      (artifact) =>
        artifact.name === TIMINGS_ARTIFACT &&
        !artifact.expired &&
        Date.parse(artifact.created_at) <= latest &&
        artifact.workflow_run?.repository_id === repositoryId &&
        artifact.workflow_run?.head_repository_id === repositoryId &&
        publishingBranch(artifact.workflow_run?.head_branch),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
}

/** A run whose timings a shard trusts: the Test workflow's, in this repository, on a push to `dev`
 * or a merge queue trial commit, never a pull request's, whose code no one has merged. */
export function trustedRun(run: WorkflowRun, repositoryId: number): boolean {
  return (
    run.path === '.github/workflows/test.yml' &&
    run.repository.id === repositoryId &&
    run.head_repository?.id === repositoryId &&
    publishingBranch(run.head_branch) &&
    ((run.event === 'push' && run.head_branch === 'dev') || run.event === 'merge_group')
  );
}

/** What a shard dealt, written beside its report for the `e2e` job's check. */
export interface DealRecord {
  shard: number;
  total: number;
  /** Where the timings came from, the same words on every shard that took the same timings. */
  source: string;
  timings: Timings;
  /** Whether the shard dealt every listed file, or the list `--specs` named. */
  scope: 'whole' | 'named';
  /** How many spec files Playwright listed. */
  listed: number;
  /** What the shard dealt from: every listed file, or the named list. */
  files: string[];
  hand: string[];
  /** The listed files of the serial list, sorted; none in a record from before the passes. */
  serial?: string[];
  /** The parallel pass's workers; one in a record from before the passes. */
  workers?: number;
}

/** One shard's artifact, as the `e2e` job downloads it: either file may be missing. */
export interface ShardResult {
  shard: number;
  deal?: DealRecord;
  report?: Report;
  phases?: Phase[];
}

/**
 * The check that the shards dealt what the run must run, alike, and ran every file of it once: every
 * shard of the total its deal records name uploaded a deal record and a report, every deal record is
 * of the whole suite, or with `named` of exactly those files, every one holds the same timings and
 * the same files, each report holds exactly its shard's hand, and every file dealt from is in
 * exactly one report. Also each shard's seconds of tests, by its report, 0 for none.
 */
export function checkShards(
  shards: readonly ShardResult[],
  named?: readonly string[],
): {
  problems: string[];
  seconds: number[];
} {
  const deals = shards
    .flatMap((shard) => (shard.deal ? [shard.deal] : []))
    .sort((a, b) => a.shard - b.shard);
  if (deals.length === 0) return { problems: ['no shard uploaded a deal record'], seconds: [] };
  const problems: string[] = [];
  const total = Math.max(...deals.map((deal) => deal.total));
  const selection = named && sorted(named);
  for (const deal of deals) {
    const shard = `shard ${deal.shard}/${total}`;
    if (!selection) {
      if (deal.scope !== 'whole') {
        problems.push(`${shard} dealt the test map's selection, but this run must run every spec`);
      }
      continue;
    }
    if (deal.scope !== 'named') {
      problems.push(`${shard} dealt the whole suite, but this run ran the test map's selection`);
    }
    const dealt = sorted(deal.files);
    if (JSON.stringify(dealt) !== JSON.stringify(selection)) {
      problems.push(
        `${shard} dealt ${dealt.join(', ')}, not the ` +
          `${counted(selection.length, 'spec file')} the selection named`,
      );
    }
  }
  // What decides the hands, not the words of the source: shards that fell back to the committed file
  // for different reasons dealt alike. A record from before the passes dealt by no serial file at
  // one worker.
  const serial = (deal: DealRecord) => deal.serial ?? [];
  const workers = (deal: DealRecord) => deal.workers ?? 1;
  const plural = (count: number, noun: string) =>
    count === 0 ? `no ${noun}` : counted(count, noun);
  const parts = [
    {
      what: 'timings',
      key: (deal: DealRecord) => JSON.stringify([deal.timings, deal.total, deal.files]),
      says: () => '',
    },
    {
      what: 'serial files',
      key: (deal: DealRecord) => JSON.stringify(serial(deal)),
      says: (deal: DealRecord) => `, ${plural(serial(deal).length, 'serial file')}`,
    },
    {
      what: 'worker counts',
      key: (deal: DealRecord) => String(workers(deal)),
      says: (deal: DealRecord) => `, ${plural(workers(deal), 'worker')}`,
    },
  ].filter((part) => new Set(deals.map(part.key)).size > 1);
  if (parts.length > 0) {
    problems.push(
      `the shards dealt by different ${parts.map((part) => part.what).join(' and ')}: ` +
        deals
          .map(
            (deal) =>
              `shard ${deal.shard} by ${deal.source}${parts.map((part) => part.says(deal)).join('')}`,
          )
          .join('; '),
    );
  }
  const ranOn = new Map<string, number>();
  const seconds: number[] = [];
  for (let current = 1; current <= total; current++) {
    const shard = shards.find((result) => result.shard === current);
    if (!shard?.deal) problems.push(`shard ${current}/${total} uploaded no deal record`);
    if (!shard?.report) {
      problems.push(`shard ${current}/${total} uploaded no report`);
      seconds.push(0);
      continue;
    }
    const ran = specFiles(shard.report);
    for (const file of ran) ranOn.set(file, (ranOn.get(file) ?? 0) + 1);
    seconds.push(
      tenth(Object.values(secondsFromReports([shard.report])).reduce((a, b) => a + b, 0)),
    );
    const hand = sorted(shard.deal?.hand ?? []);
    if (shard.deal && JSON.stringify(ran) !== JSON.stringify(hand)) {
      problems.push(
        `shard ${current}/${total} was dealt ${hand.join(', ')} but its report holds ${ran.join(', ')}`,
      );
    }
  }
  const listed = sorted(deals.flatMap((deal) => deal.files));
  const twice = listed.filter((file) => (ranOn.get(file) ?? 0) > 1);
  const never = listed.filter((file) => !ranOn.has(file));
  if (twice.length > 0) problems.push(`${twice.join(', ')} ran on more than one shard`);
  if (never.length > 0) problems.push(`${never.join(', ')} ran on no shard`);
  return { problems, seconds };
}

/** The timings' source every shard dealt by, or each source with its shards when they differ. */
export function dealtBy(deals: readonly DealRecord[]): string {
  if (deals.length === 0) return 'no timings any shard recorded';
  const bySource = new Map<string, number[]>();
  for (const deal of [...deals].sort((a, b) => a.shard - b.shard)) {
    bySource.set(deal.source, [...(bySource.get(deal.source) ?? []), deal.shard]);
  }
  if (bySource.size === 1) return deals[0]!.source;
  return [...bySource]
    .map(
      ([source, shards]) => `${source} (shard${shards.length > 1 ? 's' : ''} ${shards.join(', ')})`,
    )
    .join('; ');
}

/** The timings a run publishes once `checkShards` passed: the ones it dealt by, blended with the
 * seconds its shards' reports measured. */
export function publishedTimings(shards: readonly ShardResult[]): Record<string, number> {
  const deal = shards.find((shard) => shard.deal)!.deal!;
  const reports = shards.flatMap((shard) => (shard.report ? [shard.report] : []));
  return blendTimings(deal.timings, secondsFromReports(reports), deal.files);
}

/**
 * The `e2e` job's summary of the deal: what ran and the timings' source, each shard's seconds of
 * tests and its passes' wall seconds (`phases`, by shard, a dash for a pass it did not run or a
 * shard with none), the spread, the problems. The spread is over the passes' wall seconds summed
 * when every shard has phases, else over the seconds of tests. With `problems` its opening names
 * only the timings' source, since what `ran` says the shards dealt may never have run.
 */
export function shardSummary(
  source: string,
  seconds: readonly number[],
  problems: readonly string[],
  ran: { scope: DealRecord['scope']; files: number; listed: number },
  phases: readonly (readonly Phase[] | undefined)[] = [],
): string {
  const subject =
    ran.scope === 'whole'
      ? 'Every spec file the suite lists'
      : `The ${counted(ran.files, 'spec file')} the test map named, ` +
        `of the ${ran.listed} the suite lists,`;
  const opening =
    problems.length > 0 ? `Dealt by ${source}.` : `${subject} ran, dealt by ${source}.`;
  const lines = ['### E2E shards', '', opening, ''];
  lines.push(
    '| Shard | Seconds of tests | Serial pass | Parallel pass |',
    '|-------|------------------|-------------|---------------|',
  );
  const pass = (n: number, name: Phase['name']) =>
    phases[n]?.find((phase) => phase.name === name)?.seconds;
  const cell = (value: number | undefined) => (value === undefined ? '-' : `${Math.round(value)}`);
  seconds.forEach((value, n) =>
    lines.push(
      `| ${n + 1}/${seconds.length} | ${Math.round(value)} | ${cell(pass(n, 'serial'))} | ` +
        `${cell(pass(n, 'parallel'))} |`,
    ),
  );
  if (seconds.length > 0) {
    const byPasses = seconds.every((_, n) => phases[n] !== undefined);
    const loads = byPasses
      ? seconds.map((_, n) => phases[n]!.reduce((sum, phase) => sum + phase.seconds, 0))
      : seconds;
    const slowest = Math.max(...loads);
    const spread = slowest - Math.min(...loads);
    const share = slowest > 0 ? Math.round((spread / slowest) * 100) : 0;
    lines.push(
      '',
      `Spread: ${counted(Math.round(spread), 'second')} between the fastest and the slowest ` +
        `${byPasses ? "shard's passes" : 'shard'} (${share}% of the slowest).`,
    );
  }
  if (problems.length > 0) {
    lines.push('', '**The deal is broken:**', '', ...problems.map((problem) => `- ${problem}`));
  }
  return `${lines.join('\n')}\n`;
}

/** Playwright's list of the suite, or of the files the filters name, as a JSON report. */
export function list(filters: readonly string[] = []): Report {
  const listed = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json', ...filters], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (listed.status !== 0) throw new Error(`playwright test --list exited ${listed.status}`);
  return JSON.parse(listed.stdout) as Report;
}

/** The timings a shard deals by, and where they came from. */
export interface ChosenTimings {
  source: string;
  timings: Timings;
}

/** The committed timings, named with why a shard deals by them. */
const committed = (why?: string): ChosenTimings => ({
  source: why ? `${COMMITTED} (${why})` : COMMITTED,
  timings: parseTimings(readFileSync(timingsFile(), 'utf8')),
});

/** A GitHub API call with this run's token, tried up to three times on a timeout, a network error,
 * a 5xx or a 429, and once on any other failing answer. */
async function github(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${api}${path}`, {
        headers: {
          Accept: accept,
          ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response;
      failure = new Error(`GitHub answered ${response.status} to ${path}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  throw failure;
}

/** The reads the lookup makes of GitHub, apart so a unit test can answer them. */
export interface GitHubReads {
  /** A REST API path's JSON answer. */
  json(path: string): Promise<unknown>;
  /** The text of `e2e-shard-timings.json` inside an artifact's zip. */
  artifactText(repository: string, artifactId: number): Promise<string>;
}

/** GitHub's API with this run's token, the zip opened by the runner's `unzip`. */
const githubReads: GitHubReads = {
  json: async (path) => (await github(path)).json(),
  async artifactText(repository, artifactId) {
    const zip = await github(`/repos/${repository}/actions/artifacts/${artifactId}/zip`, '*/*');
    const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'e2e-shard-timings-'));
    try {
      const path = join(dir, 'artifact.zip');
      writeFileSync(path, Buffer.from(await zip.arrayBuffer()));
      const unzipped = spawnSync('unzip', ['-p', path, 'e2e-shard-timings.json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (unzipped.status !== 0) throw new Error(`unzip exited ${unzipped.status}`);
      return unzipped.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** How many pages of 100 artifacts the lookup reads at most: a re-run may come weeks later, with
 * every run on `dev` and the merge queue since having published one. */
const ARTIFACT_PAGES = 20;

/** How far before the best candidate so far an artifact listed must have been made for the lookup
 * to stop: GitHub lists artifacts by id, which only roughly follows the order they were made (ids
 * were seen out of order by up to 15 minutes), so a newer candidate may list below an older one. */
const LISTING_DISORDER_MS = 60 * 60_000;

/**
 * The artifacts `chooseTimingsArtifacts` names for `run`, best first, over every artifact read:
 * GitHub's list, page after page, until the list ends or a page holds an artifact made an hour
 * before the best candidate so far, past which no newer candidate is listed. So the choice is the
 * same wherever the pages' boundaries fall, and an artifact many newer ones have buried since is
 * still found.
 */
async function listCandidates(
  gh: GitHubReads,
  repository: string,
  run: WorkflowRun,
): Promise<Artifact[]> {
  const read: Artifact[] = [];
  for (let page = 1; page <= ARTIFACT_PAGES; page++) {
    const listed = (await gh.json(
      `/repos/${repository}/actions/artifacts?name=${TIMINGS_ARTIFACT}&per_page=100&page=${page}`,
    )) as { artifacts: Artifact[] };
    read.push(...listed.artifacts);
    const best = chooseTimingsArtifacts(read, run.repository.id, new Date(run.created_at!))[0];
    const pastIt =
      best !== undefined &&
      listed.artifacts.some(
        (artifact) =>
          Date.parse(artifact.created_at) < Date.parse(best.created_at) - LISTING_DISORDER_MS,
      );
    if (pastIt || listed.artifacts.length < 100) break;
  }
  return chooseTimingsArtifacts(read, run.repository.id, new Date(run.created_at!));
}

/**
 * The timings this CI run deals by: the best of the first ten artifacts `chooseTimingsArtifacts`
 * names whose run is trusted, or the committed file when none of them is, the one chosen is
 * corrupt, or GitHub's API fails.
 */
export async function chooseTimings(
  gh: GitHubReads,
  repository: string | undefined,
  runId: string | undefined,
): Promise<ChosenTimings> {
  if (!repository || !runId) return committed('not in a GitHub Actions run');
  let run: WorkflowRun;
  let candidates: Artifact[];
  try {
    run = (await gh.json(`/repos/${repository}/actions/runs/${runId}`)) as WorkflowRun;
    candidates = await listCandidates(gh, repository, run);
  } catch (error) {
    return committed(`GitHub's API failed: ${(error as Error).message}`);
  }
  const cutoff = new Date(Date.parse(run.created_at!) - TIMINGS_MARGIN_MS)
    .toISOString()
    .replace('.000Z', 'Z');
  for (const artifact of candidates.slice(0, 10)) {
    const name = `run ${artifact.workflow_run?.id}'s ${TIMINGS_ARTIFACT} (artifact ${artifact.id}, made ${artifact.created_at})`;
    try {
      const source = (await gh.json(
        `/repos/${repository}/actions/runs/${artifact.workflow_run?.id}`,
      )) as WorkflowRun;
      if (!trustedRun(source, run.repository.id)) continue;
    } catch (error) {
      return committed(`GitHub's API failed: ${(error as Error).message}`);
    }
    try {
      return {
        source: name,
        timings: parseTimings(await gh.artifactText(repository, artifact.id)),
      };
    } catch (error) {
      return committed(`${name} could not be read: ${(error as Error).message}`);
    }
  }
  return committed(`no trusted ${TIMINGS_ARTIFACT} artifact made before ${cutoff}`);
}

/** Writes the timings this run deals by to `out`; never fails, falling back to the committed file. */
async function timingsCommand(out: string): Promise<number> {
  const chosen = await chooseTimings(
    githubReads,
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_RUN_ID,
  );
  if (chosen.source.startsWith(`${COMMITTED} (`)) {
    console.log(`::warning::The e2e shards deal by ${chosen.source}.`);
  } else {
    console.log(`The e2e shards deal by ${chosen.source}.`);
  }
  writeFileSync(out, `${JSON.stringify(chosen)}\n`);
  return 0;
}

/** The timings `--timings` names, or the committed file without one or when it cannot be read. */
function readChosen(path: string | undefined): ChosenTimings {
  if (!path) return committed();
  try {
    const chosen = JSON.parse(readFileSync(path, 'utf8')) as {
      source?: unknown;
      timings?: unknown;
    };
    if (typeof chosen.source !== 'string') throw new Error('it names no source');
    return { source: chosen.source, timings: parseTimings(JSON.stringify(chosen.timings)) };
  } catch (error) {
    console.log(`::warning::${path} could not be read, so this shard deals by ${COMMITTED}.`);
    return committed(`${path} could not be read: ${(error as Error).message}`);
  }
}

/** The deal record, beside Playwright's report, which Playwright empties the folder of first. */
const dealRecordFile = () => join(import.meta.dirname, '..', 'test-results', 'e2e-deal.json');

/** The spec files a `--specs` file names: a JSON array of strings. */
function readSpecList(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return value;
    throw new Error('it is not a JSON array of strings');
  } catch (error) {
    throw new Error(
      `${path} could not be read as a list of spec files: ${(error as Error).message}`,
    );
  }
}

/**
 * Lists the suite, deals it, or the files `--specs` names, checks Playwright selects exactly this
 * shard's hand, runs it, and writes the deal record.
 */
function runShard(
  shard: string,
  timingsPath: string | undefined,
  specsPath: string | undefined,
  playwrightArgs: readonly string[],
): number {
  const { current, total } = parseShard(shard);
  let named: string[] | undefined;
  try {
    if (specsPath !== undefined) named = readSpecList(specsPath);
  } catch (error) {
    console.log(`::error::${(error as Error).message}`);
    return 1;
  }
  const suite = list();
  const rootDir = suite.config?.rootDir;
  if (!rootDir) throw new Error("Playwright's list names no rootDir");
  const { source, timings } = readChosen(timingsPath);
  const listed = specFiles(suite);
  const { scope, files, unlisted } = filesToDeal(listed, named);
  // Both from the one list: a file's project, and the config's workers, are the same in every list.
  const serial = serialFiles(suite);
  const workers = Math.max(1, suite.config?.workers ?? 1);
  const writeRecord = (hand: string[]) => {
    const record: DealRecord = {
      shard: current,
      total,
      source,
      timings,
      scope,
      listed: listed.length,
      files,
      hand,
      serial: [...serial].sort(),
      workers,
    };
    mkdirSync(join(import.meta.dirname, '..', 'test-results'), { recursive: true });
    writeFileSync(dealRecordFile(), `${JSON.stringify(record)}\n`);
  };
  if (unlisted.length > 0) {
    for (const file of unlisted) {
      console.log(`::error::${file} is named by the selection but Playwright does not list it`);
    }
    writeRecord([]);
    return 1;
  }

  const hand = dealShards(files, timings, total, { serial, workers })[current - 1]!;
  const weight = fileWeight(files, timings, { serial, workers });
  const minutes = hand.reduce((sum, file) => sum + weight(file), 0) / 60;
  const isSerial = new Set(serial);
  const dealtFrom =
    scope === 'whole'
      ? counted(files.length, 'spec file')
      : `the ${counted(files.length, 'named spec file')} (of ${listed.length} listed)`;
  console.log(
    `e2e shard ${current}/${total}: ${hand.length} of ${dealtFrom}, ` +
      `${hand.filter((file) => isSerial.has(file)).length} serial, ` +
      `about ${minutes.toFixed(1)} minutes by ${source}`,
  );
  for (const file of hand) {
    const notes = [isSerial.has(file) ? 'serial' : '', file in timings ? '' : 'no timing yet'];
    const said = notes.filter(Boolean).join(', ');
    console.log(`  ${file}${said ? ` (${said})` : ''}`);
  }
  if (hand.length === 0) {
    writeRecord(hand);
    return 0;
  }

  const filters = hand.map((file) => fileFilter(rootDir, file));
  const selected = specFiles(list(filters));
  if (JSON.stringify(selected) !== JSON.stringify(hand)) {
    console.error(`The filters select ${JSON.stringify(selected)}, not this shard's hand.`);
    writeRecord(hand);
    return 1;
  }
  // The serial project's files first, at one worker, then the rest at the config's workers, so no
  // test of the serial project ever runs beside another, and both whatever the first's result, so
  // one serial failure never hides the rest of the hand. Each pass keeps its own output folder,
  // HTML report and JSON report, since Playwright empties its folders first; the shard's report is
  // the passes' merged, at the path the config names.
  const resultsDir = join(import.meta.dirname, '..', 'test-results');
  const reports: Report[] = [];
  const phases: Phase[] = [];
  for (const pass of passes(hand, serial)) {
    const json = join(resultsDir, `results-${pass.name}.json`);
    // Outside the pass's output folder, so Playwright never empties it: a pass that ends before
    // its JSON reporter writes must leave none, not an earlier run's.
    rmSync(json, { force: true });
    const started = Date.now();
    const run = spawnSync(
      'npx',
      [
        'playwright',
        'test',
        `--project=${pass.project}`,
        ...(pass.name === 'serial' ? ['--workers=1'] : []),
        `--output=${join(resultsDir, pass.name)}`,
        ...pass.files.map((file) => fileFilter(rootDir, file)),
        ...playwrightArgs,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_JSON_OUTPUT: json,
          PLAYWRIGHT_HTML_OUTPUT_DIR: join(
            import.meta.dirname,
            '..',
            'playwright-report',
            pass.name,
          ),
        },
      },
    );
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    phases.push({ name: pass.name, files: pass.files.length, seconds, status: run.status });
    console.log(
      `e2e shard ${current}/${total}: the ${pass.name} pass, ` +
        `${counted(pass.files.length, 'file')}, took ${seconds} s`,
    );
    if (existsSync(json)) reports.push(JSON.parse(readFileSync(json, 'utf8')) as Report);
  }
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, 'results.json'), `${JSON.stringify(mergeReports(reports))}\n`);
  writeFileSync(join(resultsDir, 'e2e-phases.json'), `${JSON.stringify(phases)}\n`);
  writeRecord(hand);
  return shardStatus(phases.map((phase) => phase.status));
}

/** Each shard's artifact under `dir`, as `actions/download-artifact` lays them out by pattern:
 * `e2e-results-shard-<n>/`, each with `results.json`, `e2e-deal.json` and `e2e-phases.json`. */
function shardResults(dir: string): ShardResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const match = /^e2e-results-shard-(\d+)$/.exec(name);
      return match ? [{ name, shard: Number(match[1]) }] : [];
    })
    .map(({ name, shard }) => {
      const read = <T>(file: string): T | undefined => {
        const path = join(dir, name, file);
        return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
      };
      return {
        shard,
        deal: read<DealRecord>('e2e-deal.json'),
        report: read<Report>('results.json'),
        phases: read<Phase[]>('e2e-phases.json'),
      };
    });
}

/** The `e2e` job's check of the deal, of the whole suite or of the files `--named` names, its
 * summary, and with `publish` the next timings. */
function checkCommand(
  dir: string,
  publish: string | undefined,
  namedPath: string | undefined,
): number {
  let named: string[] | undefined;
  try {
    if (namedPath !== undefined) named = readSpecList(namedPath);
  } catch (error) {
    console.log(`::error::${(error as Error).message}`);
    return 1;
  }
  const shards = shardResults(dir);
  const { problems, seconds } = checkShards(shards, named);
  const deals = shards.flatMap((shard) => (shard.deal ? [shard.deal] : []));
  // With no deal record the check has failed, and the summary says nothing of what ran.
  const [deal] = deals;
  const phases = seconds.map((_, n) => shards.find((shard) => shard.shard === n + 1)?.phases);
  const summary = shardSummary(
    dealtBy(deals),
    seconds,
    problems,
    {
      scope: deal?.scope ?? 'whole',
      files: deal?.files.length ?? 0,
      listed: deal?.listed ?? 0,
    },
    phases,
  );
  console.log(summary);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, summary);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) return 1;
  if (publish) {
    const timings = publishedTimings(shards);
    writeFileSync(publish, `${JSON.stringify(timings, null, 2)}\n`);
    const minutes = Object.values(timings).reduce((sum, value) => sum + value, 0) / 60;
    const note =
      `Published ${TIMINGS_ARTIFACT}: ${counted(Object.keys(timings).length, 'spec file')}, ` +
      `${minutes.toFixed(1)} minutes of tests.\n`;
    console.log(note);
    if (summaryFile) appendFileSync(summaryFile, `\n${note}`);
  }
  return 0;
}

/** Every `results.json` under `dir`, at any depth, as `gh run download` lays the artifacts out. */
function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return jsonFiles(path);
      return name.endsWith('results.json') ? [path] : [];
    });
}

/** Rewrites the committed timings from runs' reports, a folder each, oldest first. */
function refresh(dirs: readonly string[]): number {
  const runs = dirs.map((dir) =>
    jsonFiles(dir).map((path) => JSON.parse(readFileSync(path, 'utf8')) as Report),
  );
  const empty = dirs.filter((_, n) => runs[n]!.length === 0);
  if (empty.length > 0) {
    console.error(`No Playwright JSON report under ${empty.join(', ')}.`);
    return 1;
  }
  let seconds: Record<string, number>;
  try {
    seconds = refreshTimings(specFiles(list()), runs);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const files = Object.keys(seconds).length;
  writeFileSync(timingsFile(), `${JSON.stringify(seconds, null, 2)}\n`);
  const minutes = Object.values(seconds).reduce((sum, value) => sum + value, 0) / 60;
  console.log(
    `${timingsFile()}: ${counted(files, 'spec file')} from ${counted(runs.length, 'run')}, ` +
      `${minutes.toFixed(1)} minutes of tests`,
  );
  return 0;
}

/** The arguments after `--shard=`: its own flags, `--timings=` and `--specs=` in either order and
 * each at most once, then Playwright's. Undefined when a flag is given twice. */
function shardArguments(args: readonly string[]) {
  const flags: { timings?: string; specs?: string } = {};
  let first = 0;
  for (; first < args.length; first++) {
    const match = /^--(timings|specs)=(.*)$/.exec(args[first]!);
    if (!match) break;
    const name = match[1] as 'timings' | 'specs';
    if (flags[name] !== undefined) return undefined;
    flags[name] = match[2]!;
  }
  return { ...flags, playwright: args.slice(first) };
}

/** `check`'s arguments: the folder, then at most one of `--publish=<file>` and `--named=<file>`,
 * since a run that publishes timings is never a pull request's. Undefined for anything else. */
function checkArguments(args: readonly string[]) {
  const [dir, flag, ...more] = args;
  if (dir === undefined || more.length > 0) return undefined;
  if (flag === undefined) return { dir };
  // An empty `--named=` is a file that cannot be read, never a check without the flag.
  const match = /^--(?:publish=(?<publish>.+)|named=(?<named>.*))$/.exec(flag);
  return match ? { dir, publish: match.groups!.publish, named: match.groups!.named } : undefined;
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  const shardArgs = first?.startsWith('--shard=') ? shardArguments(rest) : undefined;
  const checkArgs = first === 'check' ? checkArguments(rest) : undefined;
  if (first === 'refresh' && rest.length > 0) {
    process.exitCode = refresh(rest);
  } else if (first === 'timings' && rest.length === 1) {
    process.exitCode = await timingsCommand(rest[0]!);
  } else if (checkArgs) {
    const { dir, publish, named } = checkArgs;
    process.exitCode = checkCommand(dir, publish, named);
  } else if (shardArgs) {
    const { timings, specs, playwright } = shardArgs;
    process.exitCode = runShard(first!.slice('--shard='.length), timings, specs, playwright);
  } else {
    console.error(
      'Usage: node scripts/e2e-shards.ts --shard=<current>/<total> [--timings=<file>] [--specs=<file>] [playwright args]\n' +
        '       node scripts/e2e-shards.ts timings <out file>\n' +
        "       node scripts/e2e-shards.ts check <dir of the shards' artifacts> [--publish=<file> | --named=<file>]\n" +
        "       node scripts/e2e-shards.ts refresh <dir of one run's Playwright JSON reports>...",
    );
  }
  if (process.exitCode === undefined) process.exitCode = 2;
}
