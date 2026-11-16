"""Single owner of what a vendor owes and what they have paid (E44/F01/S01).

Conventioner tracks what is expected and what came in, not accounting (Daniel, T92 Q5): vendors pay
outside the app, by e-transfer or cash (Q7), and an organizer records each payment here.

- **The amount owed is kept per table-day** (Q26): by default the price of the seat the vendor holds
  that day, priced as the drawer's date cards price it (``pricing.Groups``), so it follows the seat
  while nobody has set it by hand.
  An amount an Admin sets by hand (``OwedEvent.ADMIN_SETS``) holds whatever the seat does, until
  "Use the calculated price" takes it back; setting $0 is how a fee is waived.
- **Freeing a table never changes either amount by itself** (Q26: after the cancellation deadline
  "the amount owed and amount paid dont change even though the table did"): the seat's line is kept
  as it stood when it was freed, still owed, until someone sets the amount.
  A free that asks "Also remove its $35.00 from what they owe?" waives the day in that same
  write; a seat held on the day always wins over it (``on_day``, T270).
- **Each owed table-day stores its state** (T335), written only by ``owed_day_transition``, which
  holds the record's ``revision``; ``lines`` is a projection of that state and the held seat.
- **The amount paid is the sum of the vendor's entries still standing**, each with who recorded it
  and when (Q15): a payment, or a refund an Admin records as a negative entry once it is given back
  (Q26). An edit or a removal keeps what the entry read before in its own ``changes``, and a removed
  entry is kept, marked, rather than deleted.
- **An entry is recorded once per press of Record** (T270): it keeps the ``request_key`` the dialog
  sent, unique on the market, so a press repeated after its answer was lost records nothing new.

Two collections, each a record kind keyed by market: ``payments``, one document per payment, and
``amounts_owed``, one document per vendor per table-day that holds something the seat cannot say -
the line of a freed table, or an amount set by hand - in its ``state``, beside the ``freed`` and
``set_by_hand`` the release before reads, kept as a mirror (``legacy_fields``). A seat held now
is read from the market's assignment, never copied here. Like ``vendor_notes``, no applicant
endpoint reads either: what a vendor owes is the organizers' to read (Q20.2).

Storage contract: snake_case with the market foreign key ``market_id`` and the vendor's address
lowercased; every reader and writer goes through this module, and a market's payments and amounts
owed are deleted with the market (``market_deletion``).
"""
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple, Union

from pymongo.errors import DuplicateKeyError

from datatypes import PaymentEntry
from db_config import get_database
from unique_indexes import ensure_unique_index, ensure_vendor_day_index
from utils.email_address import normalized_email

logger = logging.getLogger(__name__)

PAYMENTS_COLLECTION = "payments"
AMOUNTS_OWED_COLLECTION = "amounts_owed"
MARKET_ID_FIELD = "market_id"
VENDOR_EMAIL_FIELD = "vendor_email"
#: The key the Record payment dialog made when it opened, sent on each press of that opening.
REQUEST_KEY_FIELD = "request_key"
REQUEST_KEY_INDEX = "payments_request_key_unique"

db = get_database()
payments_collection = db[PAYMENTS_COLLECTION]
amounts_owed_collection = db[AMOUNTS_OWED_COLLECTION]


def ensure_payment_indexes() -> None:
    """One owed record per vendor's day, and one entry per request key, held by the database
    (T270).

    Two writes of a day with no record yet - an Admin setting the amount as an Editor frees the
    seat - both read none and both insert, so only a unique index keeps the day one record: it
    refuses the second insert, and ``owed_day_transition`` reads the day again. ``app.py`` builds
    it at boot and refuses to start without it (``unique_indexes``).
    """
    ensure_vendor_day_index(amounts_owed_collection, AMOUNTS_OWED_COLLECTION)
    # One entry per press of Record payment: pressing it again after the first answer never came
    # back recorded the payment twice. Partial to string keys, since an entry recorded before the
    # key, or by a tab on an older bundle, has none.
    ensure_unique_index(
        payments_collection, (MARKET_ID_FIELD, REQUEST_KEY_FIELD), REQUEST_KEY_INDEX,
        shown=(MARKET_ID_FIELD,), one="one request key",
        partial={REQUEST_KEY_FIELD: {"$type": "string"}},
    )


@dataclass(frozen=True)
class Seat:
    """One table-day a vendor holds, and what the pricing says it costs: None where unpriced."""

    table_code: str
    tier: str
    table_choice: str
    cents: Optional[int]
    #: The card's row that set the price: a price group's name, "Everyone else" on a card with
    #: groups, or None on a card without (E43/F01/S02).
    group: Optional[str] = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _vendor(market_id: str, vendor_email: str) -> Dict[str, str]:
    return {MARKET_ID_FIELD: market_id, VENDOR_EMAIL_FIELD: normalized_email(vendor_email)}


# --- The amount paid ------------------------------------------------------------------------------

#: An entry is a payment the vendor made, or a refund an Admin gave back (E44/F01/S02), stored as a
#: negative amount so the amount paid is the sum of every entry still standing.
PAYMENT = "payment"
REFUND = "refund"

#: An entry's fields as a person gives them, and as an edit or a removal records them.
ENTRY_FIELDS = ("cents", "method", "paid_on", "note")


def _signed(entry: PaymentEntry, kind: str) -> Dict[str, Any]:
    fields = entry.model_dump()
    if kind == REFUND:
        fields["cents"] = -fields["cents"]
    return fields


def record_payment(
    market_id: str, vendor_email: str, entry: PaymentEntry, by: str, kind: str = PAYMENT,
    request_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Keep one payment, or a refund, with who recorded it and when. Returns it as stored.

    With a ``request_key``, the market's unique index refuses a second entry with that key by
    raising ``DuplicateKeyError``; the caller looks the first up (``entry_with_request_key``).
    """
    stored = {
        "id": str(uuid.uuid4()),
        **_vendor(market_id, vendor_email),
        "kind": kind,
        **_signed(entry, kind),
        "recorded_by": by,
        "recorded_at": _now(),
    }
    if request_key is not None:
        stored[REQUEST_KEY_FIELD] = request_key
    payments_collection.insert_one(dict(stored))
    return stored


def entry_with_request_key(market_id: str, request_key: str) -> Optional[Dict[str, Any]]:
    """The entry this market recorded with ``request_key``, removed or not, or None."""
    return payments_collection.find_one({MARKET_ID_FIELD: market_id,
                                         REQUEST_KEY_FIELD: request_key})


def same_entry(doc: Mapping[str, Any], vendor_email: str, entry: PaymentEntry, kind: str) -> bool:
    """Whether a stored entry is the one ``entry`` would record: the same vendor, kind and
    fields."""
    return (doc.get(VENDOR_EMAIL_FIELD) == normalized_email(vendor_email)
            and (doc.get("kind") or PAYMENT) == kind
            and {key: doc.get(key) for key in ENTRY_FIELDS} == _signed(entry, kind))


def payment(market_id: str, payment_id: str) -> Optional[Dict[str, Any]]:
    """One entry of this market, removed or not, or None."""
    return payments_collection.find_one({MARKET_ID_FIELD: market_id, "id": payment_id})


def _trail(doc: Mapping[str, Any], by: str, what: str) -> Dict[str, Any]:
    """One line of an entry's own history: who changed it, when, and what it read before."""
    return {"by": by, "at": _now(), "what": what,
            "before": {key: doc.get(key) for key in ENTRY_FIELDS}}


def edit_payment(
    market_id: str, payment_id: str, entry: PaymentEntry, by: str,
) -> Optional[Dict[str, Any]]:
    """Change a standing entry's fields, keeping what it read before in its own history. Returns
    the entry as it now reads, or None when this market has no such entry standing."""
    doc = payment(market_id, payment_id)
    if doc is None or doc.get("removed_at"):
        return None
    payments_collection.update_one(
        {MARKET_ID_FIELD: market_id, "id": payment_id},
        {"$set": _signed(entry, doc.get("kind") or PAYMENT),
         "$push": {"changes": _trail(doc, by, "edited")}},
    )
    return payment(market_id, payment_id)


def remove_payment(market_id: str, payment_id: str, by: str) -> Optional[Dict[str, Any]]:
    """Take a standing entry out of the amount paid. It is kept, marked removed with who and
    when, so its own history stands. Returns it as it now reads, or None when there is none."""
    doc = payment(market_id, payment_id)
    if doc is None or doc.get("removed_at"):
        return None
    payments_collection.update_one(
        {MARKET_ID_FIELD: market_id, "id": payment_id},
        {"$set": {"removed_by": by, "removed_at": _now()},
         "$push": {"changes": _trail(doc, by, "removed")}},
    )
    return payment(market_id, payment_id)


def _last_first(found: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(found, key=lambda doc: doc.get("recorded_at") or "", reverse=True)


def payments_for(market_id: str, vendor_email: str) -> List[Dict[str, Any]]:
    """One vendor's entries, removed ones too, the last recorded first."""
    return _last_first(payments_collection.find(_vendor(market_id, vendor_email)))


def payments_by_vendor(market_id: str) -> Dict[str, List[Dict[str, Any]]]:
    """Every vendor's entries on the market, by address, each as ``payments_for`` reads it."""
    found: Dict[str, List[Dict[str, Any]]] = {}
    for doc in _last_first(payments_collection.find({MARKET_ID_FIELD: market_id})):
        found.setdefault(doc.get(VENDOR_EMAIL_FIELD) or "", []).append(doc)
    return found


# --- The amount owed ------------------------------------------------------------------------------
#
# Each owed table-day stores its state (T335): it follows the seat (no record at all), an Admin set
# an amount (``SetByHand``), its table was freed (``Freed``), or it was freed and waived by the
# free's deduction (``FreedWaived``). ``next_owed_state`` is the one table of what each event makes
# of each state, ``owed_day_transition`` the one writer of a record, and ``lines`` a projection of
# the state and the held seat.

def _owed_key(market_id: str, vendor_email: str, date: str) -> Dict[str, str]:
    return {**_vendor(market_id, vendor_email), "date": date}


#: The seat's fields as a freed record keeps them.
_SEAT_FIELDS = ("table_code", "tier", "table_choice", "cents", "group")


@dataclass(frozen=True)
class HandAmount:
    """An amount owed an Admin chose for a table-day, $0 being a waiver, with who and when."""

    cents: int
    by: Optional[str]
    at: Optional[str]

    def to_stored(self) -> Dict[str, Any]:
        return {"cents": self.cents, "by": self.by, "at": self.at}

    @classmethod
    def from_stored(cls, doc: Any) -> Optional["HandAmount"]:
        if not isinstance(doc, Mapping):
            return None
        return cls(doc["cents"], doc.get("by"), doc.get("at"))


@dataclass(frozen=True)
class FreedSeat:
    """The seat of a freed table-day as it stood when it was freed, and who freed it and when."""

    seat: Seat
    by: Optional[str]
    at: Optional[str]

    def to_stored(self) -> Dict[str, Any]:
        """The ``seat`` and ``freed`` of a freed state's stored ``state``."""
        return {"seat": _seat_stored(self.seat), "freed": {"by": self.by, "at": self.at}}

    def to_legacy(self) -> Dict[str, Any]:
        """The ``freed`` field the release before reads: the seat's fields beside who and when."""
        return {**_seat_stored(self.seat), "by": self.by, "at": self.at}


def _seat_from(doc: Mapping[str, Any]) -> Seat:
    return Seat(**{key: doc.get(key) for key in _SEAT_FIELDS})


def _seat_stored(seat: Seat) -> Dict[str, Any]:
    return {key: getattr(seat, key) for key in _SEAT_FIELDS}


@dataclass(frozen=True)
class FollowsSeat:
    """The day owes what its held seat costs, or nothing without one: no record is stored."""

    kind = "follows_seat"

    def to_stored(self) -> None:
        return None


@dataclass(frozen=True)
class SetByHand:
    """An Admin set what the day owes; it holds through a move of the seat."""

    amount: HandAmount
    kind = "set"

    def to_stored(self) -> Dict[str, Any]:
        return {"kind": self.kind, "amount": self.amount.to_stored()}


@dataclass(frozen=True)
class Freed:
    """The day's table was freed: its line is kept as the seat stood, still owed, owing the
    Admin's amount if one stands, else the freed seat's price."""

    freed: FreedSeat
    amount: Optional[HandAmount]
    kind = "freed"

    def to_stored(self) -> Dict[str, Any]:
        stored: Dict[str, Any] = {"kind": self.kind, **self.freed.to_stored()}
        if self.amount is not None:
            stored["amount"] = self.amount.to_stored()
        return stored


@dataclass(frozen=True)
class FreedWaived:
    """The day's table was freed by a free that ticked "Also remove its $35.00 from what they
    owe?": the line owes $0, and keeps the Admin's amount it replaced (``before``), which seating
    the day again puts back."""

    freed: FreedSeat
    waiver_by: Optional[str]
    waiver_at: Optional[str]
    before: Optional[HandAmount]
    kind = "freed_waived"

    def to_stored(self) -> Dict[str, Any]:
        stored: Dict[str, Any] = {"kind": self.kind, **self.freed.to_stored(),
                                  "waiver": {"by": self.waiver_by, "at": self.waiver_at}}
        if self.before is not None:
            stored["before"] = self.before.to_stored()
        return stored


OwedState = Union[FollowsSeat, SetByHand, Freed, FreedWaived]


def owed_state_from_stored(doc: Optional[Mapping[str, Any]]) -> OwedState:
    """A record's stored ``state`` as its state; ``ValueError`` (or a ``KeyError``) when it is not
    one this build reads."""
    if doc is None:
        return FollowsSeat()
    kind = doc.get("kind")
    if kind == SetByHand.kind:
        return SetByHand(HandAmount.from_stored(doc["amount"]) or _unreadable(doc))
    if kind in (Freed.kind, FreedWaived.kind):
        freed = FreedSeat(_seat_from(doc["seat"]), doc["freed"].get("by"), doc["freed"].get("at"))
        if kind == Freed.kind:
            return Freed(freed, HandAmount.from_stored(doc.get("amount")))
        return FreedWaived(freed, doc["waiver"].get("by"), doc["waiver"].get("at"),
                           HandAmount.from_stored(doc.get("before")))
    return _unreadable(doc)


def _unreadable(doc: Any) -> Any:
    raise ValueError(f"not an owed state this build reads: {doc!r}")


class OwedEvent(str, Enum):
    """What may happen to an owed table-day."""

    #: A placement, a move, a swap or a run that seats the day.
    SEATED = "seated"
    #: The day's table freed, the free unticked.
    FREED = "freed"
    #: The day's table freed with "Also remove its $35.00 from what they owe?" ticked.
    FREED_WITH_DEDUCTION = "freed_with_deduction"
    #: A run that leaves the vendor without a table on the day.
    DROPPED_BY_RUN = "dropped_by_run"
    #: An Admin's "Change the amount owed".
    ADMIN_SETS = "admin_sets"
    #: An Admin's "Use the calculated price".
    ADMIN_CALCULATED = "admin_calculated"


class OwedEventRefused(Exception):
    """An event the day's state does not take: nothing is written."""


class OwedDayChanged(Exception):
    """The day's record kept changing between the owner's read and its write, ``OWED_TRIES``
    times: nothing was written."""


def on_day(state: OwedState, held: bool) -> OwedState:
    """The state a day reads as, ``held`` or not in the assignment read.

    A held seat always wins over a free (T270): on a held day a freed state is a free that stopped
    before its seat went, or a seating that stopped before it tidied the day, so it reads as
    seating the day makes it. On a day not held, an Admin's amount is no line anybody sees (a
    record a rolled-back release left), so it reads as following the seat.
    """
    if held:
        if isinstance(state, Freed):
            return SetByHand(state.amount) if state.amount else FollowsSeat()
        if isinstance(state, FreedWaived):
            return SetByHand(state.before) if state.before else FollowsSeat()
        return state
    if isinstance(state, SetByHand):
        return FollowsSeat()
    return state


def next_owed_state(
    state: OwedState, event: OwedEvent, *, held: bool, cents: Optional[int] = None,
    seat: Optional[Seat] = None, by: Optional[str], at: Optional[str],
) -> OwedState:
    """What ``event`` makes of a day in ``state``, ``held`` or not in the assignment the write
    read: the one table of every (state, event), raising ``OwedEventRefused`` on a refused cell.

    ``seat`` is the seat being freed, on ``FREED`` and on ``FREED_WITH_DEDUCTION`` of a held day;
    ``cents`` the Admin's amount on ``ADMIN_SETS``. The state is read through ``on_day`` first,
    so a held day is following its seat or set, and a day not held is following it or freed.

    Except that an Admin's amount on a freed record keeps the freed seat even on a held day: the
    Admin's request read the seat before a free may have, and a free in flight has written its
    record but not yet freed the seat. Kept with the seat, the amount reads as set while the seat
    is held, and as the freed line's once it goes, so either way the free ends the day is right.
    """
    freed_line = isinstance(state, (Freed, FreedWaived)) and (
        not held or event in (OwedEvent.ADMIN_SETS, OwedEvent.ADMIN_CALCULATED))
    state = state if freed_line else on_day(state, held)
    standing = state.amount if isinstance(state, SetByHand) else None

    if event == OwedEvent.SEATED:
        # Seated, the day reads as a held day does.
        return on_day(state, True)
    if event == OwedEvent.FREED:
        if not held:
            raise OwedEventRefused()
        return Freed(FreedSeat(_needed(seat, "seat"), by, at), standing)
    if event == OwedEvent.FREED_WITH_DEDUCTION:
        if held:
            return FreedWaived(FreedSeat(_needed(seat, "seat"), by, at), by, at, standing)
        # Pressing Free again on a day a free from before T270 left freed and owing its full
        # amount, which stopped between its seat and its deduction, finishes that deduction.
        if isinstance(state, Freed) and state.amount is None:
            return FreedWaived(state.freed, by, at, None)
        raise OwedEventRefused()
    if event == OwedEvent.DROPPED_BY_RUN:
        return FollowsSeat() if held else state
    if event == OwedEvent.ADMIN_SETS:
        amount = HandAmount(_needed(cents, "cents"), by, at)
        if freed_line:
            # Kept with its seat, so the line still says where it came from.
            return Freed(state.freed, amount)
        if not held:
            raise OwedEventRefused()
        return SetByHand(amount)
    if event == OwedEvent.ADMIN_CALCULATED:
        if freed_line:
            return Freed(state.freed, None)
        if not held:
            raise OwedEventRefused()
        return FollowsSeat()
    raise ValueError(f"not an owed event: {event!r}")


def _needed(value: Any, name: str) -> Any:
    if value is None:
        raise ValueError(f"this event needs its {name}")
    return value


# The legacy fields, kept as a mirror for one release: the release before reads ``freed`` and
# ``set_by_hand`` alone, so every write stores them as it would, and a rollback past this release
# reads every line as it did.

def legacy_fields(state: OwedState) -> Dict[str, Any]:
    """The ``freed`` and ``set_by_hand`` the release before reads ``state`` from."""
    freed: Optional[Dict[str, Any]] = None
    set_by_hand: Optional[Dict[str, Any]] = None
    if isinstance(state, (Freed, FreedWaived)):
        freed = state.freed.to_legacy()
    if isinstance(state, SetByHand):
        set_by_hand = state.amount.to_stored()
    elif isinstance(state, Freed) and state.amount is not None:
        set_by_hand = state.amount.to_stored()
    elif isinstance(state, FreedWaived):
        set_by_hand = {"cents": 0, "by": state.waiver_by, "at": state.waiver_at, "by_free": True}
        if state.before is not None:
            set_by_hand["replaced"] = state.before.to_stored()
    return {"freed": freed, "set_by_hand": set_by_hand}


def _legacy_of(doc: Mapping[str, Any]) -> Dict[str, Any]:
    return {"freed": doc.get("freed") or None, "set_by_hand": doc.get("set_by_hand") or None}


def derive_from_legacy(doc: Mapping[str, Any]) -> OwedState:
    """The state the release before's fields say, for a record with no ``state``, or one whose
    mirror disagrees with it: a free's $0 with no freed seat is a free that stopped before its
    seat went, and reads as the Admin's amount it replaced, or as following the seat."""
    freed = doc.get("freed")
    by_hand = doc.get("set_by_hand")
    if not isinstance(by_hand, Mapping) or not by_hand:
        by_hand = None
    if isinstance(freed, Mapping) and freed:
        seat = FreedSeat(_seat_from(freed), freed.get("by"), freed.get("at"))
        if by_hand is None:
            return Freed(seat, None)
        if by_hand.get("by_free"):
            return FreedWaived(seat, by_hand.get("by"), by_hand.get("at"),
                               HandAmount.from_stored(by_hand.get("replaced")))
        return Freed(seat, HandAmount.from_stored(by_hand))
    if by_hand is None:
        return FollowsSeat()
    if by_hand.get("by_free"):
        replaced = HandAmount.from_stored(by_hand.get("replaced"))
        return SetByHand(replaced) if replaced else FollowsSeat()
    return SetByHand(HandAmount.from_stored(by_hand))


def _named(doc: Mapping[str, Any]) -> str:
    """A record as a log names it: by market, date and record id, never the vendor's address."""
    return (f"market_id {doc.get(MARKET_ID_FIELD)}, date {doc.get('date')}, "
            f"record {doc.get('_id')}")


#: What reading a malformed stored state or legacy field raises.
_UNREADABLE = (KeyError, TypeError, ValueError, AttributeError)


def _read_record(doc: Optional[Mapping[str, Any]]) -> Tuple[OwedState, bool]:
    """``state_of`` a record, and whether that is its stored ``state``, trusted because its
    mirror agrees (or there is no record): only then is a result equal to it nothing to write."""
    if doc is None:
        return FollowsSeat(), True
    stored = doc.get("state")
    if stored is not None:
        try:
            state: Optional[OwedState] = owed_state_from_stored(stored)
        except _UNREADABLE:
            state = None
        if state is not None and _legacy_of(doc) == legacy_fields(state):
            return state, True
        logger.warning("Owed record %s holds a state its legacy fields disagree with; read from "
                       "the legacy fields.", _named(doc))
    try:
        return derive_from_legacy(doc), False
    except _UNREADABLE:
        logger.warning("Owed record %s could not be read; read as following the seat.",
                       _named(doc))
        return FollowsSeat(), False


def state_of(doc: Optional[Mapping[str, Any]]) -> OwedState:
    """The state of a stored record, or following the seat for none. Never raises.

    The stored ``state`` is trusted only while the legacy fields agree with it: a rolled-back
    release writes only them, so a record whose mirror disagrees is read from what that release
    wrote, with a warning on each read, until its next write stores the state again.
    """
    return _read_record(doc)[0]


def _reading(doc: Optional[Mapping[str, Any]], state: OwedState, held: bool) -> OwedState:
    """The state the stored day ``doc``, read as ``state``, reads as (``on_day``), logging an
    Admin's amount on a day not held: no line shows it, so it reads as following the seat until
    the migration drops it."""
    if doc is not None and not held and isinstance(state, SetByHand):
        logger.warning("Owed record %s holds an amount set by hand on a day not held; read as "
                       "following the seat.", _named(doc))
    return on_day(state, held)


#: How many times the owner reads a day whose record changed between its read and its write.
OWED_TRIES = 3

#: The fields of a record its owner writes, and an ``undo`` puts back.
_OWNED_FIELDS = ("state", "freed", "set_by_hand", "revision")


@dataclass(frozen=True)
class OwedTransition:
    """What ``owed_day_transition`` did to one vendor's day: the state the day read as
    (``before``), the state it left (``after``), the record as read, the revision written (None
    for a record deleted or nothing written), and whether what the day reads as changed, which
    alone the history records: a write that only tidies a stopped free's record on a held day
    leaves the day reading as it did."""

    key: Dict[str, str]
    before: OwedState
    after: OwedState
    record: Optional[Dict[str, Any]]
    revision: Optional[int]
    wrote: bool
    changed: bool

    def undo(self) -> None:
        """Put the record back as it was read, for a free whose seat could not be freed, and only
        while it still holds the revision written: a write that landed since is the day's now."""
        if not self.wrote:
            return
        if self.revision is None:
            # Deleted: back only while no write has made the day a record since.
            if self.record is not None and amounts_owed_collection.find_one(self.key) is None:
                try:
                    amounts_owed_collection.insert_one(dict(self.record))
                except DuplicateKeyError:
                    # A write made the day a record between the read and the insert: it is the
                    # day's now, as for a record changed since.
                    pass
            return
        still_written = {**self.key, "revision": self.revision}
        if self.record is None:
            amounts_owed_collection.delete_one(still_written)
            return
        restore: Dict[str, Any] = {}
        as_read = {field: self.record[field] for field in _OWNED_FIELDS if field in self.record}
        if as_read:
            restore["$set"] = as_read
        lacked = {field: "" for field in _OWNED_FIELDS if field not in self.record}
        if lacked:
            restore["$unset"] = lacked
        amounts_owed_collection.update_one(still_written, restore)


def _held_after(event: OwedEvent, held: bool) -> bool:
    """Whether the day is held once ``event`` has happened: seated, it is; freed or dropped, not."""
    if event == OwedEvent.SEATED:
        return True
    if event in (OwedEvent.FREED, OwedEvent.FREED_WITH_DEDUCTION, OwedEvent.DROPPED_BY_RUN):
        return False
    return held


def owed_day_transition(
    market_id: str, vendor_email: str, date: str, event: OwedEvent, *,
    held: Optional[Seat], by: Optional[str], cents: Optional[int] = None,
    seat: Optional[Seat] = None,
) -> OwedTransition:
    """The only writer of an ``amounts_owed`` record: read the day, apply ``event`` to the state it
    reads as (``on_day``), and write the result holding what was read.

    ``held`` is the seat the day holds in the assignment the caller read, or None; for
    ``SEATED`` it is the seat held before the write. A result that is the stored state exactly
    writes nothing. Otherwise a day with no record gets one by ``insert_one`` at ``revision`` 1
    (none for following the seat), and the unique index refuses one created since (T270); a
    record read is updated, or deleted for following the seat, only while it holds the
    ``revision`` read. A refusal or a miss reads the day again, and after ``OWED_TRIES`` reads
    ``OwedDayChanged`` is raised having written nothing. A refused cell raises
    ``OwedEventRefused``, also having written nothing.

    Not a transaction with the seat's write: a free writes this first, while the seat is held,
    and a freed state on a held day reads as the seat (``on_day``), so a free that stopped in
    between is harmless.
    """
    key = _owed_key(market_id, vendor_email, date)
    for _ in range(OWED_TRIES):
        doc = amounts_owed_collection.find_one(key)
        stored, trusted = _read_record(doc)
        before = _reading(doc, stored, held is not None)
        after = next_owed_state(stored, event, held=held is not None, cents=cents, seat=seat,
                                by=by, at=_now())
        changed = before != on_day(after, _held_after(event, held is not None))
        if after == stored and trusted:
            return OwedTransition(key, before, after, doc, None, False, changed)
        if doc is None:
            revision = 1
            try:
                amounts_owed_collection.insert_one(
                    {**key, "state": after.to_stored(), **legacy_fields(after),
                     "revision": revision})
            except DuplicateKeyError:
                continue
            return OwedTransition(key, before, after, doc, revision, True, changed)
        read = doc.get("revision")
        holding = {**key, "_id": doc["_id"],
                   "revision": read if read is not None else {"$exists": False}}
        if isinstance(after, FollowsSeat):
            if amounts_owed_collection.delete_one(holding).deleted_count:
                return OwedTransition(key, before, after, doc, None, True, changed)
            continue
        revision = (read or 0) + 1
        if amounts_owed_collection.update_one(holding, {"$set": {
                "state": after.to_stored(), **legacy_fields(after), "revision": revision,
        }}).matched_count:
            return OwedTransition(key, before, after, doc, revision, True, changed)
    raise OwedDayChanged()


def amounts_owed_for(market_id: str, vendor_email: str) -> Dict[str, Dict[str, Any]]:
    """What is kept of one vendor's table-days, by date."""
    return {
        doc["date"]: doc
        for doc in amounts_owed_collection.find(_vendor(market_id, vendor_email))
    }


def amounts_owed_by_vendor(market_id: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """What is kept of every vendor's table-days on the market, by address, then by date."""
    found: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for doc in amounts_owed_collection.find({MARKET_ID_FIELD: market_id}):
        found.setdefault(doc.get(VENDOR_EMAIL_FIELD) or "", {})[doc["date"]] = doc
    return found


def records_that_may_move(market_id: str, dates: Iterable[str]) -> List[Dict[str, Any]]:
    """The market's owed records a write of the assignment may change: each holding a freed line,
    which seating its day again takes back, and any on ``dates``, those of the days it seats afresh
    (which may hold an amount a rolled-back release left on a day not held) or drops. One read, so
    a run never reads the market's records one by one; the caller keeps the vendor-days it wrote."""
    dates = sorted(set(dates))
    either: List[Dict[str, Any]] = [{"freed": {"$type": "object"}}]
    if dates:
        either.append({"date": {"$in": dates}})
    return list(amounts_owed_collection.find({MARKET_ID_FIELD: market_id, "$or": either}))


def _line(date: str, seat: Seat, amount: Optional[HandAmount], *, by_free: bool = False,
          freed: Optional[FreedSeat] = None) -> Dict[str, Any]:
    return {
        "date": date,
        "tableCode": seat.table_code,
        "tier": seat.tier,
        "tableChoice": seat.table_choice,
        "group": seat.group,
        "priceCents": seat.cents,
        "owedCents": amount.cents if amount else seat.cents,
        "owedSetBy": amount.by if amount else None,
        "owedSetAt": amount.at if amount else None,
        # Set by the free that asked "Also remove its $35.00 …?", not by hand: seating the day
        # again takes it back, so the tab says which amounts hold.
        "owedByFree": by_free,
        "freed": freed is not None,
        "freedAt": freed.at if freed else None,
        "freedBy": freed.by if freed else None,
    }


def lines(
    seats: Mapping[str, Seat], kept: Mapping[str, Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """A vendor's table-day lines, by date, camelCased for the wire: a projection of each day's
    state as it reads (``on_day``) and the seat held on it, reading nothing else of the record.

    A held day reads its seat and its price, or the amount an Admin set; a freed day reads the
    seat as it was freed, with who freed it and when, owing the Admin's amount if one stands, its
    price if none, or the free's $0; a day neither held nor freed has no line.
    """
    found = []
    for date in sorted({*seats, *kept}):
        held = seats.get(date)
        doc = kept.get(date)
        state = _reading(doc, state_of(doc), held is not None)
        if held is not None:
            found.append(_line(date, held, state.amount if isinstance(state, SetByHand) else None))
        elif isinstance(state, Freed):
            found.append(_line(date, state.freed.seat, state.amount, freed=state.freed))
        elif isinstance(state, FreedWaived):
            found.append(_line(date, state.freed.seat,
                               HandAmount(0, state.waiver_by, state.waiver_at),
                               by_free=True, freed=state.freed))
    return found


def _payment(doc: Mapping[str, Any]) -> Dict[str, Any]:
    edits = [change for change in doc.get("changes") or [] if change.get("what") == "edited"]
    return {
        "id": doc.get("id"),
        "kind": doc.get("kind") or PAYMENT,
        "cents": doc.get("cents"),
        "method": doc.get("method"),
        "paidOn": doc.get("paid_on"),
        "note": doc.get("note") or "",
        "recordedBy": doc.get("recorded_by"),
        "recordedAt": doc.get("recorded_at"),
        "editedBy": edits[-1]["by"] if edits else None,
        "editedAt": edits[-1]["at"] if edits else None,
        "removedBy": doc.get("removed_by"),
        "removedAt": doc.get("removed_at"),
    }


def account(
    currency: Optional[str], day_lines: List[Dict[str, Any]], paid: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """A vendor's account as the drawer's Payment tab reads it: each line, each entry, the two
    totals, and how they compare (``balanceState`` and ``compares``), which every screen words as
    it is served and keeps no copy of. An unpriced line owes nothing toward the total, and a
    removed entry pays nothing."""
    held: Dict[str, Any] = {
        "currency": currency,
        "lines": day_lines,
        "payments": [_payment(doc) for doc in paid],
        "owedCents": sum(line["owedCents"] or 0 for line in day_lines),
        "paidCents": sum(doc.get("cents") or 0 for doc in paid if not doc.get("removed_at")),
    }
    return {**held, "balanceState": balance_state(held), "compares": compares(held)}


#: How what a vendor paid compares with what they owe, served on every account for the screens to
#: word (``balanceText`` in ``front-end/src/utils/payments.ts``): "Owes $27.00", "Paid in full", or
#: "Paid $15.00 more than owed", a refund to issue (Q26). Nothing owed and nothing paid is none.
OWES = "owes"
PAID_IN_FULL = "paid"
PAID_MORE = "over"
BALANCE_STATES = {OWES: "Owes", PAID_IN_FULL: "Paid in full", PAID_MORE: "Paid more than owed"}


def compares(vendor_account: Mapping[str, Any]) -> bool:
    """Whether what an ``account`` paid compares with what it owes: always on a market with prices,
    and on one without (no ``currency``) only for an account owing an amount set by hand, or one
    refunded beyond what it paid, whose negative amount paid is money owed back to the market. The
    reading follows the account, not the market (T153 review findings 10, 12 and 14)."""
    return (vendor_account["currency"] is not None or bool(vendor_account["owedCents"])
            or vendor_account["paidCents"] < 0)


def balance_state(vendor_account: Mapping[str, Any]) -> Optional[str]:
    """Which of ``BALANCE_STATES`` an ``account`` is in, or None for nothing owed and none paid.

    On a market without prices (no ``currency``) an account owing nothing is in none either,
    whatever it paid, so long as that is not below nothing: nothing is priced, so a payment is not
    "more than owed". One owing an amount set by hand, or refunded beyond what it paid, reads as
    anywhere (``compares``)."""
    if not compares(vendor_account):
        return None
    balance = vendor_account["owedCents"] - vendor_account["paidCents"]
    if balance > 0:
        return OWES
    if balance < 0:
        return PAID_MORE
    return PAID_IN_FULL if vendor_account["owedCents"] > 0 else None


def offers_payment_states(
    currency: Optional[str], accounts: Mapping[str, Mapping[str, Any]],
) -> bool:
    """Whether anyone on the market may be in a payment state (``balance_state``), which the
    Payments page's figures and filters and the export's payment filter are offered by: always on a
    market that sets prices (a ``currency``), and on one that does not only where some account
    ``compares``: one owing an amount set by hand, or refunded beyond what it paid."""
    return currency is not None or any(compares(held) for held in accounts.values())


# --- The market's money (E44/F02/S01) -------------------------------------------------------------

def _figures(owed: int, paid: int, compared: bool = True) -> Dict[str, int]:
    """What the Payments page counts, for a vendor, a day, a tier, a date or the market. What was
    paid that compares with nothing (``compared`` false) is paid, but never paid more than owed."""
    return {"owedCents": owed, "paidCents": paid, "stillOwedCents": max(owed - paid, 0),
            "paidMoreCents": max(paid - owed, 0) if compared else 0}


def shares(cents: int, weights: List[int]) -> List[int]:
    """``cents`` split across ``weights`` in proportion, to the cent: each takes its whole share,
    and the cents left over go to the largest remainders, the earlier first, so nothing is lost.
    Every weight is at least 0 and one at least is above it."""
    total = sum(weights)
    whole = abs(cents)
    exact = [whole * weight for weight in weights]
    split = [part // total for part in exact]
    left = whole - sum(split)
    for i in sorted(range(len(weights)), key=lambda i: (-(exact[i] % total), i))[:left]:
        split[i] += 1
    return [-part for part in split] if cents < 0 else split


def market_summary(
    accounts: Mapping[str, Mapping[str, Any]], tier_order: List[str],
) -> Dict[str, Any]:
    """The Payments page from every vendor's account: each vendor with a line or a payment, by
    address, with their ``balance_state`` (what the page's lists and the export's payment filter
    both read) and whether their account ``compares``, and the market's figures, also by tier and
    by date.

    A payment is a vendor's, never a day's, so what a vendor paid is shared across their table-days
    in proportion to what each owes, or evenly where they owe nothing, and each day's share counts
    toward its tier and its date; what a vendor with no line paid is counted apart, under neither
    (``None``), and only where it is not nothing. A vendor's days are all owing or all paid more,
    so the still owed and the paid more of every breakdown add up to the market's, which are each
    vendor's own, summed. They are summed by the rule the states are read by (``compares``): what
    an account that compares with nothing paid counts as paid, but never as paid more than owed,
    in the totals or any share of them.
    """
    vendors: List[Dict[str, Any]] = []
    totals = _figures(0, 0)
    by_tier: Dict[Optional[str], Dict[str, int]] = {}
    by_date: Dict[Optional[str], Dict[str, int]] = {}

    def add(into: Dict[str, int], owed: int, paid: int, compared: bool) -> None:
        for key, value in _figures(owed, paid, compared).items():
            into[key] += value

    for email in sorted(accounts):
        held = accounts[email]
        if not held["lines"] and not held["payments"]:
            continue
        compared = compares(held)
        vendors.append({"email": email, "owedCents": held["owedCents"],
                        "paidCents": held["paidCents"], "balanceState": balance_state(held),
                        "compares": compared})
        add(totals, held["owedCents"], held["paidCents"], compared)
        owed = [line["owedCents"] or 0 for line in held["lines"]]
        if not owed:
            # A vendor with no line whose payments came to nothing (one removed, or a refund
            # matching it) is listed, but adds no "No table" row of noughts to the breakdowns.
            parts = [(None, None, 0, held["paidCents"])] if held["paidCents"] else []
        else:
            paid = shares(held["paidCents"], owed if sum(owed) else [1] * len(owed))
            parts = [((line["tier"] or "").strip() or None, line["date"], cents, share)
                     for line, cents, share in zip(held["lines"], owed, paid)]
        for tier, date, cents, share in parts:
            add(by_tier.setdefault(tier, _figures(0, 0)), cents, share, compared)
            add(by_date.setdefault(date, _figures(0, 0)), cents, share, compared)

    def tier_place(tier: Optional[str]) -> Tuple[int, int, str]:
        if tier is None:
            return (2, 0, "")
        if tier in tier_order:
            return (0, tier_order.index(tier), tier)
        return (1, 0, tier)

    return {
        "vendors": vendors,
        "totals": totals,
        "byTier": [{"tier": tier, **by_tier[tier]} for tier in sorted(by_tier, key=tier_place)],
        "byDate": [{"date": date, **by_date[date]}
                   for date in sorted(by_date, key=lambda date: (date is None, date or ""))],
    }


def delete_for_market(market_id: str) -> int:
    """Take a market's payments and amounts owed with the market. Returns how many went."""
    query = {MARKET_ID_FIELD: market_id}
    return (
        payments_collection.delete_many(query).deleted_count
        + amounts_owed_collection.delete_many(query).deleted_count
    )
