"""The test map's build (T349): which app modules and endpoints each E2E spec reached, and which
back-end functions each endpoint runs.

The build reads what CI's shards recorded (one JSON line per test, front-end/e2e/helpers/testMap.ts)
beside each shard's back-end log, and the coverage data of the pytest pass that
back-end/tests/test_map_plugin.py splits by endpoint. These tests give it fixture records, logs and
a real coverage data file, and read the map it writes and what it says; the endpoint pass runs over
a back end of its own.
"""
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import coverage
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_map  # noqa: E402

SCRIPT = Path(__file__).resolve().parents[1] / "test_map.py"

# `/markets/new` after `/markets/<market_id>`, so a match that took the first rule listed fails.
RULES = [
    ["/markets", ["GET", "POST"]],
    ["/markets/<market_id>", ["GET", "PUT"]],
    ["/markets/new", ["GET"]],
    ["/markets/<market_id>/history", ["GET"]],
    ["/static/<path:filename>", ["GET"]],
]

# 2026-11-14T15:16:00Z on the wall clock, in milliseconds.
T0 = 1794672960000


def stamp(ms):
    """A Docker log timestamp, nanoseconds and all, for a wall-clock millisecond."""
    seconds, millis = divmod(ms, 1000)
    import datetime

    when = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return when.strftime("%Y-%m-%dT%H:%M:%S") + f".{millis:03d}546500Z"


def log_line(ms, method, path, colour=False, prefix=""):
    request = f"{method} {path} HTTP/1.1"
    if colour:
        request = f"\x1b[35m\x1b[1m{request}\x1b[0m"
    return (
        f"{prefix}{stamp(ms)} INFO:werkzeug:172.19.0.1 - - [14/Nov/2026 15:16:08] "
        f'"{request}" 200 -\n'
    )


def record(spec, start, end, requests=(), title="a test"):
    return {
        "spec": spec,
        "title": title,
        "status": "passed",
        "start": start,
        "end": end,
        "requests": list(requests),
        "cov": {},
    }


def specs_of(shards):
    return test_map.spec_maps(shards, test_map.Rules(RULES))


class TestALogLineGoesToTheTestRunningThen:
    def test_a_line_inside_a_tests_window_goes_to_that_tests_spec(self):
        records = [
            record("a.spec.ts", T0, T0 + 1000),
            record("b.spec.ts", T0 + 2000, T0 + 3000),
        ]
        log = [log_line(T0 + 500, "GET", "/markets"), log_line(T0 + 2500, "POST", "/markets")]
        specs = specs_of([(records, log)])
        assert specs["a.spec.ts"]["endpoints"] == ["GET /markets"]
        assert specs["b.spec.ts"]["endpoints"] == ["POST /markets"]

    def test_a_line_between_tests_goes_to_none(self):
        records = [
            record("a.spec.ts", T0, T0 + 1000),
            record("b.spec.ts", T0 + 2000, T0 + 3000),
        ]
        log = [
            log_line(T0 - 500, "GET", "/markets/new"),
            log_line(T0 + 1500, "GET", "/markets/new"),
            log_line(T0 + 3500, "GET", "/markets/new"),
        ]
        specs = specs_of([(records, log)])
        assert specs["a.spec.ts"]["endpoints"] == []
        assert specs["b.spec.ts"]["endpoints"] == []

    def test_a_line_on_the_edge_of_a_window_is_inside_it(self):
        records = [record("a.spec.ts", T0, T0 + 1000)]
        log = [log_line(T0, "GET", "/markets"), log_line(T0 + 1000, "POST", "/markets")]
        assert specs_of([(records, log)])["a.spec.ts"]["endpoints"] == [
            "GET /markets",
            "POST /markets",
        ]

    def test_each_shards_log_is_laid_against_its_own_tests_only(self):
        # Two shards run at once on two runners, so their windows overlap.
        one = ([record("a.spec.ts", T0, T0 + 1000)], [log_line(T0 + 500, "GET", "/markets")])
        two = ([record("b.spec.ts", T0, T0 + 1000)], [log_line(T0 + 500, "POST", "/markets")])
        specs = specs_of([one, two])
        assert specs["a.spec.ts"]["endpoints"] == ["GET /markets"]
        assert specs["b.spec.ts"]["endpoints"] == ["POST /markets"]

    def test_a_coloured_line_a_query_and_composes_prefix_are_read(self):
        records = [record("a.spec.ts", T0, T0 + 1000)]
        log = [
            log_line(T0 + 100, "POST", "/markets", colour=True),
            log_line(T0 + 200, "GET", "/markets/m-1/history?group=Assignment"),
            log_line(T0 + 300, "PUT", "/markets/m-1", prefix="backend-1  | "),
        ]
        assert specs_of([(records, log)])["a.spec.ts"]["endpoints"] == [
            "GET /markets/<market_id>/history",
            "POST /markets",
            "PUT /markets/<market_id>",
        ]

    def test_lines_that_are_no_request_are_left_out(self):
        records = [record("a.spec.ts", T0, T0 + 1000)]
        log = [
            f"{stamp(T0 + 100)} INFO:werkzeug: * Restarting with stat\n",
            f"{stamp(T0 + 200)} WARNING:utils.secret_key:Signing with a random secret\n",
            "\n",
        ]
        assert specs_of([(records, log)])["a.spec.ts"]["endpoints"] == []

    def test_a_retried_test_counts_both_its_attempts(self):
        records = [
            record("a.spec.ts", T0, T0 + 1000),
            record("a.spec.ts", T0 + 2000, T0 + 3000),
        ]
        log = [log_line(T0 + 500, "GET", "/markets"), log_line(T0 + 2500, "PUT", "/markets/m-1")]
        assert specs_of([(records, log)])["a.spec.ts"]["endpoints"] == [
            "GET /markets",
            "PUT /markets/<market_id>",
        ]


class TestAPathMatchesItsRule:
    rules = test_map.Rules(RULES)

    def test_a_path_with_an_id_matches_its_rule(self):
        assert self.rules.match("GET", "/markets/4d796588-7111-4711-aee7-40728d35612b") == (
            "GET /markets/<market_id>"
        )
        assert self.rules.match("GET", "/markets/m-1/history") == "GET /markets/<market_id>/history"

    def test_a_fixed_segment_wins_over_an_id(self):
        assert self.rules.match("GET", "/markets/new") == "GET /markets/new"

    def test_the_method_must_be_one_the_rule_allows(self):
        assert self.rules.match("PUT", "/markets/new") == "PUT /markets/<market_id>"
        assert self.rules.match("DELETE", "/markets/m-1") is None

    def test_a_path_rule_takes_the_slashes(self):
        assert self.rules.match("GET", "/static/a/b.css") == "GET /static/<path:filename>"

    def test_a_path_no_rule_has_matches_none(self):
        assert self.rules.match("GET", "/") is None
        assert self.rules.match("GET", "/markets/m-1/history/more") is None

    def test_a_line_whose_path_no_rule_has_is_left_out(self):
        records = [record("a.spec.ts", T0, T0 + 1000)]
        log = [log_line(T0 + 100, "GET", "/"), log_line(T0 + 200, "GET", "/nowhere")]
        assert specs_of([(records, log)])["a.spec.ts"]["endpoints"] == []


class TestTheModulesASpecLoaded:
    def test_its_pages_modules_as_repository_paths_each_once(self):
        records = [
            record("a.spec.ts", T0, T0 + 1000, ["/src/App.vue", "/src/main.ts"]),
            record("a.spec.ts", T0 + 2000, T0 + 3000, ["/src/App.vue", "/src/views/Home.vue"]),
        ]
        assert specs_of([(records, [])])["a.spec.ts"]["modules"] == [
            "front-end/src/App.vue",
            "front-end/src/main.ts",
            "front-end/src/views/Home.vue",
        ]

    def test_the_pages_own_api_calls_count_as_endpoints_too(self):
        records = [record("a.spec.ts", T0, T0 + 1000, ["GET /api/markets/m-1", "/src/App.vue"])]
        specs = specs_of([(records, [])])
        assert specs["a.spec.ts"]["endpoints"] == ["GET /markets/<market_id>"]
        assert specs["a.spec.ts"]["modules"] == ["front-end/src/App.vue"]


class TestTheEnclosingFunction:
    SOURCE = textwrap.dedent(
        '''\
        import os

        LIMIT = 3


        def outer(x):
            def inner(y):
                return y + 1

            return inner(x)


        class Things:
            @staticmethod
            def make():
                return []

            def name(self):
                return "things"
        '''
    )

    def test_a_line_inside_a_nested_function_names_the_innermost_one(self):
        spans = test_map.function_spans(self.SOURCE)
        assert test_map.function_at(spans, 8) == "outer.inner"
        assert test_map.function_at(spans, 10) == "outer"

    def test_a_method_is_named_by_its_class_and_its_decorator_is_its_own(self):
        spans = test_map.function_spans(self.SOURCE)
        assert test_map.function_at(spans, 14) == "Things.make"
        assert test_map.function_at(spans, 16) == "Things.make"
        assert test_map.function_at(spans, 19) == "Things.name"

    def test_a_line_outside_every_function_is_the_module(self):
        spans = test_map.function_spans(self.SOURCE)
        assert test_map.function_at(spans, 3) == "<module>"
        assert test_map.function_at(spans, 13) == "<module>"

    def test_a_file_that_does_not_parse_has_no_functions(self):
        assert test_map.function_spans("def broken(:\n") == []


APP = textwrap.dedent(
    '''\
    def list_markets():
        return [m for m in range(2)]


    def save_market(market):
        def check(m):
            return bool(m)

        if check(market):
            return market
        return None


    def unused():
        return 0
    '''
)


@pytest.fixture
def coverage_data(tmp_path):
    """A real coverage data file: two tests, each calling its endpoint in a context of its own."""
    back_end = tmp_path / "back-end"
    (back_end / "routes").mkdir(parents=True)
    (back_end / "routes" / "markets.py").write_text(APP)
    (back_end / "routes" / "late.py").write_text("LOADED = True\n\n\ndef later():\n    return 1\n")
    data_file = tmp_path / ".coverage"
    driver = textwrap.dedent(
        f'''\
        import sys
        import coverage

        cov = coverage.Coverage(data_file={str(data_file)!r}, branch=True,
                                source=[{str(back_end)!r}], config_file=False)
        cov.start()
        sys.path.insert(0, {str(back_end)!r})
        from routes import markets
        cov.switch_context("tests/test_a.py::test_lists")
        cov.switch_context("tests/test_a.py::test_lists|GET /markets")
        markets.list_markets()
        from routes import late
        cov.switch_context("tests/test_a.py::test_lists")
        cov.switch_context("tests/test_b.py::test_saves|PUT /markets/<market_id>")
        markets.save_market({{"id": 1}})
        cov.switch_context("tests/test_b.py::test_saves")
        cov.stop()
        cov.save()
        '''
    )
    subprocess.run([sys.executable, "-c", driver], check=True)
    return data_file, back_end


class TestTheEndpointBridge:
    # `late.py` is first imported inside GET /markets, so its module lines ran in that context:
    # which request first imports a module is the suite's order, not what the endpoint runs.
    def test_each_endpoint_names_the_functions_its_requests_ran(self, coverage_data):
        data_file, back_end = coverage_data
        assert test_map.endpoint_bridge(data_file, back_end) == {
            "GET /markets": {"back-end/routes/markets.py": ["list_markets"]},
            "PUT /markets/<market_id>": {
                "back-end/routes/markets.py": ["save_market", "save_market.check"]
            },
        }


class TestTheCommandLine:
    def test_build_writes_the_map_from_each_shards_records_and_log(self, tmp_path, coverage_data):
        data_file, back_end = coverage_data
        endpoints = tmp_path / "endpoints.json"
        endpoints.write_text(
            json.dumps({"rules": RULES, "endpoints": test_map.endpoint_bridge(data_file, back_end)})
        )
        shards = tmp_path / "shards"
        for n, (spec, method, path) in enumerate(
            [("a.spec.ts", "GET", "/markets"), ("b.spec.ts", "PUT", "/markets/m-7")], start=1
        ):
            shard = shards / f"test-map-shard-{n}"
            shard.mkdir(parents=True)
            (shard / "records.jsonl").write_text(
                json.dumps(record(spec, T0, T0 + 1000, ["/src/App.vue"])) + "\n"
            )
            (shard / "backend.log").write_text(log_line(T0 + 10, method, path))
        out = tmp_path / "test-map.json"
        done = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "build",
                "--commit",
                "291c5732",
                "--endpoints",
                str(endpoints),
                "--shards",
                str(shards),
                "--out",
                str(out),
            ],
            capture_output=True,
            text=True,
        )
        assert done.returncode == 0, done.stderr
        assert json.loads(out.read_text()) == {
            "commit": "291c5732",
            "specs": {
                "a.spec.ts": {"modules": ["front-end/src/App.vue"], "endpoints": ["GET /markets"]},
                "b.spec.ts": {
                    "modules": ["front-end/src/App.vue"],
                    "endpoints": ["PUT /markets/<market_id>"],
                },
            },
            "endpoints": {
                "GET /markets": {"back-end/routes/markets.py": ["list_markets"]},
                "PUT /markets/<market_id>": {
                    "back-end/routes/markets.py": ["save_market", "save_market.check"]
                },
            },
        }
        assert "2 specs" in done.stdout
        assert "2 endpoints" in done.stdout

    def build(self, tmp_path, *extra, bridge=None):
        endpoints = tmp_path / "endpoints.json"
        endpoints.write_text(json.dumps({"rules": RULES, "endpoints": bridge or {}}))
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "build",
                "--commit",
                "291c5732",
                "--endpoints",
                str(endpoints),
                "--shards",
                str(tmp_path / "shards"),
                "--out",
                str(tmp_path / "out.json"),
                *extra,
            ],
            capture_output=True,
            text=True,
        )

    def shard(self, tmp_path, n, records=True):
        shard = tmp_path / "shards" / f"test-map-shard-{n}"
        shard.mkdir(parents=True)
        (shard / "backend.log").write_text("")
        if records:
            (shard / "records.jsonl").write_text(
                json.dumps(record(f"s{n}.spec.ts", T0, T0 + 1000)) + "\n"
            )

    def test_build_refuses_a_shard_with_no_records(self, tmp_path):
        self.shard(tmp_path, 1, records=False)
        done = self.build(tmp_path)
        assert done.returncode == 1
        assert "test-map-shard-1" in done.stderr
        assert not (tmp_path / "out.json").exists()

    def test_build_refuses_fewer_shards_than_expected(self, tmp_path):
        # A shard that stopped before it uploaded anything leaves no directory at all.
        self.shard(tmp_path, 1)
        self.shard(tmp_path, 3)
        done = self.build(tmp_path, "--shards-expected", "3")
        assert done.returncode == 1
        assert "2 of 3" in done.stderr
        assert not (tmp_path / "out.json").exists()
        assert self.build(tmp_path, "--shards-expected", "2").returncode == 0

    @pytest.mark.parametrize("expected, said", [(1, "0 of 1 shard under"), (2, "0 of 2 shards under")])
    def test_build_words_the_shards_it_expected_by_their_count(self, tmp_path, expected, said):
        done = self.build(tmp_path, "--shards-expected", str(expected))
        assert done.returncode == 1
        assert said in done.stderr

    @pytest.mark.parametrize(
        "count, said",
        [
            (1, "1 spec from 1 test on 1 shard, 1 endpoint, at 291c5732"),
            (2, "2 specs from 2 tests on 2 shards, 2 endpoints, at 291c5732"),
        ],
    )
    def test_build_words_what_it_wrote_by_its_counts(self, tmp_path, count, said):
        for n in range(1, count + 1):
            self.shard(tmp_path, n)
        done = self.build(tmp_path, bridge={f"GET /{n}": {} for n in range(count)})
        assert done.returncode == 0, done.stderr
        assert f"test_map: {said}" in done.stdout

    @pytest.mark.parametrize(
        "count, said", [(1, "1 endpoint, 1 rule, to "), (2, "2 endpoints, 2 rules, to ")]
    )
    def test_the_endpoint_pass_words_what_it_wrote_by_its_counts(self, tmp_path, count, said):
        # A back end of its own, with a stand-in for its plugin that names `count` rules, and one
        # test that calls `count` functions, each in an endpoint's context.
        back_end = tmp_path / "back-end"
        (back_end / "tests").mkdir(parents=True)
        (back_end / "routes.py").write_text("def a():\n    return 1\n\n\ndef b():\n    return 2\n")
        (back_end / "tests" / "test_map_plugin.py").write_text(
            textwrap.dedent(
                f"""\
                import json
                import os


                def pytest_sessionfinish(session):
                    with open(os.environ["TEST_MAP_RULES"], "w") as out:
                        json.dump({RULES[:count]!r}, out)
                """
            )
        )
        (back_end / "tests" / "test_routes.py").write_text(
            textwrap.dedent(
                f"""\
                import coverage

                import routes


                def test_calls():
                    for name in ["a", "b"][:{count}]:
                        coverage.Coverage.current().switch_context(f"t|GET /{{name}}")
                        getattr(routes, name)()
                """
            )
        )
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "endpoints", "--out", str(tmp_path / "endpoints.json"),
             "--back-end", str(back_end)],
            capture_output=True,
            text=True,
        )  # fmt: skip
        assert done.returncode == 0, done.stdout + done.stderr
        assert f"test_map: {said}" in done.stdout


def test_the_coverage_installed_is_one_the_bridge_reads():
    # The bridge reads coverage's SQLite data file, whose tables are coverage's own: the dev lock
    # pins the version these tests ran on.
    assert coverage.version_info[0] == 7
