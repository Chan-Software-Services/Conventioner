"""A request that mails a code or a link counts per caller and address, and per address by the hour.

Five requests that mail, the vendor's code request and the organizer's code, reset link,
verification link and sign-up, are each counted twice before anything is looked up or mailed:
per caller and address together (5 in 15 minutes), so one caller's requests for an address leave
every other caller's requests for it as they were, and per address alone (20 in an hour), so one
inbox's mail stays bounded whoever asks. A request the pair refused is not counted on the address.

Driven at the routes a browser posts to, from callers named by ``REMOTE_ADDR``, on a clock held at
the start of an hour (``sign_in_limits``' windows are aligned to the clock).
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import account_secrets
import api.applicant_auth as ApplicantAuthApi
import api.applications as ApplicationsApi
import api.users as UsersApi
import app as app_module
from market_documents import market_name_slug
from test_applicant_auth import FakeDatabase, _application_doc, _published_market_doc
from test_the_organizer_sign_in_is_bounded import (  # noqa: F401  (the fixtures)
    ACCOUNT_EMAIL, FAST_ROUNDS, NO_ACCOUNT_EMAIL, PASSWORD, UNVERIFIED_EMAIL, MailingUsers,
    _account, _answer, client, fast_stand_in_hash,
)

# The start of an hour, so the hour's window and its first quarter start together.
HOUR_STARTS = datetime(2026, 11, 9, 12, 0, 0, tzinfo=timezone.utc)

VENDOR_ADDRESS = "applicant@example.com"
SLUG = market_name_slug("Test Market")

CALLER_A = "198.51.100.1"
CALLER_B = "198.51.100.2"


class Asked:
    """One request that mails, the address it mails, and what it says past a limit."""

    def __init__(self, name, path, sends_to, key, sentence, extra=None):
        self.name = name
        self.path = path
        self.sends_to = sends_to
        self.key = key
        self.sentence = sentence
        self.extra = extra or {}

    def __repr__(self):
        return self.name

    def ask(self, client, caller):
        return client.post(self.path, json={"email": self.sends_to, **self.extra},
                           environ_base={"REMOTE_ADDR": caller})

    def limited(self, answer):
        """Whether ``answer`` is this route's refusal past a limit, whatever its wait."""
        status, body, _retry_after = answer
        said = (body or {}).get(self.key, "")
        before, after = self.sentence.split("{wait}")
        return status == 429 and said.startswith(before) and said.endswith(after)

    def refused(self, seconds):
        """The 429 that says to wait ``seconds``, in this route's words, under its key."""
        minutes = -(-seconds // 60)
        wait = "1 minute" if minutes == 1 else f"{minutes} minutes"
        return 429, {self.key: self.sentence.format(wait=wait)}, str(seconds)


VENDOR_TOO_MANY = "Too many sign-in attempts. Please try again in {wait}."
ASKED_TOO_OFTEN = "You have asked several times. Try again in {wait}."

REQUESTS = [
    Asked("vendor code", f"/public/markets/{SLUG}/applicant-login/request-code", VENDOR_ADDRESS,
          "message", VENDOR_TOO_MANY, {"captcha_token": "test-human-check"}),
    Asked("organizer code", "/request-otp", ACCOUNT_EMAIL, "msg", ASKED_TOO_OFTEN),
    Asked("reset link", "/request-password-reset", ACCOUNT_EMAIL, "msg", ASKED_TOO_OFTEN),
    Asked("verification link", "/resend-verification", UNVERIFIED_EMAIL, "msg", ASKED_TOO_OFTEN),
    Asked("sign-up", "/register", NO_ACCOUNT_EMAIL, "msg", ASKED_TOO_OFTEN,
          {"password": PASSWORD, "captcha_token": "test-human-check"}),
]


@pytest.fixture
def clock(monkeypatch):
    """The server's clock, the vendor's and the organizer's limits' and the organizer's secrets'
    alike, held at the start of an hour until a test moves it."""
    now = {"at": HOUR_STARTS}
    monkeypatch.setattr(UsersApi, "_now", lambda: now["at"].timestamp())
    monkeypatch.setattr(account_secrets, "now", lambda: now["at"])
    monkeypatch.setattr(ApplicantAuthApi, "_limit_clock", lambda: now["at"])
    return now


@pytest.fixture
def outbox(monkeypatch):
    """Every mail sent, by the address it went to; while ``failing``, the provider refuses each."""
    box = SimpleNamespace(sent=[], failing=False)

    def sender(to, *_rest, **_kwargs):
        if box.failing:
            return False
        box.sent.append(to)
        return True

    for name in ("send_otp_email", "send_password_reset_email", "send_verification_email",
                 "send_account_exists_email"):
        monkeypatch.setattr(UsersApi, name, sender)
    monkeypatch.setattr(ApplicantAuthApi, "_send_code_email", sender)
    return box


@pytest.fixture
def world(monkeypatch, clock, outbox):
    """A published market with one applicant, and the organizer's accounts."""
    db = FakeDatabase(markets=[_published_market_doc()], applications=[_application_doc()])
    monkeypatch.setattr(ApplicantAuthApi, "db", db)
    monkeypatch.setattr(ApplicantAuthApi, "challenges_collection", db["applicant_login_challenges"])
    monkeypatch.setattr(ApplicationsApi, "applications_collection", db["applications"])
    users = MailingUsers(_account(ACCOUNT_EMAIL), _account(UNVERIFIED_EMAIL, verified=False))
    monkeypatch.setattr(UsersApi, "users_collection", users)
    # A sign-up hashes at bcrypt's lowest cost, as the accounts here are hashed.
    monkeypatch.setattr(app_module.bcrypt, "_log_rounds", FAST_ROUNDS)
    return SimpleNamespace(clock=clock, outbox=outbox, users=users)


@pytest.mark.parametrize("asked", REQUESTS, ids=repr)
class TestOneCallersRequestsLeaveAnothersAsTheyWere:
    def test_after_caller_as_five_requests_caller_bs_request_mails(self, client, world, asked):
        # The provider refuses A's mail, so each leaves the address free to be mailed again (a code
        # and a reset link are mailed one at a time): what is left between A and B is the limits.
        world.outbox.failing = True
        for _ in range(5):
            assert not asked.limited(_answer(asked.ask(client, CALLER_A)))
        assert _answer(asked.ask(client, CALLER_A)) == asked.refused(900)

        world.outbox.failing = False
        assert not asked.limited(_answer(asked.ask(client, CALLER_B)))
        assert world.outbox.sent == [asked.sends_to]

    def test_a_request_the_pair_refused_is_not_counted_on_the_address(self, client, world, asked):
        for _ in range(30):
            asked.ask(client, CALLER_A)
        world.outbox.sent.clear()

        # A's 25 refused requests left the address 15 of its hour's 20.
        answers = [_answer(asked.ask(client, f"198.51.100.{10 + n // 5}")) for n in range(15)]

        assert not any(asked.limited(answer) for answer in answers)


# Twenty requests in an hour: six in each of its first three quarters, from two callers of three
# each, and two at the start of the last, so no quarter holds more than any count per quarter allows.
TWENTY_IN_AN_HOUR = [(0, 3), (0, 3), (15, 3), (15, 3), (30, 3), (30, 3), (45, 2)]


def _ask_twenty_times_in_the_hour(client, world, asked):
    for n, (minute, times) in enumerate(TWENTY_IN_AN_HOUR):
        world.clock["at"] = HOUR_STARTS + timedelta(minutes=minute)
        for _ in range(times):
            assert not asked.limited(_answer(asked.ask(client, f"198.51.100.{10 + n}")))


@pytest.mark.parametrize("asked", REQUESTS, ids=repr)
class TestOneInboxIsMailedAtMostTwentyTimesAnHour:
    def test_the_21st_request_in_an_hour_is_refused_whoever_asks(self, client, world, asked):
        _ask_twenty_times_in_the_hour(client, world, asked)
        world.clock["at"] = HOUR_STARTS + timedelta(minutes=46)
        world.outbox.sent.clear()
        world.users.reads.clear()

        assert _answer(asked.ask(client, "203.0.113.99")) == asked.refused(14 * 60)
        assert world.outbox.sent == []
        assert world.users.reads == []

    def test_the_next_hour_starts_from_nothing(self, client, world, asked):
        _ask_twenty_times_in_the_hour(client, world, asked)
        world.clock["at"] = HOUR_STARTS + timedelta(minutes=59)
        assert _answer(asked.ask(client, CALLER_B)) == asked.refused(60)

        world.clock["at"] = HOUR_STARTS + timedelta(hours=1)

        assert not asked.limited(_answer(asked.ask(client, CALLER_B)))
