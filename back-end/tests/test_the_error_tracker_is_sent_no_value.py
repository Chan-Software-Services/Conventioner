"""The error tracker is sent what ADR 0049 allows, and never an applicant's data.

Driven the way production runs it: ``error_tracking.start`` with a fixture DSN and a transport that
records every envelope item it is handed, the real app's test client, and real log lines. Each test
reads what would have left the process, serialised whole, so a field a later SDK adds is caught too,
and so would be a Sentry Log or a session item if one were ever sent.
"""
import http.server
import json
import logging
import os
import subprocess
import sys
import threading
from types import SimpleNamespace

import pymongo.errors
import pytest

from conftest import (
    COMPLETE_PLAN,
    FakeMarketsCollection,
    sessions_load_through_get_user,
    skip_without_real_dependencies,
    stored_market,
)

skip_without_real_dependencies()

import requests
from sentry_sdk.transport import Transport

import app as app_module
import api.markets as MarketsApi
import api.payments as PaymentsApi
import api.users as UsersApi
import error_tracking as ErrorTracking
from datatypes import MarketPhase

BACK_END_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FIXTURE_DSN = "https://publickey@sentry.example.com/2"
OWNER_EMAIL = "owner.t584@example.com"
OWNER_ID = "user-t584"
MARKET_ID = "market-123"

# Obviously synthetic, and in each shape the address rule has to find.
ADDRESS = "fixture.vendor+t584@stalls.example.com"
SHOUTED_ADDRESS = "FIXTURE.VENDOR@STALLS.EXAMPLE.COM"
ANSWER = "Hand-poured-lanterns-fixture-answer"
TOKEN = "fixture-token-q8Zr5t584"

# What no item may hold, whatever the test put it in.
NEVER_SENT = (ADDRESS, SHOUTED_ADDRESS, ANSWER, TOKEN, OWNER_EMAIL, OWNER_ID, "127.0.0.1")


class RecordingTransport(Transport):
    """Holds each envelope until it is flushed, as a request's events are held until the response.

    ``items`` is everything handed over, held or delivered; ``delivered`` only what a flush sent.
    """

    def __init__(self):
        super().__init__(None)
        self.held = []
        self.delivered = []
        self.flushes = []

    def capture_envelope(self, envelope):
        self.held.extend(envelope.items)

    def flush(self, timeout, callback=None):
        self.flushes.append(timeout)
        self.delivered.extend(self.held)
        self.held.clear()

    @property
    def items(self):
        return self.delivered + self.held

    def events(self):
        return [item.payload.json for item in self.items if item.headers.get("type") == "event"]


def serialised(transport):
    return json.dumps(
        [{"headers": item.headers, "payload": item.payload.json} for item in transport.items]
    )


def assert_sent_no_value(transport):
    """No fixture value is in any item, in any case, and no item says who was signed in."""
    sent = serialised(transport)
    for value in NEVER_SENT:
        assert value.lower() not in sent.lower(), value
    for event in transport.events():
        assert "user" not in event
        assert "request" not in event or set(event["request"]) <= {"method", "url"}


def sdk_importers(root):
    """Each back-end `.py` under ``root`` naming `sentry_sdk`, skipping what is not our code."""
    importers = []
    for directory, subdirectories, files in os.walk(root):
        subdirectories[:] = sorted(
            name for name in subdirectories
            if not name.startswith(".") and name not in ("tests", "venv", "__pycache__")
        )
        for name in sorted(files):
            path = os.path.join(directory, name)
            if name.endswith(".py"):
                with open(path, encoding="utf-8") as module:
                    if "sentry_sdk" in module.read():
                        importers.append(os.path.relpath(path, root))
    return importers


@pytest.fixture(autouse=True)
def a_tracker_not_yet_started():
    """Importing the app started the tracker, with the suite's environment and so no DSN; a second
    start would change nothing, so each test starts from none."""
    ErrorTracking.stop()
    yield
    ErrorTracking.stop()


@pytest.fixture
def tracker():
    transport = RecordingTransport()
    ErrorTracking.start(dsn=FIXTURE_DSN, transport=transport)
    yield transport
    ErrorTracking.stop()
    # Whatever a test did, nothing but events was sent: no Sentry Log, no session, no client report.
    assert {item.headers.get("type") for item in transport.items} <= {"event"}


@pytest.fixture
def client(monkeypatch):
    """Signed in as the market's owner, through the session as in production."""
    monkeypatch.setattr(app_module.login_manager, "session_protection", None)
    sessions_load_through_get_user(monkeypatch)
    monkeypatch.setattr(
        UsersApi, "get_user",
        lambda email: SimpleNamespace(
            id=OWNER_ID, email=email, is_active=True, is_authenticated=True,
            is_anonymous=False, get_id=lambda e=email: e,
        ) if email == OWNER_EMAIL else None,
    )
    monkeypatch.setattr(
        MarketsApi, "markets_collection",
        FakeMarketsCollection(stored_market(phase=MarketPhase.ASSIGNMENT, setupObject=COMPLETE_PLAN)),
    )
    client = app_module.app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = OWNER_EMAIL
        session["_fresh"] = True
    client.set_cookie("fixture_cookie", TOKEN)
    return client


def raising_with_every_value(*args, **_kwargs):
    """A failure deep in a route, holding the vendor's address, an answer and a token in its locals
    and in its message, as a library's error might."""
    vendor_email = ADDRESS
    answer = ANSWER
    token = TOKEN
    raise RuntimeError(f"could not record {answer} for {vendor_email} with {token}: {args!r}")


def a_raise_through_the_payment_route(client):
    return client.post(
        f"/markets/{MARKET_ID}/payments/{ADDRESS}?vendor={ADDRESS}&token={TOKEN}",
        json={"cents": 3500, "method": "e-transfer", "note": ANSWER, "email": ADDRESS},
        headers={"Authorization": f"Bearer {TOKEN}", "X-Fixture": ANSWER},
    )


class TestAnUnexpectedException:
    def test_it_sends_one_event_naming_its_type_and_route_and_no_value(
        self, tracker, client, monkeypatch,
    ):
        monkeypatch.setattr(PaymentsApi, "record_payment", raising_with_every_value)

        response = a_raise_through_the_payment_route(client)

        assert response.status_code == 500
        [event] = tracker.events()
        [exception] = event["exception"]["values"]
        assert exception["type"] == "RuntimeError"
        assert "value" not in exception
        functions = [frame["function"] for frame in exception["stacktrace"]["frames"]]
        assert functions[-1] == "raising_with_every_value"
        assert "record_payment" in functions
        assert event["request"] == {
            "method": "POST", "url": f"/markets/{MARKET_ID}/payments/<path:vendor_email>",
        }
        assert event["transaction"] == "/markets/<market_id>/payments/<path:vendor_email>"
        assert event["tags"] == {"market_id": MARKET_ID}
        assert_sent_no_value(tracker)

    def test_a_frame_carries_no_variable_and_no_source_line(self, tracker, client, monkeypatch):
        monkeypatch.setattr(PaymentsApi, "record_payment", raising_with_every_value)

        a_raise_through_the_payment_route(client)

        [event] = tracker.events()
        for frame in event["exception"]["values"][0]["stacktrace"]["frames"]:
            assert set(frame) <= {"filename", "abs_path", "module", "function", "lineno", "in_app"}

    def test_a_chained_exception_sends_each_type_and_no_message(self, tracker, client, monkeypatch):
        def chained(*_args, **_kwargs):
            try:
                raise KeyError(ADDRESS)
            except KeyError as error:
                raise ValueError(ANSWER) from error

        monkeypatch.setattr(PaymentsApi, "record_payment", chained)

        a_raise_through_the_payment_route(client)

        [event] = tracker.events()
        assert [value["type"] for value in event["exception"]["values"]] == ["KeyError", "ValueError"]
        assert_sent_no_value(tracker)

    def test_the_vendors_address_in_a_longer_route_stays_its_rule(self, tracker, client, monkeypatch):
        monkeypatch.setattr(PaymentsApi, "set_amount_owed", raising_with_every_value)

        response = client.put(
            f"/markets/{MARKET_ID}/payments/{SHOUTED_ADDRESS}/owed/2026-11-14", json={"cents": 0},
        )

        assert response.status_code == 500
        [event] = tracker.events()
        assert event["request"]["url"] == (
            f"/markets/{MARKET_ID}/payments/<path:vendor_email>/owed/<date>"
        )
        assert "2026-11-14" not in serialised(tracker)
        assert_sent_no_value(tracker)

    def test_an_event_is_delivered_before_the_response_within_the_bound(
        self, tracker, client, monkeypatch,
    ):
        monkeypatch.setattr(PaymentsApi, "record_payment", raising_with_every_value)

        a_raise_through_the_payment_route(client)

        assert ErrorTracking.FLUSH_TIMEOUT_SECONDS == 2
        assert tracker.flushes == [ErrorTracking.FLUSH_TIMEOUT_SECONDS]
        assert tracker.held == []
        assert len(tracker.delivered) == 1

    def test_a_client_error_sends_nothing(self, tracker, client):
        response = client.post(f"/markets/{MARKET_ID}/payments/{ADDRESS}", data="not json")

        assert response.status_code == 400
        assert tracker.items == []
        assert tracker.flushes == []


class TestTheHealthCheck:
    def test_an_unreachable_database_is_one_error_event_with_no_message(
        self, tracker, client, monkeypatch,
    ):
        def unreachable(*_args, **_kwargs):
            raise pymongo.errors.ServerSelectionTimeoutError(f"{ADDRESS}:27017: timed out")

        database = SimpleNamespace(command=unreachable)
        monkeypatch.setattr(MarketsApi, "markets_collection", SimpleNamespace(database=database))

        response = client.get("/healthz")

        assert response.status_code == 503
        [event] = tracker.events()
        assert event["level"] == "error"
        assert event["logger"] == "app"
        [exception] = event["exception"]["values"]
        assert exception["type"] == "ServerSelectionTimeoutError"
        assert "value" not in exception
        assert event["logentry"]["formatted"] == "Health check: the database did not answer"
        assert tracker.flushes == [ErrorTracking.FLUSH_TIMEOUT_SECONDS]
        assert_sent_no_value(tracker)

    def test_a_request_with_no_event_never_flushes(self, tracker, client, monkeypatch):
        database = SimpleNamespace(command=lambda *_args, **_kwargs: {"ok": 1})
        monkeypatch.setattr(MarketsApi, "markets_collection", SimpleNamespace(database=database))

        response = client.get("/healthz")

        assert response.status_code == 200
        assert tracker.items == []
        assert tracker.flushes == []


class TestALogLine:
    def test_a_warning_is_an_event_with_every_address_replaced(self, tracker):
        logging.getLogger("payments").warning(
            "Could not tidy the owed days of %s or <%s>", ADDRESS, SHOUTED_ADDRESS,
        )

        [event] = tracker.events()
        assert event["level"] == "warning"
        assert event["logger"] == "payments"
        assert event["logentry"] == {
            "message": "Could not tidy the owed days of %s or <%s>",
            "formatted": "Could not tidy the owed days of [address] or <[address]>",
        }
        assert_sent_no_value(tracker)

    def test_an_address_in_the_words_themselves_is_replaced_too(self, tracker):
        logging.getLogger("history").error(f"Could not record the change {ADDRESS} made")

        [event] = tracker.events()
        assert event["logentry"]["message"] == "Could not record the change [address] made"
        assert_sent_no_value(tracker)

    def test_an_informational_line_is_one_scrubbed_breadcrumb_on_the_next_event(
        self, tracker, caplog,
    ):
        caplog.set_level(logging.INFO)  # the app's own root level, `logging.basicConfig`'s
        logging.getLogger("csv_import").info("Read the export of %s", ADDRESS)
        logging.getLogger("csv_import").error("Skipped an unreadable application")

        [event] = tracker.events()
        [crumb] = event["breadcrumbs"]["values"]
        assert {key: crumb[key] for key in ("type", "category", "level", "message")} == {
            "type": "log", "category": "csv_import", "level": "info",
            "message": "Read the export of [address]",
        }
        assert set(crumb) == {"type", "category", "level", "message", "timestamp"}
        assert_sent_no_value(tracker)

    def test_an_informational_line_alone_sends_nothing(self, tracker, caplog):
        caplog.set_level(logging.INFO)
        logging.getLogger("csv_import").info("Read the export of %s", ADDRESS)

        assert tracker.items == []

    def test_werkzeugs_request_lines_are_never_events(self, tracker):
        logging.getLogger("werkzeug").warning('"GET /markets/%s?vendor=%s" 500', MARKET_ID, ADDRESS)

        assert tracker.items == []

    def test_a_critical_line_is_delivered_when_the_call_returns(self, tracker):
        logging.getLogger("app").critical("Refusing to start: the market keys are not migrated")

        [event] = [item.payload.json for item in tracker.delivered]
        assert event["level"] == "fatal"
        assert event["logentry"]["formatted"] == (
            "Refusing to start: the market keys are not migrated"
        )
        assert tracker.flushes == [ErrorTracking.FLUSH_TIMEOUT_SECONDS]

    def test_a_warning_outside_a_request_is_never_flushed_by_itself(self, tracker):
        logging.getLogger("payments").warning("Could not tidy the owed days")

        assert tracker.flushes == []
        assert len(tracker.held) == 1


class TestWhereAnEventSaysItCameFrom:
    def test_a_deployment_names_its_environment_and_its_commit(self, monkeypatch):
        monkeypatch.setenv("VERCEL_ENV", "production")
        monkeypatch.setenv("BUILD_COMMIT", "0123abc")
        transport = RecordingTransport()
        ErrorTracking.start(dsn=FIXTURE_DSN, transport=transport)
        try:
            logging.getLogger("payments").warning("Could not tidy the owed days")
        finally:
            ErrorTracking.stop()

        [event] = transport.events()
        assert event["environment"] == "production"
        assert event["release"] == "0123abc"
        assert event["sdk"]["name"] == "sentry.python.flask"
        assert set(event) <= {
            "event_id", "timestamp", "platform", "level", "logger", "logentry", "environment",
            "release", "sdk",
        }

    def test_anywhere_else_is_development_with_no_release(self, monkeypatch):
        monkeypatch.delenv("VERCEL_ENV", raising=False)
        monkeypatch.setenv("BUILD_COMMIT", "   ")
        transport = RecordingTransport()
        ErrorTracking.start(dsn=FIXTURE_DSN, transport=transport)
        try:
            logging.getLogger("payments").warning("Could not tidy the owed days")
        finally:
            ErrorTracking.stop()

        [event] = transport.events()
        assert event["environment"] == "development"
        assert "release" not in event


class TestAnotherService:
    def test_a_request_the_back_end_makes_carries_nothing_of_the_tracker(self, tracker, monkeypatch):
        """Resend, Discord, Google and TypeSafe are sent no trace header: the SDK's default attaches
        `sentry-trace` and `baggage`, the release and the environment in it, to every request."""
        monkeypatch.setenv("BUILD_COMMIT", "0123abc")
        received = []

        class Recording(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append({name.lower(): value for name, value in self.headers.items()})
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Recording)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            requests.get(f"http://127.0.0.1:{server.server_port}/", timeout=5)
        finally:
            server.shutdown()
            server.server_close()

        [headers] = received
        assert not {"sentry-trace", "baggage", "traceparent"} & set(headers)


class TestStarting:
    def test_a_second_start_changes_nothing(self, tracker):
        handlers = list(logging.getLogger().handlers)
        second = RecordingTransport()

        ErrorTracking.start(dsn="https://otherkey@sentry.example.com/9", transport=second)
        logging.getLogger("payments").warning("Could not tidy the owed days")

        assert logging.getLogger().handlers == handlers
        assert len(tracker.events()) == 1
        assert second.items == []

    @pytest.mark.parametrize("dsn", ["", "   ", "your-sentry-dsn", "<SENTRY_DSN>"])
    def test_a_blank_or_placeholder_dsn_is_none(self, monkeypatch, dsn):
        monkeypatch.setenv("SENTRY_DSN", dsn)
        handlers = list(logging.getLogger().handlers)
        transport = RecordingTransport()

        ErrorTracking.start(transport=transport)
        try:
            logging.getLogger("payments").warning("Could not tidy the owed days")
            ErrorTracking.report(RuntimeError(ANSWER))
        finally:
            ErrorTracking.stop()

        assert transport.items == []
        assert logging.getLogger().handlers == handlers

    def test_a_malformed_dsn_warns_once_by_its_name_and_tracks_nothing(self, monkeypatch, caplog):
        monkeypatch.setenv("SENTRY_DSN", "https://o1.ingest.us.sentry.io/2")
        handlers = list(logging.getLogger().handlers)
        transport = RecordingTransport()

        with caplog.at_level(logging.WARNING):
            ErrorTracking.start(transport=transport)
        try:
            logging.getLogger("payments").warning("Could not tidy the owed days")
            ErrorTracking.report(RuntimeError(ANSWER))
        finally:
            ErrorTracking.stop()

        [warning] = [record for record in caplog.records if record.name == "error_tracking"]
        assert warning.levelno == logging.WARNING
        assert "SENTRY_DSN" in warning.getMessage()
        assert "BadDsn" in warning.getMessage()
        assert transport.items == []
        assert logging.getLogger().handlers == handlers

    def test_with_no_dsn_the_sdk_is_never_imported(self):
        environment = {key: value for key, value in os.environ.items() if key != "SENTRY_DSN"}
        probe = (
            "import sys, error_tracking, client_errors\n"
            "error_tracking.start()\n"
            "print('sentry_sdk' in sys.modules)\n"
        )

        done = subprocess.run(
            [sys.executable, "-c", probe], cwd=BACK_END_DIR, env=environment,
            capture_output=True, text=True, timeout=60, check=True,
        )

        assert done.stdout.strip() == "False"

    def test_no_other_module_imports_the_sdk(self, tmp_path):
        assert sdk_importers(BACK_END_DIR) == ["error_tracking.py"]

        # A developer's `back-end/venv` (docs/STARTUP.md) holds the SDK itself, and a vendored
        # file need not be UTF-8: neither is the back end's code.
        for skipped in ("venv", ".venv", "tests", "__pycache__"):
            (tmp_path / skipped).mkdir()
            (tmp_path / skipped / "vendored.py").write_bytes(b"import sentry_sdk\n# \xff\n")
        (tmp_path / "error_tracking.py").write_text("import sentry_sdk\n")
        assert sdk_importers(str(tmp_path)) == ["error_tracking.py"]


def test_a_dsn_the_shell_exported_is_gone_before_any_test_runs():
    tests_dir = os.path.join(BACK_END_DIR, "tests")
    probe = (
        f"import os, sys\nsys.path.insert(0, {tests_dir!r})\nimport conftest\n"
        "print('SENTRY_DSN' in os.environ)\n"
    )

    done = subprocess.run(
        [sys.executable, "-c", probe], env={**os.environ, "SENTRY_DSN": FIXTURE_DSN},
        capture_output=True, text=True, timeout=60, check=True,
    )

    assert done.stdout.strip().splitlines()[-1] == "False"
