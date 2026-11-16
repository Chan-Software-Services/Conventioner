"""The test map's pytest plugin (T349), and its tests.

`scripts/test_map.py endpoints` loads this module with `-p test_map_plugin`, under `coverage run`,
for the pytest pass of CI's `test-map` job; nothing else loads it as a plugin, so the suite's own
runs collect only its tests below. As a plugin it:

- names the coverage context of each test its node id, and, while the app handles a request,
  `<node id>|<METHOD> <rule>` (`Flask.full_dispatch_request`, so the request's `before_request` and
  `after_request` handlers and its error handlers count with its view), so the data says which
  back-end functions each endpoint runs across the whole suite;
- writes the app's URL rules, with their methods, to the file `TEST_MAP_RULES` names, as the session
  ends, so the map's build can match a logged path to its rule.

A request no rule matches (a 404) stays in its test's context.
"""

import functools
import inspect
import json
import os
import sys

import coverage
import flask
import pytest

_test = {"id": ""}


def _switch(context):
    cov = coverage.Coverage.current()
    if cov is not None:
        cov.switch_context(context)


def in_endpoint_contexts(full_dispatch_request):
    """Wrap `Flask.full_dispatch_request` to run each request in its endpoint's context."""

    @functools.wraps(full_dispatch_request)
    def dispatch(self):
        rule = flask.request.url_rule
        if rule is None:
            return full_dispatch_request(self)
        _switch(f"{_test['id']}|{flask.request.method} {rule.rule}")
        try:
            return full_dispatch_request(self)
        finally:
            _switch(_test["id"])

    return dispatch


def url_rules(app):
    """Each rule of the app and the methods it allows, HEAD and OPTIONS aside, as Flask adds both."""
    return sorted(
        [rule.rule, sorted(m for m in rule.methods if m not in ("HEAD", "OPTIONS"))]
        for rule in app.url_map.iter_rules()
    )


def pytest_configure(config):
    flask.Flask.full_dispatch_request = in_endpoint_contexts(flask.Flask.full_dispatch_request)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    _test["id"] = item.nodeid
    _switch(item.nodeid)
    yield
    _test["id"] = ""
    _switch("")


def pytest_sessionfinish(session):
    out = os.environ.get("TEST_MAP_RULES")
    module = sys.modules.get("app")
    app = getattr(module, "app", None)
    if out and isinstance(app, flask.Flask):
        with open(out, "w") as f:
            json.dump(url_rules(app), f)


class FakeCoverage:
    def __init__(self):
        self.contexts = []

    def switch_context(self, context):
        self.contexts.append(context)


@pytest.fixture
def contexts(monkeypatch):
    """The contexts the plugin switches to, on a stand-in for the coverage measuring the run."""
    fake = FakeCoverage()
    monkeypatch.setattr(coverage.Coverage, "current", staticmethod(lambda: fake))
    monkeypatch.setitem(_test, "id", "tests/test_x.py::test_y")
    return fake.contexts


@pytest.fixture
def app(monkeypatch):
    app = flask.Flask("a_test_map_app")
    # Flask's own, under the wrap this module puts on it when it is loaded as the plugin.
    unwrapped = inspect.unwrap(flask.Flask.full_dispatch_request)
    monkeypatch.setattr(flask.Flask, "full_dispatch_request", in_endpoint_contexts(unwrapped))
    seen = {}

    def now():
        switched = coverage.Coverage.current().contexts
        return switched[-1] if switched else None

    @app.before_request
    def note():
        seen["before"] = now()

    @app.get("/things/<thing_id>")
    def thing(thing_id):
        seen["view"] = now()
        return {"id": thing_id}

    @app.route("/things", methods=["POST", "PUT"])
    def things():
        flask.abort(409)

    @app.errorhandler(409)
    def conflict(error):
        seen["error"] = now()
        return {"error": "conflict"}, 409

    app.seen = seen
    return app


class TestEachRequestRunsInItsEndpointsContext:
    def test_the_request_runs_in_its_rules_context_and_the_test_goes_on_in_its_own(
        self, contexts, app
    ):
        assert app.test_client().get("/things/7").json == {"id": "7"}
        assert contexts == [
            "tests/test_x.py::test_y|GET /things/<thing_id>",
            "tests/test_x.py::test_y",
        ]

    def test_its_before_request_handler_and_its_view_are_the_endpoints(self, contexts, app):
        app.test_client().get("/things/7")
        assert app.seen["before"] == "tests/test_x.py::test_y|GET /things/<thing_id>"
        assert app.seen["view"] == "tests/test_x.py::test_y|GET /things/<thing_id>"

    def test_its_error_handler_is_the_endpoints(self, contexts, app):
        assert app.test_client().put("/things").status_code == 409
        assert app.seen["error"] == "tests/test_x.py::test_y|PUT /things"
        assert contexts[-1] == "tests/test_x.py::test_y"

    def test_a_request_no_rule_matches_stays_in_the_tests_context(self, contexts, app):
        assert app.test_client().get("/nowhere").status_code == 404
        assert contexts == []

    def test_with_no_coverage_running_a_request_is_answered_as_ever(self, monkeypatch, app):
        monkeypatch.setattr(coverage.Coverage, "current", staticmethod(lambda: None))
        app.before_request_funcs.clear()
        app.view_functions["thing"] = lambda thing_id: {"id": thing_id}
        assert app.test_client().get("/things/7").json == {"id": "7"}


def test_the_rules_are_each_rule_with_its_methods(app):
    assert url_rules(app) == [
        ["/static/<path:filename>", ["GET"]],
        ["/things", ["POST", "PUT"]],
        ["/things/<thing_id>", ["GET"]],
    ]
