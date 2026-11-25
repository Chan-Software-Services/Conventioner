"""The report of the e2e tests that passed only on a retry over dev's last Test runs (T606).

The script's command line runs as the nightly `e2e-retries` job runs it, against a stub GitHub API,
and the tests read what a person reads: the report on stdout and in the summary file, the reason on
stderr, and the exit code. The stub answers each path with a scripted answer and records every
request, in the pattern of test_ci_suite.py's, which this file does not import. An artifact's zip
answers, as GitHub's does, with a redirect to storage on another origin (the same host, another
port): a second stub.
"""
import io
import json
import subprocess
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "e2e_retries.py"

GITHUB_TOKEN = "github-token-not-for-logs"
RUNS = "/repos/owner/repo/actions/workflows/test.yml/runs"
SHA = "3c1d7e1423b61cc0c4383aeba4ade1e8ddf84d61"


class Stub:
    """An HTTP server whose answer per path is scripted: `(status, body bytes, headers)`."""

    def __init__(self):
        self.routes = {}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                parts = urlsplit(self.path)
                stub.requests.append((parts.path, parse_qs(parts.query), {k.lower(): v for k, v in self.headers.items()}))
                page = parse_qs(parts.query).get("page", [None])[0]
                answer = stub.routes.get((parts.path, page)) or stub.routes.get(parts.path)
                status, body, headers = answer or (404, b'{"message": "Not Found"}', {})
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def serve(self, path, status, body, headers=None, page=None):
        """Answers `path`, or with `page` only that page of it (`?page=<n>`)."""
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.routes[(path, str(page)) if page else path] = (status, data, headers or {"Content-Type": "application/json"})

    def paths(self):
        return [path for path, _, _ in self.requests]


def started():
    server = Stub()
    server.thread.start()
    return server


def stopped(server):
    server.server.shutdown()
    server.server.server_close()


@pytest.fixture
def stub():
    server = started()
    yield server
    stopped(server)


@pytest.fixture
def storage():
    """Where an artifact's zip redirects to: another port, so another origin."""
    server = started()
    yield server
    stopped(server)


@pytest.fixture
def env(tmp_path, stub):
    summary = tmp_path / "summary.md"
    summary.write_text("")
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path),
        "GITHUB_API_URL": stub.origin,
        "GITHUB_REPOSITORY": "owner/repo",
        "GITHUB_TOKEN": GITHUB_TOKEN,
        "GITHUB_STEP_SUMMARY": str(summary),
    }


def run(env, *args):
    """The script's exit code, stdout, stderr and summary file; the token is in none of them."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    summary = Path(env["GITHUB_STEP_SUMMARY"]).read_text() if "GITHUB_STEP_SUMMARY" in env else ""
    for text in (result.stdout, result.stderr, summary):
        assert GITHUB_TOKEN not in text
    return result.returncode, result.stdout, result.stderr, summary


# GitHub's answers.

def run_id(number):
    return 45500000000 + number


def run_url(number):
    return f"https://github.com/owner/repo/actions/runs/{run_id(number)}"


def a_run(number, event="push", branch="dev", status="completed", conclusion="failure", created="2026-11-25T04:22:36Z"):
    return {
        "id": run_id(number),
        "run_number": number,
        "event": event,
        "head_branch": branch,
        "head_sha": SHA,
        "status": status,
        "conclusion": conclusion,
        "created_at": created,
        "html_url": run_url(number),
    }


def queued(number, pr=435, **fields):
    """A trial commit of dev's merge queue, as GitHub lists run 45546349014."""
    return a_run(number, event="merge_group", branch=f"gh-readonly-queue/dev/pr-{pr}-{SHA}", **fields)


def runs_page(*items):
    return {"total_count": len(items), "workflow_runs": list(items)}


def artifact_id(number, shard):
    return run_id(number) * 100 + shard


def artifact(number, shard, name=None, expired=False):
    return {
        "id": artifact_id(number, shard),
        "name": name or f"e2e-results-shard-{shard}",
        "expired": expired,
    }


def artifacts_path(number):
    return f"/repos/owner/repo/actions/runs/{run_id(number)}/artifacts"


def zip_path(number, shard):
    return f"/repos/owner/repo/actions/artifacts/{artifact_id(number, shard)}/zip"


def zipped(files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return data.getvalue()


def attempts_of(status):
    """A test of a Playwright JSON report, its attempts as its outcome has them."""
    attempts = {
        "expected": ["passed"],
        "flaky": ["failed", "passed"],
        "unexpected": ["failed", "failed", "failed"],
        "skipped": ["skipped"],
    }[status]
    return {"status": status, "projectName": "chromium", "results": [{"status": s, "retry": n} for n, s in enumerate(attempts)]}


def spec(title, status="expected", file=None):
    return {"title": title, "file": file, "tests": [attempts_of(status)]}


def file_suite(file, specs=(), suites=()):
    """A spec file's suite, the top level of a report, as Playwright writes it."""
    return {"title": file, "file": file, "specs": [{**s, "file": s["file"] or file} for s in specs], "suites": list(suites)}


def describe(title, specs=(), suites=()):
    return {"title": title, "specs": list(specs), "suites": list(suites)}


def report(*suites):
    return {"config": {"rootDir": "/e2e"}, "suites": list(suites), "stats": {}}


def shard_of(stub, storage, number, shard, results):
    """One shard's artifact, its zip a redirect to storage, which serves `results.json` and the deal."""
    blob = f"/blob/{artifact_id(number, shard)}.zip"
    stub.serve(zip_path(number, shard), 302, b"", {"Location": f"{storage.origin}{blob}"})
    storage.serve(blob, 200, zipped({"results.json": json.dumps(results), "e2e-deal.json": "{}"}), {"Content-Type": "application/zip"})


def shards(stub, storage, number, *reports, extra=()):
    """A run that ran the shards: an `e2e-results-shard-<n>` artifact for each report."""
    stub.serve(
        artifacts_path(number),
        200,
        {"total_count": len(reports) + len(extra), "artifacts": [artifact(number, n) for n in range(1, len(reports) + 1)] + list(extra)},
    )
    for n, results in enumerate(reports, start=1):
        shard_of(stub, storage, number, n, results)


CLEAN = report(file_suite("clean.spec.ts", [spec("passes at once")]))
FLAKY = report(
    file_suite(
        "the-tabs.spec.ts",
        [spec("passes at once")],
        [describe("The market frame", [spec("scrolls the tabs", "flaky")])],
    )
)


def header(runs, oldest="2026-11-25", newest="2026-11-25"):
    noun = "run" if runs == 1 else "runs"
    return f"The last {runs} Test {noun} on `dev` and its merge queue that ran the e2e shards, {oldest} to {newest}"


# The report

def test_a_test_that_passed_only_on_a_retry_is_reported_with_its_file_title_and_run(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(queued(7, pr=435)))
    shards(stub, storage, 7, CLEAN, FLAKY)

    code, stdout, stderr, summary = run(env, "--runs", "5")

    assert code == 0
    assert stdout == summary
    assert stdout == (
        "### E2E tests that passed only on a retry\n"
        "\n"
        f"{header(1)}: 1 test passed only on a retry, in 1 of them.\n"
        "Only 1 of the 5 asked for was found.\n"
        "\n"
        "| Spec file | Test | Runs | Which |\n"
        "| --- | --- | --- | --- |\n"
        f"| `the-tabs.spec.ts` | The market frame › scrolls the tabs | 1 | [merge queue, PR 435]({run_url(7)}) |\n"
    )
    assert stderr == ""


def test_a_test_that_failed_every_attempt_or_passed_at_once_is_not_reported(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    failing = report(file_suite("broken.spec.ts", [spec("fails", "unexpected"), spec("is skipped", "skipped")]))
    shards(stub, storage, 7, CLEAN, failing)

    code, stdout, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert stdout == (
        "### E2E tests that passed only on a retry\n"
        "\n"
        f"{header(1)}: no test passed only on a retry.\n"
    )


def test_a_test_in_several_runs_is_one_row_counting_each_run_most_first(stub, storage, env):
    other = report(file_suite("other.spec.ts", [spec("waits", "flaky")]))
    stub.serve(
        RUNS,
        200,
        runs_page(
            a_run(9, event="schedule", created="2026-11-25T19:17:00Z"),
            queued(8, pr=439, created="2026-11-25T11:41:13Z"),
            a_run(7, event="workflow_dispatch", created="2026-11-24T08:00:00Z"),
        ),
    )
    shards(stub, storage, 9, FLAKY)
    shards(stub, storage, 8, other)
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "3")

    assert code == 0
    assert stdout == (
        "### E2E tests that passed only on a retry\n"
        "\n"
        f"{header(3, oldest='2026-11-24')}: 2 tests passed only on a retry, in 3 of them.\n"
        "\n"
        "| Spec file | Test | Runs | Which |\n"
        "| --- | --- | --- | --- |\n"
        f"| `the-tabs.spec.ts` | The market frame › scrolls the tabs | 2 | [nightly]({run_url(9)}), [by hand]({run_url(7)}) |\n"
        f"| `other.spec.ts` | waits | 1 | [merge queue, PR 439]({run_url(8)}) |\n"
    )


def test_a_test_is_named_by_the_spec_file_that_loaded_it(stub, storage, env):
    # A helper registers the sweep's tests, so the test's own `file` is the helper's; the report
    # names the spec file Playwright loaded, as the selection audit does.
    swept = report(file_suite("layout.spec.ts", [spec("sweeps Markets", "flaky", file="helpers/screenSweeps.ts")]))
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, swept)

    _, stdout, _, _ = run(env, "--runs", "1")

    assert f"| `layout.spec.ts` | sweeps Markets | 1 | [push to dev]({run_url(7)}) |\n" in stdout


def test_a_pipe_in_a_title_does_not_break_the_table(stub, storage, env):
    piped = report(file_suite("a.spec.ts", [spec("reads a | b", "flaky")]))
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, piped)

    _, stdout, _, _ = run(env, "--runs", "1")

    assert "| reads a \\| b |" in stdout


# Which runs count

@pytest.mark.parametrize(
    "other",
    [
        a_run(6, event="pull_request", branch="dev"),
        a_run(6, event="pull_request", branch="fix/a-branch"),
        a_run(6, event="push", branch="main"),
        a_run(6, event="workflow_dispatch", branch="fix/a-branch"),
        a_run(6, event="merge_group", branch=f"gh-readonly-queue/main/pr-1-{SHA}"),
        a_run(6, status="in_progress", conclusion=None),
    ],
    ids=["a fork's PR from its dev", "a PR", "a push to main", "by hand on a branch", "another queue", "a run still going"],
)
def test_only_a_completed_run_on_dev_or_its_queue_is_read(stub, storage, env, other):
    stub.serve(RUNS, 200, runs_page(other, a_run(5)))
    shards(stub, storage, 6, FLAKY)
    shards(stub, storage, 5, CLEAN)

    code, stdout, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert artifacts_path(6) not in stub.paths()
    assert f"{header(1)}: no test passed only on a retry.\n" in stdout


def test_a_run_that_ran_no_shard_is_passed_over_and_not_counted(stub, storage, env):
    # A warm push, a night whose commit has a map, or a run cancelled before its shards.
    stub.serve(RUNS, 200, runs_page(a_run(9), a_run(8), a_run(7)))
    stub.serve(artifacts_path(9), 200, {"total_count": 0, "artifacts": []})
    shards(stub, storage, 8, CLEAN, extra=[artifact(8, 11, name="playwright-artifacts-shard-1")])
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "2")

    assert code == 0
    assert f"{header(2)}: 1 test passed only on a retry, in 1 of them.\n" in stdout
    assert zip_path(8, 11) not in stub.paths()


def test_an_expired_report_is_not_read(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    stub.serve(artifacts_path(7), 200, {"total_count": 1, "artifacts": [artifact(7, 1, expired=True)]})
    shard_of(stub, storage, 7, 1, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert zip_path(7, 1) not in stub.paths()
    assert "No Test run on `dev` or its merge queue that GitHub still lists ran the e2e shards.\n" in stdout


def test_it_stops_at_the_runs_asked_for(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(9), a_run(8), a_run(7)))
    shards(stub, storage, 9, CLEAN)
    shards(stub, storage, 8, CLEAN)
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "2")

    assert code == 0
    assert artifacts_path(7) not in stub.paths()
    assert f"{header(2)}: no test passed only on a retry.\n" in stdout


def test_it_asks_for_completed_runs_a_page_at_a_time_with_the_token(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, CLEAN)

    run(env, "--runs", "1")

    path, query, headers = stub.requests[0]
    assert path == RUNS
    assert query == {"status": ["completed"], "per_page": ["100"], "page": ["1"]}
    assert headers["authorization"] == f"Bearer {GITHUB_TOKEN}"
    assert {path for path, _, _ in stub.requests if path == artifacts_path(7)}
    assert all(h["authorization"] == f"Bearer {GITHUB_TOKEN}" for _, _, h in stub.requests)


def test_it_reads_the_next_page_until_a_page_is_short(stub, storage, env):
    # A full page is 100 runs: page 1 holds 100 pull request runs, so page 2 is read, and ends the
    # list by being shorter.
    stub.serve(RUNS, 200, runs_page(*[a_run(1000 + n, event="pull_request") for n in range(100)]), page=1)
    stub.serve(RUNS, 200, runs_page(a_run(7)), page=2)
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "5")

    assert code == 0
    assert [query["page"] for path, query, _ in stub.requests if path == RUNS] == [["1"], ["2"]]
    assert f"{header(1)}: 1 test passed only on a retry, in 1 of them.\n" in stdout


def test_it_reads_no_more_than_ten_pages(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(*[a_run(1000 + n, event="pull_request") for n in range(100)]))

    code, stdout, _, _ = run(env, "--runs", "5")

    assert code == 0
    assert [query["page"][0] for path, query, _ in stub.requests if path == RUNS] == [str(n) for n in range(1, 11)]
    assert "No Test run on `dev` or its merge queue that GitHub still lists ran the e2e shards.\n" in stdout


# The token stays on GitHub's API

def test_the_token_is_never_sent_to_the_storage_an_artifact_redirects_to(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, FLAKY)

    code, _, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert storage.requests, "the zip was never fetched from the storage"
    assert all("authorization" not in headers for _, _, headers in storage.requests)


# What it could not read

def test_a_report_it_could_not_read_names_its_run_and_why_and_the_rest_still_counts(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(8), a_run(7)))
    shards(stub, storage, 8, CLEAN, CLEAN, CLEAN)
    stub.serve(zip_path(8, 2), 500, b"{}")
    storage.serve(f"/blob/{artifact_id(8, 3)}.zip", 200, b"not a zip", {"Content-Type": "application/zip"})
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, summary = run(env, "--runs", "2")

    assert code == 0
    assert stdout == summary
    assert f"{header(2)}: 1 test passed only on a retry, in 1 of them.\n" in stdout
    assert stdout.endswith(
        "\n"
        f"Not wholly read, so a test may be missing: [push to dev]({run_url(8)}), "
        "`e2e-results-shard-2` (500), `e2e-results-shard-3` (BadZipFile).\n"
    )


def test_a_run_whose_artifacts_could_not_be_listed_is_named_too(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(8), a_run(7)))
    stub.serve(artifacts_path(8), 502, b"{}")
    shards(stub, storage, 7, CLEAN)

    code, stdout, _, _ = run(env, "--runs", "2")

    assert code == 0
    assert f"{header(1)}: no test passed only on a retry.\n" in stdout
    assert f"Not wholly read, so a test may be missing: [push to dev]({run_url(8)}), its artifacts (502).\n" in stdout


def test_a_report_with_no_results_file_is_named(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, CLEAN)
    storage.serve(f"/blob/{artifact_id(7, 1)}.zip", 200, zipped({"e2e-deal.json": "{}"}), {"Content-Type": "application/zip"})

    code, stdout, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert f"[push to dev]({run_url(7)}), `e2e-results-shard-1` (KeyError)." in stdout


@pytest.mark.parametrize(
    ("status", "body", "reason"),
    [(503, b"{}", "503"), (403, b"{}", "403"), (200, b"not json", "JSONDecodeError"), (200, b'{"runs": []}', "KeyError")],
)
def test_runs_it_could_not_list_fail_with_the_reason_and_no_report(stub, storage, env, status, body, reason):
    stub.serve(RUNS, status, body)

    code, stdout, stderr, summary = run(env, "--runs", "1")

    assert code == 1
    assert stdout == ""
    assert stderr == f"GitHub's list of the Test runs could not be read ({reason}).\n"
    assert summary == f"GitHub's list of the Test runs could not be read ({reason}).\n"


# GitHub's rate limit

RATE_LIMITED = {"Content-Type": "application/json", "x-ratelimit-remaining": "0"}
STOP_403 = "GitHub answered 403, its rate limit or a token that may not read Actions"
STOP_429 = "GitHub answered 429, its rate limit"


def test_a_rate_limit_on_a_run_s_artifacts_stops_the_walk_and_reports_what_it_read(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(9), a_run(8), a_run(7)))
    shards(stub, storage, 9, FLAKY)
    stub.serve(artifacts_path(8), 403, b'{"message": "API rate limit exceeded"}', RATE_LIMITED)
    stub.serve(artifacts_path(7), 403, b'{"message": "API rate limit exceeded"}', RATE_LIMITED)

    code, stdout, _, summary = run(env, "--runs", "5")

    assert code == 0
    assert stdout == summary
    assert artifacts_path(7) not in stub.paths()
    assert stdout == (
        "### E2E tests that passed only on a retry\n"
        "\n"
        f"{header(1)}: 1 test passed only on a retry, in 1 of them.\n"
        "\n"
        "| Spec file | Test | Runs | Which |\n"
        "| --- | --- | --- | --- |\n"
        f"| `the-tabs.spec.ts` | The market frame › scrolls the tabs | 1 | [push to dev]({run_url(9)}) |\n"
        "\n"
        f"Stopped at [push to dev]({run_url(8)}): {STOP_403}, so the report holds only the runs before it.\n"
    )


def test_a_rate_limit_on_a_zip_stops_the_walk_and_drops_that_run(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(9), a_run(8), a_run(7)))
    shards(stub, storage, 9, CLEAN)
    shards(stub, storage, 8, FLAKY, CLEAN)
    stub.serve(zip_path(8, 2), 429, b"{}", RATE_LIMITED)
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "5")

    assert code == 0
    assert artifacts_path(7) not in stub.paths()
    assert f"{header(1)}: no test passed only on a retry.\n" in stdout
    assert stdout.endswith(f"\nStopped at [push to dev]({run_url(8)}): {STOP_429}, so the report holds only the runs before it.\n")


def test_a_rate_limit_on_a_later_page_of_runs_reports_what_the_pages_before_gave(stub, storage, env):
    page_1 = [a_run(7)] + [a_run(1000 + n, event="pull_request") for n in range(99)]
    stub.serve(RUNS, 200, runs_page(*page_1), page=1)
    stub.serve(RUNS, 403, b'{"message": "API rate limit exceeded"}', RATE_LIMITED, page=2)
    shards(stub, storage, 7, FLAKY)

    code, stdout, stderr, _ = run(env, "--runs", "5")

    assert code == 0
    assert stderr == ""
    assert f"{header(1)}: 1 test passed only on a retry, in 1 of them.\n" in stdout
    assert "Only 1 of the 5" not in stdout
    assert stdout.endswith(f"\nStopped at page 2 of GitHub's list of runs: {STOP_403}, so the report holds only the runs before it.\n")


# The command line

@pytest.mark.parametrize("given", [["--runs", "0"], ["--runs", "many"], ["--runs", "-3"]])
def test_runs_must_be_a_whole_number_of_at_least_one(stub, env, given):
    code, stdout, stderr, _ = run(env, *given)

    assert code == 2
    assert stdout == ""
    assert "--runs" in stderr
    assert stub.requests == []


@pytest.mark.parametrize("missing", ["GITHUB_REPOSITORY", "GITHUB_TOKEN"])
def test_it_needs_the_repository_and_a_token(stub, env, missing):
    del env[missing]

    code, stdout, stderr, _ = run(env)

    assert code == 2
    assert stdout == ""
    assert missing in stderr
    assert stub.requests == []


def test_it_reads_twenty_runs_unless_told(stub, storage, env):
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, CLEAN)

    _, stdout, _, _ = run(env)

    assert "Only 1 of the 20 asked for was found.\n" in stdout


def test_without_a_summary_file_it_prints_alone(stub, storage, env):
    del env["GITHUB_STEP_SUMMARY"]
    stub.serve(RUNS, 200, runs_page(a_run(7)))
    shards(stub, storage, 7, FLAKY)

    code, stdout, _, _ = run(env, "--runs", "1")

    assert code == 0
    assert stdout.startswith("### E2E tests that passed only on a retry\n")
