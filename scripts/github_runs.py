"""Reading GitHub's API for the release workflows' checks (T317).

Deploy (scripts/deploy_proof.py), Promote (scripts/promote_check.py) and the Test workflow's
first job on a push to `dev` (scripts/ci_suite.py) each decide from the Test workflow's runs, so
which runs count is read here, once, and every request goes through the one authenticated GET
below. A read fails closed: any error, an HTTP status, no answer
or an answer unlike GitHub's, comes back as the reason it could not be read, never retried, so the
caller refuses rather than guesses. The nightly report of the e2e tests that needed a retry
(scripts/e2e_retries.py) reads its runs and their artifacts' files through the same GET.

Nothing here prints, and the reason never holds the token.
"""
import http.client
import io
import json
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from typing import Any, Callable, Optional, Tuple

TIMEOUT = 30

#: What a read may raise; any of them means GitHub was not read.
UNREADABLE = (OSError, http.client.HTTPException, ValueError, KeyError, TypeError, zipfile.BadZipFile)


class _TokenStaysOnTheHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect, dropping the token when it leads to another host: an artifact's zip
    redirects to storage that is not GitHub's API, which must never be sent the token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        follow = super().redirect_request(req, fp, code, msg, headers, newurl)
        if follow is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            follow.remove_header("Authorization")
        return follow


_OPENER = urllib.request.build_opener(_TokenStaysOnTheHost)


def read(
    api: str,
    path: str,
    token: str,
    parse: Callable[[Any], Any] = lambda data: data,
    query=None,
    body: Callable[[bytes], Any] = json.loads,
):
    """One authenticated GET of `<api><path>`, its JSON passed through `parse`.

    Returns `(value, None)`, or `(None, reason)` when it could not be read: the HTTP status, or the
    error's type. `parse` runs inside the same guard, so an answer unlike GitHub's, a missing key
    or a wrong type, is a reason too. `body` reads the answer's bytes, JSON unless told; a redirect
    to another host is followed without the token.
    """
    address = f"{api.rstrip('/')}{path}"
    if query:
        address += "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(
        address,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            return parse(body(response.read())), None
    except urllib.error.HTTPError as error:
        error.close()
        return None, str(error.code)
    except UNREADABLE as error:
        return None, type(error).__name__


def newest_run(sha: str, branch: str, api: str, repository: str, token: str) -> Tuple[Optional[dict], Optional[str]]:
    """The Test workflow's newest run on a push to `branch` at `sha`, by `run_number`.

    Returns `(run, None)`, `(None, None)` when there is no such run, or `(None, reason)` when the
    runs could not be read. Only a run of this commit, on a push, to this branch counts, whatever
    else GitHub lists; a re-run of failed jobs is the same run.
    """

    def newest(data):
        runs = [
            run for run in data["workflow_runs"]
            if run["head_sha"] == sha and run["event"] == "push" and run["head_branch"] == branch
        ]
        return max(runs, key=lambda run: run["run_number"], default=None)

    query = {"head_sha": sha, "event": "push", "branch": branch, "per_page": 100}
    return read(api, f"/repos/{repository}/actions/workflows/test.yml/runs", token, newest, query)


#: The head branch of every run of `dev`'s merge queue, `gh-readonly-queue/dev/pr-<n>-<base sha>`.
DEV_QUEUE = "gh-readonly-queue/dev/"


def dev_runs(sha: str, api: str, repository: str, token: str) -> Tuple[Optional[list], Optional[str]]:
    """The Test workflow's runs at `sha` that judged it as `dev` has it (T510).

    Those are the runs of `dev`'s merge queue on the commit and of a push to `dev` at it. Promote
    decides by the newest of them, and the Test workflow's first job on a push to `dev` by the
    queue's, so the one query asks by the commit alone and both kinds are kept here. A nightly or
    hand-started run, a pull request's and another queue's never count, whatever else GitHub lists.

    Returns `(runs, None)`, the list possibly empty, or `(None, reason)` when the runs could not be
    read; a kept run without a whole `run_number` is an answer unlike GitHub's, so its callers may
    sort by it.
    """

    def judged_as_dev(run):
        if run["head_sha"] != sha:
            return False
        if run["event"] == "push":
            return run["head_branch"] == "dev"
        if run["event"] == "merge_group":
            if not isinstance(run["head_branch"], str):
                raise TypeError("head_branch")
            return run["head_branch"].startswith(DEV_QUEUE)
        return False

    def kept(data):
        counted = [run for run in data["workflow_runs"] if judged_as_dev(run)]
        if any(not isinstance(run["run_number"], int) for run in counted):
            raise TypeError("run_number")
        return counted

    query = {"head_sha": sha, "per_page": 100}
    return read(api, f"/repos/{repository}/actions/workflows/test.yml/runs", token, kept, query)


def artifact_file(api: str, repository: str, artifact_id: int, name: str, token: str) -> Tuple[Optional[bytes], Optional[str]]:
    """The file `name` inside an artifact's zip (T606), as `read` answers: `(data, None)`, or
    `(None, reason)`, a missing file a `KeyError` and a zip that is not one a `BadZipFile`. GitHub
    answers the zip with a redirect to its storage, which is followed without the token."""

    def member(data: bytes) -> bytes:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            return archive.read(name)

    return read(api, f"/repos/{repository}/actions/artifacts/{artifact_id}/zip", token, body=member)
