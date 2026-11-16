"""A vendor's payments, as the organizers read and record them (E44/F01/S01).

The drawer's Payment tab reads one vendor's account here: a line per table-day with what they owe
for it, each payment recorded, and the two totals. The lines are read off the market's stored
assignment, the same rows and the same pricing the drawer's date cards read (``get_market_tables``),
so a line and its date card never disagree; ``payments.py`` keeps what the assignment cannot say.

Reading asks ``Actions.READ``: everyone with a role reads it, and no applicant endpoint does
(Q20.2). Recording a payment asks ``Actions.RECORD_PAYMENT``, an Editor's by default (Q15);
changing a table-day's amount owed asks ``Actions.CHANGE_OWED``, and recording a refund or editing
or removing an entry ``Actions.ADJUST_PAID``, each an Admin's by default (Q26, E44/F01/S02). An
archived market refuses every write.
"""
import functools
import logging
import uuid
from typing import Any, Callable, Dict, Iterable, NamedTuple, Optional, Tuple

from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

import api.applications as ApplicationsApi
import api.market_actions as Actions
import api.markets as MarketsApi
from assignment.utils import convert_keys_to_snake_case
from client_errors import BadRequestError, ConflictError, NotFoundError, field_named_copy
from datatypes import Market, PaymentEntry, VendorAssignmentResult
import history as History
import payments as Payments
import pricing as Pricing
from tombstone import live
from utils.email_address import normalized_email
from utils.request_body import string_field

logger = logging.getLogger(__name__)

#: The most a table-day may be set to owe: what a price cell may hold, $100,000.00.
MOST_OWED_CENTS = 10_000_000

NO_LINE = "That vendor holds no table that day, so nothing is owed for it."
NO_ENTRY = "This market has no such payment standing."
NOT_A_REQUEST_KEY = "A payment's request key must be a UUID."
OWED_KEPT_CHANGING = ("What this vendor owes for that day kept changing as it was saved, so "
                      "nothing was changed. Try again.")
OWED_CHANGED_UNDER_FREE = ("What this vendor owes for that day changed as the seat was freed, so "
                           "nothing was freed. Try again.")
#: What a second press of one opening of the Record dialog is told when it differs from the entry
#: the first press recorded, by the kind it asked.
ALREADY_RECORDED = {
    kind: f"This {kind} was already recorded, as it was first sent. Close this and edit it if it "
          f"should read differently."
    for kind in (Payments.PAYMENT, Payments.REFUND)
}
#: The request body's key for the one press of Record it carries (``RecordPaymentDialog``).
REQUEST_KEY = "requestKey"


class AlreadyRecorded(ConflictError):
    """A press of Record whose key the market already holds, with fields that differ from the
    entry recorded with it: a 409, with the vendor's account as it stands, so the dialog shows
    the entry already recorded behind it."""

    def __init__(self, kind: str, account: Dict[str, Any]):
        super().__init__(ALREADY_RECORDED[kind])
        self.account = account

    def body(self) -> Dict[str, Any]:
        return {"error": self.message, "account": self.account}


def seats_by_vendor(market: Market) -> Dict[str, Dict[str, Payments.Seat]]:
    """Every seat held on the market, by vendor and date, each with its price that day and the
    card's row that set it: the price groups the vendor's answers put them in (E43/F01/S02), as
    the tables read prices the date cards (``Pricing.row_prices``)."""
    groups = Pricing.Groups(market)
    answers = Pricing.vendor_answers(groups, market.id)
    seats: Dict[str, Dict[str, Payments.Seat]] = {}
    for row in MarketsApi.derive_market_table_rows(market):
        priced = {normalized_email(price["email"]): price
                  for price in Pricing.row_prices(groups, row, answers)}
        for email in dict.fromkeys(normalized_email(email) for email in row.assignment if email):
            price = priced.get(email) or {}
            seats.setdefault(email, {})[row.date] = Payments.Seat(
                row.table_code, row.tier, row.table_choice, price.get("cents"), price.get("group"))
    return seats


def _account(market: Market, vendor_email: str) -> Dict[str, Any]:
    pricing = market.setup_object.pricing if market.setup_object else None
    address = normalized_email(vendor_email)
    return Payments.account(
        pricing.currency if pricing else None,
        Payments.lines(seats_by_vendor(market).get(address, {}),
                       Payments.amounts_owed_for(market.id, address)),
        Payments.payments_for(market.id, address),
    )


def accounts(market: Market) -> Dict[str, Dict[str, Any]]:
    """Every vendor's account on the market, by address, each as ``vendor_account`` answers it:
    every vendor with a seat, a kept line or an entry, read once for the whole market. A record
    with no address is nobody's. The caller has asked the table already."""
    pricing = market.setup_object.pricing if market.setup_object else None
    seats = seats_by_vendor(market)
    kept = Payments.amounts_owed_by_vendor(market.id)
    paid = Payments.payments_by_vendor(market.id)
    return {
        address: Payments.account(
            pricing.currency if pricing else None,
            Payments.lines(seats.get(address, {}), kept.get(address, {})),
            paid.get(address, []),
        )
        for address in dict.fromkeys([*seats, *kept, *paid]) if address
    }


def vendor_account(market_id: str, vendor_email: str, requesting_user: str) -> Dict[str, Any]:
    """One vendor's account on this market. Asks ``Actions.READ``."""
    market = MarketsApi._load_market_for(market_id, requesting_user, Actions.READ)
    return _account(market, vendor_email)


def market_payments(market_id: str, requesting_user: str) -> Dict[str, Any]:
    """The Payments page (E44/F02/S01): every vendor with a table-day line or a payment, with what
    they owe and paid, and the market's figures, also by tier and by date
    (``Payments.market_summary``). Each vendor's account is the one their Payment tab reads and the
    export reads (``accounts``), and each vendor's state the one the export filters by
    (``Payments.balance_state``). Asks ``Actions.READ``."""
    return market_money(MarketsApi._load_market_for(market_id, requesting_user, Actions.READ))


def market_money(market: Market) -> Dict[str, Any]:
    """The Payments page's reading of a market, for whoever has asked the table already: the page
    itself (``market_payments``) and the Stats tab's headlines (``market_stats.py``), so the two
    tell the same figures. ``currency`` is ``None`` where the market sets no prices, and
    ``offersPaymentStates`` whether anyone may be in a payment state, which the page draws its
    figures and offers its filters by (``Payments.offers_payment_states``)."""
    setup = market.setup_object
    currency = setup.pricing.currency if setup and setup.pricing else None
    tiers = [tier.name.strip() for tier in (setup.tiers if setup else [])]
    held = accounts(market)
    return {"currency": currency,
            "offersPaymentStates": Payments.offers_payment_states(currency, held),
            **Payments.market_summary(held, tiers)}


def _entry(body: Any, what: str) -> PaymentEntry:
    """A request body as an entry, or a refusal naming each field it gets wrong."""
    try:
        return PaymentEntry.model_validate(
            convert_keys_to_snake_case(body) if isinstance(body, dict) else body)
    except ValidationError as e:
        raise BadRequestError(field_named_copy(f"The {what} cannot be recorded", e)) from e


def _applicant(market_id: str, vendor_email: str) -> str:
    """The vendor's address, once the market has an application from them: money is only ever
    a vendor's of this market, as a seat is."""
    address = normalized_email(vendor_email)
    if not address or ApplicationsApi.find_application_by_email(market_id, address) is None:
        raise NotFoundError("This market has no application from that vendor.")
    return address


def _fields(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """An entry's fields as its history records them; all None for an entry not there."""
    return {key: (doc or {}).get(key) or None for key in Payments.ENTRY_FIELDS}


def _request_key(body: Any) -> Tuple[Optional[str], Any]:
    """The press's request key, in the one lowercase spelling of its UUID, and the body without it,
    for the entry's model, which forbids any other field. No key, or a null one, is None: a tab on
    an older bundle sends none, and records as it did."""
    if not isinstance(body, dict):
        return None, body
    rest = {key: value for key, value in body.items() if key != REQUEST_KEY}
    if body.get(REQUEST_KEY) is None:
        return None, rest
    sent = string_field(body, REQUEST_KEY) or ""
    try:
        spelled = str(uuid.UUID(sent))
    except ValueError:
        raise BadRequestError(NOT_A_REQUEST_KEY) from None
    if spelled != sent.lower():
        # A UUID in braces or as a URN reads as one, but is no spelling a dialog sends.
        raise BadRequestError(NOT_A_REQUEST_KEY)
    return spelled, rest


def _first_recorded(market_id: str, request_key: Optional[str]) -> Optional[Dict[str, Any]]:
    """The entry the market recorded with this press's key, or None."""
    return Payments.entry_with_request_key(market_id, request_key) if request_key else None


def _record_entry(
    market_id: str, vendor_email: str, body: Any, requesting_user: str, kind: str,
) -> Dict[str, Any]:
    """Record one entry, once per request key: a repeat of the key records nothing, and answers
    the account when it is the entry first recorded, or ``AlreadyRecorded`` when it differs."""
    row = Actions.RECORD_PAYMENT if kind == Payments.PAYMENT else Actions.ADJUST_PAID
    market = MarketsApi._load_market_to_change(market_id, requesting_user, row)
    address = _applicant(market_id, vendor_email)
    request_key, fields = _request_key(body)
    entry = _entry(fields, kind)
    first = _first_recorded(market_id, request_key)
    if first is None:
        try:
            stored = Payments.record_payment(
                market_id, address, entry, requesting_user, kind, request_key)
        except DuplicateKeyError:
            # Two presses at once: both found no entry, and the other's insert landed first.
            first = _first_recorded(market_id, request_key)
            if first is None:
                raise
    if first is not None:
        if not Payments.same_entry(first, address, entry, kind):
            raise AlreadyRecorded(kind, _account(market, address))
        return _account(market, address)
    History.record(
        market_id, requesting_user, row,
        kind=None if kind == Payments.PAYMENT else History.REFUND_RECORDED, vendors=[address],
        subject={"payment_id": stored["id"], "payment_kind": kind, **_currency(market)},
        detail=lambda: History.changes(_fields(None), _fields(stored)),
    )
    return _account(market, address)


def record_payment(
    market_id: str, vendor_email: str, body: Any, requesting_user: str,
) -> Dict[str, Any]:
    """Record one payment a vendor made, ``{cents, method, paidOn, note}``, once per the press's
    ``requestKey``, and answer their account as it now reads. Asks ``Actions.RECORD_PAYMENT``; an
    archived market refuses it, and so does a vendor it has no application from."""
    return _record_entry(market_id, vendor_email, body, requesting_user, Payments.PAYMENT)


def record_refund(
    market_id: str, vendor_email: str, body: Any, requesting_user: str,
) -> Dict[str, Any]:
    """Record money given back to a vendor, the same fields as a payment, kept as a negative entry
    (Q26: "when the refund is settled they can come back and adjust amount paid"). Asks
    ``Actions.ADJUST_PAID``."""
    return _record_entry(market_id, vendor_email, body, requesting_user, Payments.REFUND)


def _change_entry(
    market_id: str, payment_id: str, requesting_user: str, body: Any = None,
) -> Dict[str, Any]:
    market = MarketsApi._load_market_to_change(market_id, requesting_user, Actions.ADJUST_PAID)
    before = Payments.payment(market_id, str(payment_id or ""))
    if before is None or before.get("removed_at"):
        raise NotFoundError(NO_ENTRY)
    if body is None:
        after, kind = Payments.remove_payment(market_id, before["id"], requesting_user), \
            History.PAYMENT_REMOVED
        recorded_after: Optional[Dict[str, Any]] = None
    else:
        entry = _entry(body, before.get("kind") or Payments.PAYMENT)
        after, kind = Payments.edit_payment(market_id, before["id"], entry, requesting_user), \
            History.PAYMENT_EDITED
        recorded_after = after
    if after is None:
        raise NotFoundError(NO_ENTRY)
    History.record(
        market_id, requesting_user, Actions.ADJUST_PAID, kind=kind,
        vendors=[before.get("vendor_email")],
        subject={"payment_id": before["id"],
                 "payment_kind": before.get("kind") or Payments.PAYMENT, **_currency(market)},
        detail=lambda: History.changes(_fields(before), _fields(recorded_after)),
    )
    return _account(market, before.get("vendor_email") or "")


def edit_payment(
    market_id: str, payment_id: str, body: Any, requesting_user: str,
) -> Dict[str, Any]:
    """Change a payment or a refund's amount, method, day or note; what it read before is kept in
    its own history. Asks ``Actions.ADJUST_PAID``."""
    return _change_entry(market_id, payment_id, requesting_user, body)


def remove_payment(market_id: str, payment_id: str, requesting_user: str) -> Dict[str, Any]:
    """Take a payment or a refund out of the amount paid; it is kept, marked removed. Asks
    ``Actions.ADJUST_PAID``."""
    return _change_entry(market_id, payment_id, requesting_user)


def _line(market: Market, address: str, date: str) -> Optional[Dict[str, Any]]:
    return next((line for line in _account(market, address)["lines"] if line["date"] == date),
                None)


def _owed_cents(body: Any) -> int:
    cents = body.get("cents") if isinstance(body, dict) else None
    if isinstance(cents, bool) or not isinstance(cents, int) or not 0 <= cents <= MOST_OWED_CENTS:
        raise BadRequestError(
            "An amount owed is a whole number of cents from 0 to 10000000 ($100,000.00).")
    return cents


def _currency(market: Market) -> Dict[str, Any]:
    """The market's currency, in a payment entry's subject, so its money reads in it."""
    return Pricing.pricing_subject(market.setup_object)


def _record_owed(
    market: Market, requesting_user: str, address: str, date: str, kind: str,
    before: Dict[str, Any], after: Optional[Dict[str, Any]],
) -> None:
    History.record(
        market.id, requesting_user, Actions.CHANGE_OWED, kind=kind, vendors=[address],
        subject={"date": date, **_currency(market)},
        detail=lambda: History.changes({"owed_cents": before["owedCents"]},
                                       {"owed_cents": (after or {}).get("owedCents")}),
    )


def _held(market: Market, address: str, date: str) -> Optional[Payments.Seat]:
    return seats_by_vendor(market).get(address, {}).get(date)


def _change_owed(
    market: Market, requesting_user: str, address: str, date: str, event: Payments.OwedEvent,
    kind: str, cents: Optional[int] = None,
) -> Dict[str, Any]:
    """An Admin's change of one table-day's amount owed, through the day's owner: a day with no
    line is refused, as is one whose record kept changing under the write, and a change that
    leaves the day reading as it did records nothing."""
    before = _line(market, address, date)
    if before is None:
        raise NotFoundError(NO_LINE)
    try:
        moved = Payments.owed_day_transition(
            market.id, address, date, event, held=_held(market, address, date),
            by=requesting_user, cents=cents)
    except Payments.OwedEventRefused:
        # The line went between this request's read and the owner's.
        raise NotFoundError(NO_LINE) from None
    except Payments.OwedDayChanged:
        raise ConflictError(OWED_KEPT_CHANGING) from None
    account = _account(market, address)
    if moved.changed:
        _record_owed(market, requesting_user, address, date, kind, before,
                     _line(market, address, date))
    return account


def set_amount_owed(
    market_id: str, vendor_email: str, date: str, body: Any, requesting_user: str,
) -> Dict[str, Any]:
    """Set what a vendor owes for one table-day, ``{cents}``, $0 being how a fee is waived (Q26).
    Asks ``Actions.CHANGE_OWED``; a day with no line, held or freed, is refused."""
    market = MarketsApi._load_market_to_change(market_id, requesting_user, Actions.CHANGE_OWED)
    cents = _owed_cents(body)
    return _change_owed(market, requesting_user, normalized_email(vendor_email), date,
                        Payments.OwedEvent.ADMIN_SETS, History.OWED_SET, cents)


def use_calculated_price(
    market_id: str, vendor_email: str, date: str, requesting_user: str,
) -> Dict[str, Any]:
    """Take back an amount set by hand on one table-day: it owes the calculated price again.
    Asks ``Actions.CHANGE_OWED``."""
    market = MarketsApi._load_market_to_change(market_id, requesting_user, Actions.CHANGE_OWED)
    return _change_owed(market, requesting_user, normalized_email(vendor_email), date,
                        Payments.OwedEvent.ADMIN_CALCULATED, History.OWED_CALCULATED)


class KeptLine(NamedTuple):
    """What a free kept of a seat's line before the seat goes (``keep_freed_line``)."""

    #: Puts the record back as it was, for a free whose seat could not be freed.
    undo: Callable[[], None]
    #: Records the deduction the free made, if it made one, once the seat is freed.
    record_deduction: Callable[[], None]


def keep_freed_line(
    market: Market, vendor_email: str, date: str, by: str, deduct: bool = False,
) -> KeptLine:
    """Keep the line of the seat a vendor holds on ``date``, which is about to be freed: freeing a
    table changes neither what they owe nor what they paid (Q26). With ``deduct``, the free asked
    "Also remove its $15.00 from what they owe?", and the same write waives the day: the line
    stays, owing $0.00, and the amount paid is untouched, so a vendor who paid shows paid more
    than owed, a refund to issue by hand.

    Written while the seat is still held, before it goes (T270); ``undo`` puts the record back as
    it was read, for a free whose seat could not be freed. A day whose record kept changing under
    the write frees nothing, ``OWED_CHANGED_UNDER_FREE``.

    The deduction's history entry runs from what the line owed as this request read it, while the
    seat was held, to 0, and reads nothing again: a line read once the seat is freed, off the
    market as this request read it, would say the seat's price.
    """
    address = normalized_email(vendor_email)
    seat = _held(market, address, date)
    if seat is None:
        return KeptLine(lambda: None, lambda: None)
    owed = _line(market, address, date) if deduct else None
    event = (Payments.OwedEvent.FREED_WITH_DEDUCTION if deduct
             else Payments.OwedEvent.FREED)
    try:
        moved = Payments.owed_day_transition(market.id, address, date, event, held=seat,
                                             seat=seat, by=by)
    except Payments.OwedDayChanged:
        raise ConflictError(OWED_CHANGED_UNDER_FREE) from None

    def record_deduction() -> None:
        if owed is not None:
            _record_owed(market, by, address, date, History.OWED_SET, owed, {"owedCents": 0})

    return KeptLine(moved.undo, record_deduction)


def deduct_freed_day(market: Market, vendor_email: str, date: str, by: str) -> None:
    """The free's deduction on a day the vendor no longer holds, whose line is freed and holds no
    amount set by hand: a free from before T270 that stopped between its seat and its deduction
    left the day owing its full amount, and pressing Free again finishes it. Any other day is
    left as it is."""
    address = normalized_email(vendor_email)
    owed = _line(market, address, date)
    if owed is None:
        return
    try:
        moved = Payments.owed_day_transition(
            market.id, address, date, Payments.OwedEvent.FREED_WITH_DEDUCTION, held=None, by=by)
    except Payments.OwedEventRefused:
        return
    except Payments.OwedDayChanged:
        raise ConflictError(OWED_CHANGED_UNDER_FREE) from None
    if moved.changed:
        _record_owed(market, by, address, date, History.OWED_SET, owed, {"owedCents": 0})


def _day(row: VendorAssignmentResult) -> Tuple[str, str]:
    return normalized_email(row.email), row.date


def assignment_written(
    market_id: str, *, seated: Iterable[VendorAssignmentResult],
    held_before: Iterable[VendorAssignmentResult], dropped: Iterable[VendorAssignmentResult],
    by: str,
) -> None:
    """Tell each owed day a write of the assignment moved what it did, through the day's owner:
    ``seated`` every row the write seats, ``held_before`` the rows of the assignment it read, and
    ``dropped`` the rows it read that it no longer seats.

    A day seated afresh takes back its freed line, and a day that was held already loses any freed
    record a free that stopped before its seat went left on it (T270). Where a free's $0 is taken
    back on a day not in ``held_before``, which alone read as freed, it is recorded under the row
    the seating asked (``Actions.ASSIGN``), as the amount it took back and what the day owes now,
    read off the market as it stands. A dropped day forgets what it held, and an amount an Admin
    set for it goes with it (Daniel's decision 9.3), recorded under the same row as the amount and
    who set it (``owed_dropped``).

    The assignment's write has landed, so a day whose record kept changing never fails it: it is
    logged, and the day reads through ``on_day`` until its next write.
    """
    held = {_day(row): Payments.Seat(row.table_code, row.tier, row.table_choice, None)
            for row in held_before}
    events = {_day(row): Payments.OwedEvent.DROPPED_BY_RUN for row in dropped}
    events.update({_day(row): Payments.OwedEvent.SEATED for row in seated})
    if not events:
        return
    # One read of the records that may move; a day with none follows its seat whatever it took.
    # Beside every freed line, that is any record on a day seated afresh or dropped.
    moving = {(doc.get(Payments.VENDOR_EMAIL_FIELD), doc.get("date"))
              for doc in Payments.records_that_may_move(market_id, {
                  date for (address, date), event in events.items()
                  if (address, date) not in held or event == Payments.OwedEvent.DROPPED_BY_RUN})}

    @functools.cache
    def market_now() -> Market:
        """The market as it stands once the assignment's write has landed, read once for every
        entry it records."""
        return MarketsApi.market_from_document(
            MarketsApi.markets_collection.find_one(live({"id": market_id})))

    for (address, date), event in events.items():
        if (address, date) not in moving:
            continue
        try:
            moved = Payments.owed_day_transition(market_id, address, date, event,
                                                 held=held.get((address, date)), by=by)
        except (Payments.OwedDayChanged, Payments.OwedEventRefused) as missed:
            logger.warning("The owed day of market_id %s, date %s was not tidied after a write "
                           "of the assignment (%s).", market_id, date, type(missed).__name__)
            continue
        if not moved.changed:
            continue
        if (event == Payments.OwedEvent.DROPPED_BY_RUN
                and isinstance(moved.before, Payments.SetByHand)):
            _record_dropped(market_id, market_now, address, date, moved.before.amount, by)
        elif (address, date) not in held and isinstance(moved.before, Payments.FreedWaived):
            _record_taken_back(market_id, market_now, address, date, by)


def _record_dropped(
    market_id: str, market_now: Callable[[], Market], address: str, date: str,
    amount: Payments.HandAmount, by: str,
) -> None:
    History.record(
        market_id, by, Actions.ASSIGN, kind=History.OWED_DROPPED, vendors=[address],
        subject=lambda: {"date": date, **_currency(market_now()), "set_by": amount.by},
        detail=History.changes({"owed_cents": amount.cents}, {"owed_cents": None}))


def _record_taken_back(
    market_id: str, market_now: Callable[[], Market], address: str, date: str, by: str,
) -> None:
    def detail():
        line = _line(market_now(), address, date) or {}
        return History.changes({"owed_cents": 0}, {"owed_cents": line.get("owedCents")})

    def subject():
        return {"date": date, **_currency(market_now())}

    History.record(market_id, by, Actions.ASSIGN, kind=History.OWED_TAKEN_BACK,
                   vendors=[address], subject=subject, detail=detail)
