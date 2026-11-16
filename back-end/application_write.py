"""Recording an applicant's answers: the one write path both intake paths use.

An application that arrived by CSV import and one submitted through the public form must be the
SAME KIND OF DOCUMENT. If they are not, the solver reads two shapes and the organizer's review
view shows two behaviours - and the drift is silent, because nothing compares them.

Three things make that fragile enough to be worth a shared function rather than a shared
intention, all of them easy to leave out of a second implementation:

  1. The essential offering is FROZEN before the answers are persisted, and the save re-validates
     when a concurrent freeze won a different offering. An answer recorded against an unfrozen
     offering can have its question moved under it by a later market-plan edit.
  2. Answers are normalised through the shared validators into their stored shapes - dates as ISO
     strings in plan order, max dates as an int, rankings best-first, accepted sets in plan order.
  3. The answers are written with what they do to the verdict, by the review state's own event
     (``application_status.answers_changed``, decision 9.1 of T277), held on the application as
     read: an applicant's or an import's change sends a person's verdict back to open, and an
     application with no status yet becomes ``open``, which is what puts it in front of a
     reviewer.

So this module owns the sequence, and every caller gets all three. It deliberately takes plain
documents rather than a request or a session: the CSV importer has neither.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import api.applications as ApplicationsApi
import application_status as ReviewState
import essential_fields as EssentialFields
from datatypes import Application
from market_documents import market_doc_field

logger = logging.getLogger(__name__)


def _asks_nothing(market_doc: Dict[str, Any], fields: List[Dict[str, Any]]) -> bool:
    """Does this market ask nothing at all, so there is genuinely no form to answer?

    A form is its custom fields PLUS the essential questions the market plan asks, and either half
    alone is a form. This used to be read off the custom fields alone, which was true only before
    the essential questions existed: a market whose form was exactly the essential questions could
    open applications - ``FormHasFieldsGuard`` says such a form asks something - and then refuse
    every application it received, by import and by applicant alike.

    ``plan_derived_asked_keys`` is deliberately the same function ``FormHasFieldsGuard`` reads.
    Two copies of "what does this market ask" would drift, and the drift shows up as one layer
    refusing what another just accepted, which is exactly the bug this replaces.

    Plan-derived, so identity is excluded. The applicant's name is asked unconditionally
    (E13/F01/S01), so counting it would make this - and the guard with it - unable to say no, and
    a market with no dates, no tiers and fewer than two sections would start collecting
    applications it can never place.
    """
    if fields:
        return False
    options = EssentialFields.effective_essential_options(market_doc)
    return not EssentialFields.plan_derived_asked_keys(options)


NO_FORM_ERROR = "This market does not have an application form configured."
# A held write that matched nothing: a verdict moved since the caller read the application.
ANSWERS_MOVED = "This application's status changed since it was read."
#: How many times a save is written on the application read again, when each try finds it moved
#: since it was read: an import row (``csv_import.ROW_TRIES``) and the applicant's save alike.
ANSWER_TRIES = 3


class Recorded(NamedTuple):
    """What recording answers did: the refusal, with nothing written; else the application as
    stored, and whether the answers sent a verdict back to open (decision 9.1 of T277)."""
    error: Optional[str]
    application: Optional[Application]
    returned: bool = False


def validate_application_answers(
    market_doc: Dict[str, Any], form_data: Dict[str, Any], *, imported: bool = False,
) -> Optional[str]:
    """Would these answers be accepted? Returns the refusal, or None.

    Writes nothing and - importantly - does NOT freeze the offering. A dry run that froze would
    make merely looking at an import decide what the form offers for ever, which is a side effect
    no preview is allowed to have. It therefore validates against the offering as it stands; the
    real save validates again, against whichever offering actually governs by then.
    """
    application_form = market_doc_field(market_doc, "application_form")
    fields = (application_form or {}).get("fields") or []
    if _asks_nothing(market_doc, fields):
        return NO_FORM_ERROR
    error, _stored = validated_form_data(form_data, fields)
    if error:
        return error

    options = EssentialFields.effective_essential_options(market_doc)
    essential_error, _answers = EssentialFields.validated_essential_answers(
        form_data, options, limit_required=not imported,
    )
    return essential_error


def record_application_answers(
    markets_collection: Any,
    market_doc: Dict[str, Any],
    read: Dict[str, Any],
    form_data: Dict[str, Any],
    *,
    source: ReviewState.Source,
    arrival: ReviewState.Arrival,
    submitted_at: Optional[str] = None,
) -> Recorded:
    """Validate, freeze, persist and status an applicant's answers. The whole sequence, once.

    ``market_doc`` is the raw stored (camelCase) market; ``read`` the raw stored application, as
    the caller read it. Returns ``Recorded``: when its ``error`` is not None nothing was written
    and the caller must refuse the save.

    ``source`` is the applicant's own save or an import row. A row from a form this product did not
    write may never have asked how many dates the applicant wants; its absence then means no
    personal limit (bug 24).

    The freeze happens BEFORE the answers are persisted so no answer is ever recorded against an
    unfrozen offering, and a concurrent first save that froze a different offering is handled by
    re-validating against whichever one actually governs.

    The answers are written by ``ReviewState.answers_changed``, held to the status and the
    verdict's time ``read`` has, so they never land under a verdict given after the caller read
    the application: when the held write matches nothing the error is ``ANSWERS_MOVED`` and
    nothing was written, for the caller to read it again. A verdict the answers send back to open
    is marked for the deal by ``arrival``. ``submitted_at`` is the row's own time, kept only where
    the application has none.
    """
    imported = source is ReviewState.Source.IMPORT
    application_form = market_doc_field(market_doc, "application_form")
    fields = (application_form or {}).get("fields") or []
    if _asks_nothing(market_doc, fields):
        return Recorded(NO_FORM_ERROR, None)
    error, stored_form_data = validated_form_data(form_data, fields)
    if error:
        return Recorded(error, None)

    # The essential answers are merged last so no custom answer can ever shadow one.
    essential_options = EssentialFields.effective_essential_options(market_doc)
    essential_error, essential_answers = EssentialFields.validated_essential_answers(
        form_data, essential_options, limit_required=not imported,
    )
    if essential_error:
        return Recorded(essential_error, None)

    market_id = market_doc.get("id", "")
    frozen_options = EssentialFields.freeze_and_effective_essential_options(
        markets_collection, market_id, essential_options,
    )
    if frozen_options != essential_options:
        essential_error, essential_answers = EssentialFields.validated_essential_answers(
            form_data, frozen_options, limit_required=not imported,
        )
        if essential_error:
            return Recorded(essential_error, None)
    stored_form_data.update(essential_answers)

    now = datetime.now(timezone.utc).isoformat()
    answers = {
        "form_data": stored_form_data,
        "submitted_at": read.get("submitted_at") or submitted_at or now,
        "updated_at": now,
    }
    moved = ReviewState.answers_changed(read, source, answers, arrival)
    if moved is None:
        return Recorded(ANSWERS_MOVED, None)

    stored = ApplicationsApi.find_application_by_id(read.get("id", ""))
    return Recorded(None, Application(**(stored or {**moved.applied(read), **answers})),
                    ReviewState.returned_to_review(read, moved))


def validated_form_data(
    incoming: Dict[str, Any], fields: List[Dict[str, Any]],
) -> Tuple[Optional[str], Dict[str, Any]]:
    """Validate submitted form data against field definitions.

    Returns (error_message, stored_data). When ``error_message`` is not None, the form
    should be refused. When it is None, ``stored_data`` is ready to persist.

    Field key defines identity; anything not in a field key is ignored (and
    stripped). An answer is present when it passes the field-type-specific
    "answered" test.

    An empty field list is not an error here: it means the market asks no CUSTOM question, which
    is ordinary for a market whose form is exactly the essential questions. Whether the market
    asks anything at all is ``_asks_nothing``'s question, because only it can see both halves.
    """
    stored: Dict[str, Any] = {}
    for field_def in fields:
        error = _field_answer(field_def, incoming, stored)
        if error:
            return error, {}
    return None, stored


def validated_answer(field_def: Dict[str, Any], value: Any) -> Tuple[Optional[str], Any]:
    """One custom question's answer as the form stores it, or the form's reason for refusing it:
    for an organizer's update of one answer (E41/F01/S01), held to what the vendor was held to."""
    stored: Dict[str, Any] = {}
    error = _field_answer(field_def, {field_def.get("key"): value}, stored)
    return error, stored.get(field_def.get("key"))


def form_data_errors(incoming: Dict[str, Any], fields: List[Dict[str, Any]]) -> List[str]:
    """Every custom question these answers would be refused on - for the import's report of a
    skipped row, which named one problem at a time (bug 40)."""
    stored: Dict[str, Any] = {}
    return [error for error in (_field_answer(f, incoming, stored) for f in fields) if error]


def answer_errors(
    market_doc: Dict[str, Any], form_data: Dict[str, Any], *, imported: bool = False,
) -> List[str]:
    """Every reason ``validate_application_answers`` would refuse these answers, not the first."""
    application_form = market_doc_field(market_doc, "application_form")
    fields = (application_form or {}).get("fields") or []
    if _asks_nothing(market_doc, fields):
        return [NO_FORM_ERROR]
    options = EssentialFields.effective_essential_options(market_doc)
    return (EssentialFields.essential_answer_errors(form_data, options, limit_required=not imported)
            + form_data_errors(form_data, fields))


def _field_answer(
    field_def: Dict[str, Any], incoming: Dict[str, Any], stored: Dict[str, Any],
) -> Optional[str]:
    """One custom question's answer into ``stored``, or the reason it is refused."""
    key = field_def.get("key")
    if not key:
        return None
    field_type = field_def.get("type", "text")
    required = field_def.get("required", False)
    label = field_def.get("label", key)

    raw = incoming.get(key)
    answered = _is_answered(raw, field_type)

    if not answered:
        if required:
            return f"'{label}' is required."
        stored[key] = _unanswered_value(field_type)
        return None

    # Type-specific validation
    if field_type == "number":
        try:
            stored[key] = _as_number(raw)
        except (TypeError, ValueError):
            # Why the conversion failed is the answer itself, which is the applicant's to know and
            # nobody's to log; the copy says all there is.
            return f"'{label}' must be a number."
        return None

    if field_type in ("select", "multi_select"):
        options = field_def.get("options") or []
        if field_type == "select":
            raw_str = str(raw).strip()
            if raw_str not in options:
                return f"'{label}' must be one of: {', '.join(options)}"
            stored[key] = raw_str
        else:
            if not isinstance(raw, list):
                return f"'{label}' requires one or more selections."
            for val in raw:
                if str(val).strip() not in options:
                    return f"'{label}' contains an invalid option: {val}"
            stored[key] = [str(v).strip() for v in raw]
        return None

    if field_type == "checkbox":
        if not isinstance(raw, bool):
            return f"'{label}' must be true or false."
        stored[key] = raw
        return None

    # text, email, date: store as trimmed string
    if not isinstance(raw, str):
        return f"'{label}' must be text."
    stored[key] = raw.strip()
    return None


def _is_answered(value: Any, field_type: str) -> bool:
    """Whether a submitted value counts as an answer for a field of this type.

    "Present in the payload" is not the same as "answered", and the difference is type-shaped:
    an unticked mandatory consent checkbox arrives as ``False`` and an untouched mandatory
    multi_select as ``[]``, both of which are non-null, non-empty-string values that a purely
    null/blank test waves through.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, list):
        return len(value) > 0
    if field_type == "checkbox":
        return value is True
    return True


def _unanswered_value(field_type: str) -> Any:
    """What an unanswered field of this type stores."""
    if field_type == "number":
        return None
    if field_type == "checkbox":
        return False
    if field_type == "multi_select":
        return []
    return ""


def _as_number(value: Any) -> Any:
    """The numeric value of an answer to a ``number`` field. Raises if it is not one."""
    if isinstance(value, bool):
        raise TypeError("a boolean is not a number")
    if isinstance(value, int):
        number: Any = value
    elif isinstance(value, str):
        text = value.strip()
        try:
            number = int(text)
        except ValueError:
            number = float(text)
    else:
        number = float(value)
    if isinstance(number, float):
        if number != number or number in (float("inf"), float("-inf")):
            raise ValueError("not a finite number")
    if isinstance(number, float) and number.is_integer():
        return int(number)
    return number
