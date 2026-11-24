"""Single owner of the ``sign_in_attempts`` collection: how often a caller may ask to sign in.

Every sign-in endpoint is public: the applicant's code sign-in, the organizer's password and code
sign-ins and the requests that mail an organizer a code or a link, the sign-up among them, and the
vendor's check-in at the door. A request that sends an email, left unbounded, could flood
any address with mail, spending the sender's money and reputation; a sign-in try is a guess at a
password or a code. Each limit here is counted per address, per caller, or per caller and address
together, small enough to stop that and far above what a vendor or an organizer who mistypes or
asks again ever reaches.
Where a try that signs in is taken back (``take_back_attempt``), only wrong tries pile up.

**The counters live in the database, never in a process.** A serverless deployment runs many
processes and freezes or discards each at will, so a counter held in memory bounds nothing. Each
window is one document, counted with an atomic ``$inc`` upsert, and removed by the TTL index once
its window has ended; nothing in the application cleans up. The window is fixed and aligned to the
clock, so a document's key names its window and a counter Mongo has not yet removed is never read
again.

**A caller is a network** (``caller``): an IPv4 address, or the /64 network an IPv6 address sits
in, since one line or machine is handed a whole /64. So a per-caller limit counts one machine
once, on IPv6 as on IPv4, and the addresses of its own network add nothing to its allowance.

**No one else's tries refuse a person.** A sign-in that checks a secret (``SecretBounds``) says to
wait only for the caller's own tries at an address; past the address's own count, which only many
callers together reach, it asks the human check, which the person passes. A request that mails
(``MailBounds``) is counted per caller and address too, and per address by the hour.

**A counter names nobody.** Its key is a hash of the limit, the subject and the window: the
collection holds how many times someone knocked in a window, not who.

**A limit is the same for every address**, with an account or an application or neither, and it
is counted before the account or the market is looked up, so a refusal says nothing about who has
an account, who has applied or which markets exist (the applicant login ruling,
``api/applicant_auth.py``). It is also not the attempt counter that ruling forbids: that one
existed only for addresses that had applied, and so answered whether they had.
"""
import hashlib
import ipaddress
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Tuple, Union

from flask import jsonify, request
from pymongo import ReturnDocument

from db_config import get_database
from utils import captcha

SIGN_IN_ATTEMPTS_COLLECTION = "sign_in_attempts"
COUNT_FIELD = "count"
EXPIRES_AT_FIELD = "expires_at"

db = get_database()
attempts_collection = db[SIGN_IN_ATTEMPTS_COLLECTION]


@dataclass(frozen=True)
class SignInLimit:
    """At most ``attempts`` in each ``window``, for each subject (an address, or a caller)."""

    name: str
    attempts: int
    window: timedelta


# Every limit, in one place. A vendor asks for a code, perhaps once more, and enters it; vendors on
# one venue's wifi share an address, so a caller is allowed far more than an address is. What bounds
# a guess at a code is the count per caller and address, and past the address's own count the human
# check.
#
# A request that mails a code or a link (``MailBounds``) is counted three ways: per caller, per
# caller and address together, and per address alone by the hour. The pair's five a quarter of an
# hour bound what one caller may ask for one address, and leave every other caller's requests for it
# as they were; the address's twenty an hour bound one inbox's mail, whoever asks. Twenty is four
# callers' fives, so a person who asks again from a second network is never near it.
REQUEST_CODE_PER_CALLER = SignInLimit("request-code:caller", attempts=300, window=timedelta(minutes=15))
REQUEST_CODE_PER_CALLER_AND_ADDRESS = SignInLimit(
    "request-code:caller-address", attempts=5, window=timedelta(minutes=15))
REQUEST_CODE_PER_ADDRESS_HOUR = SignInLimit(
    "request-code:address-hour", attempts=20, window=timedelta(hours=1))
# A sign-in that checks a secret (``SecretBounds``) counts its wrong tries per caller and address
# together, ten a quarter of an hour, which bounds one caller's guesses at one address and leaves
# every other caller's tries at it as they were. Per address alone it counts fifty, which only many
# callers together reach, and past them it asks the human check rather than refusing, so the person
# the address belongs to still signs in. The vendor's code, the organizer's password and the
# organizer's code are each tried this way; a code's own five tries are counted on the code, which
# these limits do not replace.
VERIFY_CODE_PER_CALLER = SignInLimit("verify-code:caller", attempts=300, window=timedelta(minutes=15))
VERIFY_CODE_PER_CALLER_AND_ADDRESS = SignInLimit(
    "verify-code:caller-address", attempts=10, window=timedelta(minutes=15))
VERIFY_CODE_PER_ADDRESS_CEILING = SignInLimit(
    "verify-code:address-ceiling", attempts=50, window=timedelta(minutes=15))
# A remembered vendor's page asks once per visit (``applicant-login/resume``). Its secret is not to
# be guessed, so this bounds the work a caller makes the database do, not a guess.
RESUME_PER_CALLER = SignInLimit("resume:caller", attempts=300, window=timedelta(minutes=15))
# A vendor checking in on their page sends the door code (``api/vendor_check_in.py``): every try is
# bounded per signed-in address, and by nothing per caller. A venue's wifi is one caller for every
# vendor there, and a count of its wrong codes refused a right code after strangers' wrong ones, so
# it was dropped (T318); the counters it left under ``check-in:caller`` are never read and expire.
# The sign-in for the market and a seat on a day in reach bound a guess with this limit.
CHECK_IN_PER_ADDRESS = SignInLimit("check-in:address", attempts=10, window=timedelta(minutes=15))
# An organizer's password sign-in (``api/users.py``, ``/login``) is a ``SecretBounds`` as the
# vendor's code is: a try that signs in, or proves the password of an account not yet verified, is
# taken back, so an organizer who signs in all day is never held back and only wrong passwords pile
# up. Organizers on a venue's shared address share the caller's count, so it is far above what a few
# of them mistyping reach.
PASSWORD_PER_CALLER = SignInLimit("password:caller", attempts=50, window=timedelta(minutes=15))
PASSWORD_PER_CALLER_AND_ADDRESS = SignInLimit(
    "password:caller-address", attempts=10, window=timedelta(minutes=15))
PASSWORD_PER_ADDRESS_CEILING = SignInLimit(
    "password:address-ceiling", attempts=50, window=timedelta(minutes=15))
# An organizer's code sign-in (``/login-otp``) is bounded as the password is, with a right code
# taken back, and the caller's count set as the door's. A code's own five tries are counted on the
# account, which these limits do not replace.
ORGANIZER_CODE_PER_CALLER = SignInLimit(
    "organizer-code:caller", attempts=60, window=timedelta(minutes=15))
ORGANIZER_CODE_PER_CALLER_AND_ADDRESS = SignInLimit(
    "organizer-code:caller-address", attempts=10, window=timedelta(minutes=15))
ORGANIZER_CODE_PER_ADDRESS_CEILING = SignInLimit(
    "organizer-code:address-ceiling", attempts=50, window=timedelta(minutes=15))
# The organizer's requests that send a mail (``api/users.py``): a sign-in code (``/request-otp``),
# a reset link, a verification link, and the sign-up's own link. Every request counts and none is
# taken back. A caller is allowed thirty for organizers who share a venue's address; the pair and
# the address are counted as the vendor's code request is. Each request has its own three, so each
# refusal names its request and one request's use holds back no other.
ORGANIZER_CODE_REQUEST_PER_CALLER = SignInLimit(
    "organizer-code-request:caller", attempts=30, window=timedelta(minutes=15))
ORGANIZER_CODE_REQUEST_PER_CALLER_AND_ADDRESS = SignInLimit(
    "organizer-code-request:caller-address", attempts=5, window=timedelta(minutes=15))
ORGANIZER_CODE_REQUEST_PER_ADDRESS_HOUR = SignInLimit(
    "organizer-code-request:address-hour", attempts=20, window=timedelta(hours=1))
RESET_LINK_PER_CALLER = SignInLimit("reset-link:caller", attempts=30, window=timedelta(minutes=15))
RESET_LINK_PER_CALLER_AND_ADDRESS = SignInLimit(
    "reset-link:caller-address", attempts=5, window=timedelta(minutes=15))
RESET_LINK_PER_ADDRESS_HOUR = SignInLimit(
    "reset-link:address-hour", attempts=20, window=timedelta(hours=1))
VERIFICATION_LINK_PER_CALLER = SignInLimit(
    "verification-link:caller", attempts=30, window=timedelta(minutes=15))
VERIFICATION_LINK_PER_CALLER_AND_ADDRESS = SignInLimit(
    "verification-link:caller-address", attempts=5, window=timedelta(minutes=15))
VERIFICATION_LINK_PER_ADDRESS_HOUR = SignInLimit(
    "verification-link:address-hour", attempts=20, window=timedelta(hours=1))
SIGN_UP_PER_CALLER = SignInLimit("sign-up:caller", attempts=30, window=timedelta(minutes=15))
SIGN_UP_PER_CALLER_AND_ADDRESS = SignInLimit(
    "sign-up:caller-address", attempts=5, window=timedelta(minutes=15))
SIGN_UP_PER_ADDRESS_HOUR = SignInLimit("sign-up:address-hour", attempts=20, window=timedelta(hours=1))

LIMITS = (
    REQUEST_CODE_PER_CALLER,
    REQUEST_CODE_PER_CALLER_AND_ADDRESS,
    REQUEST_CODE_PER_ADDRESS_HOUR,
    VERIFY_CODE_PER_CALLER,
    VERIFY_CODE_PER_CALLER_AND_ADDRESS,
    VERIFY_CODE_PER_ADDRESS_CEILING,
    RESUME_PER_CALLER,
    CHECK_IN_PER_ADDRESS,
    PASSWORD_PER_CALLER,
    PASSWORD_PER_CALLER_AND_ADDRESS,
    PASSWORD_PER_ADDRESS_CEILING,
    ORGANIZER_CODE_PER_CALLER,
    ORGANIZER_CODE_PER_CALLER_AND_ADDRESS,
    ORGANIZER_CODE_PER_ADDRESS_CEILING,
    ORGANIZER_CODE_REQUEST_PER_CALLER,
    ORGANIZER_CODE_REQUEST_PER_CALLER_AND_ADDRESS,
    ORGANIZER_CODE_REQUEST_PER_ADDRESS_HOUR,
    RESET_LINK_PER_CALLER,
    RESET_LINK_PER_CALLER_AND_ADDRESS,
    RESET_LINK_PER_ADDRESS_HOUR,
    VERIFICATION_LINK_PER_CALLER,
    VERIFICATION_LINK_PER_CALLER_AND_ADDRESS,
    VERIFICATION_LINK_PER_ADDRESS_HOUR,
    SIGN_UP_PER_CALLER,
    SIGN_UP_PER_CALLER_AND_ADDRESS,
    SIGN_UP_PER_ADDRESS_HOUR,
)


# The block of IPv6 addresses one caller is counted as: a line or a machine is handed a /64 network
# of its own, so its addresses are one caller, as one IPv4 address is.
IPV6_CALLER_PREFIX = 64


def caller() -> str:
    """Who is asking: the network the request came from, from the address ``ProxyFix`` settled by
    ``TRUSTED_PROXY_HOPS``. Every per-caller limit names its caller this one way.

    A caller is a network, so one machine is one caller whichever of its addresses it asks from: an
    IPv4 address as it is, an IPv6 address as its /64 network (``2001:db8:1:2::/64``), and an
    IPv4-mapped IPv6 address as the IPv4 address it maps. What is not an address is kept as given.
    """
    remote = request.remote_addr or "unknown"
    try:
        address = ipaddress.ip_address(remote)
    except ValueError:
        return remote
    if address.version == 4:
        return str(address)
    if address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    network = ipaddress.IPv6Network((int(address), IPV6_CALLER_PREFIX), strict=False)
    return str(network)


def caller_and_address(address: str) -> str:
    """The subject of a per-caller-and-address limit: this caller and the normalized ``address``,
    joined by a NUL, which neither holds. The counter's key is a hash of it, as of any subject."""
    return f"{caller()}\0{address}"


def ensure_expiry_index() -> None:
    """Build the TTL index that removes a counter once its window has ended.

    Raises ``PyMongoError`` when it cannot; the applicant login boot check
    (``api.applicant_auth.ensure_applicant_login_indexes``) refuses to start on it.
    """
    attempts_collection.create_index(
        [(EXPIRES_AT_FIELD, 1)],
        expireAfterSeconds=0,
        name="sign_in_attempt_ttl",
    )


def _window(limit: SignInLimit, subject: str, now: datetime) -> Tuple[str, datetime]:
    """The counter key and end of the window ``now`` falls in."""
    window_seconds = limit.window.total_seconds()
    window = math.floor(now.timestamp() / window_seconds)
    window_ends = datetime.fromtimestamp((window + 1) * window_seconds, tz=timezone.utc)
    key = hashlib.sha256(f"{limit.name}\0{subject}\0{window}".encode()).hexdigest()
    return key, window_ends


def count_attempt(limit: SignInLimit, subject: str, now: Optional[datetime] = None) -> Optional[int]:
    """Count one attempt by ``subject`` against ``limit``.

    Returns None while the attempt is within the limit, and otherwise the whole seconds until the
    window ends, for a ``Retry-After``. A refused attempt is counted too, so a caller who keeps
    knocking stays refused until the window ends.
    """
    now = now or datetime.now(timezone.utc)
    key, window_ends = _window(limit, subject, now)
    counter = attempts_collection.find_one_and_update(
        {"_id": key},
        {"$inc": {COUNT_FIELD: 1}, "$setOnInsert": {EXPIRES_AT_FIELD: window_ends}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    if counter[COUNT_FIELD] <= limit.attempts:
        return None
    return max(1, math.ceil((window_ends - now).total_seconds()))


def take_back_attempt(limit: SignInLimit, subject: str, now: datetime) -> None:
    """Take back one attempt ``count_attempt`` counted, for a try that signed in.

    ``now`` is the one the attempt was counted with, so the try leaves the window it was counted
    in. The count never goes below zero, and a counter already removed is left removed.
    """
    key, _ = _window(limit, subject, now)
    attempts_collection.update_one({"_id": key, COUNT_FIELD: {"$gt": 0}}, {"$inc": {COUNT_FIELD: -1}})


def wait_in_words(seconds: int) -> str:
    """A wait as a person reads it: whole minutes, rounded up."""
    minutes = math.ceil(seconds / 60)
    return "1 minute" if minutes == 1 else f"{minutes} minutes"


def too_many(
    retry_after: Optional[int], sentence: str, key: str = "message",
) -> Optional[Tuple[Any, int]]:
    """The 429 for a limit ``count_attempt`` refused, or None when it did not refuse.

    ``sentence`` says plainly how long to wait, with ``{wait}`` where the wait goes
    (``wait_in_words``), under ``key``, the one each caller's screen reads its refusals from (the
    sign-in reads ``message``, the check-in ``error``), with the seconds in ``Retry-After``. One
    refusal for every limit, so the sign-ins' and the check-in's never drift apart.
    """
    if retry_after is None:
        return None
    response = jsonify({key: sentence.format(wait=wait_in_words(retry_after))})
    response.headers["Retry-After"] = str(retry_after)
    return response, 429


@dataclass(frozen=True)
class TooMany:
    """A limit refused the request: its window ends in ``seconds``, the ``Retry-After``."""

    seconds: int


@dataclass(frozen=True)
class HumanCheckNeeded:
    """The address is past its own count, and the try did not pass the human check."""


#: What a bounds shape answers when it refuses; the route says it in its own words (``answer``).
Refusal = Union[TooMany, HumanCheckNeeded]


def answer(
    refusal: Optional[Refusal], sentence: str, key: str = "message",
) -> Optional[Tuple[Any, int]]:
    """The route's answer for a refusal, or None when there was none: the 429 of ``too_many`` with
    the route's ``sentence`` under its ``key``, or the human check's 403 under that ``key``
    (``captcha.human_check_needed``), so the vendor's and the organizer's words stay their own."""
    if refusal is None:
        return None
    if isinstance(refusal, HumanCheckNeeded):
        return captcha.human_check_needed(key)
    return too_many(refusal.seconds, sentence, key=key)


def _refused(limit: SignInLimit, subject: str, now: datetime) -> Optional[TooMany]:
    retry_after = count_attempt(limit, subject, now)
    return None if retry_after is None else TooMany(retry_after)


@dataclass(frozen=True)
class MailBounds:
    """How a request that mails a code or a link is bounded: per caller, per caller and address,
    and per address alone.

    A route keeps one order: ``caller_refusal`` before the body is read, then whatever else it asks
    first (the human check, a missing address), then ``before_the_mail`` before any account,
    application or market is looked up, so a refusal is the same for every address. The pair is
    counted first, and a request it refused is not counted on the address, so one caller adds at
    most the pair's limit to the address's count in a window. Nothing is taken back: each counts a
    request, whether or not a mail went.
    """

    per_caller: SignInLimit
    per_caller_and_address: SignInLimit
    per_address: SignInLimit

    def caller_refusal(self, now: datetime) -> Optional[TooMany]:
        """The refusal when this caller is past its limit, else None; counts the request either way."""
        return _refused(self.per_caller, caller(), now)

    def before_the_mail(self, address: str, now: datetime) -> Optional[TooMany]:
        """The refusal when this caller and ``address`` together, or ``address`` alone, is past its
        limit, else None; counts the pair, then the address unless the pair refused."""
        refused = _refused(self.per_caller_and_address, caller_and_address(address), now)
        if refused is not None:
            return refused
        return _refused(self.per_address, address, now)


@dataclass(frozen=True)
class SecretBounds:
    """How a sign-in that checks a secret (a code or a password) is bounded: per caller, per caller
    and address, and per address alone, past which it asks the human check for ``action``.

    A route keeps one order: ``caller_refusal`` before the body is read, then ``before_the_secret``
    before any account, application or market is looked up, so a refusal and the check's answer
    are the same for every address and every market; then the secret, and ``signed_in`` for a
    right one.

    The pair bounds one caller's guesses at one address, and is the only count that refuses with a
    wait, so no one else's tries ever refuse a person's right secret. A try the pair refused is not
    counted on the address, so one caller adds at most the pair's limit to it in a window. Past the
    address's own count the try must pass the human check, which a person does; one that does not is
    taken back from the pair and the address, so only tries whose secret was checked stay counted.
    """

    per_caller: SignInLimit
    per_caller_and_address: SignInLimit
    per_address: SignInLimit
    action: str

    def caller_refusal(self, now: datetime) -> Optional[TooMany]:
        """The refusal when this caller is past its limit, else None; counts the try either way."""
        return _refused(self.per_caller, caller(), now)

    def before_the_secret(
        self, address: str, captcha_token: Optional[str], now: datetime,
    ) -> Optional[Refusal]:
        """The refusal when this caller and ``address`` together are past their limit, or when
        ``address`` alone is past its own and ``captcha_token`` does not pass the human check; else
        None. Counts the pair, then the address unless the pair refused."""
        pair = caller_and_address(address)
        refused = _refused(self.per_caller_and_address, pair, now)
        if refused is not None:
            return refused
        if count_attempt(self.per_address, address, now) is None:
            return None
        if captcha.captcha_passes(captcha_token, self.action):
            return None
        take_back_attempt(self.per_caller_and_address, pair, now)
        take_back_attempt(self.per_address, address, now)
        return HumanCheckNeeded()

    def signed_in(self, address: str, now: datetime) -> None:
        """Take back a try whose secret was right, from the caller, the pair and the address, in the
        window ``now`` counted it in, so only wrong tries pile up."""
        take_back_attempt(self.per_caller, caller(), now)
        take_back_attempt(self.per_caller_and_address, caller_and_address(address), now)
        take_back_attempt(self.per_address, address, now)
