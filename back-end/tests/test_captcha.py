"""The human check on the server (``utils.captcha``): Cloudflare Turnstile's siteverify, driven as a
route drives it, with Cloudflare stood in for by a fake ``requests.post``.

Every test but those of a module marked ``real_human_check`` runs with the ``human_check`` stand-in
from ``conftest.py``; this module is marked, so it meets the real function.
"""

import logging
import os
import sys

import pytest
import requests

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

import utils.captcha as captcha
from utils.captcha import (
    SITEVERIFY_URL,
    TURNSTILE_SECRET_KEY_VAR,
    CaptchaNotConfiguredError,
    assert_captcha_configured,
    captcha_passes,
    human_check_needed,
)
from utils.deployment import INSECURE_LOCAL_DEV_VAR

pytestmark = pytest.mark.real_human_check

SECRET = "fixture-turnstile-secret"
TOKEN = "fixture-turnstile-token-value"
CALLER = "203.0.113.9"
ADDRESS = "stranger.vendor@example.com"

#: Cloudflare's published test secrets: always passes, always fails, always "token already spent".
CLOUDFLARE_TEST_SECRETS = (
    "1x0000000000000000000000000000000AA",
    "2x0000000000000000000000000000000AA",
    "3x0000000000000000000000000000000AA",
)


@pytest.fixture(autouse=True)
def no_secret(monkeypatch):
    """A process holding no Turnstile secret and no bypass, unless the test says otherwise.

    The environment, because that is what the module reads, on every call: a real key in a
    developer's shell cannot decide what this file tests.
    """
    monkeypatch.delenv(TURNSTILE_SECRET_KEY_VAR, raising=False)
    monkeypatch.delenv("RECAPTCHA_SECRET_KEY", raising=False)
    monkeypatch.delenv("DISABLE_CAPTCHA", raising=False)


@pytest.fixture
def local_dev(monkeypatch):
    """A process that has said, explicitly, that it is a local development one."""
    monkeypatch.setenv(INSECURE_LOCAL_DEV_VAR, "true")


@pytest.fixture
def deployed(monkeypatch):
    """Anything that has not said so, which is every deployment, and the default."""
    monkeypatch.delenv(INSECURE_LOCAL_DEV_VAR, raising=False)


class FakeAnswer:
    def __init__(self, status_code=200, body=None, text=None):
        self.status_code = status_code
        self._body = body
        self._text = text

    def json(self):
        if self._text is not None:
            raise requests.JSONDecodeError("Expecting value", self._text, 0)
        return self._body


@pytest.fixture
def cloudflare(monkeypatch, deployed):
    """Cloudflare's siteverify, answering what the test sets, and every post it was sent."""

    class Cloudflare:
        def __init__(self):
            self.posts = []
            self.answer = FakeAnswer(body={"success": True, "action": "sign-up"})
            self.raises = None

        def post(self, url, data=None, timeout=None, **_kwargs):
            self.posts.append({"url": url, "data": dict(data), "timeout": timeout})
            if self.raises is not None:
                raise self.raises
            return self.answer

    fake = Cloudflare()
    monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, SECRET)
    monkeypatch.setattr(captcha.requests, "post", fake.post)
    return fake


@pytest.fixture
def a_request():
    """A request the caller sent, with its address as ProxyFix settled it."""
    app = Flask(__name__)
    with app.test_request_context("/register", environ_base={"REMOTE_ADDR": CALLER}):
        yield


class TestTheCheckAsksCloudflare:
    def test_it_posts_the_secret_the_token_and_the_callers_address(self, cloudflare, a_request):
        assert captcha_passes(TOKEN, "sign-up") is True

        [post] = cloudflare.posts
        assert post == {
            "url": "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            "data": {"secret": SECRET, "response": TOKEN, "remoteip": CALLER},
            "timeout": 3,
        }
        assert SITEVERIFY_URL == post["url"]

    def test_outside_a_request_it_sends_no_address(self, cloudflare):
        assert captcha_passes(TOKEN, "sign-up") is True

        [post] = cloudflare.posts
        assert "remoteip" not in post["data"]

    @pytest.mark.parametrize("action", ["sign-up", "sign-in", "vendor-sign-in"])
    def test_it_passes_a_token_carrying_the_action_asked(self, cloudflare, action):
        cloudflare.answer = FakeAnswer(body={"success": True, "action": action})

        assert captcha_passes(TOKEN, action) is True

    @pytest.mark.parametrize("answered", [
        {"success": True, "action": "sign-in"},
        {"success": True, "action": ""},
        {"success": True},
    ], ids=["another action", "an empty action", "no action"])
    def test_a_token_made_for_another_action_is_refused(self, cloudflare, answered):
        cloudflare.answer = FakeAnswer(body=answered)

        assert captcha_passes(TOKEN, "sign-up") is False

    @pytest.mark.parametrize("codes", [
        ["invalid-input-response"],
        ["timeout-or-duplicate"],
        ["invalid-input-secret"],
        [],
    ])
    def test_a_token_cloudflare_did_not_pass_is_refused(self, cloudflare, codes):
        cloudflare.answer = FakeAnswer(
            body={"success": False, "error-codes": codes, "action": "sign-up"})

        assert captcha_passes(TOKEN, "sign-up") is False

    @pytest.mark.parametrize("token", ["", None])
    def test_no_token_is_refused_without_asking(self, cloudflare, token):
        assert captcha_passes(token, "sign-up") is False
        assert cloudflare.posts == []

    def test_a_token_longer_than_cloudflares_maximum_is_refused_without_asking(self, cloudflare):
        # Only a token Cloudflare could have issued is sent, even while it cannot be reached.
        cloudflare.raises = requests.ConnectionError("connection reset")

        assert captcha_passes("t" * 2049, "sign-up") is False
        assert cloudflare.posts == []

    def test_a_token_of_cloudflares_maximum_length_is_asked(self, cloudflare):
        assert captcha_passes("t" * 2048, "sign-up") is True
        [post] = cloudflare.posts
        assert post["data"]["response"] == "t" * 2048

    def test_a_4xx_answer_is_a_refusal(self, cloudflare):
        cloudflare.answer = FakeAnswer(
            status_code=400, body={"success": False, "error-codes": ["bad-request"]})

        assert captcha_passes(TOKEN, "sign-up") is False


class TestAnUnreachableCheckLetsTheRequestThrough:
    """When the server cannot reach Cloudflare, the request goes on under the sign-in limits, and
    one warning names the kind of outage, never the token, the caller or Cloudflare's words."""

    @pytest.mark.parametrize("failure, kind", [
        (requests.Timeout("timed out reaching for " + TOKEN), "Timeout"),
        (requests.ConnectTimeout("connect timed out for " + ADDRESS), "ConnectTimeout"),
        (requests.ConnectionError("no route for " + CALLER), "ConnectionError"),
    ], ids=["timeout", "connect timeout", "connection error"])
    def test_a_request_that_does_not_complete(
        self, cloudflare, a_request, caplog, capsys, failure, kind,
    ):
        cloudflare.raises = failure

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is True

        self._one_warning_naming(kind, caplog, capsys)

    @pytest.mark.parametrize("status", [500, 502, 503])
    def test_a_server_error(self, cloudflare, a_request, caplog, capsys, status):
        cloudflare.answer = FakeAnswer(
            status_code=status, body={"success": False, "error-codes": ["internal-error"]})

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is True

        self._one_warning_naming(f"HTTP {status}", caplog, capsys)

    @pytest.mark.parametrize("answer", [
        FakeAnswer(text=f"<html>{ADDRESS}</html>"),
        FakeAnswer(body=["success", True]),
    ], ids=["not JSON", "not an object"])
    def test_a_body_that_cannot_be_read(self, cloudflare, a_request, caplog, capsys, answer):
        cloudflare.answer = answer

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is True

        self._one_warning_naming("not JSON", caplog, capsys)

    def test_cloudflares_internal_error(self, cloudflare, a_request, caplog, capsys):
        cloudflare.answer = FakeAnswer(
            body={"success": False, "error-codes": ["internal-error"], "messages": [ADDRESS]})

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is True

        self._one_warning_naming("internal-error", caplog, capsys)

    def test_an_error_that_is_not_the_network_refuses(self, cloudflare, caplog):
        cloudflare.raises = RuntimeError(f"a bug holding {TOKEN}")

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is False

        [record] = caplog.records
        assert record.levelno == logging.ERROR
        assert "RuntimeError" in record.getMessage()
        assert TOKEN not in caplog.text

    @staticmethod
    def _one_warning_naming(kind, caplog, capsys):
        [record] = caplog.records
        assert record.levelno == logging.WARNING
        assert record.getMessage() == (
            f"The human check could not be reached ({kind}); let through under the sign-in limits")
        assert record.exc_info is None
        for kept_out in (TOKEN, CALLER, ADDRESS, SECRET):
            assert kept_out not in caplog.text
        assert capsys.readouterr() == ("", "")


class TestARefusalIsLoggedWithoutTheCaller:
    def test_a_refused_token_leaves_nothing_of_the_caller_in_the_log(
        self, cloudflare, a_request, caplog, capsys,
    ):
        cloudflare.answer = FakeAnswer(body={
            "success": False, "error-codes": ["invalid-input-response"],
            "hostname": "elsewhere.test", "action": ADDRESS,
        })

        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is False

        for kept_out in (TOKEN, CALLER, ADDRESS, SECRET, "elsewhere.test"):
            assert kept_out not in caplog.text
        assert capsys.readouterr() == ("", "")

    def test_an_unusable_secret_names_the_variable(self, deployed, caplog, capsys):
        with caplog.at_level(logging.DEBUG, logger="utils.captcha"):
            assert captcha_passes(TOKEN, "sign-up") is False

        [record] = caplog.records
        assert record.levelno == logging.ERROR
        assert TURNSTILE_SECRET_KEY_VAR in record.getMessage()
        assert TOKEN not in caplog.text
        assert capsys.readouterr() == ("", "")


class TestTheLocalStack:
    """The local stack signs up with the front end's placeholder token, and a screen that forgets
    the token fails there as it would in production."""

    @pytest.mark.parametrize("switch", ["true", "1"])
    def test_disable_captcha_passes_any_token(self, monkeypatch, local_dev, switch):
        monkeypatch.setenv("DISABLE_CAPTCHA", switch)
        monkeypatch.setattr(captcha.requests, "post", _never_posted)

        assert captcha_passes("e2e-test-captcha-token", "vendor-sign-in") is True

    @pytest.mark.parametrize("token", ["", None])
    def test_disable_captcha_still_refuses_no_token(self, monkeypatch, local_dev, token):
        monkeypatch.setenv("DISABLE_CAPTCHA", "true")
        monkeypatch.setattr(captcha.requests, "post", _never_posted)

        assert captcha_passes(token, "sign-up") is False

    def test_a_local_machine_with_no_secret_passes_a_token(self, monkeypatch, local_dev):
        monkeypatch.setattr(captcha.requests, "post", _never_posted)

        assert captcha_passes(TOKEN, "sign-up") is True
        assert captcha_passes("", "sign-up") is False

    def test_disable_captcha_is_ignored_by_anything_that_is_not_local_dev(
        self, monkeypatch, cloudflare,
    ):
        """A deployment that inherited DISABLE_CAPTCHA from a copied .env has no live bypass on it."""
        monkeypatch.setenv("DISABLE_CAPTCHA", "true")
        cloudflare.answer = FakeAnswer(body={"success": False, "error-codes": []})

        assert captcha_passes(TOKEN, "sign-up") is False
        assert len(cloudflare.posts) == 1

    def test_a_deployment_with_no_secret_refuses(self, monkeypatch, deployed):
        """Belt and braces for an entrypoint that skipped the boot check."""
        monkeypatch.setenv("DISABLE_CAPTCHA", "true")
        monkeypatch.setattr(captcha.requests, "post", _never_posted)

        assert captcha_passes(TOKEN, "sign-up") is False


class TestTheBootCheck:
    def test_boot_refuses_when_the_secret_is_missing(self, deployed):
        with pytest.raises(CaptchaNotConfiguredError) as exc:
            assert_captcha_configured()

        assert TURNSTILE_SECRET_KEY_VAR in str(exc.value)
        assert INSECURE_LOCAL_DEV_VAR in str(exc.value)
        assert "dash.cloudflare.com" in str(exc.value)

    @pytest.mark.parametrize("flask_env", ["development", "production", ""])
    def test_the_refusal_does_not_depend_on_flask_env(self, monkeypatch, deployed, flask_env):
        monkeypatch.setenv("FLASK_ENV", flask_env)

        with pytest.raises(CaptchaNotConfiguredError):
            assert_captcha_configured()

    def test_boot_is_allowed_once_the_secret_is_set(self, monkeypatch, deployed):
        monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, SECRET)

        assert_captcha_configured()

    def test_the_old_recaptcha_secret_is_no_longer_read(self, monkeypatch, deployed):
        monkeypatch.setenv("RECAPTCHA_SECRET_KEY", "prod-recaptcha-secret")

        with pytest.raises(CaptchaNotConfiguredError) as exc:
            assert_captcha_configured()

        assert TURNSTILE_SECRET_KEY_VAR in str(exc.value)

    def test_an_opted_in_local_dev_machine_still_boots_without_a_secret(self, local_dev):
        assert_captcha_configured()

    def test_a_blank_secret_is_no_secret(self, monkeypatch, deployed):
        monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, "   ")

        with pytest.raises(CaptchaNotConfiguredError):
            assert_captcha_configured()


class TestATestSecretIsNotASecret:
    """Cloudflare publishes secrets that pass, or fail, every token. A deployment holding one checks
    nothing, so each is refused at boot, hatch or not, and no token is ever sent against one."""

    @pytest.mark.parametrize("secret", CLOUDFLARE_TEST_SECRETS)
    def test_boot_refuses_it(self, monkeypatch, deployed, secret):
        monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, secret)

        with pytest.raises(CaptchaNotConfiguredError) as exc:
            assert_captcha_configured()

        assert TURNSTILE_SECRET_KEY_VAR in str(exc.value)
        assert "test secret" in str(exc.value)

    @pytest.mark.parametrize("secret", CLOUDFLARE_TEST_SECRETS)
    def test_a_local_dev_machine_is_refused_it_too(self, monkeypatch, local_dev, secret):
        monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, secret)

        with pytest.raises(CaptchaNotConfiguredError):
            assert_captcha_configured()

    @pytest.mark.parametrize("secret", CLOUDFLARE_TEST_SECRETS)
    def test_no_token_is_ever_checked_against_it(self, monkeypatch, deployed, secret):
        monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, secret)
        monkeypatch.setattr(captcha.requests, "post", _never_posted)

        assert captcha_passes(TOKEN, "sign-up") is False


class TestTheAnswerWhenTheCheckIsNeeded:
    @pytest.mark.parametrize("key", ["message", "msg"])
    def test_it_is_one_403_under_the_routes_key(self, key):
        app = Flask(__name__)
        with app.test_request_context("/"):
            body, status = human_check_needed(key)

            assert status == 403
            assert body.get_json() == {
                key: "Confirm you're a person, then try again.", "captcha": "required"}


def _never_posted(*_args, **_kwargs):
    raise AssertionError("no token may be sent to Cloudflare here")
