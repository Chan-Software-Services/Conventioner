"""The counters that bound the sign-in endpoints, the applicant's and the organizer's.

A counter lives in the database, not in a process: a serverless deployment runs many processes and
forgets each one, so a limit kept in memory bounds nothing. These tests hold the limiter to that
shape with a fake collection that behaves as Mongo's upsert does (``conftest.FakeAttemptsCollection``).
"""
from datetime import datetime, timedelta, timezone

import pytest
from flask import Flask, jsonify

import sign_in_limits
from sign_in_limits import (
    SignInLimit, caller, count_attempt, take_back_attempt, too_many, wait_in_words,
)


THREE_A_MINUTE = SignInLimit("test", attempts=3, window=timedelta(minutes=1))
# 30 seconds into a minute-long window, so the window ends 30 seconds from now.
NOW = datetime(2026, 10, 22, 12, 0, 30, tzinfo=timezone.utc)


def test_attempts_up_to_the_limit_are_allowed(sign_in_attempts):
    assert [count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW) for _ in range(3)] == [
        None, None, None,
    ]


def test_the_attempt_past_the_limit_is_told_when_the_window_ends(sign_in_attempts):
    for _ in range(3):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW) == 30


def test_a_refused_attempt_still_counts(sign_in_attempts):
    """A caller who keeps knocking stays refused for the rest of the window."""
    for _ in range(5):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW + timedelta(seconds=29)) == 1


def test_the_wait_is_never_less_than_a_second(sign_in_attempts):
    almost_over = datetime(2026, 10, 22, 12, 0, 59, 999000, tzinfo=timezone.utc)
    for _ in range(3):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=almost_over)
    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=almost_over) == 1


def test_each_subject_is_counted_apart(sign_in_attempts):
    for _ in range(3):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    assert count_attempt(THREE_A_MINUTE, "b@example.com", now=NOW) is None


def test_each_limit_is_counted_apart(sign_in_attempts):
    other = SignInLimit("other", attempts=3, window=timedelta(minutes=1))
    for _ in range(3):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    assert count_attempt(other, "a@example.com", now=NOW) is None


def test_the_next_window_starts_from_nothing(sign_in_attempts):
    for _ in range(4):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW + timedelta(minutes=1)) is None


def test_a_counter_expires_when_its_window_ends(sign_in_attempts):
    """The TTL index removes it; nothing in the application cleans up."""
    count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    [doc] = sign_in_attempts.docs.values()
    assert doc["expires_at"] == datetime(2026, 10, 22, 12, 1, 0, tzinfo=timezone.utc)


def test_a_counter_names_no_address_and_no_caller(sign_in_attempts):
    """The counters hold who knocked for a quarter of an hour; they need not hold who it was."""
    count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    count_attempt(THREE_A_MINUTE, "203.0.113.7", now=NOW)
    stored = repr(sign_in_attempts.docs)
    assert "a@example.com" not in stored
    assert "203.0.113.7" not in stored


def test_the_expiry_index_removes_a_counter_once_its_window_ends(sign_in_attempts):
    sign_in_limits.ensure_expiry_index()
    assert sign_in_attempts.indexes == [
        ([("expires_at", 1)], {"expireAfterSeconds": 0, "name": "sign_in_attempt_ttl"}),
    ]


def test_every_limit_fits_a_real_applicant():
    """A vendor who mistypes or asks again is never near a limit; a flood is."""
    for limit in sign_in_limits.LIMITS:
        assert limit.attempts >= 5
        assert limit.window <= timedelta(hours=1)


QUARTER = timedelta(minutes=15)
HOUR = timedelta(hours=1)


def test_the_table_holds_every_limit_in_use_once():
    """Every limit, its count and its window; a name that left the table is never read again, and
    its counters expire with their window."""
    assert {limit.name: (limit.attempts, limit.window) for limit in sign_in_limits.LIMITS} == {
        "request-code:caller": (300, QUARTER),
        "request-code:caller-address": (5, QUARTER),
        "request-code:address-hour": (20, HOUR),
        "verify-code:caller": (300, QUARTER),
        "verify-code:caller-address": (10, QUARTER),
        "verify-code:address-ceiling": (50, QUARTER),
        "resume:caller": (300, QUARTER),
        "check-in:address": (10, QUARTER),
        "password:caller": (50, QUARTER),
        "password:caller-address": (10, QUARTER),
        "password:address-ceiling": (50, QUARTER),
        "organizer-code:caller": (60, QUARTER),
        "organizer-code:caller-address": (10, QUARTER),
        "organizer-code:address-ceiling": (50, QUARTER),
        "organizer-code-request:caller": (30, QUARTER),
        "organizer-code-request:caller-address": (5, QUARTER),
        "organizer-code-request:address-hour": (20, HOUR),
        "reset-link:caller": (30, QUARTER),
        "reset-link:caller-address": (5, QUARTER),
        "reset-link:address-hour": (20, HOUR),
        "verification-link:caller": (30, QUARTER),
        "verification-link:caller-address": (5, QUARTER),
        "verification-link:address-hour": (20, HOUR),
        "sign-up:caller": (30, QUARTER),
        "sign-up:caller-address": (5, QUARTER),
        "sign-up:address-hour": (20, HOUR),
    }


# Taking a try back: a try that signs in returns its count, so only wrong tries pile up.

def test_a_try_taken_back_lowers_its_windows_count_by_one(sign_in_attempts):
    for _ in range(3):
        count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)

    take_back_attempt(THREE_A_MINUTE, "a@example.com", NOW)

    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW) is None
    assert count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW) == 30


def test_a_count_is_never_taken_below_nothing(sign_in_attempts):
    count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)

    take_back_attempt(THREE_A_MINUTE, "a@example.com", NOW)
    take_back_attempt(THREE_A_MINUTE, "a@example.com", NOW)

    [doc] = sign_in_attempts.docs.values()
    assert doc["count"] == 0


def test_taking_a_try_back_touches_only_its_own_window(sign_in_attempts):
    count_attempt(THREE_A_MINUTE, "a@example.com", now=NOW)
    later = NOW + timedelta(minutes=1)
    count_attempt(THREE_A_MINUTE, "a@example.com", now=later)

    take_back_attempt(THREE_A_MINUTE, "a@example.com", later)

    assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [0, 1]


def test_taking_a_try_back_from_a_removed_counter_writes_nothing(sign_in_attempts):
    take_back_attempt(THREE_A_MINUTE, "a@example.com", NOW)

    assert sign_in_attempts.docs == {}


# The wait, in words.

def test_a_wait_is_said_in_whole_minutes_rounded_up():
    assert [wait_in_words(s) for s in (1, 60, 61, 120, 900)] == [
        "1 minute", "1 minute", "2 minutes", "2 minutes", "15 minutes",
    ]


def test_a_refusal_says_its_sentence_with_the_wait_and_retry_after():
    with Flask(__name__).app_context():
        response, status = too_many(61, "Try again in {wait}.", key="msg")

    assert status == 429
    assert response.get_json() == {"msg": "Try again in 2 minutes."}
    assert response.headers["Retry-After"] == "61"


def test_no_refusal_when_the_limit_did_not_refuse():
    assert too_many(None, "Try again in {wait}.") is None


@pytest.mark.parametrize("retry_after, wait", [(60, "1 minute"), (899, "15 minutes")])
def test_the_applicants_and_the_check_ins_refusals_keep_their_words(retry_after, wait):
    """Their sentence moved into a template; what a vendor reads did not change by a byte."""
    import api.applicant_auth as applicant_auth
    import api.vendor_check_in as vendor_check_in

    with Flask(__name__).app_context():
        sign_in, _ = applicant_auth._too_many(retry_after)
        check_in, _ = vendor_check_in._too_many(retry_after)
        assert sign_in.get_data() == jsonify(
            {"message": f"Too many sign-in attempts. Please try again in {wait}."}).get_data()
        assert check_in.get_data() == jsonify(
            {"error": f"Too many check-in attempts. Please try again in {wait}."}).get_data()


@pytest.mark.parametrize("prefix, name, per_caller", [
    ("PASSWORD", "password", 50),
    ("ORGANIZER_CODE", "organizer-code", 60),
])
def test_each_organizer_sign_in_is_limited_per_caller_and_address_and_per_address(
    prefix, name, per_caller,
):
    limits = [getattr(sign_in_limits, f"{prefix}_{suffix}") for suffix in (
        "PER_CALLER", "PER_CALLER_AND_ADDRESS", "PER_ADDRESS_CEILING")]
    assert limits == [
        SignInLimit(f"{name}:caller", attempts=per_caller, window=QUARTER),
        SignInLimit(f"{name}:caller-address", attempts=10, window=QUARTER),
        SignInLimit(f"{name}:address-ceiling", attempts=50, window=QUARTER),
    ]
    assert set(limits) <= set(sign_in_limits.LIMITS)
    assert not hasattr(sign_in_limits, f"{prefix}_PER_ADDRESS")


@pytest.mark.parametrize("prefix, name", [
    ("REQUEST_CODE", "request-code"),
    ("ORGANIZER_CODE_REQUEST", "organizer-code-request"),
    ("RESET_LINK", "reset-link"),
    ("VERIFICATION_LINK", "verification-link"),
    ("SIGN_UP", "sign-up"),
])
def test_each_mail_request_is_limited_per_caller_and_address_and_per_address_by_the_hour(
    prefix, name,
):
    per_caller_and_address = getattr(sign_in_limits, f"{prefix}_PER_CALLER_AND_ADDRESS")
    per_address = getattr(sign_in_limits, f"{prefix}_PER_ADDRESS_HOUR")
    assert per_caller_and_address == SignInLimit(f"{name}:caller-address", attempts=5,
                                                 window=QUARTER)
    assert per_address == SignInLimit(f"{name}:address-hour", attempts=20, window=HOUR)
    assert not hasattr(sign_in_limits, f"{prefix}_PER_ADDRESS")


def test_every_limit_has_a_name_of_its_own():
    names = [limit.name for limit in sign_in_limits.LIMITS]
    assert len(names) == len(set(names))


def test_the_caller_is_the_address_the_request_came_from():
    app = Flask(__name__)
    with app.test_request_context("/", environ_base={"REMOTE_ADDR": "203.0.113.7"}):
        assert caller() == "203.0.113.7"
    with app.test_request_context("/", environ_base={"REMOTE_ADDR": ""}):
        assert caller() == "unknown"


def _caller_from(remote_addr):
    app = Flask(__name__)
    with app.test_request_context("/", environ_base={"REMOTE_ADDR": remote_addr}):
        return caller()


@pytest.mark.parametrize("remote_addr, expected", [
    ("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"),
    ("2001:db8:1:2::1", "2001:db8:1:2::/64"),
    ("2001:DB8:0001:0002:0:0:0:9", "2001:db8:1:2::/64"),
    ("::ffff:192.0.2.1", "192.0.2.1"),
    ("192.0.2.1", "192.0.2.1"),
    ("unknown", "unknown"),
    ("not an address", "not an address"),
])
def test_a_caller_is_counted_by_its_network(remote_addr, expected):
    """An IPv6 caller is its /64 network, the block one line or one machine is handed, so one
    machine counts as one caller on IPv6 as on IPv4; a mapped IPv4 address is that IPv4 address,
    and anything that is not an address is counted as given."""
    assert _caller_from(remote_addr) == expected


def test_two_addresses_of_one_ipv6_network_share_a_count(sign_in_attempts):
    one = _caller_from("2001:db8:1:2::1")
    other = _caller_from("2001:db8:1:2:ffff:ffff:ffff:ffff")
    for _ in range(3):
        assert count_attempt(THREE_A_MINUTE, one, NOW) is None
    assert count_attempt(THREE_A_MINUTE, other, NOW) == 30


def test_two_ipv6_networks_are_counted_apart(sign_in_attempts):
    one = _caller_from("2001:db8:1:2::1")
    neighbour = _caller_from("2001:db8:1:3::1")
    for _ in range(3):
        assert count_attempt(THREE_A_MINUTE, one, NOW) is None
    assert count_attempt(THREE_A_MINUTE, neighbour, NOW) is None


def test_a_mapped_ipv4_caller_shares_the_ipv4_callers_count(sign_in_attempts):
    for _ in range(3):
        assert count_attempt(THREE_A_MINUTE, _caller_from("192.0.2.1"), NOW) is None
    assert count_attempt(THREE_A_MINUTE, _caller_from("::ffff:192.0.2.1"), NOW) == 30


# A request that mails: ``MailBounds``.

PER_CALLER = SignInLimit("test-mail:caller", attempts=4, window=timedelta(minutes=1))
PER_PAIR = SignInLimit("test-mail:caller-address", attempts=2, window=timedelta(minutes=1))
PER_ADDRESS = SignInLimit("test-mail:address-hour", attempts=3, window=timedelta(hours=1))
MAIL = sign_in_limits.MailBounds(PER_CALLER, PER_PAIR, PER_ADDRESS)
# 30 seconds into a minute and into an hour, so a minute's window ends in 30 seconds and the hour's
# in 3,570.
MAIL_NOW = datetime(2026, 10, 22, 12, 0, 30, tzinfo=timezone.utc)


def _as(remote_addr, bounds_call):
    app = Flask(__name__)
    with app.test_request_context("/", environ_base={"REMOTE_ADDR": remote_addr}):
        return bounds_call()


def _mail(remote_addr, address="a@example.com", now=MAIL_NOW):
    return _as(remote_addr, lambda: MAIL.before_the_mail(address, now))


def _count(sign_in_attempts, limit, subject, now=MAIL_NOW):
    key, _ = sign_in_limits._window(limit, subject, now)
    return sign_in_attempts.docs.get(key, {}).get("count", 0)


def test_a_mail_request_counts_its_caller(sign_in_attempts):
    answers = [_as("203.0.113.7", lambda: MAIL.caller_refusal(MAIL_NOW)) for _ in range(5)]

    assert answers == [None] * 4 + [sign_in_limits.TooMany(30)]


def test_a_mail_request_counts_its_caller_and_address_then_its_address(sign_in_attempts):
    assert [_mail("203.0.113.7") for _ in range(2)] == [None, None]

    assert _count(sign_in_attempts, PER_PAIR, "203.0.113.7\0a@example.com") == 2
    assert _count(sign_in_attempts, PER_ADDRESS, "a@example.com") == 2


def test_past_its_pair_a_request_waits_for_the_pairs_window(sign_in_attempts):
    _mail("203.0.113.7")
    _mail("203.0.113.7")

    assert _mail("203.0.113.7") == sign_in_limits.TooMany(30)


def test_a_request_the_pair_refused_is_not_counted_on_the_address(sign_in_attempts):
    for _ in range(10):
        _mail("203.0.113.7")

    assert _count(sign_in_attempts, PER_ADDRESS, "a@example.com") == 2
    assert _mail("198.51.100.1") is None


def test_past_its_address_a_request_waits_for_the_addresss_window_whoever_asks(sign_in_attempts):
    for caller_address in ("198.51.100.1", "198.51.100.2", "198.51.100.3"):
        assert _mail(caller_address) is None

    assert _mail("198.51.100.4") == sign_in_limits.TooMany(3570)


def test_each_address_is_counted_apart(sign_in_attempts):
    for caller_address in ("198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"):
        _mail(caller_address)

    assert _mail("198.51.100.5", address="b@example.com") is None


def test_the_pairs_counter_names_no_address_and_no_caller(sign_in_attempts):
    _mail("203.0.113.7")

    stored = repr(sign_in_attempts.docs)
    assert "a@example.com" not in stored
    assert "203.0.113.7" not in stored


def test_the_pair_is_the_callers_network_and_the_address():
    """Two addresses of one IPv6 network are one caller asking, as for any per-caller count."""
    one = _as("2001:db8:1:2::1", lambda: sign_in_limits.caller_and_address("a@example.com"))
    other = _as("2001:db8:1:2::9", lambda: sign_in_limits.caller_and_address("a@example.com"))

    assert one == other == "2001:db8:1:2::/64\0a@example.com"


def test_a_refusal_is_said_in_the_routes_words_under_its_key():
    with Flask(__name__).app_context():
        response, status = sign_in_limits.answer(
            sign_in_limits.TooMany(3570), "Try again in {wait}.", key="msg")

    assert status == 429
    assert response.get_json() == {"msg": "Try again in 60 minutes."}
    assert response.headers["Retry-After"] == "3570"


def test_no_refusal_is_no_answer():
    assert sign_in_limits.answer(None, "Try again in {wait}.") is None


# A sign-in that checks a secret: ``SecretBounds``.

SECRET_PER_CALLER = SignInLimit("test-secret:caller", attempts=6, window=timedelta(minutes=1))
SECRET_PER_PAIR = SignInLimit("test-secret:caller-address", attempts=2, window=timedelta(minutes=1))
SECRET_PER_ADDRESS = SignInLimit("test-secret:address-ceiling", attempts=3,
                                 window=timedelta(minutes=1))
SECRET = sign_in_limits.SecretBounds(SECRET_PER_CALLER, SECRET_PER_PAIR, SECRET_PER_ADDRESS,
                                     "test-action")
PAIR_A = "198.51.100.1\0a@example.com"


def _try(remote_addr, token=None, address="a@example.com"):
    return _as(remote_addr, lambda: SECRET.before_the_secret(address, token, MAIL_NOW))


def _fill_the_address(callers=("198.51.100.1", "198.51.100.2", "198.51.100.3")):
    """Three tries from three callers, which fill the address's count of three."""
    for caller_address in callers:
        assert _try(caller_address) is None


def test_a_secret_try_counts_its_caller(sign_in_attempts):
    answers = [_as("203.0.113.7", lambda: SECRET.caller_refusal(MAIL_NOW)) for _ in range(7)]

    assert answers == [None] * 6 + [sign_in_limits.TooMany(30)]


def test_a_secret_try_counts_its_caller_and_address_then_its_address(sign_in_attempts):
    assert [_try("198.51.100.1") for _ in range(2)] == [None, None]

    assert _count(sign_in_attempts, SECRET_PER_PAIR, PAIR_A) == 2
    assert _count(sign_in_attempts, SECRET_PER_ADDRESS, "a@example.com") == 2


def test_past_its_pair_a_try_waits_for_the_pairs_window(sign_in_attempts, human_check):
    _try("198.51.100.1")
    _try("198.51.100.1")

    assert _try("198.51.100.1", token="a-token") == sign_in_limits.TooMany(30)
    assert human_check.actions == []


def test_a_try_the_pair_refused_is_not_counted_on_the_address(sign_in_attempts):
    for _ in range(10):
        _try("198.51.100.1")

    assert _count(sign_in_attempts, SECRET_PER_ADDRESS, "a@example.com") == 2
    assert _try("198.51.100.2") is None


def test_under_its_address_count_a_try_asks_no_human_check(sign_in_attempts, human_check):
    _fill_the_address()

    assert human_check.actions == []


def test_past_its_address_count_a_try_with_no_token_needs_the_human_check(
    sign_in_attempts, human_check,
):
    _fill_the_address()

    assert _try("198.51.100.4") == sign_in_limits.HumanCheckNeeded()
    assert human_check.actions == ["test-action"]


def test_past_its_address_count_a_try_that_passes_the_check_goes_on(sign_in_attempts, human_check):
    _fill_the_address()

    assert _try("198.51.100.4", token="a-token") is None
    assert _count(sign_in_attempts, SECRET_PER_ADDRESS, "a@example.com") == 4


def test_a_try_refused_for_want_of_the_check_is_taken_back_from_the_pair_and_the_address(
    sign_in_attempts, human_check,
):
    _fill_the_address()
    human_check.refuse = True

    assert _try("198.51.100.4", token="a-token") == sign_in_limits.HumanCheckNeeded()
    assert _try("198.51.100.4", token="a-token") == sign_in_limits.HumanCheckNeeded()

    assert _count(sign_in_attempts, SECRET_PER_PAIR, "198.51.100.4\0a@example.com") == 0
    assert _count(sign_in_attempts, SECRET_PER_ADDRESS, "a@example.com") == 3


def test_no_ones_tries_ever_refuse_another_caller_with_a_wait(sign_in_attempts):
    """Past the address's count a try only ever needs the check: the pair alone says to wait."""
    for caller_address in ("198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"):
        for _ in range(5):
            _try(caller_address)

    assert _try("198.51.100.5", token="a-token") is None


def test_a_right_secret_is_taken_back_from_the_caller_the_pair_and_the_address(sign_in_attempts):
    _as("198.51.100.1", lambda: SECRET.caller_refusal(MAIL_NOW))
    _try("198.51.100.1")

    _as("198.51.100.1", lambda: SECRET.signed_in("a@example.com", MAIL_NOW))

    assert _count(sign_in_attempts, SECRET_PER_CALLER, "198.51.100.1") == 0
    assert _count(sign_in_attempts, SECRET_PER_PAIR, PAIR_A) == 0
    assert _count(sign_in_attempts, SECRET_PER_ADDRESS, "a@example.com") == 0


def test_the_human_check_needed_is_said_under_the_routes_key():
    with Flask(__name__).app_context():
        response, status = sign_in_limits.answer(
            sign_in_limits.HumanCheckNeeded(), "Try again in {wait}.", key="msg")

    assert status == 403
    assert response.get_json() == {"msg": "Confirm you're a person, then try again.",
                                   "captcha": "required"}
    assert "Retry-After" not in response.headers
