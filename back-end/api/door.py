"""An organizer checks a vendor in at the door and out again, or undoes either (E29/F01/S02, T496),
makes the market's door code, the vendor's proof that they are at the door (ADR 0022), and sets
the market's self check-in switch.

The vendor's own check-in is on their vendor page, behind their sign-in and the door code
(``api/vendor_check_in.py``); this is the organizer's, keyed by the market's id and held to the table's "Check vendors in" row, EDITOR by default, so a
volunteer at the door is added as an editor. It loads through the change loader, so an archived
market's record is never changed, and it writes through ``record_attendance``, so the two doors
record alike, through the row's asking the change loader returned.

**The door code** is one live code per market, stored on the market document as ``doorCode``
(``{code, madeAt, madeBy}``) and served only here: no market read serves it
(``market_documents.leave_out_what_no_read_serves``), since a Viewer who read it could check
vendors in by proxy. Reading and making it are held to the same "Check vendors in" row; making it
loads through the change loader and only in ``market_days``. A new code replaces the old, which
ends every poster of it; it is recorded in the market's history without the code itself. A code a
vendor sends is compared here (``door_code_matches``), so the live code never leaves this module.

**The self check-in switch** is the market's ``vendorSelfCheckIn``, a boolean that says whether
its vendors check themselves in and out on their vendor page (T496). Absent is off, so every
market is the organizers' door until someone turns it on (``set_self_check_in``); the door code's
read and write answer it as ``selfCheckIn`` beside the code, and the vendor's four routes read it
off the market they load (``vendor_self_check_in_from_market_document``).
"""
import hmac
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

import api.attendance as AttendanceApi
import api.market_actions as Actions
import api.markets as MarketsApi
import history as History
from datatypes import MarketPhase, vendor_self_check_in_from_market_document
from market_documents import market_doc_key
from tombstone import live
from market_write import write_market
from utils.email import frontend_url

NOT_PUBLISHED = AttendanceApi.NOT_PUBLISHED
NO_DOOR_CODE_YET = "A door code is made once the market is published."

#: No 0, O, 1 or I, which a vendor typing the code from a poster would mistake for each other.
DOOR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
DOOR_CODE_LENGTH = 6
DOOR_CODE_KEY = market_doc_key("door_code")

SELF_CHECK_IN_NOT_YET = "Vendors' own check-in is set once the market is published."
SELF_CHECK_IN_MALFORMED = "enabled must be true or false."
#: The stored key of the market's self check-in switch (``Market.vendor_self_check_in``).
SELF_CHECK_IN_KEY = market_doc_key("vendor_self_check_in")


def _market_on_its_days(
    market_id: str, requesting_user: str,
) -> Optional[MarketsApi.MarketChange]:
    """The market loaded to change and its "Check vendors in" asking, or None outside its days."""
    change = MarketsApi._market_change(market_id, requesting_user, Actions.CHECK_IN)
    return change if change.market.phase is MarketPhase.MARKET_DAYS else None


def check_in(
    market_id: str, vendor_email: str, date: str, requesting_user: str,
) -> Tuple[Dict[str, Any], int]:
    """Record that a vendor is here on this date, made by ``requesting_user``: any market date
    that has begun somewhere, so a tap missed in the rush is corrected after, and never one that
    has not (``AttendanceApi.day_has_begun``, refused in ``record_attendance``)."""
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": NOT_PUBLISHED}, 409
    return AttendanceApi.record_attendance(change.asked, vendor_email, date)


def undo_check_in(
    market_id: str, vendor_email: str, date: str, requesting_user: str,
) -> Tuple[Dict[str, Any], int]:
    """Take back a check-in on this date, whoever made it."""
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": NOT_PUBLISHED}, 409
    return AttendanceApi.undo_attendance(change.asked, vendor_email, date)


def check_out(
    market_id: str, vendor_email: str, date: str, requesting_user: str,
) -> Tuple[Dict[str, Any], int]:
    """Record that a vendor left on this date, made by ``requesting_user``: any date with a
    check-in, as the undo of a check-in takes any date (``AttendanceApi.record_check_out``)."""
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": NOT_PUBLISHED}, 409
    return AttendanceApi.record_check_out(change.asked, vendor_email, date)


def undo_check_out(
    market_id: str, vendor_email: str, date: str, requesting_user: str,
) -> Tuple[Dict[str, Any], int]:
    """Take back a check-out on this date, whoever made it."""
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": NOT_PUBLISHED}, 409
    return AttendanceApi.undo_check_out(change.asked, vendor_email, date)


def new_door_code() -> str:
    """Six characters of ``DOOR_CODE_ALPHABET``, each drawn by ``secrets``."""
    return "".join(secrets.choice(DOOR_CODE_ALPHABET) for _ in range(DOOR_CODE_LENGTH))


def door_url(slug: str, code: str) -> str:
    """The vendor page with the code, which the QR code opens:
    ``<app>/<slug>/vendor?door=<code>``."""
    return f"{frontend_url()}/{quote(slug, safe='')}/vendor?door={quote(code, safe='')}"


def normalized_door_code(typed: str) -> str:
    """A typed code as the poster prints it: upper case, its spaces and dashes dropped ("k7m-4qp"
    and "K7M 4QP" are "K7M4QP")."""
    return "".join(typed.split()).replace("-", "").upper()


def door_code_matches(market_id: str, typed: Optional[str]) -> bool:
    """Is ``typed`` this market's live door code? Compared in constant time; a market with no code
    yet matches nothing."""
    held = _held_code(market_id)
    if held is None or not isinstance(typed, str):
        return False
    return hmac.compare_digest(
        normalized_door_code(typed).encode("utf-8"), str(held["code"]).encode("utf-8"))


def _held_code(market_id: str) -> Optional[Dict[str, Any]]:
    document = MarketsApi.markets_collection.find_one(
        live({market_doc_key("id"): market_id}), {DOOR_CODE_KEY: 1})
    held = (document or {}).get(DOOR_CODE_KEY)
    return held if isinstance(held, dict) and held.get("code") else None


def _served(slug: str, held: Optional[Dict[str, Any]], self_check_in: bool) -> Dict[str, Any]:
    """What the door code's screen reads: the code, and the switch beside it."""
    if held is None:
        return {"code": None, "selfCheckIn": self_check_in}
    return {
        "code": held["code"],
        "madeAt": held.get("madeAt"),
        "madeBy": held.get("madeBy"),
        "url": door_url(slug, held["code"]),
        "selfCheckIn": self_check_in,
    }


def door_code(market_id: str, requesting_user: str) -> Dict[str, Any]:
    """The market's live door code and its self check-in switch,
    ``{code, madeAt, madeBy, url, selfCheckIn}``, or ``{code: None, selfCheckIn}``."""
    market = MarketsApi._load_market_for(market_id, requesting_user, Actions.CHECK_IN)
    return _served(market.slug, _held_code(market_id), market.vendor_self_check_in)


def set_self_check_in(
    market_id: str, body: Dict[str, Any], requesting_user: str,
) -> Tuple[Dict[str, Any], int]:
    """Turn the market's self check-in switch on or off, by a request body ``{enabled}``: whether
    its vendors check themselves in and out on their vendor page, and undo either
    (``api/vendor_check_in.py``). The organizer's door never reads it.

    The body is read here, after the person is let in, so a stranger is refused before its shape
    is: it holds ``enabled``, a JSON boolean, and no other key, else 400
    ``SELF_CHECK_IN_MALFORMED``.

    Held to the "Check vendors in" row through the change loader, only in ``market_days``, as
    making the door code is. It is apart from the door code: the code stays stored while the
    switch is off and works again, with every poster of it, once it is on, and making a code does
    not turn it on. A switch restated writes and records nothing. Answers what the door code's
    read does.

    Raises:
        MarketChanged: the market moved, or the switch was set, since it was loaded; nothing was
            written.
    """
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": SELF_CHECK_IN_NOT_YET}, 409
    enabled = body.get("enabled")
    if set(body) != {"enabled"} or not isinstance(enabled, bool):
        return {"error": SELF_CHECK_IN_MALFORMED}, 400
    market = change.market
    before = market.vendor_self_check_in
    if before != enabled:
        # Holding the phase it was loaded in, and the switch as read.
        write_market(market, {"$set": {SELF_CHECK_IN_KEY: enabled}}, holds=(SELF_CHECK_IN_KEY,))
        change.asked.record(
            kind=History.SELF_CHECK_IN_SET,
            detail=lambda: History.changes({"enabled": before}, {"enabled": enabled}))
    return _served(market.slug, _held_code(market_id), enabled), 200


def make_door_code(market_id: str, requesting_user: str) -> Tuple[Dict[str, Any], int]:
    """Make a new door code, the first or a replacement, which ends the old one at once.

    Raises:
        MarketChanged: the market moved since it was loaded; no code was made.
    """
    change = _market_on_its_days(market_id, requesting_user)
    if change is None:
        return {"error": NO_DOOR_CODE_YET}, 409
    market = change.market
    before = _held_code(market_id)
    made = {
        "code": new_door_code(),
        "madeAt": datetime.now(timezone.utc).isoformat(),
        "madeBy": requesting_user,
    }
    # Holding the phase it was loaded in, so a market archived since is not changed.
    write_market(market, {"$set": {DOOR_CODE_KEY: made}})
    change.asked.record(kind=History.DOOR_CODE_MADE, detail={"replaced": before is not None})
    return _served(market.slug, made, market.vendor_self_check_in), 200
