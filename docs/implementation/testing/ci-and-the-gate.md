---
layer: implementation
kind: testing
describes:
  - .github/workflows/test.yml
  - .github/workflows/codeql.yml
  - .github/dependabot.yml
  - .no-mistakes.yaml
  - scripts/nm-test.sh
  - scripts/e2e-lock.sh
  - scripts/image-tags.sh
  - scripts/th-compose.sh
  - front-end/e2e/helpers/stack.ts
  - front-end/e2e/helpers/containerNames.ts
  - front-end/scripts/bundle-budget.ts
  - front-end/scripts/e2e-shards.ts
  - front-end/scripts/e2e-shard-timings.json
  - front-end/scripts/no-eval.ts
  - front-end/vite.config.ts#noDevModules
  - .github/actions/e2e-stack/action.yml
  - .github/actions/front-end-deps/action.yml
  - scripts/ci_suite.py
verified: 2026-11-23
sources:
  - T47
  - T53
  - T74
  - T84
  - T109
  - T200
  - T221
  - T234
  - T254
  - T263
  - T273
  - T284
  - T294
  - T317
  - T375
  - T424
  - T464
  - T510
---

# CI and the gate

GitHub Actions runs the suites before code reaches `dev`, on every pull request and merge queue trial commit, and again on a push only when [the queue did not test that commit](#which-suite-a-run-runs); the no-mistakes gate, on a branch pushed through it, checks it for real data before it pushes and [leaves the suites to CI](#the-no-mistakes-gate).
[Dependabot's pull requests](#dependabot) meet only the first.
What each suite covers is [TESTING.md](../../TESTING.md); how a commit reaches production is [RELEASING.md](../../RELEASING.md).

## CI

[`.github/workflows/test.yml`](../../../.github/workflows/test.yml) runs on pushes and pull requests to `dev` and `main`, and on [a merge queue's trial commit](#a-merge-queues-trial-commit) for `dev`.
Its token is read-only (`permissions: contents: read`, and on the `suite` job `actions: read` too, for the queue's run, and on the `e2e` job, for the newest `test-map` artifact, another run's), every action is pinned by its full commit SHA with the version in a comment beside it, which [Dependabot](#dependabot) bumps together, and no checkout keeps its git credentials (`persist-credentials: false`), since no job pushes.
No `${{ }}` expression is written inside a `run:` script: a value reaches the shell through the step's `env:` and is read as a variable.
A push to a pull request's branch cancels the run of its earlier head (`concurrency`); a push to `dev` or `main` never cancels one, since each commit there keeps the checks a promotion reads, and neither does a trial commit, whose group is its own queue branch and commit.
Every job but `e2e-shard` (whose checks are `e2e shard <n>/10`) sets `name:` to its id, the name `dev`'s and `main`'s rules require its check by, so renaming a job drops a required check.
CodeQL's analysis is [a workflow of its own](#codeql), whose three checks `dev` requires too.

Each job is one block, what it runs one item a line ([two features never share a line](../conventions/two-features-never-share-a-line.md)); a new job is a block beside the job it is most like, and a new step of a job is one item beside the step it is most like.

**`suite`**

- on a push to `dev` alone, and first, before every other job: [`scripts/ci_suite.py`](../../../scripts/ci_suite.py) reads the queue's Test run on the pushed commit and says, as the job's output `run`, [which suite the run runs](#which-suite-a-run-runs)
- the runner's own `python3`, since the script needs only the standard library, with the run's read-only token
- skipped on every other run, so a pull request's, a trial commit's and a push to `main`'s start every job at once, as before it

**`backend`**

- Python 3.12, the locks `requirements.txt`, `requirements-floorplan-solver.txt` and `requirements-dev.txt`, a re-lock that fails on any difference ([the locks](../../TECH_STACK.md#python-dependencies-are-locked)), then pytest, with a `mongo:7` service ([why not 8.0](real-mongo-suite.md#the-mongodb-version)) on runner port 27117, allowed [64000 open files](real-mongo-suite.md#the-mongodb-version), for [the real-MongoDB suite](real-mongo-suite.md), which `REAL_MONGODB_REQUIRED=true` makes fail rather than skip without it

**`frontend-unit`**

- the Node `.nvmrc` pins, `npm ci`, Vitest

**`frontend-lint-and-types`**

- a check that the Node is `.nvmrc`'s, `npm ci --engine-strict` (the npm is `engines.npm`), and a check that npm writes the committed lockfile unchanged ([Node and npm are pinned](../../TECH_STACK.md#node-and-npm-are-pinned)), then Prettier's `format:check` over `front-end/` and `docs/`, ESLint (`lint:check`, which never fixes, since a fix on the runner is thrown away, and refuses a warning as it does an error), Stylelint (`lint:css`, the [design language](../../design-system.md) gate, which refuses a warning as it does an error), the type-check (`vue-tsc --build` over the app, its unit tests, the E2E specs and the Node-run config files and scripts), and a `vite build`, which fails on [a development page](#no-development-page-in-the-build), measured against [the bundle budget](#the-bundle-budget) and checked for [no string evaluated as script](#no-string-evaluated-as-script)

**`knowledge-graph`**

- pytest from `back-end/requirements-dev.txt`, the scripts' tests (on the Node `.nvmrc` pins, since the pre-warm's tests run its npm) and `knowledge_graph.py check`, then, on a pull request only, `knowledge_graph.py drift` against the base branch, which fails on a changed file a node describes when the pull request neither touches that node nor bumps its `verified`
- it clones the full history for the drift

**`real-data-and-workflows`**

- four short checks in one job, so [one run fits the account's 20 jobs](#the-e2e-shards): on a pull request only, [`real_data_check.py`](../../../scripts/real_data_check.py) on the PR's commits since the base branch ("No real data in the PR's commits") and then on every file of the merge it checks out ("No real data anywhere in the tree"), then gitleaks 8.28.0 (checksum-verified, fully redacted) on the same commits, which lets by only the fingerprints in the root `.gitleaksignore` (a fixture value gitleaks takes for a key, in a commit already pushed, which only a force-push could take out of the range), the backstop to the git hooks and the gate, which run the checker before anything is pushed ([real data never leaves the PC](../conventions/security-invariants.md#real-data-never-leaves-the-pc))
- on every run, [zizmor](https://docs.zizmor.sh/) 1.31.1 (checksum-verified) with `--offline` over the repository, which audits the five workflows (Test, CodeQL, Deploy, Release Please and Promote), the [shared e2e actions](#the-e2e-stack-and-its-caches) and `dependabot.yml` without a token, where any finding fails the job and its log names the audit, file and line, an accepted finding is ignored on the line zizmor reports, with its audit and the reason after it (`# zizmor: ignore[<audit>] <reason>`), and there is no zizmor config file, so nothing is ignored wholesale
- then [actionlint](https://github.com/rhysd/actionlint) 1.7.12 (checksum-verified) over the five workflows: their syntax, expressions, job references and action inputs (a local action's against its `action.yml`), and each `run:` script through the runner's shellcheck, which zizmor's security audits do not read, but not a composite action's own scripts, where any finding fails the job and its log names the file, line and rule
- last, on a pull request only, zizmor without `--offline`, given the run's read-only token, for the audits that look actions up on GitHub (an impostor commit, a known-vulnerable action or a confused ref behind a pin), with `--format github`, so each finding is an annotation on the pull request, and `continue-on-error`, so a finding or an outage of GitHub's API never fails the job

**`docker-build`**

- `docker compose build`

**`e2e-shard`**

- ten runners, each running the [shared actions](#the-e2e-stack-and-its-caches), which fill `front-end/node_modules`, install Chromium, load the stack's images from the cache or build them, start the stack and seed it with `seed_fixture.sh --primary`, then running the spec files [dealt to it by time](#the-e2e-shards), with `DISABLE_CAPTCHA`, `DISABLE_EMAIL` and `DISCORD_FAKE` set
- it posts a flaky-test summary and uploads its JSON report (`e2e-results-shard-<n>`, kept 90 days) on every run, and on failure uploads the whole report
- on a push to `dev` alone it also records [the test map](the-test-map.md) (`TEST_MAP_OUT`) and uploads the records with the back end's timestamped log (`test-map-shard-<n>`, kept 90 days)

**`warm-caches`**

- on a warm push alone: the setup-node step with npm's cache, `npm ci` so that cache is full to save on a miss, then both [shared actions](#the-e2e-stack-and-its-caches) saving, the stack's with `start: "false"`, so it restores or makes each cache a pull request reads and runs no test, no stack and no build of the front end
- it continues on error (`continue-on-error: true`), so a cache it could not save costs the next pull requests a cold start, never a red run on a commit the queue passed

**`e2e`**

- passes only when every shard did
- on a pull request it first runs [the selection audit](the-test-map.md#where-a-miss-shows), which lists each spec the shards failed in the job's summary as ran, left to CI or missed by `affected-specs.py` for the pull request's diff, each miss also a warning annotation once a test map exists, its steps continuing on error so they never decide the job

**`test-map`**

- on a push to `dev` alone whose shards ran (not [a warm one](#which-suite-a-run-runs)), once they are done, whatever their result: the back end's suite once under coverage and the build of [the test map](the-test-map.md) from it and the shards' records, uploaded as `test-map` (kept 90 days)
- not a required check, and never run on a pull request
- it continues on error (`continue-on-error: true`), so a map that fails is not made but never decides the run's conclusion or Promote, which reads it

**`dev`'s ruleset requires eleven checks, and `main`'s rulesets six.**
Both require `backend`, `frontend-unit`, `frontend-lint-and-types`, `docker-build`, `e2e` and `real-data-and-workflows`.
`dev` also requires `knowledge-graph`, [CodeQL's](#codeql) `Analyze (actions)`, `Analyze (javascript-typescript)` and `Analyze (python)`, each of its ten from GitHub Actions, and `agent-review`, a commit status the agent team's reviewer sets on a pull request's head rather than a CI job, from any source.
`dev`'s rules are one ruleset with a merge queue: a pull request into `dev` merges only through the queue, by a merge commit, once every required check has passed on its head and again on [the queue's trial commit](#a-merge-queues-trial-commit), and its `code_scanning` rule holds back one that brings in [a new CodeQL alert](#codeql).
The ruleset has no bypass actor, so nothing merges into `dev`, the merge of `main` back into it included, without all eleven, short of changing the ruleset itself; `main`'s rulesets let an admin bypass them through a pull request only, which is how the Release PR merges with `--admin`, and let no one but the Promote workflow's App push to `main` ([RELEASING.md](../../RELEASING.md#branch-model), [ADR 0027](../../adr/0027-main-moves-only-through-promote.md)).
`e2e` is a job of its own so the rules name one check whatever the shard count becomes.
It runs whatever the shards' result, so a failed shard fails it, but not on a cancelled run (`!cancelled()`), which would post a red `e2e` on the head a later push made moot, nor on a warm push, whose skipped shards would post a red one on a commit the queue passed.
`knowledge-graph` fails a pull request that changes a described file without touching its node or bumping `verified`: its drift step is part of the required check.
The online zizmor step never fails `real-data-and-workflows`: a rate limit or outage of GitHub's API would otherwise block a merge, and the offline step already holds the workflows to the offline audits.
The selection audit never fails `e2e`, for the same reason: a failed download or an outage of GitHub's API would otherwise block a merge whose shards all passed.
The real-data steps of `real-data-and-workflows` are the only real-data check the gate's own commits get: the document, lint and CI-fix steps commit after `nm-test.sh` has run, and the gate pushes them from its repository, which has no hooks installed ([real data never leaves the PC](../conventions/security-invariants.md#real-data-never-leaves-the-pc)).

**A flaky test fails the build.**
Under `CI`, Playwright retries twice and sets `failOnFlakyTests` ([`front-end/playwright.config.ts`](../../../front-end/playwright.config.ts)), so a test that passes only on a retry still fails its shard.
Every failed attempt and every retry keeps its trace, so the shard's `playwright-artifacts-shard-<n>` artifact, uploaded on that failure, holds every failed attempt's trace beside its passing retry's ([when a test fails](../../TESTING.md#when-a-test-fails)).
Within a shard the tests share one database (`workers: 1`); never across shards.

## Which suite a run runs

**A push to `dev` of a commit the merge queue passed runs no test: it only warms the caches.**
The queue merges a pull request by the very trial commit it tested, so the push of that commit to `dev` would run the same suite on the same tree a second time, about 165 runner minutes that tested nothing new ([ADR 0043](../../adr/0043-a-commit-the-queue-tested-is-not-tested-again-on-dev.md)).
`suite`'s one step, `decide`, runs `ci_suite.py --event <event> --commit <sha>`, which prints one word and says why in one sentence, in its log and in the run's summary:

- `warm`: the newest run of `dev`'s merge queue on the commit (an event `merge_group` whose head branch starts `gh-readonly-queue/dev/`, by `run_number`, read through `github_runs.dev_runs`) completed with `success`; or it is still going and every one of its jobs has passed or was skipped, since GitHub can mark a run completed seconds after the push it merged has started
- `full`: no such run, one that ended otherwise, one with a job not passed yet, GitHub unread or answering unlike GitHub, and every event but a push

The step's shell turns anything but one of the script's words into `full` (a crash, a usage error, nothing printed, a stray word), and the jobs read an empty `run`, `suite` skipped or failed, as `full` too, so no doubt ever skips a test.
Each word runs these jobs:

| `run`            | Jobs                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| empty, or `full` | every test job, as before `suite`: `backend`, `knowledge-graph`, `real-data-and-workflows`, `frontend-unit`, `frontend-lint-and-types`, `docker-build`, the shards and `e2e` |
| `warm`           | `warm-caches` alone                                                                                                                                                          |
| `map`            | the shards alone                                                                                                                                                             |

Each test job `needs: suite` and runs `if: ${{ !cancelled() && (needs.suite.outputs.run == '' || needs.suite.outputs.run == 'full') }}`, the shards on `map` too; `!cancelled()` lets them run when `suite` was skipped or failed.
A required check whose job its `if:` skipped reports success, so a warm push's six required checks and `e2e` pass on a commit whose queue run passed them, and its run is green whatever `warm-caches` did.
[Promote](../../RELEASING.md#how-a-promotion-proves-itself) reads that run or the queue's, the newest of the two.

## A merge queue's trial commit

**Every required check a workflow makes runs on the commit a merge queue builds for `dev`.**
The `merge_group` trigger (`checks_requested`, for `dev` alone, since `main` moves only through Promote) runs the Test workflow and [the CodeQL workflow](#codeql) on the trial commit GitHub builds for a queued pull request on its own `gh-readonly-queue/dev/...` branch, runs separate from the pull request's and the push's, so the queue gets the Test workflow's seven required checks and CodeQL's three on the commit it would merge.
`dev`'s one other required check, `agent-review`, comes from outside this repository: the agent team posts it on the trial commit.
The roll-up `CodeQL` check is not required, since GitHub posts it only on a pull request, never on a trial commit.
On it `github.base_ref` and `github.event.pull_request` are empty, since they belong to a pull request's event, and each job reads its event as follows:

| Job                                                                   | On a trial commit                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `suite`, `warm-caches`                                                | skipped: `suite` runs on a push to `dev` alone, and `warm-caches` only on its `warm`                                                                                                                               |
| `backend`, `frontend-unit`, `frontend-lint-and-types`, `docker-build` | every step, as on a push: `suite` skipped leaves `run` empty, which their `if:` reads as the whole suite, and no step has an `if:`                                                                                 |
| `knowledge-graph`                                                     | the scripts' tests and `knowledge_graph.py check`; the drift step, which reads `github.base_ref`, is skipped, as on a push, since it judges a pull request against its base, which the pull request's own run does |
| `real-data-and-workflows`                                             | zizmor offline and actionlint; the real-data scans, gitleaks and zizmor online, each `if: github.event_name == 'pull_request'`, are skipped, as on a push                                                          |
| `e2e-shard`                                                           | every step, as on a push, but shard 1 saves no cache ([why](#the-e2e-stack-and-its-caches)) and no shard records [the test map](the-test-map.md), which only a push to `dev` records (`RECORD_TEST_MAP`)           |
| `e2e`                                                                 | its `if:`, which reads `suite`'s empty `run` as the whole suite; the selection audit's steps, each `if: github.event_name == 'pull_request'`, are skipped, as on a push                                            |
| `test-map`                                                            | skipped (`if:` a push to `dev`), as on a push to `main`; not a required check                                                                                                                                      |
| CodeQL's `analyze`, the three `Analyze (<language>)` checks           | every step, as on a push: none has an `if:`                                                                                                                                                                        |

Each workflow's concurrency group is `<its name>-<its queue branch's ref>-<its sha>` (`Test-...`, `CodeQL-...`), so no other run shares it and none is cancelled.
The queue builds at most two trial commits at once: one asks for 19 of [the account's 20 jobs](#the-e2e-shards), so a third would only wait for runners, while a second fills the runners the first leaves idle in its long `e2e` tail.
The queue drops an entry whose required check has not reported within 120 minutes, above the 98 the slowest of 80 recent Test runs took.
Promotion reads a trial commit's run: [`promote_check.py`](../../../scripts/promote_check.py) takes the newest Test run on the commit from `dev`'s queue or a push to `dev`, so the push run of a merged commit decides, and a commit the queue merged inside a batch, whose push was a later commit, is decided by its own queue run.

## The e2e shards

Each `e2e-shard` job runs [`front-end/scripts/e2e-shards.ts`](../../../front-end/scripts/e2e-shards.ts) `--shard=<n>/10`, not Playwright's `--shard`.
Playwright's `--shard` cuts the alphabetical list of spec files into runs of equal test count, whatever the tests cost (with `fullyParallel: false` a spec file is never split), so on the first six-shard run the three people-at-scale files, whose names sort together, all landed on one shard: 24 minutes of tests on it, 6 on another, and 28 minutes for the workflow.
The script lists the suite with `playwright test --list`, deals the spec files heaviest first, each to the shard with the fewest seconds so far, by the seconds in [`front-end/scripts/e2e-shard-timings.json`](../../../front-end/scripts/e2e-shard-timings.json), and runs its own hand in alphabetical order.
The hands depend only on the list and the timings, so every runner deals the same ones and each spec file is in exactly one (`src/__tests__/e2eShards.test.ts`); before it runs, the script lists its hand again through the filters it passes and fails the shard if Playwright selects any other set of files.
A spec file with no timing yet weighs the median of those measured.

The timings are the summed duration of every attempt of every test in a file, from CI's own reports.
Refresh them when a shard runs well over the others, or after a large spec file lands:

```sh
gh run download <run id> -R Chan-Software-Services/Conventioner -p 'e2e-results-shard-*' -D <an empty dir>
cd front-end && node scripts/e2e-shards.ts refresh <that dir>
```

and commit the rewritten file in its own `ci:` PR.
The refresh lists the suite and refuses, naming each file, when a spec file it lists is in none of the reports, as when a shard stopped before Playwright wrote its report, so a missing shard never drops its files to the median.
The first timings came from run 42493172818's list-reporter times, before the reports were uploaded on a passing run; they were refreshed from run 42973207637 (89 minutes of tests) when the shards went from six to ten.

**Ten shards, since the suite is the run's critical path.**
With six, the slowest shard ended a median 21.5 minutes into a run, while every other job was done by 2.7; a shard is about 3 minutes of setup and its share of the suite, so ten bring a shard to about 12 minutes at about 13 more runner-minutes of setup a run.
That holds while runners are free: the account is on GitHub Free, which runs 20 jobs at once across the repository.
A pull request's or a trial commit's run asks for 19, so it fits alone: 16 Test jobs at its start (`backend`, `knowledge-graph`, `real-data-and-workflows`, `frontend-unit`, `frontend-lint-and-types`, `docker-build` and the ten shards), `e2e` only once the shards are done, and CodeQL's three; a push to `main` asks for the same.
A [warm push](#which-suite-a-run-runs) to `dev` asks for two, `suite` then `warm-caches`, and CodeQL's three; a whole-suite push to `dev` asks for `suite` first, then the same 16, then `e2e` with `test-map` beside it once the shards are done.
That is why the five short checks (drift, the real-data scan with gitleaks, zizmor offline, zizmor online and actionlint) are steps of `knowledge-graph` and `real-data-and-workflows`: as five jobs of their own they made one run ask for 24, more than the account runs at once.
With another run going, shards still wait: on one such run four shards queued 9 to 12 minutes, and the run ended at 23 minutes while each shard's own time was 10.5 to 12.5.
The matrix lists the shards and their `total`, which move together.

## The e2e stack and its caches

Two composite actions set an `e2e-shard` runner up for Playwright, and fill the caches on a [warm push](#which-suite-a-run-runs)'s `warm-caches`.
[`.github/actions/front-end-deps/action.yml`](../../../.github/actions/front-end-deps/action.yml) sets up the Node `.nvmrc` pins and fills `front-end/node_modules`; it runs first, since with no `front-end/node_modules` on the host Docker (as root) creates the anonymous volume's mountpoint there root-owned, and a later `npm ci` fails with `EACCES`.
[`.github/actions/e2e-stack/action.yml`](../../../.github/actions/e2e-stack/action.yml) installs Chromium, gets the stack's two images, pulls `mongo:7` and `mongo-express:latest` from Docker Hub, retrying only that pull a handful of times, because a transient registry 500 once failed a shard outright, so a stack that genuinely fails to start fails the job at once, then starts the stack and seeds it.
Its input `start`, `"true"` unless given, is `"false"` for `warm-caches` alone: both restores then only look their key up (`lookup-only`), so a hit downloads nothing; Chromium is installed on a miss without `--with-deps`, and the system libraries, the images' load, the registry pull, the stack and its seed are skipped, while the build of the images and both saves run on a miss as they do on a shard.
Each `uses:` line calls an action by its path (`./.github/actions/...`) with a `zizmor: ignore[self-repository]`: zizmor asks for GitHub's newer `$/` form, which actionlint 1.7.12, the latest, refuses.

**Dependencies, browsers and images come from GitHub's Actions cache, keyed on the files that decide them.**

| Cache                                                               | Key                                                                                                                                                                            | On a hit                                                           | On a miss                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------- |
| `front-end/node_modules`                                            | `front-end-node-modules-<os>-<arch>-<hash>`, the hash of `.nvmrc` and `package-lock.json`                                                                                      | nothing more                                                       | `npm ci`                                      |
| Playwright's browsers, `~/.cache/ms-playwright`                     | `playwright-chromium-<os>-<arch>-<version>`, the version `npx playwright --version` prints, which `package-lock.json` decides                                                  | `npx playwright install-deps chromium`, the system libraries alone | `npx playwright install chromium --with-deps` |
| the back end's and front end's images, as one `docker save` archive | `e2e-images-<os>-<arch>-<backend tag>-<frontend tag>`, the tags [`scripts/image-tags.sh`](../../../scripts/image-tags.sh) prints, a hash of the files each image is built from | `docker load`                                                      | `docker compose build`                        |

The source is not in the images' key: an image's `COPY` of the source is stale on a hit, and the compose file's bind mounts of `back-end/` and `front-end/` put the checked-out source over it, while the front end's `node_modules` volume is filled from the image, whose `package-lock.json` is in the key.
That is the rule by which every worktree and `nm-test.sh` stack shares its images ([below](#the-no-mistakes-gate)).
Only one job of a run saves (`save-cache` and `save-caches`), and only what it did not restore, so ten shards never race to write one key: shard 1 of a pull request's run or of a whole-suite push's, and `warm-caches` on a warm push, which also saves npm's cache, the setup-node cache `frontend-unit` and `frontend-lint-and-types` read; the first run of a new key installs and builds on every shard, as before.
`docker-build` never uses the cache: it builds both images from nothing on every run, so a base image or a dependency that no longer builds still fails it.
A cache written on `dev` is read by every pull request; one written on a pull request's run only by that pull request's later runs.
A trial commit's shards read `dev`'s, the default branch's, and save none: a cache written on its queue branch would be read by no other run.
The three caches are about 660 MB together (the images' archive about 340, the browsers about 280, `node_modules` about 40), saved once by each pull request that changes a key's files, against the repository's 10 GB of Actions cache, which GitHub evicts least recently used first and after 7 days unread.

## The bundle budget

**CI fails a pull request whose entry JavaScript grows past a set gzipped size.**
The entry JavaScript is what a first visit downloads before any page paints: the module script `dist/index.html` loads and every chunk it preloads, not a route's lazily loaded chunk.
[`front-end/scripts/bundle-budget.ts`](../../../front-end/scripts/bundle-budget.ts) (`npm run bundle-budget`, after `npm run build-only`) gzips each at level 9, prints every chunk's size and the total against the limit on every run, and exits non-zero above it.
It runs in the required `frontend-lint-and-types` job and in `nm-test.sh`, both on a build made with `VITE_ALLOW_INSECURE_LOCAL_DEV=true`, since the bundle is measured and never deployed; CI's sets no site key and no `VITE_FLASK_HOST`, and builds by the hatch's two warnings.
Vue, its router and Pinia are the entry's chunk named `vue` ([`vite.config.ts`](../../../front-end/vite.config.ts)); before T263 the build named that chunk `_plugin-vue_export-helper`, after the Vue plugin's component helper it held.

The limit is `LIMIT_GZIP_BYTES` in that script, set a few KB above the total measured when it landed (101831 B against 105000 B, T76), lowered when the total fell (85740 B against 89000 B, T84, when vuedraggable stopped bringing a second Vue), and raised when growth was meant (89427 B against 92000 B, T161, the request's failure kinds, the 401 interceptor, the sign-in guard's `next` and the shell's notice for a page that could not be opened, which run before any route renders; 92032 B against 95000 B, T200, `AppDialog`'s widths, scrolling body, edge shades and tray), and lowered again when the floorplan beta went (83879 B against 94000 B, T257, its store no longer imported by `main.ts`).
It landed because nothing noticed `main.ts` installing vue-konva for the whole app, which put the floorplan canvas library on every page, `/login` included, for about 60 KB gzipped.
**Raise the limit only on purpose**: in the same pull request as the code that needs it, saying there what the extra bytes buy, and still a few KB above the new total so the next unplanned growth fails.
The first fix to try is a lazily loaded route or component, which keeps the code out of the entry.

## No string evaluated as script

**CI fails a build any of whose JavaScript calls `eval` or the `Function` constructor.**
The front end's [Content-Security-Policy](../conventions/security-invariants.md#security-headers) has no `'unsafe-eval'`, so the browser refuses such a call, and with no reporting endpoint a refusal in production shows only in the console of the tab it broke.
[`front-end/scripts/no-eval.ts`](../../../front-end/scripts/no-eval.ts) (`npm run no-eval`, after `npm run build-only`) reads every `.js` file under `dist/assets/`, prints each call with its file and a little context, and exits non-zero on any; it runs right after the bundle budget, on the same build, in `frontend-lint-and-types` and in `nm-test.sh`.
The first one it would have caught was vuedraggable's UMD build, whose bundled core-js finds the global object with `Function('return this')()` and whose `require("vue")` pulled in a second Vue with its template compiler; `vite.config.ts` resolves `vuedraggable` to the ES source the package publishes beside its builds, which has neither.

## No development page in the build

**A production build fails when any module of the component library is in it.**
The [component library](../modules/component-library.md) is a development build's only, reached through the router's `if (import.meta.env.DEV)` block, which `vite build` makes dead code.
`noDevModules`, a plugin in [`front-end/vite.config.ts`](../../../front-end/vite.config.ts), reads the modules of every chunk a production build emits and fails the build on any under `src/dev/`, naming each chunk and module; so `npm run build-only` fails in `frontend-lint-and-types` and in `nm-test.sh`, and so would a deploy's build.
It reads modules, not text, so a shipped file that imports the fixture or a part by any path is caught, as the router's block kept alive is; [`theComponentLibraryNeverShips.test.ts`](../../../front-end/src/__tests__/theComponentLibraryNeverShips.test.ts) builds a shipped module importing the fixture with the project's own configuration and finds the build refused.

## CodeQL

[`.github/workflows/codeql.yml`](../../../.github/workflows/codeql.yml), CodeQL's advanced setup, analyses `actions`, `javascript-typescript` and `python` with the default suite and no config, on every pull request and push to `dev` or `main`, every [trial commit](#a-merge-queues-trial-commit) for `dev`, and weekly on `dev`.
Its one job, `analyze`, makes an `Analyze (actions)`, an `Analyze (javascript-typescript)` and an `Analyze (python)` check, one runner each, none needing a build (`build-mode: none`), and sets each analysis's category to the default setup's, `/language:<language>`, so the alerts the default setup found and their dismissals carry over.
Its token has `contents: read`, `security-events: write` for the upload and `actions: read`, its actions are pinned as [the Test workflow's](#ci) are, and its concurrency is the Test workflow's rule.
It is the automated backstop for [a request value is a string](../conventions/a-request-value-is-a-string.md) (`py/nosql-injection`) and [an exception never reaches a client](../conventions/an-exception-never-reaches-a-client.md) (`py/stack-trace-exposure`).

**The three `Analyze (<language>)` checks are required on `dev`**, from GitHub Actions, so an analysis runs and passes on every trial commit before it merges.
GitHub's CodeQL default setup, a repository setting, runs nothing on a trial commit, and must stay off: while it is configured, GitHub refuses the workflow's uploads.
A pull request also gets a `CodeQL` check from `github-advanced-security` that reports the alerts new in the code it changed; it is not required, since GitHub posts it only on a pull request, so a queue requiring it would wait on every trial commit until the entry timed out.
**`dev`'s ruleset's `code_scanning` rule holds the alert bar instead**: a pull request that brings in a new security alert of medium severity or above (`security_alerts_threshold` `medium_or_higher`), or a new standard alert of severity error (`alerts_threshold` `errors`), cannot enter the queue.
Security alerts are held from medium, below GitHub's default of high, because `py/stack-trace-exposure` is a medium; standard alerts, which have a rule severity rather than a security one, at errors only.
`main`'s six checks are unchanged: nearly every commit reaches `main` by [promotion](../../RELEASING.md#how-a-promotion-proves-itself) from `dev`, where it has already been analysed, and the others are the Release PR, merged with `--admin`, and a [hotfix](../../RELEASING.md#hotfixes).
The workflow analyses `main` too, on every pull request and push to it, though `main`'s rules require none of its checks: a hotfix's pull request into `main` is analysed before it merges, and `main`'s alerts stay current, as under the default setup.

## Dependabot

[`.github/dependabot.yml`](../../../.github/dependabot.yml) has Dependabot open version-update pull requests weekly, for `npm` in `front-end/` and for the `github-actions` of the workflows and of the composite actions under `.github/actions/` (`directories`).
It has no `pip` entry: the back end's hashed locks are written by `uv` through `scripts/lock-backend-requirements.sh` ([the locks](../../TECH_STACK.md#python-dependencies-are-locked)), and that Dependabot writes them as the script does is unverified, so a back-end version bump is made by hand with the script.
Dependabot alerts, and the security-update toggle, are repository settings, not this file: they follow the dependency graph, so a `pip` security update can still arrive as a pull request; make it with the script rather than merging Dependabot's lock edits.

**Its pull requests target `dev`**, the default branch, and their titles are Conventional Commits that release-please reads:

| Updates                       | Title                  |
| ----------------------------- | ---------------------- |
| an npm production dependency  | `fix(deps): ...`       |
| an npm development dependency | `chore(deps-dev): ...` |
| a GitHub Action               | `ci(deps): ...`        |

The release effect of each type is the one in [RELEASING.md](../../RELEASING.md#conventional-commits); the npm split by dependency type keeps a tooling bump from carrying a `fix` title.
A week's minor and patch bumps come as one pull request per group (npm production, npm development, Actions), so CI runs once for each; a major bump comes on its own.
**A new release waits a week** (`cooldown: default-days: 7` on both updaters) before Dependabot proposes it, so a bad release has time to be pulled before CI runs it.
Security updates are not delayed: GitHub applies no cooldown to them.
The Actions updater bumps the workflows' and the composite actions' SHA pins and the version comments beside them.
A major the project cannot take yet is held with an `ignore` entry in the file, whose comment gives the reason, any upstream issues and when to try again, so next week's batch does not reopen it.
The holds today:

- `typescript` 7: 7.0 ships no JavaScript API, so `vue-tsc` and typescript-eslint cannot run on it.
- `@types/node` 25 and later: the types follow the Node major `.nvmrc` pins, 24, and move with that pin ([Node and npm are pinned](../../TECH_STACK.md#node-and-npm-are-pinned)), so a type check never accepts an API the running Node lacks.

A transitive dependency the project needs at a major its dependents do not ask for yet is held by `overrides` in `front-end/package.json`: today minimatch 11 ([the development tools](../../TECH_STACK.md#development-tools)).

The component kit's and icon font's next majors were held too, for their proprietary licence, until T45 removed both packages ([ADR 0015](../../adr/0015-the-app-owns-its-components.md)).

For these ecosystems, security updates take the same titles, and always target the default branch.

**Dependabot's pull requests bypass the no-mistakes gate**: CI's required checks are their gate, and a person reads each before merging it.
A bump to a described file fails the required `knowledge-graph` check on its drift step: `front-end/package.json` for [TECH_STACK.md](../../TECH_STACK.md), a workflow for this node and [RELEASING.md](../../RELEASING.md).
That holds the pull request until someone re-reads each affected node and pushes the `verified` bump to its branch.

## The no-mistakes gate

[`.no-mistakes.yaml`](../../../.no-mistakes.yaml) sets `allow_repo_commands: true` and one command, `test: ./scripts/nm-test.sh --real-data-only`.
**The gate reads `allow_repo_commands` only from the repository's default branch, `dev`**, so a pushed branch cannot turn it on for itself; with it on, as `dev` has it, the gate runs the pushed branch's own `commands`, not `dev`'s.
That is safe here only because every branch pushed through the gate is the team's own: the no-mistakes [repo config reference](https://kunchenguid.github.io/no-mistakes/reference/repo-config/) says to leave it `false` for a repository that accepts contributions.

**The gate leaves every suite to CI, and runs only the real-data checks.**
Its test step runs that command first as a baseline, and its agent then tests the change from a user's side as before; the baseline runs the [real-data check](../conventions/security-invariants.md#real-data-never-leaves-the-pc) on the branch's commits since `origin/dev` and on every file of the tree at `HEAD`, and fails the step on a finding.
That check stays because the gate pushes the branch to a public repository, and the real-data steps of CI's `real-data-and-workflows` read it only once it is published.
The suites went: until T294 the baseline was `--skip-e2e`, every suite but Playwright, the same suites CI's required jobs run, part of a test step whose median was 8.1 minutes, and it failed none of 241 gate runs from 2026-10-26 to 11-11; a failing unit test now shows in CI a few minutes after the push instead of in the gate.
Playwright had left the gate before (T47): on the laptop it was about 90% of the test step (22 minutes on a quiet machine, 46 to 65 under the team's load, and red on load alone in 3 of 8 runs), and CI then ran the same specs again.
So a pull request opens before any suite has passed on it; nothing merges red, because the suites' jobs are required, and a red one is the gate's red to fix.

[`scripts/nm-test.sh`](../../../scripts/nm-test.sh) is the runner the gate invokes, and anyone may run it.
With `--real-data-only`, as the gate runs it, it runs the two real-data checks, ends with `nm-test: --real-data-only: no suite run; CI runs them.` and makes no virtual environment, installs nothing and starts no stack.
With `--skip-e2e` it stops after Vitest, the build (which refuses [a development page](#no-development-page-in-the-build)), the [bundle budget](#the-bundle-budget) and [the eval check](#no-string-evaluated-as-script) with one line, `nm-test: --skip-e2e: Playwright is left to CI's e2e shards; no stack started.`, and starts no stack, sets no teardown trap and takes no heavy-run lock; without it, it runs everything below.
It runs, in order, the real-data check on the branch's commits since `origin/dev` and then on every file of the tree at `HEAD` (before anything else, and failing the run on a finding, since the gate pushes the branch), the scripts' tests and the knowledge graph's `check`, back-end pytest (installing `requirements.txt`, the floorplan solver's and the dev requirements, then re-locking them as CI does), the steps of `frontend-lint-and-types` before its build, in its order (a check that the Node is `.nvmrc`'s, which fails with `nm-test: ERROR: Node is <found>, not <pinned> (.nvmrc); run nvm use`, `npm ci --engine-strict`, the lockfile check, which leaves what npm wrote in the worktree to read, `format:check`, `lint:check`, `lint:css` and `type-check`, then `Frontend lint and types: OK`), front-end Vitest, a `vite build` held to the bundle budget and checked for no string evaluated as script, and Playwright against a Docker stack of its own, with `DISABLE_CAPTCHA`, `DISABLE_EMAIL` and `DISCORD_FAKE` set.
Its Python is `PYTHON_CMD`, else `python3.12` (`back-end/.python-version`), else `python3`, and it installs nothing into that Python: it makes a virtual environment of its own from it, installs there, and a guard deletes it once the run is gone, since a uv- or distro-managed Python refuses `pip install` outright (PEP 668).
Its stack is isolated: a unique `COMPOSE_PROJECT_NAME` (`nmtest-<pid>`), and host ports Docker assigns as the stack starts (`TH_PORTS=auto`, [below](#stack-identity)), so two runs started together can never race for one port, as runs that each probed for a free port before starting could.
Once the stack is up, the run reads its ports back with `th-compose.sh ports` and exports them for `seed_fixture.sh` and Playwright.
mongo-express is not started (it is in the overlay's `tools` profile).
It builds no image of its own: its stack runs the images every worktree and `nm-test.sh` stack with the same dependencies shares, `conventioner/backend:<tag>` and `conventioner/frontend:<tag>`, each tag a hash of the files its image is built from ([`scripts/image-tags.sh`](../../../scripts/image-tags.sh)), and `th-compose.sh ensure-images` builds one only when no image has its tag yet, so a run whose dependencies did not change builds nothing.
The source reaches the containers through the bind mounts, so the images do not depend on it.
It labels its stack `TEAM_KIND=gate`, the value the team's reaper reads, kept although only a run with neither switch starts a stack and the gate's own runs start none; it also sets `TEAM_WORKTREE` (its repository root), `TEAM_EXPIRES` (two hours after its start) and, only when `TEAM_TASK` is set, `TEAM_OWNER=agent-team`; the [worktree overlay](../../../scripts/README-treehouse.md) puts those labels on every container, volume and network, with `restart: "no"`, no bind mount that creates its missing source, every port on `127.0.0.1` and each service within its memory, CPU and process limits ([measured](../../TESTING.md#stack-limits)).

**A run's stack is gone within a minute, however the run ends.**

| The run                                                                  | What tears its stack down                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| passes, fails, or is sent `SIGTERM`                                      | the `EXIT` trap: it saves the back end's and front end's logs to `.stack-logs/`, then `down -v --remove-orphans`, printing any error |
| is aborted by the gate (`SIGTERM`, then `SIGKILL`, to its process group) | the teardown guard, since the `SIGKILL` kills the trap's own `docker` commands                                                       |
| is sent `SIGKILL`                                                        | the teardown guard, since nothing of the script runs after it                                                                        |

The teardown guard is a subshell that `nm-test.sh` starts with job control just before `up`, so it has a process group of its own and the gate's group kill misses it.
It waits for the run's process to be gone, then runs `docker compose -p <project> down -v --remove-orphans` (no compose file, as the gate may already be deleting the worktree), up to three times, until no container, volume or network of the project is left; after a normal exit it finds nothing left.
It writes to `.stack-logs/<project>-guard.log`, not to the run's output, so it holds nothing of the gate's open once the run is over.
Should both fail, the stack's `expires` label tells the team's reaper it may remove it.
A second guard, started the moment the run makes its virtual environment (`$TMPDIR/nmtest-<pid>-venv.*`), removes it once the run is gone, so a run killed in any phase leaves nothing behind.

**Runs take turns for their E2E phase, one at a time on a machine, and with the machine's other heavy runs.**
A stack starting or stopping creates or removes a Docker network, which changes the host's networks under every browser on the machine, and another run's Playwright then fails with `net::ERR_NETWORK_CHANGED`.
So from just after its images are built until its teardown is done, `nm-test.sh` holds an exclusive kernel lock on `$HOME/.local/state/agent-team/heavy.lock` ([`scripts/e2e-lock.sh`](../../../scripts/e2e-lock.sh)), taken with `flock` on one of its file descriptors, or with Python's `fcntl` where `flock` is missing.
That file is the machine's heavy-run lock, which the agent team's `team-heavy run` takes for each heavy command it runs (its own test suite, a project's local checks), so an E2E phase waits for such a command and such a command waits for an E2E phase; the path is under `$HOME` whatever `XDG_STATE_HOME` says, as `team-heavy` has it.
The kernel releases it when the last process holding that descriptor is gone: the run, and the teardown guard it starts just after taking it, so a killed run keeps the lock until its stack is down and a waiting run never starts beside a stack still being removed.
Every other command of the E2E phase (`up`, `seed_fixture.sh`, Playwright) runs with the descriptor closed, so a process one of them leaves behind, such as a browser, never keeps the lock.
The rest of the run (the knowledge graph, the back end's and the front end's unit tests, building a shared image whose dependencies changed) runs beside other runs.
A run that finds the lock held prints `nm-test: waiting for the heavy-run lock since <time>, held by <the holder's line>`, and `nm-test: has the heavy-run lock at <time>` once it has it; after 45 minutes without it the run fails with `no end-to-end slot within 45 minutes`.
Its own line in the file is `conventioner e2e <project> (pid <pid>, <worktree>) since <time>`, which `team-heavy status` prints after `held by`; the worktree after the pid keeps it from reading as a line of `team-heavy`'s own form, `<label> (pid <pid>) since <time>` or `<label> (pid <pid>, T<n>) since <time>`, whose pid the team takes for a `team-heavy`'s.
Under a `team-heavy` run, which sets `TEAM_HEAVY_HELD` for its command and holds the lock until that command ends, `nm-test.sh` takes nothing, since a second take would wait for the run it is part of: it prints `nm-test: under a heavy run, which holds the heavy-run lock for it`, and the lock then goes when that `team-heavy` ends, not when the teardown guard does.
To see who holds it and who waits: `cat ~/.local/state/agent-team/heavy.lock` names the last run to take it, and `lsof ~/.local/state/agent-team/heavy.lock` lists every process with it open, the holder and its guard, and each waiting run with its `flock`.
The lock is the one place T19's `team-capacity run --kind gate:conventioner` is to take over, keeping the lock as the fallback where `team-capacity` is absent; `nm-test.sh` does not call it yet, and the lock can go once the browser is isolated from the host's network changes.
`nm-test.sh` never calls `sudo`: it installs Chromium with `npx playwright install chromium`, never `--with-deps` or `install-deps`, because those run `sudo` with no terminal and each failed attempt counts toward the account's `pam_faillock` lockout; the machine's own package manager provides the system libraries.
CI's [e2e action](#the-e2e-stack-and-its-caches) keeps `--with-deps` when it starts the stack, and `install-deps` when the browser comes from its cache, which is correct on GitHub's Ubuntu runners.
What it does not run is CI's alone: `docker compose build`, gitleaks, zizmor, actionlint, the knowledge graph's drift check and CodeQL.

## Stack identity

Several stacks run on one machine (the primary checkout, each treehouse worktree, an `nm-test.sh` run), so every script and the E2E suite resolve which stack they mean in one order:

1. **Docker's ports** (`th-compose.sh` only): `COMPOSE_PROJECT_NAME` with `TH_PORTS=auto`, as `nm-test.sh` sets them.
   The wrapper leaves every host port empty (`127.0.0.1::<container port>`), so Docker picks each one as the container starts, and ignores any `TH_*_PORT` the caller set, so the stack's configuration is the same however it is called later.
   After an `up` it prints the assigned ports on stderr as `TH_MONGO_PORT=`, `TH_BACKEND_PORT=` and `TH_FRONTEND_PORT=` lines (and `TH_MONGO_EXPRESS_PORT=` when mongo-express runs).
   Without `COMPOSE_PROJECT_NAME` it refuses, even in a slot.
2. **Explicit variables**: `COMPOSE_PROJECT_NAME` with the `TH_*_PORT` variables, as `nm-test.sh` exports them once its stack is up.
3. **The treehouse slot** read from the path (`/.treehouse/<pool>/<N>/`): project `conventioner-N`, every port offset by `N * 10` ([the treehouse runbook](../../../scripts/README-treehouse.md)).
4. **Otherwise**: [`scripts/th-compose.sh`](../../../scripts/th-compose.sh) fails loud and sends the primary checkout to plain `docker compose`, and [`scripts/seed_fixture.sh`](../../../scripts/seed_fixture.sh) refuses before it touches anything, since it empties the stack's database: the default stack (the primary checkout's, or CI's one stack, which the `e2e` shards seed) takes `--primary`.
   It refuses as well when the environment names only part of a stack (some of `COMPOSE_PROJECT_NAME`, `TH_MONGO_PORT`, `TH_BACKEND_PORT` and `TH_FRONTEND_PORT`, not all), and `--primary` with any of them set or from a treehouse slot, where plain `docker compose` would name the project after the directory, the primary checkout's.
   It once fell back to the primary stack's defaults, and a gate run that seeded before exporting its own stack's ports wiped the primary checkout's local database.

The E2E suite's side is [`front-end/e2e/helpers/stack.ts`](../../../front-end/e2e/helpers/stack.ts), read by `playwright.config.ts`, `fixtures.ts` and [`helpers/containerNames.ts`](../../../front-end/e2e/helpers/containerNames.ts): the explicit variables, then the slot, then `CI` (one stack, named by `COMPOSE_PROJECT_NAME` or the directory), and otherwise it throws rather than guess, because a silent fall back to the primary stack once corrupted shared databases.
`BACKEND_URL`, `FRONTEND_PORT`, `E2E_MONGO_CONTAINER` and `E2E_BACKEND_CONTAINER` override it.
This order is what lets `nm-test.sh` run its stack from a worktree that has no treehouse slot without falling through to the primary stack.
`th-compose.sh ports` prints a running stack's project and ports as `export` lines, read from Docker with `docker compose port` in any of the wrapper's modes, so `eval "$(scripts/th-compose.sh ports)"` gives a shell, `seed_fixture.sh` and the suite the explicit variables of a stack whose ports Docker picked.
It fails when the stack's MongoDB, back end or front end is not running.
