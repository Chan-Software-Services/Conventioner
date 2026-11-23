#!/usr/bin/env python3
"""Which suite a Test run runs (T510): the first job of .github/workflows/test.yml, `suite`.

    ci_suite.py --event <github.event_name> --commit <sha>

It writes one word to stdout and exits 0, and one sentence saying why to stderr and, when
GITHUB_STEP_SUMMARY is set, as a line of the run's summary:

- `push` (the job runs on a push to `dev` alone): the newest by `run_number` of `dev`'s merge queue
  runs on the commit decides, read by scripts/github_runs.py's `dev_runs`. A run that passed is
  `warm`: the queue tested this very commit, so the push only warms the caches the pull requests
  read. A run still going is settled by its jobs, since GitHub can mark a run completed seconds
  after its last job ended: every job passed or skipped is `warm`. No queue run, one that did not
  pass, or GitHub unread is `full`, the whole suite.
- Any other event: `full`.

The workflow treats anything but a word, a crash or a usage error included, as `full`, so a doubt
always runs the whole suite. Every read goes through `github_runs.read`, fails closed with its
reason and is never retried.

The commit must be a full 40-character sha (upper case is read as lower). Needs GITHUB_REPOSITORY
and GITHUB_TOKEN; GITHUB_API_URL defaults to https://api.github.com. Exit codes: 0 decided, 2 a
usage error, with nothing on stdout. Nothing printed holds the token.
"""
import argparse
import os
import re
import sys
from typing import List, Optional, Tuple

import github_runs

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHOWN = 80
JOB_PASSED = {"success", "skipped"}


def short(sha: str) -> str:
    return sha[:12]


def say(word: str, sentence: str) -> int:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(f"{sentence}\n")
    print(sentence, file=sys.stderr, flush=True)
    print(word, flush=True)
    return 0


def queue_run(runs: list) -> Optional[dict]:
    """The newest queue run's facts; raises on an answer unlike GitHub's."""
    newest = max((run for run in runs if run["event"] == "merge_group"), key=lambda run: run["run_number"], default=None)
    if newest is None:
        return None
    facts = {key: newest[key] for key in ("status", "conclusion", "html_url")}
    if not isinstance(facts["status"], str) or not isinstance(facts["html_url"], str):
        raise TypeError("run")
    if facts["status"] != "completed":
        facts["id"] = newest["id"]
        if not isinstance(facts["id"], int):
            raise TypeError("id")
    return facts


def every_job_passed(data) -> bool:
    """Whether every job of a run listed has passed or was skipped; raises on an answer unlike GitHub's."""
    listed, total = data["jobs"], data["total_count"]
    if not isinstance(listed, list) or not isinstance(total, int):
        raise TypeError("jobs")
    ended = [(job["status"], job["conclusion"]) for job in listed]
    whole = bool(listed) and total <= len(listed)
    return whole and all(status == "completed" and conclusion in JOB_PASSED for status, conclusion in ended)


def queue_passed(sha: str, api: str, repository: str, token: str) -> Tuple[Optional[str], Optional[dict], Optional[str]]:
    """`(verdict, run, reason)`: verdict `passed`, `ended` or `going` of the newest queue run, or None."""
    runs, reason = github_runs.dev_runs(sha, api, repository, token)
    if reason is not None:
        return None, None, reason
    try:
        run = queue_run(runs)
    except github_runs.UNREADABLE as error:
        return None, None, type(error).__name__
    if run is None:
        return None, None, None
    if run["status"] == "completed":
        return ("passed" if run["conclusion"] == "success" else "ended"), run, None
    passed, reason = github_runs.read(
        api, f"/repos/{repository}/actions/runs/{run['id']}/jobs", token, every_job_passed,
        {"filter": "latest", "per_page": 100},
    )
    if reason is not None:
        return None, None, reason
    return ("passed" if passed else "going"), run, None


def on_push(sha: str, api: str, repository: str, token: str) -> int:
    verdict, run, reason = queue_passed(sha, api, repository, token)
    if reason is not None:
        return say(
            "full",
            f"Could not read the merge queue's Test run for {short(sha)} from GitHub ({reason}),"
            " so this push runs the whole suite.",
        )
    if run is None:
        return say("full", f"No merge queue Test run on {short(sha)}, so this push runs the whole suite.")
    url = run["html_url"]
    if verdict == "passed":
        return say("warm", f"The merge queue's Test run passed on {short(sha)} ({url}), so this push only warms the caches.")
    if verdict == "ended":
        return say(
            "full",
            f"The merge queue's Test run on {short(sha)} ended {run['conclusion']} ({url}), so this push runs the whole suite.",
        )
    return say(
        "full", f"The merge queue's Test run on {short(sha)} has not passed yet ({url}), so this push runs the whole suite."
    )


def required(command: argparse.ArgumentParser, name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        command.error(f"{name} is not set")
    return value


def main(argv: Optional[List[str]] = None) -> int:
    root = argparse.ArgumentParser(description="Which suite a Test run runs (scripts/ci_suite.py).")
    root.add_argument("--event", required=True, help="the run's github.event_name")
    root.add_argument("--commit", required=True, help="the full 40-character sha the run tests")
    args = root.parse_args(argv)
    sha = args.commit.lower()
    if not FULL_SHA.match(sha):
        root.error(f"--commit takes a commit's full 40-character sha, not {args.commit[:SHOWN]}")
    repository = required(root, "GITHUB_REPOSITORY")
    token = required(root, "GITHUB_TOKEN")
    api = os.environ.get("GITHUB_API_URL") or "https://api.github.com"
    if args.event == "push":
        return on_push(sha, api, repository, token)
    return say("full", f"A {args.event[:SHOWN]} run runs the whole suite.")


if __name__ == "__main__":
    sys.exit(main())
