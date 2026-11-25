"""The human check: whether a person, not a script, is asking, checked with Cloudflare Turnstile.

The routes that ask it (organizer sign-up, and the sign-ins and code requests that come to ask it)
call one function, ``captcha_passes(token, action)``. A token passes only when Cloudflare's
siteverify says ``success`` and the token was made for the action the route asks, so a token made
on one form cannot be spent on another. When a check is needed and not passed, the route answers
``human_check_needed(key)``: one 403 for an absent token, a refused one and a mismatched action
alike, the same for every address and every market.

When the server cannot reach Cloudflare (a timeout, a connection error, a 5xx, a body that is not
JSON, or Cloudflare's own ``internal-error``) the request is let through, and one warning names the
kind of outage and nothing else. The sign-in limits still stand in front of every route that asks
the check, so an outage of a third party never closes the door, and never opens it past its bounds.

The bypasses below exist so a developer can run the stack without Cloudflare keys, and every one of
them is scoped to a process that has explicitly said it is a local development one. A check that
disappears when it is not configured is not a control: the routes it guards are public and
unauthenticated, and they write to the database and send mail from this domain, so a deployment
with no secret would serve them unchecked and say nothing about it. Anything that is not an
opted-in local dev process therefore refuses: at boot, through ``assert_captcha_configured``, so the
refusal names the variable, and again here, so no caller reaches a check this process cannot
actually perform. Even under the hatch, a request with no token is refused, so a screen that
forgets to send one fails on the local stack and in E2E, not in production.

The escape hatch is ``ALLOW_INSECURE_LOCAL_DEV`` and nothing else. It is deliberately *not*
``FLASK_ENV``: see ``utils.deployment``.

The secret is read from the environment on every call, never captured into a module global at
import. A module that reads its key once, on the way up, is a module whose answer depends on when it
happened to be imported: it makes the boot check a function of import order rather than of the
environment, it ignores anything ``load_dotenv`` put there afterwards, and it leaves the tests
patching a module attribute. ``utils.secret_key`` reads on call; so does this, and so does
``utils.email``.
"""

import logging
import os
from typing import Optional

import requests
from flask import has_request_context, jsonify, request

from utils.configured_secret import configured_secret, is_published
from utils.deployment import (
    INSECURE_LOCAL_DEV_VAR,
    insecure_local_dev,
    switch_on,
    warn_insecure_local_dev,
)

TURNSTILE_SECRET_KEY_VAR = "TURNSTILE_SECRET_KEY"
SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TURNSTILE_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/turnstile"
#: How long a check waits on Cloudflare before it lets the request through.
SITEVERIFY_TIMEOUT_SECONDS = 3
#: The longest token Cloudflare issues (its server-side validation docs). A longer one is no
#: Turnstile token, and is refused unsent, since a post that does not complete lets a request
#: through.
MAX_TOKEN_LENGTH = 2048

#: The actions a route asks, each the ``action`` its form's widget is rendered with.
SIGN_UP = "sign-up"
SIGN_IN = "sign-in"
VENDOR_SIGN_IN = "vendor-sign-in"

#: What a route answers when the check is needed and not passed.
HUMAN_CHECK_NEEDED = "Confirm you're a person, then try again."

logger = logging.getLogger(__name__)


class CaptchaNotConfiguredError(RuntimeError):
    """There is no Turnstile secret, so the human check would check nothing."""


def configured_value() -> str:
    """What ``TURNSTILE_SECRET_KEY`` holds right now, whatever it holds."""
    return os.getenv(TURNSTILE_SECRET_KEY_VAR, "")


def verifiable_secret() -> str:
    """The secret a token can actually be checked against, or ``""`` when there is not one.

    A blank value is not a secret, and neither is a placeholder this repository has published or one
    of Cloudflare's published test secrets, which pass or fail every token whoever sent it. Boot and
    request time both ask this one question, so the check cannot pass on a value the request path
    then cannot use.
    """
    return configured_secret(configured_value())


def assert_captcha_configured() -> None:
    """Refuse to serve the routes that ask the human check without a secret to check against.

    Raises:
        CaptchaNotConfiguredError: when no secret is configured and this is not an opted-in
            local development process, or when the configured value is a placeholder or a
            published test secret, which holds everywhere, escape hatch or not, the same way it
            does for the signing key.
    """
    if is_published(configured_value()):
        raise CaptchaNotConfiguredError(
            f"{TURNSTILE_SECRET_KEY_VAR} is set to a placeholder this repository has printed or to "
            f"one of Cloudflare's published test secrets, not to a secret. A test secret answers "
            f"the same for every token whoever sent it, and a placeholder is a key Cloudflare never "
            f"issued, so the human check this variable exists to hold up would check nothing. A "
            f"truthy placeholder is worse than a blank, because a check that asks only whether the "
            f"variable is set takes it for a configured secret. Set the secret of a Turnstile "
            f"widget for this hostname ({TURNSTILE_DASHBOARD}), or clear the variable and set "
            f"{INSECURE_LOCAL_DEV_VAR}=true (with DISABLE_CAPTCHA=true) if this is a local "
            f"development machine."
        )
    if verifiable_secret():
        return
    if insecure_local_dev():
        warn_insecure_local_dev("the human check")
        return
    raise CaptchaNotConfiguredError(
        f"{TURNSTILE_SECRET_KEY_VAR} is not set. Organizer sign-up and the vendor's code request ask "
        f"the human check (Cloudflare Turnstile), and without a secret there is nothing to check a "
        f"token against, so the check would pass every caller, on routes that write to the "
        f"database and send mail from this domain. "
        f"Set {TURNSTILE_SECRET_KEY_VAR} to the secret of a Turnstile widget for this hostname "
        f"({TURNSTILE_DASHBOARD}), or set {INSECURE_LOCAL_DEV_VAR}=true if this really is a local "
        f"development machine."
    )


def human_check_needed(key: str):
    """The 403 a route answers when the human check is needed and not passed, under ``key``, the
    key the route's other answers use (``message`` or ``msg``)."""
    return jsonify({key: HUMAN_CHECK_NEEDED, "captcha": "required"}), 403


def captcha_passes(token: Optional[str], action: str) -> bool:
    """Whether ``token`` passes the human check for ``action``.

    Args:
        token: the widget's token, as the request's ``captcha_token`` carried it.
        action: the action the route asks, which the token must have been made for.

    Returns:
        True on Cloudflare's ``success`` with ``action``, or when Cloudflare cannot be reached;
        False for anything else, an absent token among them.
    """
    if not token:
        return False

    # Explicit test-mode bypass: DISABLE_CAPTCHA passes any token. Honored only by a process that
    # has opted in to being a local development one, so it cannot be a live bypass on a deployment
    # that merely forgot to unset it.
    if insecure_local_dev() and switch_on("DISABLE_CAPTCHA"):
        warn_insecure_local_dev("the human check (DISABLE_CAPTCHA)")
        return True

    secret = verifiable_secret()
    if not secret:
        if not insecure_local_dev():
            # Unreachable through app.py, which refuses to boot in this state. Reached only by an
            # entrypoint that skipped that check, and an unchecked token is not a checked one.
            # The variable's name is written into the words, never passed as an argument: CodeQL
            # reads an argument named for a secret as the secret itself.
            logger.error("TURNSTILE_SECRET_KEY is not a usable secret, refusing the request")
            return False
        warn_insecure_local_dev("the human check (no secret configured)")
        return True

    if len(token) > MAX_TOKEN_LENGTH:
        logger.info("The human check refused a token longer than Cloudflare issues")
        return False

    data = {"secret": secret, "response": token}
    caller = _caller_address()
    if caller:
        data["remoteip"] = caller

    try:
        answer = requests.post(SITEVERIFY_URL, data=data, timeout=SITEVERIFY_TIMEOUT_SECONDS)
    except requests.RequestException as e:
        # The request did not complete. By its type alone: a requests error's message can quote
        # what it was sent.
        return _let_through(type(e).__name__)
    except Exception as e:
        logger.error("The human check failed: %s", type(e).__name__)
        return False

    if answer.status_code >= 500:
        return _let_through(f"HTTP {answer.status_code}")
    try:
        result = answer.json()
    except ValueError:
        return _let_through("not JSON")
    if not isinstance(result, dict):
        return _let_through("not JSON")

    codes = result.get("error-codes") or []
    if isinstance(codes, list) and "internal-error" in codes:
        return _let_through("internal-error")

    if result.get("success") is not True:
        # Cloudflare's codes and words stay out of the log: only that it refused.
        logger.info("The human check refused a token")
        return False
    if result.get("action") != action:
        logger.info("The human check refused a token made for another action")
        return False
    return True


def _caller_address() -> Optional[str]:
    """The caller's address as ProxyFix settled it, when there is a request to read it from."""
    if not has_request_context():
        return None
    return request.remote_addr or None


def _let_through(kind: str) -> bool:
    """Let a request through that could not be checked, saying only what kind of outage it was."""
    logger.warning(
        "The human check could not be reached (%s); let through under the sign-in limits", kind)
    return True
