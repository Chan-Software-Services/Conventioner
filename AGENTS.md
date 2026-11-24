# Project agent memory

Conventioner runs a vendor market from applications to the door, in production at `conventioner.io`.

## Tech Stack

- Front-end: Vue 3 + Vite + TypeScript, the app's own components and SVG icons with no component library ([ADR 0015](docs/adr/0015-the-app-owns-its-components.md)), Pinia state management; Node 24.22.1 and its npm, pinned in `.nvmrc` (`nvm install`).
- Back-end: Python 3.12 / Flask + MongoDB.
- [The whole stack](docs/TECH_STACK.md), its versions and its folders.

## Branch Model

- `dev` is the default/integration branch: all feature PRs target `dev`.
- `main` is the deploy-only branch: reached ONLY by promoting a green `dev` commit through the Promote workflow (Daniel's to start; never a push to `main`, which its rulesets refuse).
  After a Release PR (merged with `--admin`, it gets no CI), merge `main` back into `dev`.
- Never commit directly to `main`.
  Never open PRs targeting `main` (except the release-please Release PR, which is automated).
- **Promotion is a fast-forward, made only by Promote's GitHub App ([ADR 0027](docs/adr/0027-main-moves-only-through-promote.md)), and only Daniel deploys, by hand**, with the Deploy workflow on `main`.
  No push, merge or PR deploys; never start a deploy yourself.
  After an Instant Rollback, promote a build again or no deploy reaches the domain.
  A hotfix goes through `dev` when nothing unreleased waits there, else through a `hotfix/` branch from `main` ([hotfixes](docs/RELEASING.md#hotfixes)).

## Commits and releases

- All commits MUST follow Conventional Commits: release-please derives every version from them (`feat:` → minor, `fix:` → patch, breaking → major).
- Never edit `CHANGELOG.md` by hand: release-please writes it.
- Never reintroduce `release-as` in `release-please-config.json`: it overrides the version calculation on *every* run until cleared.
- [Full release docs](docs/RELEASING.md).

## Irreversible-safety rules

- **Never put the production `MONGODB_URI` in `back-end/.env`**: the local stack mounts that directory and would run against production.
  Pass it inline to one-off scripts.
  `reset_database.py` refuses whenever `MONGODB_URI` is set.
- **An operator makes or verifies an account with `back-end/create_account.py`**, never `create_test_user.py` (a fixture script that prints the password).
- **Real applicant data never leaves the PC**: `.scratch/examples/` holds the organizers' real Google Form exports, untracked; never commit, quote or paste from them.
  The committed hooks (`.githooks/`, installed with `git config core.hooksPath .githooks`) refuse a real email, phone or name before a commit or push; the gate and CI check again.
  Use fixture values, and never `--no-verify`; see [real data never leaves the PC](docs/implementation/conventions/security-invariants.md#real-data-never-leaves-the-pc).
- **There is no fallback signing secret anywhere in this repository** and there must never be one again - not even "for dev".
  A committed fallback is a published key; see [ADR 0010](docs/adr/0010-no-secret-has-a-fallback.md).
- [Running production](docs/OPERATIONS.md), its variables and its incidents; [rebuilding it from nothing](docs/VERCEL_DEPLOYMENT.md).

## Running the stack and the suites

- **Bring a worktree's stack up with `scripts/th-compose.sh up -d`**: email is off in it unless you pass `DISABLE_EMAIL=false`, and a fake answers for Discord unless you pass `DISCORD_FAKE=false`.
  The primary checkout's plain `docker compose up -d` needs `DISABLE_EMAIL=true` ([why](docs/TESTING.md#bypassing-captcha-and-email-in-tests)) and `DISCORD_FAKE=true` ([a fake Discord](docs/TESTING.md#a-fake-discord)).
  Every stack listens on `127.0.0.1` only, so dial it there, never at `localhost` ([why](docs/TESTING.md#testing-gotchas)).
  A worktree's stack and ports come from its [treehouse slot](scripts/README-treehouse.md).
- **The whole E2E suite**: `./scripts/seed_fixture.sh` then `cd front-end && npm run test:e2e`, on a running stack: the seed never starts one.
  The seed empties the stack's database, so it refuses unless it is told the stack: the slot it sits in, the exported `th-compose.sh ports`, or `--primary` in the primary checkout ([why](docs/TESTING.md#quick-start-seed-fixture)).
- The whole back-end suite: `cd back-end && python -m pytest tests/ -v`, with both `requirements.txt` and `requirements-dev.txt` installed.
  Its real-MongoDB suite, which skips there: `scripts/real-mongo-test.sh`, which starts a MongoDB of its own and removes it; never start one for it by hand with `docker run` ([why](docs/TESTING.md#the-real-mongodb-suite)).
  The whole front-end unit suite: `cd front-end && npm run test:unit`.
- **Before delivering, run only the tests your change reaches** ([what a builder runs](docs/TESTING.md#what-a-builder-runs)): the whole suites above are CI's, which runs them on every pull request and every push to `dev` and `main`, or a person's.
- **Run `npm run format` in `front-end/` before committing**: CI's `format:check` fails unformatted front-end code and `docs/`.
- `scripts/nm-test.sh --skip-e2e` runs every suite but Playwright; without the flag it adds Playwright, on an isolated stack of its own.
  The no-mistakes gate runs only its real-data checks (`--real-data-only`) and a lint of the changed front-end and docs files, and leaves the suites to CI, where alone Playwright runs before a merge ([CI and the gate](docs/implementation/testing/ci-and-the-gate.md#the-no-mistakes-gate)).
- [Setting up a machine](docs/STARTUP.md); [every suite and its gotchas](docs/TESTING.md).

## Knowledge graph

- **Durable knowledge lives in the graph, entered at [`docs/README.md`](docs/README.md)**, which lists every folder of nodes.
- Before adding a node or editing a node's frontmatter, read [adding a node](docs/README.md#adding-a-node).
- **A PR that changes a described file touches the node or bumps `verified`**: the required `knowledge-graph` check fails a PR that does neither.
- **Run `python3 scripts/knowledge_graph.py check` after editing any Markdown.**
- Before adding a row to a doc's shared list or table, read [two features never share a line](docs/implementation/conventions/two-features-never-share-a-line.md).

## Before changing an area, read its node

- Before changing a file, run `git grep -l '<path>' docs` and read each node it lists; the lines below name what it does not find.
- Before changing how a screen gets, holds or writes a market, read [one market, from the server](docs/implementation/conventions/one-market-from-the-server.md) and [the market store](docs/implementation/modules/market-store.md).
- Before changing a market route or link, read [every market page has an address](docs/implementation/conventions/every-market-page-has-an-address.md).
- Before changing the market bar, its tabs or a market screen's layout, read [the market frame](docs/implementation/modules/market-frame.md).
- Before changing what a screen says in a phase or on an intake path, read [the market guide](docs/implementation/modules/market-guide.md).
- Before a screen holds work the server does not have yet, read [unsaved work asks before it is dropped](docs/implementation/conventions/unsaved-work-asks-before-it-is-dropped.md).
- Before changing styles, tokens or a control's look, read [the design language](docs/design-system.md) and [every control is named](docs/implementation/conventions/every-control-is-named.md).
- Before adding or changing a reusable component, read [the component library](docs/implementation/modules/component-library.md).
- Before writing or changing a dialog, read [dialogs](docs/implementation/conventions/dialogs.md).
- Before changing what Market Setup may change after draft, read [the setup settles on leaving draft](docs/business/rules/the-setup-settles-on-leaving-draft.md).
- Before changing who may do what on a market, or adding a check, read [what each role may do](docs/business/rules/what-each-role-may-do.md), [the market's actions](docs/implementation/modules/market-actions.md) and [an archived market is read-only](docs/business/rules/an-archived-market-is-read-only.md).
- Before changing a verdict or when review closes, read [verdicts settle on entering assignment](docs/business/rules/verdicts-settle-on-entering-assignment.md).
- Before changing how an organizer updates a vendor's answers, or adding a reader of an application's answers, read [an update is kept beside the vendor's answer](docs/business/rules/an-update-is-kept-beside-the-vendors-answer.md) and [the application document](docs/implementation/data/application-document.md#an-organizers-update-of-an-answer).
- Before changing the solver or a placement rule, read [the assignment solver](docs/implementation/modules/assignment-solver.md) and [the assignment behaviour suite](docs/implementation/testing/assignment-behaviour-suite.md); the rules it keeps are listed in [business/rules/](docs/business/rules/README.md).
- Before changing a placement, a pin or a swap, read [placements](docs/implementation/modules/placements.md) and [ADR 0002](docs/adr/0002-a-pin-is-a-placement-row.md).
- Before changing how an amount reads, on screen or in a file, or an amount field, read [an amount reads to the cent](docs/business/rules/an-amount-reads-to-the-cent.md).
- Before writing a raw Mongo read, filter or write on a market, read [the market document](docs/implementation/data/market-document.md).
- Before writing to a market, read [the market write](docs/implementation/modules/market-write.md) and [ADR 0024](docs/adr/0024-a-market-write-holds-what-it-read.md).
- Before recording a change on a market, or changing the market's history or how Manage market reads it, read [the market's history](docs/implementation/data/history.md), [ADR 0017](docs/adr/0017-one-history-for-every-change.md) and [reading the market's history](docs/business/flows/reading-the-markets-history.md).
- Before changing accounts or how an address is compared, read [users, and the one spelling of an address](docs/implementation/data/users-and-email.md).
- Before adding a query on a new field, read [lookup indexes](docs/implementation/data/lookup-indexes.md).
- Before looking anything up by a value from a request body, read [a request value is a string](docs/implementation/conventions/a-request-value-is-a-string.md).
- Before adding or moving a back-end Python dependency, read [Python dependencies are locked](docs/TECH_STACK.md#python-dependencies-are-locked).
- Before deleting a market or an organization, or adding a collection keyed by market, read [market deletion](docs/implementation/modules/market-deletion.md) and [when an organization may be deleted](docs/business/rules/when-an-organization-may-be-deleted.md).
- Before changing a secret, a cookie setting, the request-origin check, a boot check, an environment variable or the real-data hooks, read [security invariants](docs/implementation/conventions/security-invariants.md) and the environment table in [releasing](docs/RELEASING.md).
- Before changing how a route answers an error, what a screen says of a failed request, or where signing in returns to, read [an exception never reaches a client](docs/implementation/conventions/an-exception-never-reaches-a-client.md).
- Before answering a back end that refuses to boot, read [operations](docs/OPERATIONS.md#when-the-back-end-refuses-to-boot).
- Before writing or changing an E2E spec, read [E2E patterns](docs/implementation/testing/e2e-patterns.md) and [E2E seeds](docs/implementation/testing/e2e-seeds.md).
- Before adding a test that spans the organizer's journey, read [the market journey spec](docs/implementation/testing/the-market-journey-spec.md).
- Before adding or changing test data, read [test data](docs/implementation/testing/test-data.md).

## Agent skills

### Issue tracker

- The durable Epic > Feature > Story backlog and the Wayfinder maps live in the team home, `~/agent-team-records/projects/conventioner/{backlog,wayfinding}/`, not in this repo.
- A Story's status moves in the team home as its Conventioner PR merges; GitHub is used for pull requests only, and its issue tracker is deliberately empty.
- [The tracker contract](docs/agents/issue-tracker.md) has the rest, and where every work-item id and `sources` string resolves.

## Maintaining this file

- This file holds only what nearly every session needs before it knows which area it is in.
- Durable knowledge about one area goes to a node in the graph, read against the code first, not here.
- A new area gains an index line, "Before changing X, read [node]", only when the path lookup does not find its node.
- Point to the authoritative file or command rather than repeating what the codebase already shows, and prefer rewriting or pruning a line over appending one.
