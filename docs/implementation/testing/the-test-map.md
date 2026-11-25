---
layer: implementation
kind: testing
describes:
  - scripts/test_map.py
  - back-end/tests/test_map_plugin.py
  - front-end/e2e/helpers/testMap.ts
  - scripts/affected-specs.py
verified: 2026-11-24
sources:
  - T349
  - T510
  - T612
  - T582
---

# The test map

**The test map says, for each E2E spec file, which app modules its pages loaded and which back-end endpoints it called, and for each endpoint, which back-end functions it runs.**
It is made to tell which E2E specs a change reaches, without running all of them, which `scripts/affected-specs.py` does for a builder ([choosing a builder's specs](#choosing-a-builders-specs)) and for [a pull request's CI run](ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs).
CI's `test-map` job writes it on the nightly Test run on `dev`'s tip, as the artifact `test-map` of that run, kept 90 days ([CI and the gate](ci-and-the-gate.md#which-suite-a-run-runs)).
No other run records or has a `test-map` job: not a pull request's, not the merge queue's, not a push's.
A run of a pull request into `dev` reads the newest map to [choose its E2E specs](ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs), and when a shard test failed on a pull request's run or a trial commit's, its `e2e` job reads the newest map, to [name a miss of the selection](#where-a-miss-shows).

## What it holds

One JSON file, `test-map.json`:

```json
{
  "commit": "<the dev commit it was built at>",
  "specs": {
    "<spec file>": {
      "modules": ["front-end/src/App.vue"],
      "endpoints": ["GET /markets/<market_id>"]
    }
  },
  "endpoints": {
    "GET /markets/<market_id>": {
      "back-end/api/markets.py": ["get_market_for_user"]
    }
  }
}
```

- A spec file is named as Playwright lists it, relative to `front-end/e2e/`, and every spec file with a test that ran is in `specs`, whatever it reached; the screen sweeps' tests, registered by `helpers/screenSweeps.ts`, count under the spec file that calls `sweepTheScreens()`.
- A module is the repository path of a file under `front-end/src/` that a page of the spec loaded, whichever of its tests loaded it.
- An endpoint is the method and the Flask rule, so `/markets/<market_id>` is one endpoint whatever the id.
- An endpoint's functions are the ones whose bodies ran while the app handled one of its requests in the back end's pytest suite, by file, each by its qualified name (`outer.inner`, `Class.method`).
  The request's `before_request` and `after_request` handlers and its error handlers count with its view.
  A line outside every function's body is left out: inside a request it runs only when that request is the first to import a module, an accident of the suite's order.

## Where it comes from

The nightly Test run, at 19:17 UTC on `dev`'s tip, records three things and builds the map from them, the last two steps by [`scripts/test_map.py`](../../../scripts/test_map.py).
Its first job, `suite` ([`scripts/ci_suite.py`](../../../scripts/ci_suite.py)), finds whether that commit already has an unexpired `test-map` artifact made by a run on `dev`, whichever run made it: then the run makes no map, as on a night with no merge; else it runs only the ten shards, recording, and the `test-map` job, and when GitHub cannot be read it records too.
`gh workflow run test.yml --ref dev` starts the same run by hand, to have a map of a large change before the night.

1. **The shards record each test.**
   On the nightly run, or one started by hand, each `e2e-shard` job sets `TEST_MAP_OUT`, and [`front-end/e2e/helpers/testMap.ts`](../../../front-end/e2e/helpers/testMap.ts), which `fixtures.ts` wraps Playwright's `test` in, appends one JSON line per test to it: its spec file, its start and end on the wall clock, every request its browser contexts made under `/src/` and `/api/`, and the V8 block coverage of its pages' modules (a DevTools session of each page's own, Chromium) as the stretches of each module that ran.
   A retry is a line of its own; a context a `beforeAll` opens records nothing, since no test is running then.
   The recording makes each test slower (on `3c1d7e14`, the push run that recorded spent 127 minutes in tests across its ten shards, the queue's run that did not 99, +28%), and only the nightly run records, so a test near its timeout can pass on pull requests and the queue and fail only while recording.
   Then the nightly run fails, which no rule reads and which never holds back a merge; its shard still recorded, so the map is still made.
   When a nightly run makes no map (it was cancelled, a shard recorded nothing, or the back end's suite failed under coverage), the next night tries again, since that commit still has none, and the map's readers keep the older one meanwhile.
   It takes no script's source: Playwright's `page.coverage` fetched the source of every module Vite serves, and a run recorded through it took some 40% longer in CI than one that recorded nothing.
   The build reads the requests and the window; the stretches are in the shard's records for a reader who wants more than the map holds, as T349's pruning did.
2. **The shards keep the back end's log.**
   Each shard saves `docker compose logs --timestamps --no-log-prefix backend` beside its records and uploads both as `test-map-shard-<n>` (kept 90 days), so the calls Node's seed helpers make count as well as the pages' own.
3. **The back end's suite runs once under coverage.**
   `test_map.py endpoints` runs `pytest tests/` in `back-end/` under `coverage run` with branch coverage of the back end's own code (not `tests/`, not `migrations/`), and loads [`back-end/tests/test_map_plugin.py`](../../../back-end/tests/test_map_plugin.py) as a plugin (`-p`), which names each test's coverage context by its node id and, while the app handles a request (`Flask.full_dispatch_request`), `<node id>|<METHOD> <rule>`.
   The plugin also writes the app's URL rules as the session ends.
   Nothing else loads it as a plugin: the suite's own runs collect only the tests in it.
4. **The build lays each shard's log against that shard's tests.**
   `test_map.py build` gives each request line of a shard's log to the test of that shard whose window holds it (one worker a shard, so at most one), and a line between two tests to none, so what a `beforeAll`, the global setup or the seed does counts for no spec.
   It matches each path to its rule, adds the pages' own `/api/` calls, and writes the map.
   It refuses, writing nothing, when a shard recorded no test, or when the shards that uploaded records are not the matrix's ten (`--shards-expected`), so a map is whole or not made.

The `endpoints` pass skips the real-MongoDB package, as a plain run does, since no server is given to it: a route only that package drives has no functions in the map.
Code that runs before the app dispatches a request, such as the session's loading, counts for the test that sent it, never for the endpoint.

## How old it can be

The newest map is the newest run on `dev` that made one, which is the last night's on `dev`'s tip of then, so at most a day behind a merge, unless that run was cancelled, a shard recorded nothing, or the back end's suite failed under coverage; then it is an older night's.
A map made by hand on another branch is never read, since its run's branch is not `dev`; a map a push to `dev` made, before the map was made nightly, is read until a nightly run makes a newer one.
A branch is ahead of it by its own commits and by what `dev` took since its run, and an artifact goes after 90 days.
So a spec, a module or a function that is newer than the map is not in it, and a reader of the map takes a branch's own diff from its merge-base for what the map cannot know.

## Choosing a builder's specs

[`scripts/affected-specs.py`](../../../scripts/affected-specs.py) reads the map and a branch's diff, and runs the E2E spec files the change reaches, from the worktree root, on the worktree's stack:

```sh
python3 scripts/affected-specs.py --run [-- <playwright arguments>]
python3 scripts/affected-specs.py --list [--json]
```

The diff is from the merge-base with `origin/dev` to the worktree, uncommitted and untracked files included, both sides of every hunk read.
The map is the newest `test-map` artifact of a run on `dev`, the nightly run's, which it downloads once a run, beside that run's shard reports, to `.stack-logs/test-map/<run id>/`, removing the ones it downloaded before; offline, it reads the one it has.
`--map`, `--results`, `--base` and `--head` (with `--list`) name a map, shard reports and commits instead, as for replaying a merged pull request.
CI makes the same choice for a pull request into `dev`, with no cap and without the specs the head lacks, but runs the whole suite on any doubt, such as no map or an old one ([what a pull request's E2E run runs](ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs)).

A spec is chosen by five rules:

1. **The change edits it, or a file it imports**, transitively: a helper two levels down counts, and so does a `front-end/src/` file a spec imports itself.
   A spec whose imports at the base reached a file the change deletes counts too, since its imports at the head no longer name that file; its reason is "imported `<path>`, which the change deletes".
2. **Its pages loaded a changed file under `front-end/src/`.**
   A `.ts` or `.vue` file there whose change is to its comments alone, a `//` or `/* */` in a script or a `<!-- -->` in a template, runs nothing new, so it reaches no spec by any rule.
   Comments alone means the file reads the same at both sides of the diff with its comments taken out, each run of white space, or a script's comment, read as one space, or as one line break when it holds one, and a template's comment read as nothing; strings, templates, regexes, a tag's values, an interpolation `{{ }}` and the text of a `<style>`, `<pre>`, `<textarea>` or `<title>` are kept whole, so a `//` inside one is code.
   So is a template comment with white space beside it on its line and no line break there, as in `<b>x</b> <!-- c --> <i>y</i>`: Vue's dev build, which the E2E stack runs, keeps the comment and drops the white space between it and an element, so taking it out changes the page.
   A file the scanner cannot read for sure (an unclosed string, comment, template literal, regex, tag or interpolation, a script whose `lang` is not `ts`, a template with a `lang`) counts whole.
3. **It called an endpoint whose requests ran a changed back-end function.**
   The function is the one holding a changed line on either side of the hunk, so a deleted function is found by its old name.
   A line that runs nothing names none: a blank line, a comment, or the text of a docstring, the string that opens a module, class or function body.
   A `#` inside any other string is code, and so is a docstring's line once the change moves its quotes over a line it leaves that ran at the other side, or that it cannot pair with one there (when the two sides leave different numbers of lines, none pairs).
   When either side of the change does not parse, every line on both sides counts but a blank or `#` one.
   A change outside every function, such as an import or a constant, or in a function the map does not list, counts for every function of its file, choosing every spec that reaches the file.
   The back end's own tests reach no spec.
4. **Every spec, for a file the whole suite stands on**: `e2e/fixtures.ts`, `e2e/global-setup.ts`, `playwright.config.ts`, `package-lock.json`, `vite.config.ts` and `index.html` in `front-end/`, a compose file, a Dockerfile, a back-end lock but the advisory scan's, or `scripts/seed_fixture.sh` or the stack rule it sources, `scripts/lib/stack-identity.sh`.
   So does the E2E run's own machinery: `.github/workflows/test.yml`, a file under `.github/actions/`, `front-end/scripts/e2e-shards.ts` and its `e2e-shard-timings.json`, `scripts/affected-specs.py`, `scripts/test_map.py`, `scripts/chromium-packages.sh` and `scripts/image-tags.sh`.
5. **Every spec, for a file under `front-end/` or `back-end/` that no rule places**: not a spec, not imported by one at the head or the base, in no spec's modules and no endpoint's files.
   Such a file can drive any spec: a stylesheet `main.css` pulls in by `@import`, which Vite inlines so no page requests it, a back-end module no endpoint ran in the suite, or a file no rule reads, such as `back-end/docker-entrypoint.sh` or `front-end/tsconfig.app.json`.
   Its reason is "`<path>` is not in the map".
   A file the change deletes is placed by its deletion and chooses nothing here, since whatever read it, an importer, a stylesheet's `@import` or a config naming it, changes with it and is placed on its own; a deleted file a rule does place still chooses what that rule chooses.
   These drive no spec and choose nothing, since neither the stack nor a page reads them:
   - the docs and any Markdown
   - the suites that are not E2E: `back-end/tests/`, `scripts/tests/`, `front-end/src/__tests__/`, a `*.test.ts`, and a `*.test.ts(x)` or `*.spec.ts(x)` under `front-end/src/`
   - the unit suite's config: `front-end/vitest.config.ts` and `front-end/tsconfig.vitest.json`
   - the back end's pytest config, `back-end/pytest.ini`
   - the lint and format configs: `eslint.config.ts`, `stylelint.config.js`, `.prettierrc.json`, `.prettierignore` and `.editorconfig` in `front-end/`
   - the scripts in `front-end/scripts/` that check the build, or that nothing in CI runs: `bundle-budget.ts`, `no-eval.ts` and `brand-icons.ts`
   - the [design contract](../../design-system.md#the-contract-agents-read-designmd)'s generator, `design-md.ts` and `design-md-content.ts` in `front-end/scripts/`, which write the root `DESIGN.md` and nothing the stack or a page reads
   - the back end's deploy config, `back-end/vercel.json`
   - the advisory scan's lock, `back-end/requirements-audit.in` and `requirements-audit.txt`, which only [CI's `python-advisories` job](ci-and-the-gate.md#ci) installs
   - the migrations, `back-end/migrations/`, which an operator runs by hand and which nothing the app, the seed or a spec imports

The chosen specs are ordered by score: each changed thing a spec reaches adds 1 divided by how many specs reach it, so a module every spec loads (`App.vue`) or an endpoint every spec's setup calls adds almost nothing, while one that three specs reach decides the order.
A changed spec, and each changed file a spec imports, adds 1; a change counted for a whole back-end file, rule 4 and rule 5 add nothing, though they still choose.
Specs of one score run the shorter first.

They run in that order until the next would pass the cap, 30 CI minutes (`--minutes`), by the minutes each spec took in the map's run's shard reports, then in `front-end/scripts/e2e-shard-timings.json`, then the median of those.
A spec the change edits runs whatever the cap.
It prints what it runs and what it leaves to CI, each with its reasons, and with `--run` leaves out a spec the map names that the worktree does not have yet, saying so, and answers with Playwright's exit code.

With no map at all (no `gh`, offline with none downloaded, or no run on `dev` has made one in 90 days), it says so and chooses by rule 1 alone, which is what Playwright's own `--only-changed` chooses.

The E2E run of a pull request into `dev` is the map's selection, or the whole suite on any doubt, and the merge queue's run is whole and is the net.
So a spec the cap left out of a builder's run still runs on the pull request, and a spec the map left out still runs before anything merges, on the queue, where its failure drops the pull request from the queue.
A spec can fail through the data its setup seeds, where no map of the code a spec runs tells it from the other specs seeding the same way; that is the miss the whole run is for.

`scripts/tests/test_affected_specs.py` holds each rule, the order and the cap, the download and the fallback, and [both audits](#where-a-miss-shows), to a small repository, a fixture map and fixture shard reports.

## Where a miss shows

On a pull request, once the shards have run, CI's `e2e` job audits the selection:

```sh
python3 scripts/affected-specs.py audit --github --base HEAD^1 --head HEAD <each shard's results.json>
```

It takes the pull request's diff from its merge commit's first parent, hence two commits, and the newest map and its minutes as a builder's run does, and names each spec file with a failed test in the shards' reports, a test a helper registers counting under the spec file that calls it, as one of three:

- **ran**: the selection runs it, so a builder's `--run` would have shown the failure;
- **left to CI**: the selection chose it, but past the cap;
- **missed**: the selection did not choose it at all.

A test failed when it failed every attempt, or passed only on a retry, which under `failOnFlakyTests` fails its shard too.
The job's summary lists the specs under "E2E selection audit", a chosen one with its rank and reasons, or says "no failure to audit" when no test failed, and "nothing to audit" when it read no shard report, as when the reports' download failed.
Each miss is also a warning annotation on the run, "A miss of the selection", naming the spec and the changed files, so it shows a map that drifted, or a dependency the rules cannot see.
A pull request's run into `dev` that is [slimmed](ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs) runs only specs `e2e-select` named, and the audit reads the map again, so it lists a miss on such a run only when it read a newer map than `e2e-select` did, or none.
With no map, the selection is rule 1 alone: a failure outside it is listed as missed, with no annotation, since there is no map to have drifted.

**A pull request's run into `dev` is the selection, so a miss of it first shows on the merge queue**, whose run is whole.
So on a trial commit `e2e` audits too, judging each failed spec by [what the pull request's own run would have run](ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs):

```sh
python3 scripts/affected-specs.py audit --queue --github --base HEAD^1 --head HEAD <each shard's results.json>
```

The trial commit's first parent is the commit the queue built it on, so the diff is the queued pull request's own change.
The audit decides as `affected-specs.py ci` does, with no cap, and names each failed spec as one of three:

- **ran on the pull request**: the decision names specs, this one among them;
- **the pull request ran the whole suite**: the decision is the whole suite, for the reason it gives;
- **left out by the pull request's run**: the decision names specs, and not this one.

The job's summary lists them under "E2E selection audit (merge queue)", with the diff and any map it read, the decision's reason and the changed files.
Each spec left out is also a warning annotation on the run, "A spec the pull request's run left out", naming the spec and the changed files.
It decides again when it runs, so it is no record of what the pull request's run did: a `dev` that moved since, a map made since, one grown more than 7 days old or one it cannot read can change a verdict, and an `e2e-select` that could not decide ran the whole suite, whatever the audit says.

Neither audit fails the job: each exits 0 whatever it finds, or when it cannot audit at all, saying why in the summary, and its step continues on error, so `e2e`'s verdict never hangs on an audit.

## Building one by hand

From the worktree root, on the worktree's stack (`team-stack up`, `team-stack seed`), with the back end's locks installed:

```sh
python3 scripts/test_map.py endpoints --out <dir>/endpoints.json
cd front-end && TEST_MAP_OUT=<dir>/shards/test-map-shard-1/records.jsonl npx playwright test <specs>
docker logs --timestamps --since <when the run began> <the stack's back-end container> \
  ><dir>/shards/test-map-shard-1/backend.log
python3 scripts/test_map.py build --commit "$(git rev-parse HEAD)" \
  --endpoints <dir>/endpoints.json --shards <dir>/shards --out <dir>/test-map.json
```

`scripts/tests/test_test_map.py` holds the build to fixture records, logs and a real coverage data file; `src/__tests__/theTestMapRecords.test.ts` the recording's pure parts; the plugin's own tests are in its file.
