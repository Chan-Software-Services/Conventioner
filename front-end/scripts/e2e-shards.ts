/**
 * The e2e shards (T234): deals the Playwright spec files to CI's shards by measured time, runs one
 * shard's hand, and keeps the timings fresh from CI's own runs.
 *
 * Playwright's own `--shard` cuts the alphabetical list of spec files into runs of equal test count,
 * whatever the tests cost: on its first six-shard run the three people-at-scale files, whose names
 * sort together, all landed on one shard, which ran 24 minutes of tests while another ran 6. Here
 * every shard lists the suite itself, deals each spec file to the shard with the least time so far,
 * heaviest first by the timings, and runs its own hand. The dealing depends only on the list and the
 * timings, so every runner given the same timings deals the same hands, and each file is in exactly
 * one. A spec file with no timing yet weighs the median of those measured.
 *
 * The timings refresh themselves, with no hand step. In CI each shard first takes them with
 *
 *   node scripts/e2e-shards.ts timings <out file>
 *
 * which picks the newest `e2e-shard-timings` artifact made at least ten minutes before its own run
 * was created, by a Test run on a push to `dev`, a schedule on `dev` or a merge queue trial commit.
 * A run's creation time stays the same on every re-run, and an artifact never changes once made,
 * so every shard of a run, and every re-run of one, picks the same artifact. With no such artifact,
 * a corrupt one, or GitHub's API failing, it falls back to the committed `e2e-shard-timings.json`
 * with a warning and never fails. Then it runs its hand, as CI's `e2e-shard` job does:
 *
 *   node scripts/e2e-shards.ts --shard=3/10 --timings=<that file>
 *
 * and writes its deal record (`test-results/e2e-deal.json`: the timings' source, the timings, every
 * listed file and its hand) beside Playwright's report. Without `--timings` it deals by the
 * committed file. Once every shard has passed, CI's `e2e` job runs
 *
 *   node scripts/e2e-shards.ts check <dir of the shards' artifacts> [--publish=<out file>]
 *
 * which fails unless every shard dealt by the same timings and their reports hold every listed spec
 * file exactly once, writes each shard's seconds and the spread to the job summary, and with
 * `--publish` writes the next timings: the ones the run dealt by, blended with what it measured.
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

/**
 * The spec files dealt to `total` shards: heaviest first, each to the shard with the least time so
 * far (the lowest-numbered on a tie), ties between files broken by name, so the hands depend on the
 * files and their timings alone, never on the order the files were listed in. Each hand runs in
 * alphabetical order.
 */
export function dealShards(files: readonly string[], seconds: Timings, total: number): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`a shard count of ${total}`);
  const unique = new Set(files);
  if (unique.size !== files.length) {
    const twice = files.find((file, n) => files.indexOf(file) !== n);
    throw new Error(`${twice} is listed twice`);
  }
  const fallback = defaultSeconds(files, seconds);
  const weight = (file: string) => seconds[file] ?? fallback;
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
  specs?: { tests?: { results?: { duration?: number }[] }[] }[];
  suites?: ReportSuite[];
}

interface Report {
  config?: { rootDir?: string };
  suites?: ReportSuite[];
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
      `${missing.length} listed spec files are in no report: ${missing.join(', ')}. ` +
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

/** The artifact every passing push to `dev`, scheduled run on `dev` and merge queue trial commit
 * publishes. */
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

/** A run whose timings a shard trusts: the Test workflow's, in this repository, on a push to `dev`,
 * a scheduled run on `dev` or a merge queue trial commit, never a pull request's, whose code no one
 * has merged. */
export function trustedRun(run: WorkflowRun, repositoryId: number): boolean {
  return (
    run.path === '.github/workflows/test.yml' &&
    run.repository.id === repositoryId &&
    run.head_repository?.id === repositoryId &&
    publishingBranch(run.head_branch) &&
    (((run.event === 'push' || run.event === 'schedule') && run.head_branch === 'dev') ||
      run.event === 'merge_group')
  );
}

/** What a shard dealt, written beside its report for the `e2e` job's check. */
export interface DealRecord {
  shard: number;
  total: number;
  /** Where the timings came from, the same words on every shard that took the same timings. */
  source: string;
  timings: Timings;
  /** Every spec file the suite listed. */
  files: string[];
  hand: string[];
}

/** One shard's artifact, as the `e2e` job downloads it: either file may be missing. */
export interface ShardResult {
  shard: number;
  deal?: DealRecord;
  report?: Report;
}

/**
 * The check that the shards dealt alike and ran every spec file once: every shard of the total its
 * deal records name uploaded a deal record and a report, every deal record names the same timings'
 * source and the same files, each report holds exactly its shard's hand, and every listed file is in
 * exactly one report. Also each shard's seconds of tests, by its report, 0 for none.
 */
export function checkShards(shards: readonly ShardResult[]): {
  problems: string[];
  seconds: number[];
} {
  const deals = shards
    .flatMap((shard) => (shard.deal ? [shard.deal] : []))
    .sort((a, b) => a.shard - b.shard);
  if (deals.length === 0) return { problems: ['no shard uploaded a deal record'], seconds: [] };
  const problems: string[] = [];
  const total = Math.max(...deals.map((deal) => deal.total));
  const key = (deal: DealRecord) => JSON.stringify([deal.source, deal.total, deal.files]);
  if (new Set(deals.map(key)).size > 1) {
    problems.push(
      'the shards dealt by different timings: ' +
        deals.map((deal) => `shard ${deal.shard} by ${deal.source}`).join('; '),
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

/** The timings a run publishes once `checkShards` passed: the ones it dealt by, blended with the
 * seconds its shards' reports measured. */
export function publishedTimings(shards: readonly ShardResult[]): Record<string, number> {
  const deal = shards.find((shard) => shard.deal)!.deal!;
  const reports = shards.flatMap((shard) => (shard.report ? [shard.report] : []));
  return blendTimings(deal.timings, secondsFromReports(reports), deal.files);
}

/** The `e2e` job's summary of the deal: the timings' source, each shard's seconds, the spread. */
export function shardSummary(
  source: string,
  seconds: readonly number[],
  problems: readonly string[],
): string {
  const lines = ['### E2E shards', '', `Dealt by ${source}.`, ''];
  lines.push('| Shard | Seconds of tests |', '|-------|------------------|');
  seconds.forEach((value, n) =>
    lines.push(`| ${n + 1}/${seconds.length} | ${Math.round(value)} |`),
  );
  if (seconds.length > 0) {
    const slowest = Math.max(...seconds);
    const spread = slowest - Math.min(...seconds);
    const share = slowest > 0 ? Math.round((spread / slowest) * 100) : 0;
    lines.push(
      '',
      `Spread: ${Math.round(spread)} seconds between the fastest and the slowest shard ` +
        `(${share}% of the slowest).`,
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

/** A GitHub API call with this run's token, tried three times over a few seconds. */
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

/**
 * The timings this CI run deals by: the best artifact `chooseTimingsArtifacts` names whose run is
 * trusted, or the committed file when there is none, it is corrupt, or GitHub's API fails.
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
    const listed = (await gh.json(
      `/repos/${repository}/actions/artifacts?name=${TIMINGS_ARTIFACT}&per_page=100`,
    )) as { artifacts: Artifact[] };
    candidates = chooseTimingsArtifacts(
      listed.artifacts,
      run.repository.id,
      new Date(run.created_at!),
    );
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

/**
 * Lists the suite, deals it, checks Playwright selects exactly this shard's hand, runs it, and
 * writes the deal record.
 */
function runShard(
  shard: string,
  timingsPath: string | undefined,
  playwrightArgs: readonly string[],
): number {
  const { current, total } = parseShard(shard);
  const suite = list();
  const rootDir = suite.config?.rootDir;
  if (!rootDir) throw new Error("Playwright's list names no rootDir");
  const { source, timings } = readChosen(timingsPath);
  const files = specFiles(suite);
  const hand = dealShards(files, timings, total)[current - 1]!;
  const fallback = defaultSeconds(files, timings);
  const minutes = hand.reduce((sum, file) => sum + (timings[file] ?? fallback), 0) / 60;
  console.log(
    `e2e shard ${current}/${total}: ${hand.length} of ${files.length} spec files, ` +
      `about ${minutes.toFixed(1)} minutes of tests by ${source}`,
  );
  for (const file of hand) console.log(`  ${file}${file in timings ? '' : ' (no timing yet)'}`);
  const record: DealRecord = { shard: current, total, source, timings, files, hand };
  const writeRecord = () => {
    mkdirSync(join(import.meta.dirname, '..', 'test-results'), { recursive: true });
    writeFileSync(dealRecordFile(), `${JSON.stringify(record)}\n`);
  };
  if (hand.length === 0) {
    writeRecord();
    return 0;
  }

  const filters = hand.map((file) => fileFilter(rootDir, file));
  const selected = specFiles(list(filters));
  if (JSON.stringify(selected) !== JSON.stringify(hand)) {
    console.error(`The filters select ${JSON.stringify(selected)}, not this shard's hand.`);
    writeRecord();
    return 1;
  }
  const run = spawnSync('npx', ['playwright', 'test', ...filters, ...playwrightArgs], {
    stdio: 'inherit',
  });
  writeRecord();
  return run.status ?? 1;
}

/** Each shard's artifact under `dir`, as `actions/download-artifact` lays them out by pattern:
 * `e2e-results-shard-<n>/`, each with `results.json` and `e2e-deal.json`. */
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
      };
    });
}

/** The `e2e` job's check of the deal, its summary, and with `publish` the next timings. */
function checkCommand(dir: string, publish: string | undefined): number {
  const shards = shardResults(dir);
  const { problems, seconds } = checkShards(shards);
  const source =
    shards.find((shard) => shard.deal)?.deal?.source ?? 'no timings any shard recorded';
  const summary = shardSummary(source, seconds, problems);
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
      `Published ${TIMINGS_ARTIFACT}: ${Object.keys(timings).length} spec files, ` +
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
    `${timingsFile()}: ${files} spec files from ${runs.length} runs, ` +
      `${minutes.toFixed(1)} minutes of tests`,
  );
  return 0;
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'refresh' && rest.length > 0) {
    process.exitCode = refresh(rest);
  } else if (first === 'timings' && rest.length === 1) {
    process.exitCode = await timingsCommand(rest[0]!);
  } else if (first === 'check' && (rest.length === 1 || rest.length === 2)) {
    const publish = rest[1]?.startsWith('--publish=')
      ? rest[1].slice('--publish='.length)
      : undefined;
    if (rest.length === 2 && !publish) process.exitCode = 2;
    else process.exitCode = checkCommand(rest[0]!, publish);
  } else if (first?.startsWith('--shard=')) {
    const timings = rest[0]?.startsWith('--timings=')
      ? rest[0].slice('--timings='.length)
      : undefined;
    process.exitCode = runShard(
      first.slice('--shard='.length),
      timings,
      timings === undefined ? rest : rest.slice(1),
    );
  } else {
    console.error(
      'Usage: node scripts/e2e-shards.ts --shard=<current>/<total> [--timings=<file>] [playwright args]\n' +
        '       node scripts/e2e-shards.ts timings <out file>\n' +
        "       node scripts/e2e-shards.ts check <dir of the shards' artifacts> [--publish=<out file>]\n" +
        "       node scripts/e2e-shards.ts refresh <dir of one run's Playwright JSON reports>...",
    );
  }
  if (process.exitCode === undefined) process.exitCode = 2;
}
