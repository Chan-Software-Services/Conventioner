"""A vendor who never applied, added by hand on the day (E36/F03/S01).

A walk-in, or a late arrangement, was once seated by typing an address into a seat: no name, no
answers, nothing in the vendor drawer. A seat now goes only to an applicant (E36/F02/S01), and this
is how someone becomes one without applying: an organizer records a name and an address, and the
application says who added it and when.

An added vendor is approved by the act of adding, and is never an input to the run while they are
still an added one (origin ``added``): their answers may be missing, and a missing answer refuses
every run. They are seated by hand, as a vendor the run holds a seat for (`held_vendors_for`).
Once their answers arrive, by an import or their own save, they stay approved and are read like
any applicant (T277 P7).

They are asked every question of the form's own that a price group reads, each required, so they
are priced like any other (E43/F01/S03); a market whose card has no group asks nothing more.
"""
from typing import Any, Dict, Tuple

import api.market_actions as Actions
import api.markets as MarketsApi
import application_status as ReviewState
import history as History
import market_deletion as MarketDeletion
import essential_fields as EssentialFields
import pricing as Pricing
from application_write import validated_answer
from assignment.utils import convert_keys_to_camel_case
from client_errors import BadRequestError, ConflictError
from datatypes import Market, MarketPerson
from utils.email_address import normalized_email

class AddVendorRefused(ConflictError):
    """The market cannot take this vendor now: its phase, or an address it already holds. A 409."""


class AddVendorInvalid(BadRequestError):
    """The request names no vendor that could be recorded. A 400."""


def add_vendor(
    market_id: str, data: Dict[str, Any], adder: MarketPerson,
) -> Tuple[Dict[str, Any], int]:
    """Record a vendor who never applied: their name, their address, their answers to the questions
    the price groups read (``answers``, ``{question key: answer}``), and who added them."""
    change = MarketsApi._market_change(market_id, adder.email, Actions.ADD_VENDOR)
    market = change.market
    refused = MarketsApi.adding_refusal(market.phase)
    if refused:
        raise AddVendorRefused(refused)

    name = str(data.get("name") or "").strip()
    address = normalized_email(data.get("email"))
    if not name:
        raise AddVendorInvalid("Give the vendor's name.")
    if "@" not in address or " " in address:
        raise AddVendorInvalid("Give the vendor's email address.")
    answers = _price_answers(market, data.get("answers"))
    # Never written over: one already here, or one stored by a request in flight, is refused.
    application = ReviewState.add(
        market_id, address, {EssentialFields.FULL_NAME_KEY: name, **answers}, adder)
    if application is None:
        raise AddVendorRefused(
            f"{address} already has an application in this market. Assign them on the Assignments page."
        )
    change.asked.record(
        vendors=[address],
        subject={"application_id": application.id},
        detail=lambda: History.changes(
            {}, {"name": name, "status": application.status.value, "answers": answers}),
    )
    # After the last write: a deletion that began after the market was read has swept, or will
    # sweep, the application, or this takes it back as a 404.
    MarketDeletion.kept_only_while_live(MarketsApi.markets_collection, market_id)
    return {"application": convert_keys_to_camel_case(application.model_dump())}, 201


def _price_answers(market: Market, raw: Any) -> Dict[str, Any]:
    """The vendor's answers to the form's own questions the price groups read, each held to what the
    form holds an applicant's to and stored as it stores them. Each is required, though the form may
    leave it optional, since the price reads it (Daniel, T92 Q14); a checkbox left unticked is its
    "not ticked" answer. Any other question is refused: adding asks nothing else."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise AddVendorInvalid("answers must be an object.")
    asked = Pricing.Groups(market).fields()
    if any(str(key) not in {field.key for field in asked} for key in raw):
        raise AddVendorInvalid("That question is not asked when adding a vendor.")
    answers: Dict[str, Any] = {}
    for field in asked:
        error, value = validated_answer(
            {**field.model_dump(), "required": field.type != "checkbox"}, raw.get(field.key))
        if error:
            raise AddVendorInvalid(error)
        answers[field.key] = value
    return answers
