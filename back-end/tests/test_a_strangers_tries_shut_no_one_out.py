"""A sign-in that checks a secret counts its wrong tries per caller and address, so another caller's
tries never refuse the person's right one.

A try is counted per caller and address together (10 wrong in 15 minutes), which bounds one
caller's guesses at one address and leaves every other caller's tries at it as they were. It is
also counted per address alone (50 wrong in 15 minutes, which only many callers together reach),
and past that count the sign-in asks the human check instead of refusing: a person passes it and
signs in. A right secret takes its try back from every count, so only wrong tries pile up.

Driven at the routes a browser posts to, from callers named by ``REMOTE_ADDR``, on a clock held at
the start of a window (``sign_in_limits``' windows are aligned to the clock).
"""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import api.applicant_auth as ApplicantAuthApi
import app as app_module
import sign_in_limits
from market_documents import market_name_slug
from test_applicant_auth import FakeDatabase, _application_doc, _published_market_doc

# The start of a quarter of an hour, so every try falls in one window.
WINDOW_STARTS = datetime(2026, 11, 9, 12, 0, 0, tzinfo=timezone.utc)

VENDOR_ADDRESS = "applicant@example.com"
SLUG = market_name_slug("Test Market")
RIGHT_CODE = "246810"
WRONG_CODE = "000000"
TOKEN = "test-human-check"

CALLER_A = "198.51.100.1"
CALLER_B = "198.51.100.2"
# Five callers' ten wrong tries each fill the address's count; the sixth caller is past it.
FIVE_CALLERS = [f"203.0.113.{n}" for n in range(1, 6)]
SIXTH_CALLER = "203.0.113.6"

REFUSED = (429, {"message": "Too many sign-in attempts. Please try again in 15 minutes."}, "900")
CHECK_NEEDED = (403, {"message": "Confirm you're a person, then try again.", "captcha": "required"},
                None)


def _answer(response):
    return response.status_code, response.get_json(), response.headers.get("Retry-After")


@pytest.fixture
def client():
    return app_module.app.test_client()


@pytest.fixture
def vendor(monkeypatch):
    """A published market with one applicant, every code it is sent the right one."""
    db = FakeDatabase(markets=[_published_market_doc()], applications=[_application_doc()])
    monkeypatch.setattr(ApplicantAuthApi, "db", db)
    monkeypatch.setattr(ApplicantAuthApi, "challenges_collection", db["applicant_login_challenges"])
    monkeypatch.setattr(ApplicantAuthApi, "_generate_code", lambda: RIGHT_CODE)
    monkeypatch.setattr(ApplicantAuthApi, "_send_code_email", lambda *_a, **_k: True)
    monkeypatch.setattr(ApplicantAuthApi, "_limit_clock", lambda: WINDOW_STARTS)
    return SimpleNamespace(db=db)


def _ask_code(client, caller):
    response = client.post(
        f"/public/markets/{SLUG}/applicant-login/request-code",
        json={"email": VENDOR_ADDRESS, "captcha_token": TOKEN},
        environ_base={"REMOTE_ADDR": caller},
    )
    assert response.status_code == 200, response.get_json()


def _try_code(client, caller, code, token=None, slug=SLUG):
    body = {"email": VENDOR_ADDRESS, "code": code}
    if token is not None:
        body["captcha_token"] = token
    return client.post(f"/public/markets/{slug}/applicant-login/verify-code", json=body,
                       environ_base={"REMOTE_ADDR": caller})


def _wrong_tries(client, caller, tries):
    for _ in range(tries):
        assert _try_code(client, caller, WRONG_CODE, TOKEN).status_code == 401


def _count(sign_in_attempts, limit, subject):
    key, _ = sign_in_limits._window(limit, subject, WINDOW_STARTS)
    return sign_in_attempts.docs.get(key, {}).get("count", 0)


class TestAVendorsRightCodeIsNeverRefusedForOthersTries:
    def test_after_caller_as_eleven_wrong_codes_caller_bs_right_code_signs_in(
        self, client, vendor,
    ):
        _wrong_tries(client, CALLER_A, 10)
        assert _answer(_try_code(client, CALLER_A, WRONG_CODE, TOKEN)) == REFUSED

        _ask_code(client, CALLER_B)
        signed_in = _try_code(client, CALLER_B, RIGHT_CODE, TOKEN)

        assert signed_in.status_code == 200
        assert signed_in.get_json()["applicantEmail"] == VENDOR_ADDRESS

    def test_caller_as_own_eleventh_try_is_refused_even_with_the_right_code(self, client, vendor):
        _ask_code(client, CALLER_A)
        _wrong_tries(client, CALLER_A, 10)
        _ask_code(client, CALLER_A)

        assert _answer(_try_code(client, CALLER_A, RIGHT_CODE, TOKEN)) == REFUSED
        # The refused try never reached the code, which another caller may still use.
        assert _try_code(client, CALLER_B, RIGHT_CODE, TOKEN).status_code == 200

    def test_past_fifty_wrong_codes_a_right_code_with_no_token_is_asked_the_human_check(
        self, client, vendor, human_check,
    ):
        for caller in FIVE_CALLERS:
            _wrong_tries(client, caller, 10)
        _ask_code(client, SIXTH_CALLER)
        asked_before = len(human_check.actions)

        assert _answer(_try_code(client, SIXTH_CALLER, RIGHT_CODE)) == CHECK_NEEDED
        assert human_check.actions[asked_before:] == ["vendor-sign-in"]

    def test_past_fifty_wrong_codes_a_right_code_with_a_passing_token_signs_in(
        self, client, vendor, sign_in_attempts,
    ):
        for caller in FIVE_CALLERS:
            _wrong_tries(client, caller, 10)
        _ask_code(client, SIXTH_CALLER)
        assert _try_code(client, SIXTH_CALLER, RIGHT_CODE).status_code == 403

        signed_in = _try_code(client, SIXTH_CALLER, RIGHT_CODE, TOKEN)

        assert signed_in.status_code == 200
        # Only the fifty wrong codes are counted on the address and the pair: the try refused for
        # want of the check, and the right code, were each taken back. The caller keeps the
        # refused try, as it keeps every try that checked no secret.
        assert _count(sign_in_attempts, sign_in_limits.VERIFY_CODE_PER_ADDRESS_CEILING,
                      VENDOR_ADDRESS) == 50
        assert _count(sign_in_attempts, sign_in_limits.VERIFY_CODE_PER_CALLER_AND_ADDRESS,
                      f"{SIXTH_CALLER}\0{VENDOR_ADDRESS}") == 0
        assert _count(sign_in_attempts, sign_in_limits.VERIFY_CODE_PER_CALLER, SIXTH_CALLER) == 1

    def test_a_refused_check_leaves_the_code_to_be_tried(self, client, vendor, human_check):
        for caller in FIVE_CALLERS:
            _wrong_tries(client, caller, 10)
        _ask_code(client, SIXTH_CALLER)
        human_check.refuse = True

        assert _answer(_try_code(client, SIXTH_CALLER, RIGHT_CODE, TOKEN)) == CHECK_NEEDED

        human_check.refuse = False
        assert _try_code(client, SIXTH_CALLER, RIGHT_CODE, TOKEN).status_code == 200

    def test_past_fifty_the_check_is_asked_alike_for_every_market(self, client, vendor):
        """Asked before the market is looked up, so it says nothing of which markets exist."""
        for caller in FIVE_CALLERS:
            _wrong_tries(client, caller, 10)

        real = _answer(_try_code(client, SIXTH_CALLER, RIGHT_CODE))
        absent = _answer(_try_code(client, SIXTH_CALLER, RIGHT_CODE, slug="no-such-market"))

        assert real == absent == CHECK_NEEDED

    def test_under_fifty_wrong_codes_a_try_is_never_asked_the_human_check(
        self, client, vendor, human_check,
    ):
        for caller in FIVE_CALLERS[:4]:
            _wrong_tries(client, caller, 10)
        _ask_code(client, SIXTH_CALLER)
        asked_before = len(human_check.actions)

        assert _try_code(client, SIXTH_CALLER, RIGHT_CODE).status_code == 200
        assert human_check.actions[asked_before:] == []

    def test_a_vendor_who_signs_in_all_day_is_never_held_back(self, client, vendor):
        """A right code is taken back, so only wrong ones pile up: twelve tries, nine wrong."""
        for _ in range(3):
            _ask_code(client, CALLER_A)
            for _ in range(3):
                assert _try_code(client, CALLER_A, WRONG_CODE, TOKEN).status_code == 401
            assert _try_code(client, CALLER_A, RIGHT_CODE, TOKEN).status_code == 200


# The organizer's password and code sign-ins, bounded the same way.

ORGANIZER_ADDRESS = "fixture-organizer@example.com"
UNVERIFIED_ADDRESS = "fixture-unverified@example.com"
NO_ACCOUNT_ADDRESS = "fixture-nobody@example.com"
PASSWORD = "fixture-password-1"
WRONG_PASSWORD = "not-the-password"
ORGANIZER_CODE = "123456"
WRONG_ORGANIZER_CODE = "000000"

TOO_MANY = "Too many sign-in attempts. Try again in 15 minutes, or reset your password."
CHECK_SAYS = "Confirm you're a person, then try again."
PASSWORD_REFUSED = (429, {"message": TOO_MANY}, "900")
PASSWORD_CHECK_NEEDED = (403, {"message": CHECK_SAYS, "captcha": "required"}, None)
CODE_REFUSED = (429, {"msg": TOO_MANY}, "900")
CODE_CHECK_NEEDED = (403, {"msg": CHECK_SAYS, "captcha": "required"}, None)
VERIFY_FIRST = (403, {"message": "Verify your email address first: we sent you a link when you "
                                 "registered."}, None)


@pytest.fixture
def organizers(monkeypatch):
    """A verified and an unverified organizer, on the clock held at the start of the window."""
    from test_the_organizer_sign_in_is_bounded import Users, _account, _hash
    import account_secrets
    import api.users as UsersApi

    users = Users(_account(ORGANIZER_ADDRESS), _account(UNVERIFIED_ADDRESS, verified=False))
    monkeypatch.setattr(UsersApi, "users_collection", users)
    monkeypatch.setattr(UsersApi, "_no_account_hash", _hash("fixture-stand-in"))
    monkeypatch.setattr(UsersApi, "_now", lambda: WINDOW_STARTS.timestamp())
    monkeypatch.setattr(account_secrets, "now", lambda: WINDOW_STARTS)
    return users


def _sign_in(client, caller, password, token=None, address=ORGANIZER_ADDRESS):
    body = {"email": address, "password": password}
    if token is not None:
        body["captcha_token"] = token
    return client.post("/login", json=body, environ_base={"REMOTE_ADDR": caller})


def _wrong_passwords(client, caller, tries, address=ORGANIZER_ADDRESS):
    for _ in range(tries):
        assert _sign_in(client, caller, WRONG_PASSWORD, TOKEN, address).status_code == 401


def _issue_organizer_code(users, address=ORGANIZER_ADDRESS):
    """A code mailed to ``address``, live for five minutes from the start of the window."""
    from datetime import timedelta
    from sign_in_secrets import live_code

    users.account(address)["secrets"] = {
        "code": live_code(ORGANIZER_CODE, WINDOW_STARTS + timedelta(minutes=5))}


def _enter_code(client, caller, code, token=None, address=ORGANIZER_ADDRESS):
    body = {"email": address, "otp": code}
    if token is not None:
        body["captcha_token"] = token
    return client.post("/login-otp", json=body, environ_base={"REMOTE_ADDR": caller})


def _wrong_codes(client, caller, tries):
    # Each code takes five tries before it is discarded, so the tries meet the sign-in limits, not
    # the code's own: an address with no account is tried, where no code is ever live.
    for _ in range(tries):
        assert _enter_code(client, caller, WRONG_ORGANIZER_CODE, TOKEN,
                           NO_ACCOUNT_ADDRESS).status_code == 401


class TestAnOrganizersRightPasswordIsNeverRefusedForOthersTries:
    def test_after_caller_as_eleven_wrong_passwords_caller_bs_right_password_signs_in(
        self, client, organizers,
    ):
        _wrong_passwords(client, CALLER_A, 10)
        assert _answer(_sign_in(client, CALLER_A, WRONG_PASSWORD, TOKEN)) == PASSWORD_REFUSED

        assert _sign_in(client, CALLER_B, PASSWORD).status_code == 200

    def test_caller_as_own_eleventh_try_is_refused_even_with_the_right_password(
        self, client, organizers, password_checks,
    ):
        _wrong_passwords(client, CALLER_A, 10)
        password_checks.clear()

        assert _answer(_sign_in(client, CALLER_A, PASSWORD, TOKEN)) == PASSWORD_REFUSED
        assert password_checks == []

    def test_past_fifty_wrong_passwords_a_right_one_with_no_token_is_asked_the_human_check(
        self, client, organizers, human_check, password_checks,
    ):
        for caller in FIVE_CALLERS:
            _wrong_passwords(client, caller, 10)
        asked_before = len(human_check.actions)
        password_checks.clear()

        assert _answer(_sign_in(client, SIXTH_CALLER, PASSWORD)) == PASSWORD_CHECK_NEEDED
        assert human_check.actions[asked_before:] == ["sign-in"]
        assert password_checks == []

    def test_past_fifty_wrong_passwords_a_right_one_with_a_passing_token_signs_in(
        self, client, organizers, sign_in_attempts,
    ):
        for caller in FIVE_CALLERS:
            _wrong_passwords(client, caller, 10)
        assert _sign_in(client, SIXTH_CALLER, PASSWORD).status_code == 403

        assert _sign_in(client, SIXTH_CALLER, PASSWORD, TOKEN).status_code == 200
        # Only the fifty wrong passwords stay counted: the try refused for want of the check, and
        # the right password, were each taken back from the pair and the address.
        assert _count(sign_in_attempts, sign_in_limits.PASSWORD_PER_ADDRESS_CEILING,
                      ORGANIZER_ADDRESS) == 50
        assert _count(sign_in_attempts, sign_in_limits.PASSWORD_PER_CALLER_AND_ADDRESS,
                      f"{SIXTH_CALLER}\0{ORGANIZER_ADDRESS}") == 0
        assert _count(sign_in_attempts, sign_in_limits.PASSWORD_PER_CALLER, SIXTH_CALLER) == 1

    def test_past_fifty_a_verify_first_answer_takes_its_try_back(
        self, client, organizers, sign_in_attempts,
    ):
        for caller in FIVE_CALLERS:
            _wrong_passwords(client, caller, 10, UNVERIFIED_ADDRESS)

        assert _answer(_sign_in(client, SIXTH_CALLER, PASSWORD, TOKEN,
                                UNVERIFIED_ADDRESS)) == VERIFY_FIRST
        assert _count(sign_in_attempts, sign_in_limits.PASSWORD_PER_ADDRESS_CEILING,
                      UNVERIFIED_ADDRESS) == 50
        assert _count(sign_in_attempts, sign_in_limits.PASSWORD_PER_CALLER, SIXTH_CALLER) == 0

    def test_a_refused_check_leaves_the_password_to_be_tried(self, client, organizers, human_check):
        for caller in FIVE_CALLERS:
            _wrong_passwords(client, caller, 10)
        human_check.refuse = True

        assert _answer(_sign_in(client, SIXTH_CALLER, PASSWORD, TOKEN)) == PASSWORD_CHECK_NEEDED

        human_check.refuse = False
        assert _sign_in(client, SIXTH_CALLER, PASSWORD, TOKEN).status_code == 200

    def test_past_fifty_the_check_is_asked_alike_with_an_account_or_without(
        self, client, organizers,
    ):
        """Asked before the account is looked up, so it says nothing of who has one."""
        for address in (ORGANIZER_ADDRESS, NO_ACCOUNT_ADDRESS):
            for caller in FIVE_CALLERS:
                _wrong_passwords(client, caller, 10, address)
        organizers.reads.clear()

        with_one = _answer(_sign_in(client, SIXTH_CALLER, PASSWORD))
        without = _answer(_sign_in(client, SIXTH_CALLER, PASSWORD, address=NO_ACCOUNT_ADDRESS))

        assert with_one == without == PASSWORD_CHECK_NEEDED
        assert organizers.reads == []

    def test_under_fifty_wrong_passwords_a_try_is_never_asked_the_human_check(
        self, client, organizers, human_check,
    ):
        for caller in FIVE_CALLERS[:4]:
            _wrong_passwords(client, caller, 10)
        asked_before = len(human_check.actions)

        assert _sign_in(client, SIXTH_CALLER, PASSWORD).status_code == 200
        assert human_check.actions[asked_before:] == []


class TestAnOrganizersRightCodeIsNeverRefusedForOthersTries:
    """Tried at an address with no account, the wrong codes meet only the sign-in limits; then
    the organizer's own address is filled the same way, with a code of its own issued for the
    right try."""

    def test_after_caller_as_eleven_wrong_codes_caller_bs_right_code_signs_in(
        self, client, organizers,
    ):
        for _ in range(2):
            _issue_organizer_code(organizers)
            for _ in range(5):
                assert _enter_code(client, CALLER_A, WRONG_ORGANIZER_CODE, TOKEN).status_code == 401
        _issue_organizer_code(organizers)
        assert _answer(_enter_code(client, CALLER_A, WRONG_ORGANIZER_CODE, TOKEN)) == CODE_REFUSED

        assert _enter_code(client, CALLER_B, ORGANIZER_CODE).status_code == 200

    def test_caller_as_own_eleventh_try_is_refused_even_with_the_right_code(
        self, client, organizers,
    ):
        _wrong_codes(client, CALLER_A, 10)
        assert _answer(_enter_code(client, CALLER_A, ORGANIZER_CODE, TOKEN,
                                   NO_ACCOUNT_ADDRESS)) == CODE_REFUSED

    def test_past_fifty_wrong_codes_a_right_one_with_no_token_is_asked_the_human_check(
        self, client, organizers, human_check,
    ):
        _fill_with_wrong_codes(client, organizers)
        asked_before = len(human_check.actions)

        assert _answer(_enter_code(client, SIXTH_CALLER, ORGANIZER_CODE)) == CODE_CHECK_NEEDED
        assert human_check.actions[asked_before:] == ["sign-in"]
        # The refused try never reached the code.
        assert organizers.account(ORGANIZER_ADDRESS)["secrets"]["code"]["tries"] == 0

    def test_past_fifty_wrong_codes_a_right_one_with_a_passing_token_signs_in(
        self, client, organizers, sign_in_attempts,
    ):
        _fill_with_wrong_codes(client, organizers)
        assert _enter_code(client, SIXTH_CALLER, ORGANIZER_CODE).status_code == 403

        assert _enter_code(client, SIXTH_CALLER, ORGANIZER_CODE, TOKEN).status_code == 200
        assert _count(sign_in_attempts, sign_in_limits.ORGANIZER_CODE_PER_ADDRESS_CEILING,
                      ORGANIZER_ADDRESS) == 50
        assert _count(sign_in_attempts, sign_in_limits.ORGANIZER_CODE_PER_CALLER_AND_ADDRESS,
                      f"{SIXTH_CALLER}\0{ORGANIZER_ADDRESS}") == 0
        assert _count(sign_in_attempts, sign_in_limits.ORGANIZER_CODE_PER_CALLER,
                      SIXTH_CALLER) == 1

    def test_past_fifty_the_check_is_asked_alike_with_an_account_or_without(
        self, client, organizers,
    ):
        _fill_with_wrong_codes(client, organizers)
        for caller in FIVE_CALLERS:
            _wrong_codes(client, caller, 10)
        organizers.reads.clear()

        with_one = _answer(_enter_code(client, SIXTH_CALLER, ORGANIZER_CODE))
        without = _answer(_enter_code(client, SIXTH_CALLER, ORGANIZER_CODE,
                                      address=NO_ACCOUNT_ADDRESS))

        assert with_one == without == CODE_CHECK_NEEDED
        assert organizers.reads == []


def _fill_with_wrong_codes(client, users):
    """Five callers' ten wrong codes each at the organizer's address, a code issued every five
    tries as the organizer would ask again, and a live code left for the right try."""
    for caller in FIVE_CALLERS:
        for _ in range(2):
            _issue_organizer_code(users)
            for _ in range(5):
                assert _enter_code(client, caller, WRONG_ORGANIZER_CODE, TOKEN).status_code == 401
    _issue_organizer_code(users)


@pytest.fixture
def password_checks(monkeypatch):
    """Every bcrypt check the password sign-in makes."""
    checked = []
    check = app_module.bcrypt.check_password_hash

    def spy(pw_hash, password):
        checked.append(pw_hash)
        return check(pw_hash, password)

    monkeypatch.setattr(app_module.bcrypt, "check_password_hash", spy)
    return checked
