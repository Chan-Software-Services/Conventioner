"""A vendor's code request asks the human check (T539).

Every request for a vendor's sign-in code carries a token from the human check, made for the
``vendor-sign-in`` action, and the server checks it right after the caller's limit and before
anything else is counted, stored or sent. A request whose token is absent, refused or made for
another action answers one 403, the same for every address and every market, real or not: it mails
nothing, stores no challenge and counts no address, and still counts against the caller.

Driven at the route a browser posts to, with Cloudflare's siteverify stood in for by a fake
``requests.post``, so the real check runs (``real_human_check``).
"""
from datetime import datetime, timezone

import pytest

import api.applicant_auth as ApplicantAuthApi
import api.applications as ApplicationsApi
import app as app_module
import sign_in_limits
import utils.captcha as captcha
from market_documents import market_name_slug
from test_applicant_auth import FakeDatabase, _application_doc, _published_market_doc
from utils.captcha import TURNSTILE_SECRET_KEY_VAR
from utils.deployment import INSECURE_LOCAL_DEV_VAR

pytestmark = pytest.mark.real_human_check

SLUG = market_name_slug("Test Market")
CALLER = "203.0.113.40"
APPLICANT = "applicant@example.com"
STRANGER = "never-applied@example.com"

PASSING = "a-passing-token"
REFUSED = "a-refused-token"
FOR_SIGN_UP = "a-sign-up-token"

ASKED = {"message": "Confirm you're a person, then try again.", "captcha": "required"}
SENT = {"message": "We've sent a code to this address."}


class FakeAnswer:
    def __init__(self, body):
        self.status_code = 200
        self._body = body

    def json(self):
        return self._body


class Cloudflare:
    """Cloudflare's siteverify: a token it made for an action passes for it, any other is refused."""

    ANSWERS = {
        PASSING: {"success": True, "action": "vendor-sign-in"},
        FOR_SIGN_UP: {"success": True, "action": "sign-up"},
    }

    def __init__(self):
        self.tokens = []

    def post(self, url, data=None, timeout=None, **_kwargs):
        assert url == captcha.SITEVERIFY_URL
        self.tokens.append(data["response"])
        return FakeAnswer(self.ANSWERS.get(
            data["response"], {"success": False, "error-codes": ["invalid-input-response"]}))


@pytest.fixture
def cloudflare(monkeypatch):
    monkeypatch.delenv(INSECURE_LOCAL_DEV_VAR, raising=False)
    monkeypatch.delenv("DISABLE_CAPTCHA", raising=False)
    monkeypatch.setenv(TURNSTILE_SECRET_KEY_VAR, "fixture-turnstile-secret")
    fake = Cloudflare()
    monkeypatch.setattr(captcha.requests, "post", fake.post)
    return fake


@pytest.fixture
def market_db(monkeypatch):
    """A published form market with one applicant, and the challenges the sign-in stores."""
    db = FakeDatabase(markets=[_published_market_doc()], applications=[_application_doc()])
    monkeypatch.setattr(ApplicantAuthApi, "db", db)
    monkeypatch.setattr(ApplicantAuthApi, "challenges_collection", db["applicant_login_challenges"])
    monkeypatch.setattr(ApplicationsApi, "applications_collection", db["applications"])
    return db


@pytest.fixture
def mail(monkeypatch):
    """Every code mail sent, by its address."""
    sent = []
    monkeypatch.setattr(ApplicantAuthApi, "_send_code_email",
                        lambda email, *_rest: sent.append(email) or True)
    return sent


@pytest.fixture
def client():
    return app_module.app.test_client()


def _request_code(client, email=APPLICANT, slug=SLUG, token=None):
    body = {"email": email}
    if token is not None:
        body["captcha_token"] = token
    return client.post(f"/public/markets/{slug}/applicant-login/request-code", json=body,
                       environ_base={"REMOTE_ADDR": CALLER})


def _counter_key(limit, subject):
    key, _ = sign_in_limits._window(limit, subject, datetime.now(timezone.utc))
    return key


class TestARequestWithoutAPassingCheckSendsNothing:
    @pytest.mark.parametrize("token", [None, "", REFUSED, FOR_SIGN_UP],
                             ids=["no token", "an empty token", "a refused token",
                                  "a token for another action"])
    def test_it_is_asked_to_pass_the_check_and_nothing_is_mailed_stored_or_counted_but_the_caller(
        self, client, cloudflare, market_db, mail, sign_in_attempts, token,
    ):
        response = _request_code(client, token=token)

        assert response.status_code == 403
        assert response.get_json() == ASKED
        assert mail == []
        assert market_db.challenges.docs == {}
        assert list(sign_in_attempts.docs) == [
            _counter_key(sign_in_limits.REQUEST_CODE_PER_CALLER, CALLER)]
        assert sign_in_attempts.docs[
            _counter_key(sign_in_limits.REQUEST_CODE_PER_CALLER, CALLER)]["count"] == 1

    def test_the_answer_is_the_same_for_every_address_and_every_market(
        self, client, cloudflare, market_db, mail,
    ):
        answers = {
            (response.status_code, response.get_data())
            for response in (
                _request_code(client, email=APPLICANT),
                _request_code(client, email=STRANGER),
                _request_code(client, email=APPLICANT, slug="no-such-market"),
                _request_code(client, email=STRANGER, slug="no-such-market", token=REFUSED),
                _request_code(client, email="not-an-address"),
            )
        }

        assert answers == {(403, _request_code(client).get_data())}
        assert mail == []

    def test_the_check_is_asked_for_the_vendors_sign_in(self, client, cloudflare, market_db, mail):
        assert _request_code(client, token=PASSING).status_code == 200
        assert cloudflare.tokens == [PASSING]


class TestARequestWithAPassingCheckMailsAsBefore:
    def test_the_code_is_mailed_and_its_challenge_stored(
        self, client, cloudflare, market_db, mail,
    ):
        response = _request_code(client, token=PASSING)

        assert response.status_code == 200
        assert response.get_json() == SENT
        assert mail == [APPLICANT]
        assert market_db.challenges.find_one({"email": APPLICANT}) is not None

    def test_a_known_and_an_unknown_address_and_an_absent_market_answer_alike(
        self, client, cloudflare, market_db, mail,
    ):
        answers = {
            (response.status_code, response.get_data())
            for response in (
                _request_code(client, email=APPLICANT, token=PASSING),
                _request_code(client, email=STRANGER, token=PASSING),
                _request_code(client, email=STRANGER, slug="no-such-market", token=PASSING),
            )
        }

        assert len(answers) == 1
        assert mail == [APPLICANT, STRANGER]


class TestTheLocalStack:
    """The local stack passes the front end's placeholder token and still refuses a request that
    sends none, so a screen that forgets the token fails there as it would in production."""

    @pytest.fixture
    def local_stack(self, monkeypatch):
        monkeypatch.setenv(INSECURE_LOCAL_DEV_VAR, "true")
        monkeypatch.setenv("DISABLE_CAPTCHA", "true")

        def never_posted(*_args, **_kwargs):
            raise AssertionError("the local stack never calls Cloudflare")

        monkeypatch.setattr(captcha.requests, "post", never_posted)

    def test_the_placeholder_passes(self, client, local_stack, market_db, mail):
        response = _request_code(client, token="e2e-test-captcha-token")

        assert response.status_code == 200
        assert mail == [APPLICANT]

    def test_no_token_is_refused(self, client, local_stack, market_db, mail):
        response = _request_code(client)

        assert response.status_code == 403
        assert response.get_json() == ASKED
        assert mail == []
