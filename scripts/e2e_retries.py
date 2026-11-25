#!/usr/bin/env python3
"""The e2e tests that passed only on a retry over `dev`'s last Test runs (T606): the Test workflow's
nightly job `e2e-retries`.

    e2e_retries.py [--runs N]

Under CI Playwright retries a failed test twice and sets `failOnFlakyTests`, so a test that passes
only on a retry fails its shard and its run: a red trial commit is queued again, a red pull
request's shard is run again, and the test is forgotten. This gathers them, over the newest N
(20 unless told) Test runs on `dev` and its merge queue that ran the e2e shards:

- a run counts when it completed, on a push to `dev`, a nightly or hand-started run on `dev`, or a
  trial commit of `dev`'s merge queue (an event `merge_group` whose head branch starts
  `gh-readonly-queue/dev/`), and left an unexpired `e2e-results-shard-<n>` artifact; a run that
  ran no shard, a warm push or a night whose commit had a map, is passed over and not counted
- each such artifact's `results.json`, Playwright's JSON report, is read, and a test whose outcome
  is `flaky` passed only on a retry; a test is named by the spec file Playwright loaded and its
  title under that file, as Playwright joins it
- GitHub's list of runs is read 100 at a time, ten pages at most
- each counted run costs about a dozen requests of GitHub's API: its artifacts' list, a zip for each
  of the ten shards, and the list of a run passed over, about one a merge (its warm push); 20 runs
  are about 250, a quarter of the 1,000 an hour a run's GITHUB_TOKEN may make for the repository,
  which the Test, Promote and Deploy runs' reads share
- a 403 or a 429 (the rate limit, or a 403 for a token that may not read Actions, which every later
  read would get too) on a run's artifacts, a zip or a later page of runs stops the walk: the report
  holds the runs read before it and names where it stopped, and the run it stopped in is left out
  whole; on the first page of runs it fails with the reason, having read nothing

It writes the report, in Markdown, to stdout and, when GITHUB_STEP_SUMMARY is set, to the run's
summary: each test with how many of the runs it passed only on a retry in, and a link to each run,
most first. A run whose artifacts it could not all read is named under the table with the reason,
since a test may be missing from it.

Every read goes through `github_runs.read`, fails closed with its reason and is never retried; an
artifact's zip redirects to storage off GitHub's API, which is never sent the token. Needs
GITHUB_REPOSITORY and GITHUB_TOKEN (a token that may read the repository's Actions, as `gh auth
token` gives, whose own budget is 5,000 requests an hour); GITHUB_API_URL defaults to
https://api.github.com. Exit codes: 0 reported, 1 the list of runs could not be read (past its
first page a 403 or a 429 stops the walk instead), 2 a usage error, with nothing on stdout. Nothing
printed holds the token.
"""
import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

import github_runs

DEFAULT_RUNS = 20
#: The answers that stop the walk: GitHub's rate limit, or a token that may not read Actions.
STOPS = {
    "403": "GitHub answered 403, its rate limit or a token that may not read Actions",
    "429": "GitHub answered 429, its rate limit",
}
PER_PAGE = 100
MAX_PAGES = 10
RESULTS = "results.json"
SHARD_ARTIFACT = re.compile(r"^e2e-results-shard-\d+$")
#: Playwright's own separator between a test's titles.
TITLE_JOIN = " › "
#: Every event but a trial commit's whose run on `dev` counts.
ON_DEV = {"push": "push to dev", "schedule": "nightly", "workflow_dispatch": "by hand"}
QUEUE_PR = re.compile(r"/pr-(\d+)-")
HEADING = "### E2E tests that passed only on a retry"


def on_dev(run: dict) -> bool:
    """A completed run that judged `dev`, or its merge queue's trial commit; raises on an answer
    unlike GitHub's."""
    if run["status"] != "completed":
        return False
    if run["event"] in ON_DEV:
        return run["head_branch"] == "dev"
    if run["event"] == "merge_group":
        if not isinstance(run["head_branch"], str):
            raise TypeError("head_branch")
        return run["head_branch"].startswith(github_runs.DEV_QUEUE)
    return False


def kind(run: dict) -> str:
    if run["event"] == "merge_group":
        pr = QUEUE_PR.search(run["head_branch"])
        return f"merge queue, PR {pr.group(1)}" if pr else "merge queue"
    return ON_DEV[run["event"]]


def link(run: dict) -> str:
    return f"[{kind(run)}]({run['html_url']})"


def runs_on_dev(api: str, repository: str, token: str):
    """The completed runs on `dev` and its queue, newest first, page by page, as `(run, None,
    page)`; yields `(None, reason, page)` once and stops when a page could not be read."""
    for page in range(1, MAX_PAGES + 1):

        def parse(data):
            listed = data["workflow_runs"]
            if not isinstance(listed, list):
                raise TypeError("workflow_runs")
            return listed, [run for run in listed if on_dev(run)]

        answer, reason = github_runs.read(
            api,
            f"/repos/{repository}/actions/workflows/test.yml/runs",
            token,
            parse,
            {"status": "completed", "per_page": PER_PAGE, "page": page},
        )
        if reason:
            yield None, reason, page
            return
        listed, kept = answer
        for run in kept:
            yield run, None, page
        if len(listed) < PER_PAGE:
            return


def shard_artifacts(api: str, repository: str, run: dict, token: str) -> Tuple[Optional[list], Optional[str]]:
    """The run's unexpired `e2e-results-shard-<n>` artifacts, by name."""

    def parse(data):
        found = [
            artifact for artifact in data["artifacts"]
            if SHARD_ARTIFACT.match(artifact["name"]) and not artifact["expired"]
        ]
        if any(not isinstance(artifact["id"], int) for artifact in found):
            raise TypeError("id")
        return sorted(found, key=lambda artifact: artifact["name"])

    return github_runs.read(
        api, f"/repos/{repository}/actions/runs/{run['id']}/artifacts", token, parse, {"per_page": PER_PAGE}
    )


def retried(report: dict) -> List[Tuple[str, str]]:
    """Each test of a Playwright JSON report that passed only on a retry, as (spec file, title)."""
    found = []

    def walk(suite: dict, file: str, titles: List[str]) -> None:
        for spec in suite.get("specs", []):
            if any(test.get("status") == "flaky" for test in spec.get("tests", [])):
                found.append((file, TITLE_JOIN.join([*titles, spec["title"]])))
        for inner in suite.get("suites", []):
            walk(inner, file, [*titles, inner["title"]])

    for suite in report.get("suites", []):
        walk(suite, suite["file"], [])
    return found


def cell(text: str) -> str:
    return text.replace("|", "\\|")


def plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def render(
    asked: int,
    read: List[dict],
    tests: Dict[Tuple[str, str], List[dict]],
    unread: List[Tuple[dict, List[str]]],
    stopped: Optional[str],
) -> str:
    lines = [HEADING, ""]
    if not read:
        lines.append("No Test run on `dev` or its merge queue that GitHub still lists ran the e2e shards.")
    else:
        dates = sorted(run["created_at"][:10] for run in read)
        counted = plural(len(read), "Test run", "Test runs")
        found = (
            f"{plural(len(tests), 'test', 'tests')} passed only on a retry, in "
            f"{len({run['id'] for runs in tests.values() for run in runs})} of them."
            if tests else "no test passed only on a retry."
        )
        lines.append(
            f"The last {counted} on `dev` and its merge queue that ran the e2e shards, "
            f"{dates[0]} to {dates[-1]}: {found}"
        )
        if len(read) < asked and not stopped:
            verb = "was" if len(read) == 1 else "were"
            lines.append(f"Only {len(read)} of the {asked} asked for {verb} found.")
        if tests:
            lines += ["", "| Spec file | Test | Runs | Which |", "| --- | --- | --- | --- |"]
            order = sorted(tests, key=lambda key: (-len(tests[key]), key))
            for file, title in order:
                runs = tests[(file, title)]
                lines.append(f"| `{cell(file)}` | {cell(title)} | {len(runs)} | {', '.join(link(run) for run in runs)} |")
    if unread:
        named = "; ".join(f"{link(run)}, {', '.join(parts)}" for run, parts in unread)
        lines += ["", f"Not wholly read, so a test may be missing: {named}."]
    if stopped:
        lines += ["", f"Stopped at {stopped}, so the report holds only the runs before it."]
    return "\n".join(lines) + "\n"


def report(asked: int, api: str, repository: str, token: str) -> Tuple[Optional[str], Optional[str]]:
    read: List[dict] = []
    tests: Dict[Tuple[str, str], List[dict]] = {}
    unread: List[Tuple[dict, List[str]]] = []
    stopped = None
    for run, reason, page in runs_on_dev(api, repository, token):
        if reason:
            if page > 1 and reason in STOPS:
                stopped = f"page {page} of GitHub's list of runs: {STOPS[reason]}"
                break
            return None, reason
        artifacts, reason = shard_artifacts(api, repository, run, token)
        if reason in STOPS:
            stopped = f"{link(run)}: {STOPS[reason]}"
            break
        if reason:
            unread.append((run, [f"its artifacts ({reason})"]))
            continue
        if not artifacts:
            continue
        missed = []
        found: List[Tuple[str, str]] = []
        for artifact in artifacts:
            data, reason = github_runs.artifact_file(api, repository, artifact["id"], RESULTS, token)
            if reason in STOPS:
                break
            if reason is None:
                try:
                    found += retried(json.loads(data))
                except (ValueError, KeyError, TypeError, AttributeError) as error:
                    reason = type(error).__name__
            if reason:
                missed.append(f"`{artifact['name']}` ({reason})")
        if reason in STOPS:
            stopped = f"{link(run)}: {STOPS[reason]}"
            break
        for key in found:
            if run not in tests.setdefault(key, []):
                tests[key].append(run)
        if missed:
            unread.append((run, missed))
        read.append(run)
        if len(read) == asked:
            break
    return render(asked, read, tests, unread, stopped), None


def whole_number(text: str) -> int:
    if not re.fullmatch(r"[0-9]+", text) or int(text) < 1:
        raise argparse.ArgumentTypeError(f"a whole number of at least 1, not {text!r}")
    return int(text)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="The e2e tests that passed only on a retry over dev's last Test runs.")
    parser.add_argument("--runs", type=whole_number, default=DEFAULT_RUNS, help=f"how many runs that ran the shards (default {DEFAULT_RUNS})")
    args = parser.parse_args(argv)
    for name in ("GITHUB_REPOSITORY", "GITHUB_TOKEN"):
        if not os.environ.get(name):
            parser.error(f"{name} is not set")
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    text, reason = report(args.runs, api, os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_TOKEN"])
    if reason:
        text = f"GitHub's list of the Test runs could not be read ({reason}).\n"
        print(text, end="", file=sys.stderr, flush=True)
    else:
        print(text, end="", flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(text)
    return 1 if reason else 0


if __name__ == "__main__":
    sys.exit(main())
