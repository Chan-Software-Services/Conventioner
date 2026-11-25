"""The back end's errors, sent to Sentry, and never an applicant's data (ADR 0049).

With ``SENTRY_DSN`` set, every unexpected exception (``report``, from ``client_errors``), every
warning and error log line, and every boot refusal becomes one event; an informational log line is
kept as a breadcrumb on the event after it. With no DSN, or a blank or published one
(``configured_secret``), nothing here imports the SDK, and the app runs exactly as it would without
this module: importing it costs Active CPU on every cold start.

Every event is built anew from the ADR's allowlist (``_allowed_event``), never by deleting what the
SDK added, so a field a later SDK adds is dropped until the ADR allows it. An exception is sent by
its qualified type and its frames, never its message; a log line by its words with every address
replaced; a request by its method and its route's rule, with only ``NAMED_VIEW_ARGS`` filled in.

Vercel freezes a function once it has answered, so an event raised in a request is flushed before
the response leaves (``install``), and a boot refusal before its import fails (``_EventHandler``).

The rule, and what each field is: docs/adr/0049-what-may-be-sent-to-the-error-tracker.md; the
module: docs/implementation/modules/error-tracking.md.
"""
import logging
import os
import re
from typing import Any, Dict, List, Optional

from flask import Flask, Response, g, has_request_context, request

from utils.configured_secret import configured_secret

DSN_ENV = "SENTRY_DSN"

# The one list of URL variables an event or a log line may name: each finds the market or the
# organization a failure concerned, and none holds an applicant's value. `client_errors` logs by it.
NAMED_VIEW_ARGS = ("market_id", "market_slug", "org_id")

# How long a request that raised an event waits for it to be sent; past it, the event is lost.
FLUSH_TIMEOUT_SECONDS = 2

# Anything shaped like an address: a run with no space, `@`, `/`, `<`, `>`, quote, comma or
# semicolon, then `@`, then a host with at least one dot. The front end replaces by the same rule.
ADDRESS = re.compile(r"""[^\s@/<>"',;]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+""")
ADDRESS_REPLACEMENT = "[address]"

logger = logging.getLogger(__name__)

# The handler that captures log lines, while tracking is on; `None` before `start` and when off.
_handler: Optional[logging.Handler] = None
_started = False
_release: Optional[str] = None
_environment = "development"


def without_addresses(text: str) -> str:
    return ADDRESS.sub(ADDRESS_REPLACEMENT, text)


def start(dsn: Optional[str] = None, transport: Any = None) -> None:
    """Turn tracking on when ``SENTRY_DSN`` holds a DSN; a second call does nothing.

    ``dsn`` and ``transport`` are the tests' own, in place of the environment's DSN and the SDK's
    transport. A DSN the SDK cannot read logs one warning and leaves tracking off: the DSN is
    optional, so it never stops a boot.
    """
    global _handler, _started, _release, _environment
    if _started:
        return
    _started = True
    dsn = configured_secret(os.environ.get(DSN_ENV, "") if dsn is None else dsn)
    if not dsn:
        return

    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
    from sentry_sdk.integrations.logging import (
        EventHandler,
        LoggingIntegration,
        ignore_logger_for_events,
    )
    from sentry_sdk.utils import BadDsn, Dsn

    try:
        Dsn(dsn)
    except BadDsn as error:
        logger.warning(
            "%s is not a DSN Sentry can read (%s): error tracking is off", DSN_ENV,
            type(error).__name__,
        )
        return

    commit = os.environ.get("BUILD_COMMIT", "").strip()
    _release = commit or None
    _environment = os.environ.get("VERCEL_ENV", "").strip() or "development"

    sentry_sdk.init(
        dsn=dsn,
        transport=transport,
        # Dedupe, excepthook, atexit and the like; never the integrations that switch themselves on
        # for an installed library, pymongo's among them, whose breadcrumbs carry query filters.
        default_integrations=True,
        auto_enabling_integrations=False,
        integrations=[
            FlaskIntegration(),
            # Breadcrumbs only. `level=None` turns Sentry Logs off: at its default, every line from
            # INFO up would be sent as one, the user agent with it. Events come from `_EventHandler`.
            LoggingIntegration(level=None, event_level=None, breadcrumb_level=logging.INFO),
        ],
        data_collection={
            "user_info": False,
            "cookies": {"mode": "off"},
            "http_headers": {"request": {"mode": "off"}},
            "http_bodies": [],
            "url_query_params": {"mode": "off"},
            "database_query_data": False,
            "queues": False,
            "stack_frame_variables": False,
            "frame_context_lines": 0,
        },
        auto_session_tracking=False,
        send_client_reports=False,
        environment=_environment,
        # Never None, which has the SDK guess one from git at boot; `_allowed_event` sends ours.
        release=commit,
        before_send=_before_send,
        before_breadcrumb=_before_breadcrumb,
    )
    # A request line names its path, its query and so an address; a 500 is `report`'s one event.
    ignore_logger_for_events("werkzeug")
    ignore_logger_for_events("client_errors")

    class _FlushingEventHandler(EventHandler):
        """Captures a WARNING line or worse as an event, and sends a CRITICAL one before returning.

        A boot refusal is a CRITICAL line and then a raise at import, after which nothing in the
        process runs. The SDK's own logging hook captures a line only after the logger's handlers
        have run, so a flush in a handler beside it would find nothing queued; capturing here is
        what puts the event in the queue before the flush.
        """

        def emit(self, record: logging.LogRecord) -> Any:
            super().emit(record)
            if record.levelno >= logging.CRITICAL:
                sentry_sdk.flush(timeout=FLUSH_TIMEOUT_SECONDS)

    _handler = _FlushingEventHandler(level=logging.WARNING)
    logging.getLogger().addHandler(_handler)


def install(app: Flask) -> None:
    """Send a request's events before its response leaves; a request with none waits for nothing.

    Flask runs ``after_request`` for an answer an error handler made too, so the 500 that
    ``client_errors`` answers leaves after its event.
    """

    @app.after_request
    def _send_this_requests_events(response: Response) -> Response:
        if _handler is not None and g.get("error_tracked"):
            import sentry_sdk

            sentry_sdk.flush(timeout=FLUSH_TIMEOUT_SECONDS)
        return response


def report(error: BaseException) -> None:
    """Send one exception that escaped a route; nothing when tracking is off."""
    if _handler is None:
        return
    import sentry_sdk

    sentry_sdk.capture_exception(error)


def stop() -> None:
    """For tests only: close the client and forget it, so the next test starts clean."""
    global _handler, _started, _release, _environment
    if _handler is not None:
        import sentry_sdk

        logging.getLogger().removeHandler(_handler)
        sentry_sdk.get_client().close(timeout=0)
        sentry_sdk.get_global_scope().set_client(None)
        for scope in (
            sentry_sdk.get_global_scope(), sentry_sdk.get_isolation_scope(),
            sentry_sdk.get_current_scope(),
        ):
            scope.clear()
    _handler = None
    _started = False
    _release = None
    _environment = "development"


def _before_send(event: Dict[str, Any], _hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if has_request_context():
        g.error_tracked = True
    return _allowed_event(event)


def _before_breadcrumb(crumb: Dict[str, Any], _hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A log line's breadcrumb, its addresses replaced; every other kind, an outgoing request's
    address among them, is dropped."""
    if crumb.get("type") != "log":
        return None
    return _allowed_breadcrumb(crumb)


def _allowed_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """The event the ADR allows, built field by field from what the SDK made."""
    allowed: Dict[str, Any] = {
        key: event[key] for key in ("event_id", "timestamp", "platform") if key in event
    }
    if event.get("level") in ("debug", "info", "warning", "error", "fatal"):
        allowed["level"] = event["level"]
    if isinstance(event.get("logger"), str):
        allowed["logger"] = event["logger"]
    entry = event.get("logentry")
    if isinstance(entry, dict):
        allowed["logentry"] = {
            key: without_addresses(str(entry[key]))
            for key in ("message", "formatted") if entry.get(key) is not None
        }
    exceptions = (event.get("exception") or {}).get("values")
    if exceptions:
        allowed["exception"] = {"values": [_allowed_exception(value) for value in exceptions]}
    crumbs = (event.get("breadcrumbs") or {}).get("values")
    if crumbs:
        allowed["breadcrumbs"] = {
            "values": [_allowed_breadcrumb(crumb) for crumb in crumbs if crumb.get("type") == "log"]
        }
    if has_request_context() and request.url_rule is not None:
        named = {
            name: str(request.view_args[name])
            for name in NAMED_VIEW_ARGS
            if request.view_args and name in request.view_args
        }
        allowed["request"] = {"method": request.method, "url": _filled_rule(request.url_rule.rule, named)}
        allowed["transaction"] = request.url_rule.rule
        if named:
            allowed["tags"] = named
    allowed["environment"] = _environment
    if _release:
        allowed["release"] = _release
    sdk = event.get("sdk") or {}
    allowed["sdk"] = {key: sdk[key] for key in ("name", "version") if key in sdk}
    return allowed


_FRAME_FIELDS = ("filename", "abs_path", "module", "function", "lineno", "in_app")


def _allowed_exception(value: Dict[str, Any]) -> Dict[str, Any]:
    """An exception by its type, its module and its frames; never its value, which is its message."""
    allowed = {key: value[key] for key in ("type", "module") if value.get(key) is not None}
    frames: List[Dict[str, Any]] = (value.get("stacktrace") or {}).get("frames") or []
    allowed["stacktrace"] = {
        "frames": [{key: frame[key] for key in _FRAME_FIELDS if key in frame} for frame in frames]
    }
    return allowed


def _allowed_breadcrumb(crumb: Dict[str, Any]) -> Dict[str, Any]:
    allowed = {key: crumb[key] for key in ("type", "category", "level", "timestamp") if key in crumb}
    allowed["message"] = without_addresses(str(crumb.get("message") or ""))
    return allowed


def _filled_rule(rule: str, named: Dict[str, str]) -> str:
    """The route's rule with each named variable's value in its place, and every other variable
    left as the rule writes it, `<path:vendor_email>`."""

    def fill(match: "re.Match[str]") -> str:
        return named.get(match.group(1), match.group(0))

    return re.sub(r"<(?:[^:<>]+:)?([^:<>]+)>", fill, rule)
