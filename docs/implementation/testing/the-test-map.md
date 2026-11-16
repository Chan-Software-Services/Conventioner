---
layer: implementation
kind: testing
describes:
  - scripts/test_map.py
  - back-end/tests/test_map_plugin.py
  - front-end/e2e/helpers/testMap.ts
verified: 2026-11-16
sources:
  - T349
---

# The test map

**The test map says, for each E2E spec file, which app modules its pages loaded and which back-end endpoints it called, and for each endpoint, which back-end functions it runs.**
It is made to tell which E2E specs a change reaches, without running all of them.
CI's `test-map` job writes it on every push to `dev`, as the artifact `test-map` of that run, kept 90 days ([CI and the gate](ci-and-the-gate.md)).
A pull request's run records nothing and has no `test-map` job.

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
    "GET /markets/<market_id>": { "back-end/api/markets.py": ["get_market"] }
  }
}
```

- A spec file is named as Playwright lists it, relative to `front-end/e2e/`, and every spec file of the run is in `specs`; the screen sweeps' tests, registered by `helpers/screenSweeps.ts`, count under the spec file that calls `sweepTheScreens()`.
- A module is the repository path of a file under `front-end/src/` that a page of the spec loaded, whichever of its tests loaded it.
- An endpoint is the method and the Flask rule, so `/markets/<market_id>` is one endpoint whatever the id.
- An endpoint's functions are the ones whose bodies ran while the app handled one of its requests in the back end's pytest suite, by file, each by its qualified name (`outer.inner`, `Class.method`).
  The request's `before_request` and `after_request` handlers and its error handlers count with its view.
  A line outside every function's body is left out: inside a request it runs only when that request is the first to import a module, an accident of the suite's order.

## Where it comes from

Each push to `dev` records three things and builds the map from them, the last two steps by [`scripts/test_map.py`](../../../scripts/test_map.py):

1. **The shards record each test.**
   On a push to `dev`, each `e2e-shard` job sets `TEST_MAP_OUT`, and [`front-end/e2e/helpers/testMap.ts`](../../../front-end/e2e/helpers/testMap.ts), which `fixtures.ts` wraps Playwright's `test` in, appends one JSON line per test to it: its spec file, its start and end on the wall clock, every request its browser contexts made under `/src/` and `/api/`, and the V8 block coverage of its pages' modules (`page.coverage`, Chromium) as the stretches of each module that ran.
   A retry is a line of its own; a context a `beforeAll` opens records nothing, since no test is running then.
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
   It refuses, writing nothing, when a shard recorded no test or fewer shards than the matrix's ten uploaded records (`--shards-expected`), so a map is whole or not made.

The `endpoints` pass skips the real-MongoDB package, as a plain run does, since no server is given to it: a route only that package drives has no functions in the map.
Code that runs before the app dispatches a request, such as the session's loading, counts for the test that sent it, never for the endpoint.

## How old it can be

The newest map is the newest push to `dev` whose run made one, which is `dev`'s last push unless that run was cancelled, a shard recorded nothing, or the back end's suite failed under coverage; then it is the push before.
A branch is ahead of it by its own commits and by what `dev` took since its run, and an artifact goes after 90 days.
So a spec, a module or a function that is newer than the map is not in it, and a reader of the map takes a branch's own diff from its merge-base for what the map cannot know.

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
