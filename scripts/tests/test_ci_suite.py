"""Which suite the Test workflow runs, and the workflow's jobs that read it (T510).

The script's tests run its command line as the `suite` job's `decide` step does, against a stub
GitHub API, and read what the step reads: the one word on stdout, the sentence on stderr and in the
summary file, and the exit code. The stub answers each API path with a scripted sequence and records
every request, in the pattern of test_promote_check.py's, which this file does not import.

The workflow's tests read .github/workflows/test.yml and the two actions under .github/actions/ as
text, and run the `decide` step's shell as the runner runs it (`bash -e`) with a fake `python3`.
"""
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "ci_suite.py"

SHA = "3c1d7e1423b61cc0c4383aeba4ade1e8ddf84d61"
SHORT = SHA[:12]
OTHER = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"
GITHUB_TOKEN = "github-token-not-for-logs"
RUNS = "/repos/owner/repo/actions/workflows/test.yml/runs"
QUEUE_BRANCH = f"gh-readonly-queue/dev/pr-375-{OTHER}"

DROP = "drop"


class Stub:
    """An HTTP server whose answers per path are a scripted sequence; the last answer repeats."""

    def __init__(self):
        self.routes = {}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                parts = urlsplit(self.path)
                stub.requests.append((parts.path, parse_qs(parts.query), {k.lower(): v for k, v in self.headers.items()}))
                answers = stub.routes.get(parts.path)
                if answers is None:
                    answer = (404, "not found")
                else:
                    answer = answers.pop(0) if len(answers) > 1 else answers[0]
                if answer == DROP:
                    self.close_connection = True
                    return
                status, body = answer
                data = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def serve(self, path, *answers):
        self.routes[path] = list(answers)

    def count(self, path):
        return sum(1 for requested, _, _ in self.requests if requested == path)


@pytest.fixture
def stub():
    server = Stub()
    server.thread.start()
    yield server
    server.server.shutdown()
    server.server.server_close()


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


def decide(env, event="push", commit=SHA):
    return run(env, "--event", event, "--commit", commit)


def run_of(number, status="completed", conclusion="success", head_sha=SHA, branch="dev", event="push"):
    return {
        "id": 44300000000 + number,
        "run_number": number,
        "status": status,
        "conclusion": conclusion,
        "head_sha": head_sha,
        "event": event,
        "head_branch": branch,
        "html_url": f"https://github.com/owner/repo/actions/runs/{44300000000 + number}",
    }


def queued(number, **fields):
    """A run of dev's merge queue on the commit, as GitHub lists run 44308245312."""
    return run_of(number, event="merge_group", branch=QUEUE_BRANCH, **fields)


def url(number):
    return f"https://github.com/owner/repo/actions/runs/{44300000000 + number}"


def jobs_path(number):
    return f"/repos/owner/repo/actions/runs/{44300000000 + number}/jobs"


def runs(*items):
    return (200, json.dumps({"total_count": len(items), "workflow_runs": list(items)}))


def job(name, status="completed", conclusion="success"):
    return {"name": name, "status": status, "conclusion": conclusion}


def jobs(*items, total=None):
    return (200, json.dumps({"total_count": len(items) if total is None else total, "jobs": list(items)}))


def passed(number):
    return f"The merge queue's Test run passed on {SHORT} ({url(number)}), so this push only warms the caches."


def not_yet(number):
    return f"The merge queue's Test run on {SHORT} has not passed yet ({url(number)}), so this push runs the whole suite."


NO_QUEUE_RUN = f"No merge queue Test run on {SHORT}, so this push runs the whole suite."


def said(stdout, stderr, summary, word, sentence):
    """The step reads one word; a person reads the sentence in the log and in the summary."""
    assert stdout == f"{word}\n"
    assert stderr == f"{sentence}\n"
    assert summary == f"{sentence}\n"


# A push to dev


def test_a_commit_the_queue_passed_only_warms_the_caches(stub, env):
    stub.serve(RUNS, runs(queued(1345)))

    code, *out = decide(env)

    assert code == 0
    said(*out, "warm", passed(1345))
    assert stub.count(jobs_path(1345)) == 0


def test_a_commit_with_no_queue_run_runs_the_whole_suite(stub, env):
    stub.serve(RUNS, runs())

    code, *out = decide(env)

    assert code == 0
    said(*out, "full", NO_QUEUE_RUN)


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out", "action_required", "neutral"])
def test_a_queue_run_that_did_not_pass_runs_the_whole_suite(stub, env, conclusion):
    stub.serve(RUNS, runs(queued(1345, conclusion=conclusion)))

    code, *out = decide(env)

    assert code == 0
    said(
        *out, "full",
        f"The merge queue's Test run on {SHORT} ended {conclusion} ({url(1345)}), so this push runs the whole suite.",
    )


@pytest.mark.parametrize(
    "other",
    [
        run_of(1352),
        run_of(1350, event="pull_request", branch="feat/T375-something"),
        run_of(1351, event="schedule"),
        run_of(1353, event="workflow_dispatch"),
        run_of(1346, event="merge_group", branch=f"gh-readonly-queue/main/pr-375-{OTHER}"),
        queued(1347, head_sha=OTHER),
        run_of(1348, event="merge_group"),
    ],
    ids=["a-push-to-dev", "a-pull-request-s", "a-nightly", "a-hand-started", "main-s-queue",
         "another-commit-s-queue", "a-merge-group-on-dev-itself"],
)
def test_only_a_run_of_dev_s_queue_on_the_commit_counts(stub, env, other):
    stub.serve(RUNS, runs(other))

    code, *out = decide(env)

    assert code == 0
    said(*out, "full", NO_QUEUE_RUN)


@pytest.mark.parametrize(
    ("older", "newer", "word"),
    [
        (queued(1340, conclusion="failure"), queued(1345), "warm"),
        (queued(1340), queued(1345, conclusion="failure"), "full"),
    ],
    ids=["re-queued-green", "re-queued-red"],
)
@pytest.mark.parametrize("listed_newest_first", [True, False], ids=["newest-first", "oldest-first"])
def test_the_newest_queue_run_decides(stub, env, older, newer, word, listed_newest_first):
    stub.serve(RUNS, runs(newer, older) if listed_newest_first else runs(older, newer))

    code, stdout, stderr, _ = decide(env)

    assert code == 0
    assert stdout == f"{word}\n"
    assert url(1345) in stderr


def test_a_push_run_on_the_commit_never_outvotes_its_queue_run(stub, env):
    stub.serve(RUNS, runs(queued(1345), run_of(1352, status="in_progress", conclusion=None)))

    code, *out = decide(env)

    assert code == 0
    said(*out, "warm", passed(1345))


def test_it_asks_for_the_commit_s_runs_by_its_sha_alone_with_the_token(stub, env):
    stub.serve(RUNS, runs(queued(1345)))

    decide(env)

    [(path, query, headers)] = stub.requests
    assert path == RUNS
    assert query == {"head_sha": [SHA], "per_page": ["100"]}
    assert headers["authorization"] == f"Bearer {GITHUB_TOKEN}"


# The queue's run still going: GitHub can mark it completed seconds after its last job ended.


def in_progress(stub, *listed, total=None):
    stub.serve(RUNS, runs(queued(1345, status="in_progress", conclusion=None)))
    stub.serve(jobs_path(1345), jobs(*listed, total=total))


def test_a_queue_run_still_going_whose_jobs_all_passed_only_warms_the_caches(stub, env):
    in_progress(stub, job("suite", conclusion="skipped"), job("backend"), job("e2e shard 1/10"), job("e2e"),
                job("warm-caches", conclusion="skipped"), job("test-map", conclusion="skipped"))

    code, *out = decide(env)

    assert code == 0
    said(*out, "warm", passed(1345))


def test_it_asks_for_the_queue_run_s_latest_jobs_with_the_token(stub, env):
    in_progress(stub, job("backend"))

    decide(env)

    [(path, query, headers)] = [request for request in stub.requests if request[0] == jobs_path(1345)]
    assert query == {"filter": ["latest"], "per_page": ["100"]}
    assert headers["authorization"] == f"Bearer {GITHUB_TOKEN}"


@pytest.mark.parametrize(
    "listed",
    [
        [job("backend"), job("e2e", status="in_progress", conclusion=None)],
        [job("backend"), job("e2e", status="queued", conclusion=None)],
        [job("backend"), job("e2e", conclusion="failure")],
        [job("backend"), job("e2e", conclusion="cancelled")],
        [],
    ],
    ids=["a-job-running", "a-job-queued", "a-job-failed", "a-job-cancelled", "no-job"],
)
def test_a_queue_run_still_going_with_a_job_not_passed_runs_the_whole_suite(stub, env, listed):
    in_progress(stub, *listed)

    code, *out = decide(env)

    assert code == 0
    said(*out, "full", not_yet(1345))


def test_a_queue_run_with_more_jobs_than_were_listed_runs_the_whole_suite(stub, env):
    in_progress(stub, job("backend"), job("e2e"), total=3)

    code, *out = decide(env)

    assert code == 0
    said(*out, "full", not_yet(1345))


# GitHub could not be read, or answered unlike GitHub: the whole suite, and no retry.


def unreadable(reason):
    return f"Could not read the merge queue's Test run for {SHORT} from GitHub ({reason}), so this push runs the whole suite."


@pytest.mark.parametrize("at", ["runs", "jobs"])
def test_an_api_error_runs_the_whole_suite_with_no_retry(stub, env, at):
    if at == "runs":
        stub.serve(RUNS, (500, "upstream broke"))
        path = RUNS
    else:
        in_progress(stub)
        stub.serve(jobs_path(1345), (500, "upstream broke"))
        path = jobs_path(1345)

    code, *out = decide(env)

    assert code == 0
    said(*out, "full", unreadable("500"))
    assert stub.count(path) == 1


@pytest.mark.parametrize("at", ["runs", "jobs"])
def test_no_answer_runs_the_whole_suite_with_no_retry(stub, env, at):
    if at == "runs":
        stub.serve(RUNS, DROP)
        path = RUNS
    else:
        in_progress(stub)
        stub.serve(jobs_path(1345), DROP)
        path = jobs_path(1345)

    code, stdout, stderr, _ = decide(env)

    assert code == 0
    assert stdout == "full\n"
    assert stderr.startswith(f"Could not read the merge queue's Test run for {SHORT} from GitHub (")
    assert "(500)" not in stderr
    assert stub.count(path) == 1


def without(run, key):
    return {name: value for name, value in run.items() if name != key}


@pytest.mark.parametrize(
    ("path", "answer"),
    [
        (RUNS, (200, "not json")),
        (RUNS, (200, json.dumps({"runs": []}))),
        (RUNS, runs(without(queued(1345), "run_number"))),
        (RUNS, runs(without(queued(1345), "status"))),
        (RUNS, runs(without(queued(1345), "conclusion"))),
        (RUNS, runs(without(queued(1345), "html_url"))),
        (RUNS, runs(without(queued(1345, status="in_progress", conclusion=None), "id"))),
        (RUNS, runs({**queued(1345), "head_branch": None})),
        (jobs_path(1345), (200, "not json")),
        (jobs_path(1345), (200, json.dumps({"total_count": 1}))),
        (jobs_path(1345), (200, json.dumps({"jobs": [job("backend")]}))),
        (jobs_path(1345), jobs(without(job("backend"), "status"))),
        (jobs_path(1345), jobs(without(job("backend"), "conclusion"))),
        (jobs_path(1345), (200, json.dumps({"total_count": "1", "jobs": [job("backend")]}))),
    ],
    ids=["runs-not-json", "runs-unlike-github", "a-run-without-its-number", "a-run-without-its-status",
         "a-run-without-its-conclusion", "a-run-without-its-link", "a-run-going-without-its-id",
         "a-queue-run-without-its-branch",
         "jobs-not-json", "jobs-without-the-list", "jobs-without-the-count", "a-job-without-its-status",
         "a-job-without-its-conclusion", "a-count-that-is-text"],
)
def test_an_answer_unlike_github_s_runs_the_whole_suite(stub, env, path, answer):
    in_progress(stub, job("backend"))
    stub.serve(path, answer)

    code, stdout, stderr, _ = decide(env)

    assert code == 0
    assert stdout == "full\n"
    assert stderr.startswith(f"Could not read the merge queue's Test run for {SHORT} from GitHub (")
    assert stderr.endswith("), so this push runs the whole suite.\n")


# A nightly run, or one started by hand: the test map, unless the commit has one.

ARTIFACTS = "/repos/owner/repo/actions/artifacts"
MAPPERS = ["schedule", "workflow_dispatch"]
SERVER = "https://github.example"
NO_MAP = f"No test map has been made at {SHORT}, so this run records one."


def artifact(run_id, head_sha=SHA, name="test-map", expired=False, branch="dev"):
    """An artifact as GitHub lists it, with the run that made it."""
    return {
        "id": run_id + 7,
        "name": name,
        "expired": expired,
        "workflow_run": {"id": run_id, "head_sha": head_sha, "head_branch": branch},
    }


def artifacts(*items, total=None):
    return (200, json.dumps({"total_count": len(items) if total is None else total, "artifacts": list(items)}))


def made(run_id):
    return f"A test map was already made at {SHORT} ({SERVER}/owner/repo/actions/runs/{run_id}), so this run makes none."


def map_unread(reason):
    return f"Could not read the test maps from GitHub ({reason}), so this run records one."


@pytest.fixture
def mapper_env(env):
    return {**env, "GITHUB_SERVER_URL": SERVER}


@pytest.mark.parametrize("event", MAPPERS)
def test_a_commit_that_has_a_map_makes_none(stub, mapper_env, event):
    stub.serve(ARTIFACTS, artifacts(artifact(44100000001, head_sha=OTHER), artifact(44100000002)))

    code, *out = decide(mapper_env, event)

    assert code == 0
    said(*out, "none", made(44100000002))


def test_a_map_a_push_run_made_before_the_nightly_run_counts(stub, mapper_env):
    # Any map at the commit counts, whichever run made it, so the first night after this change
    # makes nothing when the last push already made one.
    stub.serve(ARTIFACTS, artifacts(artifact(44324061105)))

    code, *out = decide(mapper_env, "schedule")

    assert code == 0
    said(*out, "none", made(44324061105))


@pytest.mark.parametrize(
    "listed",
    [
        [],
        [artifact(44100000001, head_sha=OTHER)],
        [artifact(44100000001, expired=True)],
        [artifact(44100000001, name="test-map-shard-1")],
        [artifact(44100000001, branch="feat/something")],
        [artifact(44100000001, head_sha=OTHER), artifact(44100000002, expired=True)],
    ],
    ids=["no-map", "a-map-at-another-commit", "an-expired-map-at-it", "a-shard-s-records-at-it",
         "a-map-made-on-another-branch-at-it", "neither"],
)
@pytest.mark.parametrize("event", MAPPERS)
def test_a_commit_with_no_map_records_one(stub, mapper_env, event, listed):
    stub.serve(ARTIFACTS, artifacts(*listed))

    code, *out = decide(mapper_env, event)

    assert code == 0
    said(*out, "map", NO_MAP)


def test_it_asks_for_the_test_maps_by_name_with_the_token(stub, mapper_env):
    stub.serve(ARTIFACTS, artifacts())

    decide(mapper_env, "schedule")

    [(path, query, headers)] = stub.requests
    assert path == ARTIFACTS
    assert query == {"name": ["test-map"], "per_page": ["100"]}
    assert headers["authorization"] == f"Bearer {GITHUB_TOKEN}"


def test_the_link_names_github_s_own_server_by_default(stub, env):
    stub.serve(ARTIFACTS, artifacts(artifact(44100000002)))

    _, _, stderr, _ = decide(env, "schedule")

    assert stderr == (
        f"A test map was already made at {SHORT} (https://github.com/owner/repo/actions/runs/44100000002),"
        " so this run makes none.\n"
    )


def test_an_api_error_at_the_maps_records_one_with_no_retry(stub, mapper_env):
    stub.serve(ARTIFACTS, (500, "upstream broke"))

    code, *out = decide(mapper_env, "schedule")

    assert code == 0
    said(*out, "map", map_unread("500"))
    assert stub.count(ARTIFACTS) == 1


def test_no_answer_at_the_maps_records_one_with_no_retry(stub, mapper_env):
    stub.serve(ARTIFACTS, DROP)

    code, stdout, stderr, _ = decide(mapper_env, "schedule")

    assert code == 0
    assert stdout == "map\n"
    assert stderr.startswith("Could not read the test maps from GitHub (")
    assert "(500)" not in stderr
    assert stub.count(ARTIFACTS) == 1


def without_run_key(item, key):
    return {**item, "workflow_run": without(item["workflow_run"], key)}


@pytest.mark.parametrize(
    "answer",
    [
        (200, "not json"),
        (200, json.dumps({"total_count": 0})),
        (200, json.dumps({"total_count": 1, "artifacts": {"name": "test-map"}})),
        artifacts(without(artifact(44100000002), "name")),
        artifacts(without(artifact(44100000002), "expired")),
        artifacts(without(artifact(44100000002), "workflow_run")),
        artifacts({**artifact(44100000002), "workflow_run": None}),
        artifacts(without_run_key(artifact(44100000002), "head_sha")),
        artifacts(without_run_key(artifact(44100000002), "id")),
        artifacts(without_run_key(artifact(44100000002), "head_branch")),
        artifacts(artifact(44100000002, branch=None)),
        artifacts({**artifact(44100000002), "workflow_run": {"id": "44100000002", "head_sha": SHA}}),
        artifacts({**artifact(44100000002), "expired": "false"}),
    ],
    ids=["not-json", "without-the-list", "a-list-that-is-not-one", "a-map-without-its-name",
         "a-map-without-its-expiry", "a-map-without-its-run", "a-map-whose-run-is-null",
         "a-run-without-its-commit", "a-run-without-its-id", "a-run-without-its-branch",
         "a-run-whose-branch-is-null", "a-run-id-that-is-text", "an-expiry-that-is-text"],
)
def test_an_answer_unlike_github_s_at_the_maps_records_one(stub, mapper_env, answer):
    stub.serve(ARTIFACTS, answer)

    code, stdout, stderr, _ = decide(mapper_env, "schedule")

    assert code == 0
    assert stdout == "map\n"
    assert stderr.startswith("Could not read the test maps from GitHub (")
    assert stderr.endswith("), so this run records one.\n")


# Any other event


@pytest.mark.parametrize("event", ["pull_request", "merge_group", "release"])
def test_any_other_event_runs_the_whole_suite_and_reads_nothing(stub, env, event):
    code, *out = decide(env, event)

    assert code == 0
    said(*out, "full", f"A {event} run runs the whole suite.")
    assert stub.requests == []


# The summary


def test_the_sentence_is_added_to_the_summary_as_a_line_of_its_own(stub, env):
    Path(env["GITHUB_STEP_SUMMARY"]).write_text("### Earlier step\n")
    stub.serve(RUNS, runs())

    _, _, _, summary = decide(env)

    assert summary == f"### Earlier step\n{NO_QUEUE_RUN}\n"


def test_with_no_summary_file_it_still_decides(stub, env):
    del env["GITHUB_STEP_SUMMARY"]
    stub.serve(RUNS, runs(queued(1345)))

    code, stdout, stderr, _ = decide(env)

    assert code == 0
    assert stdout == "warm\n"
    assert stderr == f"{passed(1345)}\n"


# Usage: exit 2, nothing on stdout, before any request.


@pytest.mark.parametrize(
    "commit",
    [SHA[:12], SHA + "0", SHA[:39] + "g", "", "dev", "HEAD~1", " " + SHA[:39]],
    ids=["short", "long", "not-hexadecimal", "empty", "a-branch", "a-revision", "padded"],
)
def test_anything_but_a_full_sha_is_a_usage_error_before_any_request(stub, env, commit):
    code, stdout, stderr, _ = decide(env, commit=commit)

    assert code == 2
    assert stdout == ""
    assert f"--commit takes a commit's full 40-character sha, not {commit}" in stderr
    assert stub.requests == []


def test_a_long_commit_is_shown_cut_to_80_characters(stub, env):
    code, _, stderr, _ = decide(env, commit="a" * 200)

    assert code == 2
    assert f"not {'a' * 80}" in stderr
    assert "a" * 81 not in stderr


def test_an_upper_case_sha_is_read_as_lower_case(stub, env):
    stub.serve(RUNS, runs(queued(1345)))

    code, stdout, _, _ = decide(env, commit=SHA.upper())

    assert code == 0
    assert stdout == "warm\n"
    assert stub.requests[0][1]["head_sha"] == [SHA]


@pytest.mark.parametrize("missing", ["GITHUB_TOKEN", "GITHUB_REPOSITORY"])
def test_it_needs_its_environment(stub, env, missing):
    del env[missing]

    code, stdout, stderr, _ = decide(env)

    assert code == 2
    assert stdout == ""
    assert missing in stderr
    assert stub.requests == []


@pytest.mark.parametrize(("given", "needed"), [(["--commit", SHA], "--event"), (["--event", "push"], "--commit")])
def test_it_needs_an_event_and_a_commit(stub, env, given, needed):
    code, stdout, stderr, _ = run(env, *given)

    assert code == 2
    assert stdout == ""
    assert needed in stderr
    assert stub.requests == []


# The Test workflow and the e2e-stack action, read as text: the job that runs this file has no YAML library.

WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
E2E_STACK = ROOT / ".github" / "actions" / "e2e-stack" / "action.yml"
FRONT_END_DEPS = ROOT / ".github" / "actions" / "front-end-deps" / "action.yml"

JOBS = [
    "suite",
    "backend",
    "python-advisories",
    "knowledge-graph",
    "real-data-and-workflows",
    "frontend-unit",
    "frontend-lint-and-types",
    "docker-build",
    "e2e-shard",
    "warm-caches",
    "test-map",
    "e2e-retries",
    "e2e",
]
SIX = ["backend", "knowledge-graph", "real-data-and-workflows", "frontend-unit", "frontend-lint-and-types", "docker-build"]
FULL = "${{ !cancelled() && (needs.suite.outputs.run == '' || needs.suite.outputs.run == 'full') }}"
DECIDE = (
    'run="$(python3 scripts/ci_suite.py --event "$EVENT" --commit "$COMMIT")" || run=full\n'
    "case \"$run\" in warm | map | none) ;; *) run=full ;; esac\n"
    'echo "run=$run" >>"$GITHUB_OUTPUT"\n'
)


def mapping(lines, indent):
    """The `key: value` pairs written at exactly `indent` spaces."""
    pairs = {}
    for line in lines:
        if line.startswith(" " * indent) and not line[indent:].startswith((" ", "#", "- ")) and ":" in line:
            key, _, value = line[indent:].partition(":")
            pairs[key] = value.split(" # ")[0].strip()
    return pairs


def block(lines, start, indent):
    """The lines after `start` indented deeper than `indent`, up to the first one that is not."""
    out = []
    for line in lines[start + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        out.append(line)
    return out


def steps_of(lines, indent):
    """Each `- ` item written at `indent` spaces, with its keys, `env:`, `with:` and `run:`."""
    starts = [i for i, line in enumerate(lines) if line.startswith(" " * indent + "- ")]
    deeper = indent + 2
    steps = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        body = [" " * deeper + lines[start][deeper:]] + lines[start + 1:end]
        keys = mapping(body, deeper)
        step = {**keys, "env": {}, "with": {}, "run": ""}
        for i, line in enumerate(body):
            if line == " " * deeper + "if: >-":
                step["if"] = " ".join(l.strip() for l in block(body, i, deeper))
            if line == " " * deeper + "env:":
                step["env"] = mapping(block(body, i, deeper), deeper + 2)
            if line == " " * deeper + "with:":
                step["with"] = mapping(block(body, i, deeper), deeper + 2)
            if line.startswith(" " * deeper + "run:"):
                inline = line[len(" " * deeper + "run:"):].strip()
                if inline in ("|", ">-"):
                    step["run"] = "\n".join(l[deeper + 2:] for l in block(body, i, deeper)).strip() + "\n"
                else:
                    step["run"] = inline + "\n"
        steps.append(step)
    return steps


def workflow_jobs():
    lines = WORKFLOW.read_text().splitlines()
    jobs_block = block(lines, lines.index("jobs:"), 0)
    found = {}
    for i, line in enumerate(jobs_block):
        named = re.match(r"^  ([\w-]+):$", line)
        if named:
            body = block(jobs_block, i, 2)
            steps_at = body.index("    steps:") if "    steps:" in body else len(body)
            job_keys = mapping(body[:steps_at], 4)
            permissions = body.index("    permissions:") if "    permissions:" in body else None
            outputs = body.index("    outputs:") if "    outputs:" in body else None
            found[named.group(1)] = {
                **job_keys,
                "order": len(found),
                "permissions": mapping(block(body, permissions, 4), 6) if permissions is not None else {},
                "outputs": mapping(block(body, outputs, 4), 6) if outputs is not None else {},
                "steps": steps_of(body[steps_at + 1:], 6),
            }
    return found


def test_the_workflow_has_exactly_these_jobs_suite_first():
    jobs_found = workflow_jobs()

    # An allowed set, so a job of any other name, the removed per-PR repeat of the changed specs
    # included, fails here without its name being written in the repository.
    assert sorted(jobs_found) == sorted(JOBS)
    assert jobs_found["suite"]["order"] == 0


def test_the_workflow_runs_nightly_and_by_hand_as_well():
    lines = WORKFLOW.read_text().splitlines()
    on = block(lines, lines.index("on:"), 0)

    assert mapping(on, 2) == {
        "push": "",
        "pull_request": "",
        "merge_group": "",
        "schedule": "",
        "workflow_dispatch": "",
    }
    schedule = block(on, on.index("  schedule:"), 2)
    assert [line.strip() for line in schedule if not line.strip().startswith("#")] == ['- cron: "17 19 * * *"']
    # By hand with no inputs: `gh workflow run test.yml --ref dev`.
    by_hand = block(on, on.index("  workflow_dispatch:"), 2)
    assert all(not line.strip() or line.strip().startswith("#") for line in by_hand)


def test_suite_runs_only_on_a_push_to_dev_a_nightly_run_or_one_by_hand_reading_and_nothing_more():
    suite = workflow_jobs()["suite"]

    assert suite["name"] == "suite"
    assert suite["if"] == (
        "github.event_name == 'push' && github.ref == 'refs/heads/dev'"
        " || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
    )
    assert suite["permissions"] == {"contents": "read", "actions": "read"}
    assert suite["outputs"] == {"run": "${{ steps.decide.outputs.run }}"}
    assert "needs" not in suite


def test_suite_checks_out_with_no_credentials_and_decides_with_the_runner_s_python():
    checkout, step = workflow_jobs()["suite"]["steps"]

    assert checkout["uses"].startswith("actions/checkout@")
    assert checkout["with"] == {"persist-credentials": "false"}
    assert step["id"] == "decide"
    assert step["env"] == {
        "EVENT": "${{ github.event_name }}",
        "COMMIT": "${{ github.sha }}",
        "GITHUB_TOKEN": "${{ github.token }}",
    }
    assert step["run"] == DECIDE


@pytest.mark.parametrize("name", SIX)
def test_each_short_job_runs_only_on_the_whole_suite(name):
    job_found = workflow_jobs()[name]

    assert job_found["name"] == name
    assert job_found["needs"] == "suite"
    assert job_found["if"] == FULL


def test_the_shards_run_on_the_whole_suite_or_the_map():
    shard = workflow_jobs()["e2e-shard"]

    assert shard["needs"] == "suite"
    assert shard["if"] == (
        "${{ !cancelled() && (needs.suite.outputs.run == '' || needs.suite.outputs.run == 'full'"
        " || needs.suite.outputs.run == 'map') }}"
    )


def test_e2e_runs_only_on_the_whole_suite():
    e2e = workflow_jobs()["e2e"]

    assert e2e["name"] == "e2e"
    assert e2e["needs"] == "[suite, e2e-shard]"
    assert e2e["if"] == FULL


def test_the_test_map_is_built_only_on_a_nightly_or_hand_started_run_whose_shards_ran():
    test_map = workflow_jobs()["test-map"]

    assert test_map["needs"] == "[suite, e2e-shard]"
    assert test_map["if"] == (
        "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')"
        " && needs.e2e-shard.result != 'skipped' }}"
    )
    assert test_map["continue-on-error"] == "true"


def test_the_retry_report_runs_only_nightly_or_by_hand_reading_actions_and_never_fails_the_run():
    retries = workflow_jobs()["e2e-retries"]

    # It reads GitHub's API alone, so it waits on no job and reads no `suite` word.
    assert retries["name"] == "e2e-retries"
    assert retries["if"] == "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
    assert "needs" not in retries
    assert retries["continue-on-error"] == "true"
    assert retries["permissions"] == {"contents": "read", "actions": "read"}
    checkout, report = retries["steps"]
    assert checkout["uses"].startswith("actions/checkout@")
    assert checkout["with"] == {"persist-credentials": "false"}
    assert report["env"] == {"GITHUB_TOKEN": "${{ github.token }}"}
    assert report["run"] == "python3 scripts/e2e_retries.py --runs 20\n"


def test_only_a_nightly_or_hand_started_run_s_shards_record():
    lines = WORKFLOW.read_text().splitlines()
    jobs_block = block(lines, lines.index("jobs:"), 0)
    shard = block(jobs_block, jobs_block.index("  e2e-shard:"), 2)
    shard_env = mapping(block(shard, shard.index("    env:"), 4), 6)

    assert shard_env["RECORD_TEST_MAP"] == (
        "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}"
    )
    assert WORKFLOW.read_text().count("RECORD_TEST_MAP:") == 1


def test_warm_caches_runs_only_on_warm_and_never_fails_the_run():
    warm = workflow_jobs()["warm-caches"]

    assert warm["name"] == "warm-caches"
    assert warm["needs"] == "suite"
    assert warm["if"] == "needs.suite.outputs.run == 'warm'"
    assert warm["continue-on-error"] == "true"


def test_the_advisory_scan_reads_no_word_so_a_warm_push_and_every_nightly_run_scan_too():
    advisories = workflow_jobs()["python-advisories"]

    # Daniel's choice: a daily scan of dev's tip, a nightly run whose commit has a map included,
    # and every push; only a trial commit skips it. gitleaks, in real-data-and-workflows, stays
    # skipped on a warm push, as each of the six above is.
    assert advisories["needs"] == "real-data-and-workflows"
    assert advisories["if"] == "${{ !cancelled() && github.event_name != 'merge_group' }}"
    assert "suite" not in advisories["needs"] + advisories["if"]


def test_warm_caches_fills_npm_s_cache_node_modules_and_the_stack_s_caches_and_runs_nothing_else():
    warm = workflow_jobs()["warm-caches"]
    checkout, node, deps, stack = warm["steps"]

    assert checkout["uses"].startswith("actions/checkout@")
    assert checkout["with"] == {"persist-credentials": "false"}
    assert node["uses"].startswith("actions/setup-node@")
    assert node["id"] == "node"
    assert node["with"] == {
        "node-version-file": ".nvmrc",
        "cache": "npm",
        "cache-dependency-path": "front-end/package-lock.json",
    }
    # How it installs the front end once at most is the front-end-deps tests' below.
    assert deps["uses"] == "./.github/actions/front-end-deps"
    assert sorted(deps["with"]) == ["fill-npm-cache", "save-cache"]
    assert value(deps["with"]["save-cache"], {}) == "true"
    assert stack["uses"] == "./.github/actions/e2e-stack"
    assert stack["with"] == {"save-caches": "true", "start": '"false"'}


def test_a_warm_push_s_jobs_pin_the_same_actions_as_the_rest_of_the_workflow():
    jobs_found = workflow_jobs()
    pinned = {step["uses"] for name in SIX + ["e2e-shard"] for step in jobs_found[name]["steps"] if "uses" in step}

    for name in ("suite", "warm-caches"):
        for step in jobs_found[name]["steps"]:
            if "uses" in step and not step["uses"].startswith("./"):
                assert step["uses"] in pinned, step["uses"]


# The `decide` step's own shell, with a fake python3 that answers as told.

FAKE_PYTHON = """#!/bin/sh
printf '%s\\037' "$@" >> "$FAKE_CALLS_LOG"
printf '\\n' >> "$FAKE_CALLS_LOG"
printf '%b' "$FAKE_STDOUT"
exit "${FAKE_EXIT:-0}"
"""


def run_decide(tmp_path, **fakes):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "python3"
    fake.write_text(FAKE_PYTHON)
    fake.chmod(0o755)
    script = tmp_path / "step.sh"
    script.write_text(workflow_jobs()["suite"]["steps"][1]["run"])
    outputs = tmp_path / "outputs"
    outputs.write_text("")
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_CALLS_LOG": str(tmp_path / "calls.log"),
        "GITHUB_OUTPUT": str(outputs),
        "EVENT": "push",
        "COMMIT": SHA,
        **fakes,
    }
    result = subprocess.run(["bash", "-e", str(script)], env=env, capture_output=True, text=True, timeout=30)
    return result.returncode, outputs.read_text()


@pytest.mark.parametrize("word", ["warm", "full", "map", "none"])
def test_the_step_passes_each_word_on(tmp_path, word):
    code, outputs = run_decide(tmp_path, FAKE_STDOUT=f"{word}\\n")

    assert code == 0
    assert outputs == f"run={word}\n"


def test_the_step_runs_the_script_on_the_event_and_the_commit(tmp_path):
    run_decide(tmp_path, FAKE_STDOUT="warm\\n")

    [call] = (tmp_path / "calls.log").read_text().splitlines()
    assert call.split("\x1f")[:-1] == ["scripts/ci_suite.py", "--event", "push", "--commit", SHA]


@pytest.mark.parametrize(
    ("stdout", "exit_code"),
    [("warm\\n", "1"), ("", "2"), ("", "0"), ("fast\\n", "0"), ("warm\\nwarm\\n", "0"), ("Warm\\n", "0"),
     (" warm\\n", "0")],
    ids=["failed-after-warm", "usage-error", "silent", "a-stray-word", "two-words", "capitals", "padded"],
)
def test_anything_but_a_word_from_a_script_that_passed_is_the_whole_suite(tmp_path, stdout, exit_code):
    code, outputs = run_decide(tmp_path, FAKE_STDOUT=stdout, FAKE_EXIT=exit_code)

    assert code == 0
    assert outputs == "run=full\n"


def test_a_missing_script_is_the_whole_suite(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = tmp_path / "step.sh"
    script.write_text(workflow_jobs()["suite"]["steps"][1]["run"].replace("python3 ", f"{bin_dir}/missing "))
    outputs = tmp_path / "outputs"
    outputs.write_text("")

    result = subprocess.run(
        ["bash", "-e", str(script)],
        env={"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(outputs), "EVENT": "push", "COMMIT": SHA},
        capture_output=True, text=True, timeout=30,
    )

    assert result.returncode == 0
    assert outputs.read_text() == "run=full\n"


# The e2e-stack action's `start`: by default every step runs as before.

NOT_STARTING = [
    "Load the images",
    "Pull the stack's registry images",
    "Start the stack",
    "Seed it",
]


def action(path=E2E_STACK):
    lines = path.read_text().splitlines()
    inputs = block(lines, lines.index("inputs:"), 0)
    steps = steps_of(block(lines, lines.index("  steps:"), 2), 4)
    return {
        "inputs": {name: mapping(block(inputs, inputs.index(f"  {name}:"), 2), 4) for name in mapping(inputs, 2)},
        "steps": {step.get("name"): step for step in steps},
    }


def test_start_is_an_input_that_defaults_to_true():
    start = action()["inputs"]["start"]

    assert start["required"] == "false"
    assert start["default"] == '"true"'


@pytest.mark.parametrize("name", NOT_STARTING)
def test_a_step_that_starts_the_stack_runs_only_when_starting(name):
    condition = action()["steps"][name]["if"]

    assert condition == "inputs.start == 'true'" or condition.startswith("inputs.start == 'true' && ")


@pytest.mark.parametrize(
    "name", ["Restore Playwright's browsers", "Restore Chromium's system packages", "Restore the images"]
)
def test_a_restore_only_looks_when_not_starting(name):
    assert action()["steps"][name]["with"]["lookup-only"] == "${{ inputs.start != 'true' }}"


def test_chromium_is_installed_on_a_miss_without_its_system_packages():
    install = action()["steps"]["Install Playwright's Chromium"]

    assert install["if"] == "steps.browsers.outputs.cache-hit != 'true'"
    assert install["env"] == {}
    assert install["run"] == "npx playwright install chromium\n"


# Not starting, the packages install only on a miss, which is how their files are made and marked
# cacheable for the save; a hit, only looked up, has no files to install.
def test_chromium_s_system_packages_install_when_starting_or_on_a_miss():
    install = action()["steps"]["Install Chromium's system packages"]

    assert install["if"] == (
        "steps.packages.outputs.packages != '' && "
        "(inputs.start == 'true' || steps.packages-cache.outputs.cache-hit != 'true')"
    )


@pytest.mark.parametrize(
    "name",
    [
        "Build the images",
        "Write the images for the cache",
        "Save the images",
        "Save Playwright's browsers",
        "The system packages Chromium lacks",
        "Save Chromium's system packages",
    ],
)
def test_the_builds_and_saves_ignore_start(name):
    assert "inputs.start" not in action()["steps"][name].get("if", "")


# The front-end-deps action's `fill-npm-cache`: by default it installs only on its own cache's miss.
# Its conditions are evaluated, as the runner would, over each cache's hit or miss.

TOKEN = re.compile(r"\s*('[^']*'|==|!=|&&|\|\||[\w.-]+)")


def evaluate(expression, context):
    """An expression of the forms these steps use: references, 'literals', ==, !=, && and ||."""
    tokens = []
    rest = expression.strip()
    if rest.startswith("${{") and rest.endswith("}}"):
        rest = rest[3:-2]
    while rest.strip():
        found = TOKEN.match(rest)
        assert found, f"cannot read {rest!r}"
        tokens.append(found.group(1))
        rest = rest[found.end():]

    def operand(token):
        return token[1:-1] if token.startswith("'") else context[token]

    def comparison(tokens):
        if len(tokens) == 1:
            return operand(tokens[0])
        left, op, right = tokens
        return (operand(left) == operand(right)) == (op == "==")

    def split(tokens, op):
        parts, part = [], []
        for token in tokens:
            if token == op:
                parts.append(part)
                part = []
            else:
                part.append(token)
        return parts + [part]

    return any(all(comparison(c) for c in split(o, "&&")) for o in split(tokens, "||"))


def value(written, context):
    """What a `with:` value passes: an expression's result as a string, else the literal."""
    if written.startswith("${{"):
        return "true" if evaluate(written, context) else "false"
    return written.strip('"')


def front_end_deps(given, modules_hit):
    """What the action does with these inputs, when front-end/node_modules' cache hits or misses."""
    found = action(FRONT_END_DEPS)
    steps = found["steps"]
    restore = steps["Restore front-end/node_modules"]
    inputs = {name: spec["default"].strip('"') for name, spec in found["inputs"].items()}
    inputs.update(given)
    context = {f"inputs.{name}": v for name, v in inputs.items()}
    looks_only = value(restore["with"]["lookup-only"], context) == "true"
    context[f"steps.{restore['id']}.outputs.cache-hit"] = "true" if modules_hit else "false"
    return {
        "looks only": looks_only,
        "downloads": modules_hit and not looks_only,
        "installs": evaluate(steps["Install with npm ci"]["if"], context),
        "saves": evaluate(steps["Save front-end/node_modules"]["if"], context),
    }


def test_fill_npm_cache_is_an_input_that_defaults_to_false():
    fill = action(FRONT_END_DEPS)["inputs"]["fill-npm-cache"]

    assert fill["required"] == "false"
    assert fill["default"] == '"false"'


@pytest.mark.parametrize("modules_hit", [True, False])
@pytest.mark.parametrize("npm_hit", [True, False])
def test_warm_caches_installs_once_at_most_filling_npm_s_cache_on_its_miss(npm_hit, modules_hit):
    warm = workflow_jobs()["warm-caches"]
    node, deps = warm["steps"][1], warm["steps"][2]
    context = {f"steps.{node['id']}.outputs.cache-hit": "true" if npm_hit else "false"}
    given = {name: value(written, context) for name, written in deps["with"].items()}

    did = front_end_deps(given, modules_hit)

    # One `npm ci` step, so it runs at most once; it runs on either cache's miss, so npm's cache
    # is full for setup-node's post step to save, and node_modules is whole without it otherwise.
    assert did["installs"] == (not npm_hit or not modules_hit)
    assert did["downloads"] == (not did["installs"])
    assert not did["looks only"] or did["installs"]
    assert did["saves"] == (not modules_hit)


@pytest.mark.parametrize("modules_hit", [True, False])
def test_by_default_as_the_e2e_shards_use_it_it_installs_only_on_node_modules_miss(modules_hit):
    shard = next(s for s in workflow_jobs()["e2e-shard"]["steps"] if s.get("uses") == "./.github/actions/front-end-deps")
    assert "fill-npm-cache" not in shard["with"]

    did = front_end_deps({"save-cache": "true"}, modules_hit)

    assert not did["looks only"]
    assert did["downloads"] == modules_hit
    assert did["installs"] == (not modules_hit)
    assert did["saves"] == (not modules_hit)


def test_node_modules_is_saved_from_where_it_was_restored_under_the_restore_s_key():
    steps = action(FRONT_END_DEPS)["steps"]

    assert steps["Save front-end/node_modules"]["with"] == {
        "path": "front-end/node_modules",
        "key": "${{ steps.modules.outputs.cache-primary-key }}",
    }
    assert steps["Install with npm ci"]["run"] == "npm ci\n"
