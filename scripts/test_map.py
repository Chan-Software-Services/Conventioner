#!/usr/bin/env python3
"""The test map (T349): which app modules and back-end endpoints each E2E spec file reaches, and
which back-end functions each endpoint runs. CI's `test-map` job writes it on the nightly Test run
on `dev`'s tip, or one started by hand, when that commit has no map yet;
`docs/implementation/testing/the-test-map.md` says what it is for.

    test_map.py endpoints --out <endpoints.json> [-- <pytest arguments, in place of tests/>]
    test_map.py build --commit <sha> --endpoints <endpoints.json> --shards <dir> --out <test-map.json>
                      [--shards-expected <n>]

`endpoints` runs the back end's pytest suite once under coverage.py, with branch coverage of the
back end's own code (not its tests), and back-end/tests/test_map_plugin.py loaded, which names the
coverage context `<test>|<METHOD> <rule>` while the app handles a request. It writes the app's URL
rules and, for each endpoint, the functions its requests ran, by file:

    {"rules": [[rule, [methods]], ...], "endpoints": {"METHOD rule": {file: [functions]}}}

A function is its qualified name in the file (`outer.inner`, `Class.method`), the innermost one
whose body holds the covered line; a line outside every body is left out (`endpoint_bridge` says
why). It exits 1 when the suite failed, writing nothing.

`build` reads each shard's directory under `--shards` (`test-map-shard-<n>/`, as
`gh run download` or `actions/download-artifact` lays them out), each holding the shard's
records, every `*.jsonl` of it (front-end/e2e/helpers/testMap.ts: `records-<worker>.jsonl`, one
line a test, with its spec file, its window on the wall clock and the requests its pages and its
Node helpers made, and a `"between"` line for what a worker called between two of its tests; a
shard recorded before that, one `records.jsonl`), and `backend.log`
(`docker compose logs --timestamps` of the back end). Each spec's endpoints are its tests'
recorded `/api/` calls, each path matched to a Flask rule of `endpoints.json`, so `/markets/<id>`
is one endpoint whatever the id. It writes:

    {"commit": sha, "specs": {spec: {"modules": [paths], "endpoints": ["METHOD rule"]}},
     "endpoints": {"METHOD rule": {file: [functions]}},
     "unclaimed": {shard: {"lines": n, "endpoints": {"METHOD rule": n}} or null}}

where a module is the repository path of a file under front-end/src/ a page of the spec loaded.
`unclaimed` is the audit of each shard's log: the request lines inside some test's window whose
endpoint no record whose window holds them recorded, a test's or a worker's between its tests,
which a way of reaching the back end the recorder does not see would leave; a line outside every
test's window (the global setup, the seed) is left out, and a shard with no log is null. It
prints each shard's count and its five endpoints with the most lines. It refuses, writing
nothing, a shard with no test's record, or fewer shards than `--shards-expected`.

Exit codes: 0 written, 1 refused or the suite failed, 2 a usage error.
"""
import argparse
import ast
import bisect
import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
BACK_END = ROOT / "back-end"

Span = Tuple[int, int, str]


class Shard(NamedTuple):
    """One shard's directory as the build reads it."""

    name: str
    records: Sequence[dict]
    # The back end's log, line by line; None when the shard saved none.
    log: Optional[Sequence[str]]


def counted(count: float, noun: str) -> str:
    """A count and its noun, in the singular for one; a float reads without a needless point, 1.0
    as "1"."""
    shown = f"{count:g}" if isinstance(count, float) else str(count)
    return f"{shown} {noun}" + ("" if count == 1 else "s")


def function_spans(source: str, bodies: bool = False) -> List[Span]:
    """(first line, last line, qualified name) of every function and method.

    A span is the whole definition, decorators included, which is what a change to the source
    touches; with `bodies`, only the lines that run when the function is called, from its first
    statement on, since the decorators and the `def` line run where the function is defined.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    spans: List[Span] = []

    def visit(node: ast.AST, prefix: List[str]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = prefix + [child.name]
                if not isinstance(child, ast.ClassDef):
                    if bodies:
                        first = child.body[0].lineno
                    else:
                        first = min([d.lineno for d in child.decorator_list] + [child.lineno])
                    spans.append((first, child.end_lineno or child.lineno, ".".join(name)))
                visit(child, name)

    visit(tree, [])
    return spans


def function_at(spans: Sequence[Span], line: int) -> str:
    """The innermost function holding the line, or `<module>`."""
    best: Optional[Span] = None
    for span in spans:
        if span[0] <= line <= span[1] and (best is None or span[0] >= best[0]):
            best = span
    return best[2] if best else "<module>"


VARIABLE = re.compile(r"<(?:([a-zA-Z_][a-zA-Z0-9_]*)(?:\([^)]*\))?:)?[a-zA-Z_][a-zA-Z0-9_]*>")


class Rules:
    """The app's URL rules, matched as werkzeug matches them: a fixed segment wins over a variable."""

    def __init__(self, rules: Sequence[Sequence]):
        self._rules = []
        for rule, methods in rules:
            pattern, fixed = self._compile(rule)
            self._rules.append((pattern, fixed, rule, frozenset(methods)))
        # The most fixed segments first, so `/markets/new` is tried before `/markets/<id>`.
        self._rules.sort(key=lambda r: -r[1])

    @staticmethod
    def _compile(rule: str) -> Tuple["re.Pattern[str]", int]:
        parts, fixed, at = [], 0, 0
        for m in VARIABLE.finditer(rule):
            parts.append(re.escape(rule[at : m.start()]))
            parts.append(".+" if m.group(1) == "path" else "[^/]+")
            at = m.end()
        parts.append(re.escape(rule[at:]))
        for segment in rule.strip("/").split("/"):
            if segment and not VARIABLE.search(segment):
                fixed += 1
        return re.compile("".join(parts) + r"\Z"), fixed

    def match(self, method: str, path: str) -> Optional[str]:
        for pattern, _, rule, methods in self._rules:
            if method in methods and pattern.match(path):
                return f"{method} {rule}"
        return None


# `docker compose logs --timestamps`, with or without compose's `<service>  | ` prefix, of a
# werkzeug request line, whose request may be wrapped in colour codes.
REQUEST_LINE = re.compile(
    r"^(?:\S+\s+\|\s)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s.*?INFO:werkzeug:.*?"
    r'"(?:\x1b\[[0-9;]*m)*([A-Z]+) (\S+) HTTP/[0-9.]+(?:\x1b\[[0-9;]*m)*"'
)


def docker_time(stamp: str) -> int:
    """A Docker log timestamp (RFC 3339, UTC, up to nanoseconds) as wall-clock milliseconds."""
    main, _, fraction = stamp.rstrip("Z").partition(".")
    when = datetime.datetime.strptime(main, "%Y-%m-%dT%H:%M:%S").replace(
        tzinfo=datetime.timezone.utc
    )
    return int(when.timestamp()) * 1000 + int((fraction + "000")[:3])


def log_requests(lines: Iterable[str]) -> Iterable[Tuple[int, str, str]]:
    """(milliseconds, method, path without its query) of each request line of a back-end log."""
    for line in lines:
        m = REQUEST_LINE.match(line)
        if m:
            yield docker_time(m.group(1)), m.group(2), m.group(3).split("?", 1)[0]


def is_test(record: dict) -> bool:
    """Whether a record is a test's, not a worker's between two of its tests."""
    return not record.get("between")


def recorded_endpoint(request: str, rules: Rules) -> Optional[str]:
    """The endpoint of a recorded `/api/` call (`GET /api/markets/m-1`), or None."""
    method, _, path = request.rpartition(" ")
    if method and path.startswith("/api/"):
        return rules.match(method, path[len("/api") :])
    return None


def spec_maps(shards: Iterable[Shard], rules: Rules) -> Dict[str, Dict[str, List[str]]]:
    """Each spec's modules and endpoints, from its tests' records alone."""
    modules: Dict[str, set] = defaultdict(set)
    endpoints: Dict[str, set] = defaultdict(set)
    for shard in shards:
        for t in filter(is_test, shard.records):
            spec = t["spec"]
            # Every recorded spec is in the map, whatever it reached.
            modules.setdefault(spec, set())
            endpoints.setdefault(spec, set())
            for request in t["requests"]:
                if request.startswith("/src/"):
                    modules[spec].add("front-end" + request)
                    continue
                endpoint = recorded_endpoint(request, rules)
                if endpoint:
                    endpoints[spec].add(endpoint)
    return {
        spec: {"modules": sorted(modules[spec]), "endpoints": sorted(endpoints[spec])}
        for spec in sorted(modules)
    }


def audit(shard: Shard, rules: Rules) -> Optional[dict]:
    """The request lines of a shard's log that no test recorded, or None with no log.

    A line counts when some test's window holds it and no record whose window holds it recorded
    its endpoint: at two workers two tests' windows can hold one line, or one test's and the other
    worker's between two of its tests (a `beforeAll` seeding), and any of them claims it. A line
    outside every test's window, or whose path no rule has, is left out.
    """
    if shard.log is None:
        return None
    windows = sorted(
        (
            (r["start"], r["end"], is_test(r), {recorded_endpoint(q, rules) for q in r["requests"]})
            for r in shard.records
        ),
        key=lambda r: r[0],
    )
    starts = [r[0] for r in windows]
    unclaimed: Dict[str, int] = defaultdict(int)
    for when, method, path in log_requests(shard.log):
        holding = [r for r in windows[: bisect.bisect_right(starts, when)] if when <= r[1]]
        if not any(r[2] for r in holding):
            continue
        endpoint = rules.match(method, path)
        if endpoint and not any(endpoint in r[3] for r in holding):
            unclaimed[endpoint] += 1
    return {"lines": sum(unclaimed.values()), "endpoints": dict(sorted(unclaimed.items()))}


def audit_line(name: str, found: Optional[dict]) -> str:
    """The build's line for a shard's audit: its count and its five endpoints with the most."""
    if found is None:
        return f"{name}: no back-end log"
    line = f"{name}: {counted(found['lines'], 'request line')} no test recorded"
    top = sorted(found["endpoints"].items(), key=lambda e: (-e[1], e[0]))[:5]
    if top:
        line += ": " + ", ".join(f"{endpoint} {n}" for endpoint, n in top)
    return line


def endpoint_bridge(data_file: Path, back_end: Path) -> Dict[str, Dict[str, List[str]]]:
    """For each `<test>|<endpoint>` context of a coverage data file, the functions it ran, by file.

    Reads coverage.py's own SQLite tables (`file`, `context`, `arc`), which the dev lock's version
    pins; a covered line is either end of an arc, the negative ends being a code object's entry
    and exit. A line is laid against the functions' bodies, and a line outside every body is left
    out: it ran where a module or a function was defined, which happens inside a request only when
    that request is the first to import the module, an accident of the suite's order.
    """
    con = sqlite3.connect(str(data_file))
    try:
        files = dict(con.execute("select id, path from file"))
        contexts = {}
        for cid, name in con.execute("select id, context from context"):
            _, _, endpoint = (name or "").partition("|")
            if endpoint:
                contexts[cid] = endpoint
        spans: Dict[int, List[Span]] = {}
        names: Dict[int, str] = {}
        for fid, path in files.items():
            absolute = Path(path) if os.path.isabs(path) else back_end / path
            try:
                spans[fid] = function_spans(absolute.read_text(), bodies=True)
            except OSError:
                spans[fid] = []
            relative = os.path.relpath(absolute.resolve(), back_end.resolve().parent)
            names[fid] = relative.replace(os.sep, "/")
        bridge: Dict[str, Dict[str, set]] = defaultdict(lambda: defaultdict(set))
        rows = con.execute("select file_id, context_id, fromno, tono from arc")
        for fid, cid, start, end in rows:
            endpoint = contexts.get(cid)
            if endpoint is None:
                continue
            for line in (start, end):
                function = function_at(spans[fid], line) if line > 0 else "<module>"
                if function != "<module>":
                    bridge[endpoint][names[fid]].add(function)
    finally:
        con.close()
    return {
        endpoint: {path: sorted(fns) for path, fns in sorted(by_file.items())}
        for endpoint, by_file in sorted(bridge.items())
    }


COVERAGE_RC = """\
[run]
branch = True
relative_files = True
source = .
omit =
    tests/*
    */site-packages/*
    migrations/*
data_file = {data_file}
"""


def run_endpoints(out: Path, back_end: Path, pytest_args: Sequence[str]) -> int:
    with tempfile.TemporaryDirectory(prefix="test-map-") as tmp:
        rc = Path(tmp) / "coveragerc"
        data_file = Path(tmp) / ".coverage"
        rules_file = Path(tmp) / "rules.json"
        rc.write_text(COVERAGE_RC.format(data_file=data_file))
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(back_end / "tests")] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
        )
        env["TEST_MAP_RULES"] = str(rules_file)
        command = [
            sys.executable, "-m", "coverage", "run", f"--rcfile={rc}",
            "-m", "pytest", "-q", "-o", "addopts=", "-p", "no:cacheprovider",
            "-p", "test_map_plugin", *(pytest_args or ["tests/"]),
        ]  # fmt: skip
        status = subprocess.run(command, cwd=back_end, env=env).returncode
        if status != 0:
            print(f"test_map: the pytest pass exited {status}; nothing written", file=sys.stderr)
            return 1
        rules = json.loads(rules_file.read_text())
        bridge = endpoint_bridge(data_file, back_end)
    out.write_text(json.dumps({"rules": rules, "endpoints": bridge}, indent=0) + "\n")
    print(f"test_map: {counted(len(bridge), 'endpoint')}, {counted(len(rules), 'rule')}, to {out}")
    return 0


def read_shards(directory: Path, expected: Optional[int]) -> Tuple[List[Shard], List[str]]:
    shards: List[Shard] = []
    problems: List[str] = []
    found = sorted(p for p in directory.iterdir() if p.is_dir()) if directory.is_dir() else []
    if expected is not None and len(found) != expected:
        problems.append(
            f"{len(found)} of {counted(expected, 'shard')} under {directory}: "
            + ", ".join(p.name for p in found)
        )
    for shard in found:
        records = [
            json.loads(line)
            for records_file in sorted(shard.glob("*.jsonl"))
            for line in records_file.read_text().splitlines()
            if line.strip()
        ]
        if not any(map(is_test, records)):
            problems.append(f"{shard.name} has no records (no test's line in a *.jsonl)")
            continue
        log_file = shard / "backend.log"
        log = log_file.read_text(errors="replace").splitlines() if log_file.is_file() else None
        shards.append(Shard(shard.name, records, log))
    return shards, problems


def run_build(args: argparse.Namespace) -> int:
    shards, problems = read_shards(args.shards, args.shards_expected)
    if problems:
        for problem in problems:
            print(f"test_map: {problem}", file=sys.stderr)
        print("test_map: nothing written", file=sys.stderr)
        return 1
    bridge = json.loads(args.endpoints.read_text())
    rules = Rules(bridge["rules"])
    specs = spec_maps(shards, rules)
    unclaimed = {shard.name: audit(shard, rules) for shard in shards}
    test_map = {
        "commit": args.commit,
        "specs": specs,
        "endpoints": bridge["endpoints"],
        "unclaimed": unclaimed,
    }
    args.out.write_text(json.dumps(test_map, indent=0) + "\n")
    for name, found in unclaimed.items():
        print(f"test_map: {audit_line(name, found)}")
    tests = sum(len(list(filter(is_test, shard.records))) for shard in shards)
    print(
        f"test_map: {counted(len(specs), 'spec')} from {counted(tests, 'test')} "
        f"on {counted(len(shards), 'shard')}, "
        f"{counted(len(bridge['endpoints']), 'endpoint')}, at {args.commit}, to {args.out}"
    )
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    endpoints = sub.add_parser("endpoints", help="the pytest pass: each endpoint's functions")
    endpoints.add_argument("--out", type=Path, required=True)
    endpoints.add_argument("--back-end", type=Path, default=BACK_END)
    endpoints.add_argument(
        "pytest_args", nargs="*", help="what pytest runs, after --, in place of the whole of tests/"
    )
    build = sub.add_parser("build", help="the map from the shards' records; their logs' audit")
    build.add_argument("--commit", required=True)
    build.add_argument("--endpoints", type=Path, required=True)
    build.add_argument("--shards", type=Path, required=True)
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--shards-expected", type=int)
    args = parser.parse_args(argv)
    if args.command == "endpoints":
        return run_endpoints(args.out.resolve(), args.back_end.resolve(), args.pytest_args)
    return run_build(args)


if __name__ == "__main__":
    sys.exit(main())
