"""Applicant-facing application endpoints and organizer monitoring endpoints.

The applicant read path and the organizer review/monitoring path are in one module because they
share the same publication gate: ``applicant_visible_status`` is the one place that decides what
an applicant sees, and the organizer endpoints bypass it so the organizer always sees the truth.

Publication gate (captain ruling 2026-07-13):
    An applicant may sign in during any phase and always see their own submitted application.
    ``reviewer_approved`` / ``reviewer_rejected`` outcomes are HIDDEN from the applicant until
    the organizer explicitly PUBLISHES results. Until publication, the applicant sees a neutral
    ``under_review`` state - never the verdict.

    An organizer must not leak a half-finished review, and must retain the ability to change their
    mind before any applicant sees an outcome. Publication is the single, deliberate,
    organizer-controlled moment the verdict becomes visible.

    The enforcement lives on the BACKEND in ``applicant_visible_status``. No client-side hiding
    is sufficient: a verdict present in the API response is an information leak in the page markup,
    the same class of bug as the login oracle closed in 5d.
"""

import hashlib
import json
import logging
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from client_errors import parse_failure_detail
from application_write import (
    ANSWER_TRIES, ANSWERS_MOVED, record_application_answers, validate_application_answers,
)
import table_share as TableShare
from market_write import write_market
from market_documents import (
    applicant_intake_market_by_slug,
    market_dates_of,
    market_doc_field,
    market_doc_key,
    market_from_document,
    market_serves_applicants,
    public_map_is_open,
    results_are_out,
    vendor_page_market_by_slug,
)
from datatypes import (
    Application,
    ApplicationOrigin,
    ApplicationStatus,
    IntakeMode,
    Market,
    MarketPerson,
    Organization,
    VendorAssignmentResult,
    VerdictGiver,
    MarketPhase,
    applications_stopped_from_market_document,
    intake_mode_from_market_document,
    phase_from_market_document,
    phase_label,
    vendor_self_check_in_from_market_document,
)
from tombstone import live
from utils.application_token import (
    verify_application_token,
)

import api.applications as ApplicationsApi
import api.attendance as AttendanceApi
import api.market_actions as Actions
import application_status as ReviewState
import history as History
import market_deletion as MarketDeletion
import review_team as ReviewTeam
import result_outcome as ResultOutcome
from assignment.utils import convert_keys_to_snake_case
import assignment.lifecycle as Lifecycle
import rejection_rules as RejectionRules
import remembered_sign_ins as RememberedSignIns
import essential_fields as EssentialFields

logger = logging.getLogger(__name__)


# ── Publication gate ───────────────────────────────────────────────────────

def applicant_visible_status(
    status: ApplicationStatus, results_published: bool,
) -> ApplicationStatus:
    """The status of an application as its applicant is allowed to know it.

    Every application reads ``open`` - "Submitted" - whatever is stored (E36/F05/S01). The automatic rules judge an application in the request that saves it, so
    "Under Review" beside "Submitted" told an applicant a rule had rejected them the moment they
    submitted, and editing the answers flipped it back. Publication is the single, deliberate,
    organizer-controlled moment anything more is told.

    This has to be enforced here, on the way out of the process, because anything the applicant's
    browser receives, the applicant can read: a client-side label mapped over a payload that carries
    ``reviewer_rejected`` still ships the rejection in the response body and into the page markup.
    There is no applicant-facing payload that does not pass through ``_application_response``, so
    this is the one place that decides. The organizer's view never passes through here.
    """
    # After publication the applicant reads an outcome instead - a table, or none - which the
    # response carries beside this; a verdict is never theirs to read (E36/F05/S02), so rejected
    # and approved-without-a-seat read the same.
    return ApplicationStatus.OPEN


def _application_response(
    app: Application, results_published: bool,
    placements: Iterable[VendorAssignmentResult] = (),
    checked_in: Optional[Dict[str, Optional[str]]] = None,
    checked_out: Optional[Dict[str, str]] = None,
    with_answers: bool = True,
) -> Dict[str, Any]:
    """Serialize an application for the applicant-facing API with the publication gate applied.

    After publication it carries the applicant's outcome and their own seats (E36/F05/S02), read
    off the stored placements on every read, so a seat changed by hand shows at once. Each seat
    says when they checked in to it, from ``checked_in`` (``{date: checked_in_at}``), or null, and
    when they checked out, from ``checked_out`` (``{date: checked_out_at}``), or null.

    ``with_answers`` is false on a market that imports its vendors (ADR 0022): its page shows no
    application, and the answers are the organizer's import of their own Google Form, so the read
    carries no ``formData``.
    """
    placed = list(placements)
    outcome = (
        ResultOutcome.outcome_of(app.applicant_email, ResultOutcome.seated_from(placed))
        if results_published else None
    )
    seats = ResultOutcome.seats_of(app.applicant_email, placed) if results_published else []
    came, left = checked_in or {}, checked_out or {}
    response = {
        "outcome": outcome,
        "seats": [
            {**seat, "checkedInAt": came.get(seat["date"]),
             "checkedOutAt": left.get(seat["date"])}
            for seat in seats
        ],
        # The name the vendor goes by, as the organizer reads it, so their page greets them by it.
        "vendorName": EssentialFields.display_name(ApplicationsApi.effective_answers(app)),
        "id": app.id,
        "marketId": app.market_id,
        "applicantEmail": app.applicant_email,
        "formData": app.form_data,
        "status": applicant_visible_status(app.status, results_published).value,
        "applicationType": app.application_type.value,
        "mainApplicationId": app.main_application_id,
        "submittedAt": app.submitted_at,
        "updatedAt": app.updated_at,
    }
    if not with_answers:
        del response["formData"]
    return response


def _application_response_organizer(
    app: Application, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Serialize an application for the organizer-facing API with the raw status always visible."""
    return {
        "id": app.id,
        "marketId": app.market_id,
        "applicantEmail": app.applicant_email,
        # The answers as the organizer reads them, each update in its place (E41/F01/S01), and
        # beside them who updated which, and what the vendor wrote.
        "formData": ApplicationsApi.effective_answers(app),
        "answerUpdates": _answer_updates_payload(app),
        "status": app.status.value,
        "applicationType": app.application_type.value,
        "mainApplicationId": app.main_application_id,
        "submittedAt": app.submitted_at,
        "updatedAt": app.updated_at,
        # Who gave the verdict and when (E34/F01/S01): the organizer's, never the applicant's.
        "verdictBy": giver_payload(app.verdict_by),
        "verdictAt": app.verdict_at,
        "verdictReason": app.verdict_reason,
        "followUpOwner": app.follow_up_owner.as_wire() if app.follow_up_owner else None,
        # Who is looking at it while their claim stands (E34/F03/S02).
        "heldBy": _holder(app, now),
        # Whose share it was dealt to (E38/F07/S02), null when it never was.
        "reviewer": app.reviewer.as_wire() if app.reviewer else None,
        # Who recorded a vendor who never applied, and when (E36/F03/S01).
        "addedBy": app.added_by.as_wire() if app.added_by else None,
        "addedAt": app.added_at,
        # How it came to the market, apart from its verdict: whether they applied is read here,
        # never off ``addedBy``, since an added vendor imported since is an applicant (T277 P7).
        "origin": ReviewState.origin_of(app.model_dump()).value,
    }


def _answer_updates_payload(app: Application) -> Dict[str, Any]:
    """Each updated answer (E41/F01/S01): the value read, who updated it and when, what the vendor
    wrote, and whether that has changed since the update was made over it (a re-import, or their
    own edit), which the organizer is told."""
    theirs = app.form_data or {}
    return {
        key: {
            "value": update.value,
            "by": update.by.as_wire(),
            "at": update.at,
            "over": update.over,
            "theyWrote": theirs.get(key),
            "changedSince": theirs.get(key) != update.over,
        }
        for key, update in app.answer_updates.items()
    }


def organizer_view(doc: Dict[str, Any]) -> Dict[str, Any]:
    """A stored application as the organizer reads it."""
    return _application_response_organizer(Application(**doc))


def _holder(app: Application, now: Optional[datetime]) -> Optional[Dict[str, Any]]:
    held = ApplicationsApi.holds(
        app.held_by.model_dump() if app.held_by else None, app.held_until, now)
    return MarketPerson(**held).as_wire() if held else None


def giver_payload(by: Optional[VerdictGiver]) -> Optional[Dict[str, Any]]:
    """A verdict's giver as the organizer's views read one."""
    if by is None:
        return None
    return {"kind": by.kind, "userId": by.user_id, "email": by.email, "rule": by.rule}




# ── JWT authentication ─────────────────────────────────────────────────────


def authenticate_request(authorization_header: Optional[str]) -> Optional[Dict[str, Any]]:
    """Parse the ``Authorization: Bearer <token>`` header and return the payload.

    Called by the route handlers to authenticate applicant requests.

    Args:
        authorization_header: The raw ``Authorization`` header value.

    Returns:
        Decoded token payload dict or None if invalid.
    """
    if not authorization_header:
        return None
    parts = authorization_header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return verify_application_token(parts[1])


# ── Taking applications (E38/F04/S02) ──────────────────────────────────────


def takes_applications(market_doc: Dict[str, Any]) -> bool:
    """Whether this market's applicant form takes a new application now.

    Only in the stage where applications arrive, and only while the organizer has not stopped
    taking them: a stop is a fact about the form, kept beside the phase rather than as one
    (``applicationsStopped``, ADR 0005). Entering assignment closes the form whatever the fact says.
    """
    return (
        phase_from_market_document(market_doc) is MarketPhase.APPLICATIONS
        and not applications_stopped_from_market_document(market_doc)
    )


def applicant_phase_label(market_doc: Dict[str, Any]) -> str:
    """The phase as an applicant reads it. A stopped form reads as a market whose applications have
    closed, the words such a market showed before the stage was one phase."""
    phase = phase_from_market_document(market_doc)
    if phase is MarketPhase.APPLICATIONS and not takes_applications(market_doc):
        return "Applications Closed"
    return phase_label(phase)


# ── Public (unauthenticated) endpoints ─────────────────────────────────────

#: What every public read answers for a market it does not serve, and for a slug that names none.
MARKET_NOT_FOUND = "Market not found. Check the URL and try again."


def get_vendor_page(market_slug: str) -> Tuple[Dict[str, Any], int]:
    """What a market's vendor page, at ``/<slug>/vendor``, needs before anyone signs in (ADR 0022).

    The market page at ``/<slug>`` reads the same answer to choose its map, call or notice
    (ADR 0039).
    Served for a market ``vendor_page_market_by_slug`` serves, and otherwise the same 404 a slug
    naming nothing gets. ``ended`` is an archived market that ran, whose page is the record of where
    its vendors sat; ``rememberUntil`` is the date "Remember me" would end, or null once the
    market's last date has passed; ``mapOpen`` is whether the public map is open
    (``public_map_is_open``), the gate the map's own read is built on; ``selfCheckIn`` is whether
    the market lets its vendors check themselves in and out.
    """
    from db_config import get_database
    db = get_database()
    # The whole document, read once: ``mapOpen`` reads the market's form, layouts and settings.
    market_doc = vendor_page_market_by_slug(db["markets"], market_slug)
    if not market_doc:
        return {"error": MARKET_NOT_FOUND}, 404

    dates = market_dates_of(market_doc)
    return {
        "marketName": market_doc_field(market_doc, "name") or "",
        "intakeMode": intake_mode_from_market_document(market_doc).value,
        "phase": phase_from_market_document(market_doc).value,
        "takesApplications": takes_applications(market_doc),
        "resultsPublished": results_are_out(market_doc),
        "marketDates": dates,
        "ended": AttendanceApi.ended_after_it_ran(market_doc),
        "rememberUntil": RememberedSignIns.remembered_until_date(dates, RememberedSignIns.now()),
        "mapOpen": public_map_is_open(market_doc),
        "selfCheckIn": vendor_self_check_in_from_market_document(market_doc),
    }, 200


def get_public_application_form(
    market_slug: str,
) -> Tuple[Dict[str, Any], int]:
    """Return the public application form for a market.

    Accessible without authentication. The form is returned for every market the applicant intake
    lookup serves - a form market, in every phase but draft (``APPLICANT_SURFACE_PHASES``) - alongside
    the phase and an ``is_open`` flag that says whether the market is still taking applications. It
    is not gated on applications being open, on purpose: the market's vendor page renders stored
    answers against this field list, so a market that has closed still has to be able to hand it
    over (bug 20).

    Args:
        market_slug: The URL-safe slug of the market.

    Returns:
        Tuple of (response_body, status_code).
    """
    if not market_slug or not market_slug.strip():
        return {"error": "Market identifier is required."}, 400

    from db_config import get_database
    db = get_database()
    market_doc = applicant_intake_market_by_slug(
        db["markets"],
        market_slug,
        fields=(
            "id", "name", "phase", "applicationForm", "resultsPublished", "setupObject",
            "applicationsStopped",
        ),
    )
    if not market_doc:
        return {"error": MARKET_NOT_FOUND}, 404

    phase = phase_from_market_document(market_doc)
    drawn = _drawn_form(market_doc)

    return {
        "application_form": drawn.application_form,
        "essential_options": drawn.essential_options,
        "formVersion": _version_of(drawn),
        "market_name": market_doc.get("name", ""),
        "phase": phase.value,
        "is_open": takes_applications(market_doc),
        "phase_label": applicant_phase_label(market_doc),
    }, 200


class _DrawnForm(NamedTuple):
    """The form as the vendor's page draws it: the market's own questions, None for a market with
    no form, and what the essential questions offer, each as the public form read serves it."""

    application_form: Optional[Dict[str, Any]]
    essential_options: Dict[str, Any]


def _drawn_form(market_doc: Dict[str, Any]) -> _DrawnForm:
    """What ``get_public_application_form`` serves of the form, over the raw stored market document
    (its projection holding ``applicationForm`` and ``setupObject``)."""
    application_form = market_doc_field(market_doc, "application_form")

    form_payload = None
    if application_form:
        fields = []
        for i, f in enumerate(application_form.get("fields", [])):
            fields.append({
                "key": f.get("key", ""),
                "label": f.get("label", ""),
                "type": f.get("type", "text"),
                "required": f.get("required", False),
                "options": f.get("options", []),
                "helpText": f.get("helpText"),
                "order": f.get("order", i),
            })
        form_payload = {"fields": fields}

    essential_options = EssentialFields.effective_essential_options(market_doc)
    return _DrawnForm(form_payload, EssentialFields.essential_options_payload(essential_options))


def _version_of(drawn: _DrawnForm) -> str:
    canonical = json.dumps(drawn._asdict(), sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def applicant_form_version(market_doc: Dict[str, Any]) -> str:
    """The form version: a fingerprint of the form as the vendor's page draws it (T507).

    The SHA-256 hex digest of the canonical JSON of what the public form read serves of the form,
    the market's own questions and the essential options, so it moves with anything the vendor
    sees (a question's label, help text, options, order or required flag, a question added or
    removed, the plan's dates, sections or tiers before the first application froze them, an
    unasked essential) and never with what they cannot (a layout saved, a form saved
    unchanged, a phase move). Neither revision counter stands in for it: ``formRevision`` misses
    the plan's options, and ``planRevision`` moves on every layout save. The read serves it as
    ``formVersion``, and ``save_applicant_application`` refuses a save carrying another
    (docs/business/rules/a-vendors-save-is-held-to-the-form-they-saw.md). Never stored.
    """
    return _version_of(_drawn_form(market_doc))


# ── Applicant (JWT-authenticated) endpoints ────────────────────────────────


def get_applicant_application(
    market_slug: str, token_payload: Dict[str, Any],
) -> Tuple[Dict[str, Any], int]:
    """Return the authenticated applicant's application data for this market.

    The status is passed through ``applicant_visible_status`` so the publication gate is enforced
    on the applicant read path.

    Args:
        market_slug: The URL-safe slug of the market.
        token_payload: Decoded JWT payload from ``verify_application_token``.

    Returns:
        Tuple of (response_body, status_code).
    """
    # Verify the token belongs to this market
    from db_config import get_database
    db = get_database()
    market_doc = vendor_page_market_by_slug(
        db["markets"], market_slug, fields=("id", "resultsPublished", "assignmentObject"))
    if not market_doc:
        return {"error": MARKET_NOT_FOUND}, 404

    market_id = market_doc.get("id", "")
    token_market_id = token_payload.get("market_id", "")
    if token_market_id != market_id:
        return {"error": "Your sign-in is for a different market. Please sign in again."}, 403

    # Found by its identity - this market, this address - which is what the token proves. A vendor
    # who has signed in but not yet applied has none, and that is an answer, not an error.
    app_doc = ApplicationsApi.find_application_by_email(market_id, token_payload.get("email", ""))
    if not app_doc:
        return {"application": None}, 200

    app = Application(**app_doc)
    results_published = results_are_out(market_doc)
    return {"application": _application_response(
        app, results_published, _stored_placements(market_doc),
        AttendanceApi.check_ins_of(market_id, app.applicant_email),
        AttendanceApi.check_outs_of(market_id, app.applicant_email),
        with_answers=market_serves_applicants(market_doc))}, 200


def _stored_placements(market_doc: Dict[str, Any]) -> List[VendorAssignmentResult]:
    """The seats a market document stores, as the outcome is read off them (E36/F05/S02)."""
    rows = (market_doc_field(market_doc, "assignment_object") or {}).get("vendorAssignments") or []
    return [VendorAssignmentResult(**convert_keys_to_snake_case(row)) for row in rows]


def _gone_under_the_save(
    markets_collection: Any, market_id: str,
) -> Optional[Tuple[Dict[str, Any], int]]:
    """The 404 a save answers when its market is gone or certainly going under it, having taken
    back what it wrote (``market_deletion.kept_only_while_live``); None while the market is live,
    or carries a tombstone its organization's deletion may still take back."""
    try:
        MarketDeletion.kept_only_while_live(markets_collection, market_id)
    except MarketDeletion.MarketGoneUnderWrite:
        return {"error": "Market not found."}, 404
    return None


#: The applicant's save met their application moved under it ``ANSWER_TRIES`` times running: a
#: verdict, most likely, which they never read of, so the sentence names none.
CHANGED_WHILE_SAVED = "Your application changed while it was saved. Save again."

#: The vendor's page was drawn from another form than the market asks now
#: (``applicant_form_version``).
FORM_CHANGED = "This form changed since you opened it. Reload to continue."
FORM_CHANGED_CODE = "form_changed"


def save_applicant_application(
    market_slug: str, token_payload: Dict[str, Any], form_data: Dict[str, Any],
    form_version: Any,
) -> Tuple[Dict[str, Any], int]:
    """Save or update the authenticated applicant's application for this market.

    Validates the form data against the market's application form fields, and the essential
    answers against what the essential questions offer (``essential_fields``). Refuses
    submission unless the market takes applications (``takes_applications``).
    The applicant owns their answers but never ``status``, though changing them sends a person's
    approval or rejection back to open (decision 9.1). The save holds the application as it read
    it, so it never lands under a verdict given since: it reads it again and saves on what is
    stored then, ``ANSWER_TRIES`` times, then answers 409 ``CHANGED_WHILE_SAVED``.

    The save is held to the form the vendor's page drew: a ``form_version`` that is not the form's
    version now (``applicant_form_version``), ``None`` (a body that named none, as a tab opened
    before the version existed sends) and a value that is not a string included, is answered
    409 ``FORM_CHANGED`` once the market is known to take applications and before any answer is
    judged or anything written, so no answer lands against a form the vendor never saw.

    The first successful save freezes the essential offering onto the market's stored form
    (``freeze_and_effective_essential_options``), atomically and before the answers are
    persisted, so later market-plan edits can never move a question an applicant has already
    answered and no answer is ever recorded against an unfrozen offering.

    Args:
        market_slug: The URL-safe slug of the market.
        token_payload: Decoded JWT payload from ``verify_application_token``.
        form_data: The form answers keyed by field keys.
        form_version: The form version the vendor's page read with the form, ``None`` for a body
            that named none.

    Returns:
        Tuple of (response_body, status_code).
    """
    if not isinstance(form_data, dict):
        return {"error": "Form answers must be an object keyed by field key."}, 400

    from db_config import get_database
    db = get_database()

    market_doc = applicant_intake_market_by_slug(
        db["markets"],
        market_slug,
        fields=(
            "id", "phase", "applicationForm", "resultsPublished", "setupObject",
            "applicationsStopped",
        ),
    )
    if not market_doc:
        return {"error": "Market not found."}, 404

    market_id = market_doc.get("id", "")
    token_market_id = token_payload.get("market_id", "")
    if token_market_id != market_id:
        return {"error": "Your sign-in is for a different market."}, 403

    if not takes_applications(market_doc):
        return {
            "error": f"Applications are no longer open for this market. "
                     f"The market is in the {applicant_phase_label(market_doc)} phase.",
        }, 403

    # Judged on the one read the answers are judged on, so a form change landing after it is a
    # change after this save, as it would be had the save come a moment sooner.
    if form_version != applicant_form_version(market_doc):
        return {"error": FORM_CHANGED, "code": FORM_CHANGED_CODE}, 409

    email = token_payload.get("email", "")
    existing = ApplicationsApi.find_application_by_email(market_id, email)

    # A first save creates the application (E26/F07/S01) - and only once the answers would be
    # accepted, so a refused first try leaves nothing behind for the organizer to review as an
    # empty application (the importer learned that as bug 5).
    if existing is None:
        refusal = validate_application_answers(market_doc, form_data)
        if refusal:
            return {"error": refusal}, 422
    # The applicant's own save is its arrival, marked for the deal as it is created, and the write
    # a verdict it sends back to open is dealt by.
    arrival = ReviewState.Arrival(email, History.APPLY)
    app_doc = existing or ReviewState.arrive(
        market_id, email, ApplicationOrigin.APPLIED, None, arrival).model_dump()

    # Validation, the offering freeze, the write and the status all live in one place, so an
    # imported application and a form-submitted one cannot drift apart.
    for _try in range(ANSWER_TRIES):
        error, app, returned = record_application_answers(
            db["markets"], market_doc, app_doc, form_data,
            source=ReviewState.Source.APPLICANT, arrival=arrival)
        if error != ANSWERS_MOVED:
            break
        # A verdict landed since the read: saved again on the application as it is now.
        app_doc = ApplicationsApi.find_application_by_id(app_doc.get("id", ""))
        if app_doc is None:
            return _gone_under_the_save(db["markets"], market_id) or (
                {"error": CHANGED_WHILE_SAVED}, 409)
    else:
        return {"error": CHANGED_WHILE_SAVED}, 409
    if error:
        # Only reachable for a new application if the offering froze differently between the
        # check and the write; the application made for these answers must not outlive them.
        if existing is None:
            ApplicationsApi.delete_application(app_doc.get("id", ""))
        return _gone_under_the_save(db["markets"], market_id) or ({"error": error}, 422)

    answered = app_doc.get("form_data") or {}

    # The market's rules judge it as it arrives (E33/F03/S02); the applicant is told nothing of it.
    # Read whole, through the canonical parse: the applicant's projection carries only what they see.
    whole = db["markets"].find_one(live({"id": market_id}))
    if whole is None:
        return _gone_under_the_save(db["markets"], market_id) or ({"error": "Market not found."}, 404)
    market = market_from_document(whole)
    verdicts = RejectionRules.judge(RejectionRules.Rulebook(market), market_id, app.id,
                                    arrival=arrival)
    # After the rules, so the entry says what they did to it: no rule records an entry of its own.
    saved = app
    History.record_applicant(
        market_id, email, History.EDITED if existing else History.SUBMITTED, app.id,
        lambda: _with_rules(History.changes(answered, saved.form_data or {}), verdicts,
                            returned))
    # Then dealt to the next reviewer in turn, if reviewers are chosen and it is still open
    # (E38/F07/S03), recorded as the applicant's own arrival; anything else waiting is recorded
    # under the write that marked it, never theirs.
    ReviewTeam.deal_arrivals(market)
    # After the save's last write: a deletion that began after the market was read above has
    # swept, or will sweep, everything written here, or this takes it back (``market_deletion``).
    gone = _gone_under_the_save(db["markets"], market_id)
    if gone:
        return gone
    if verdicts.rejected:
        app = Application(**ApplicationsApi.find_application_by_id(app.id))

    results_published = bool(market_doc.get("resultsPublished"))
    return {"application": _application_response(
        app, results_published, market.assignment_object.vendor_assignments or [])}, 200


# ── Organizer (session-authenticated) endpoints ────────────────────────────


def list_market_applications(market_id: str) -> Tuple[Dict[str, Any], int]:
    """Return every application for a market. Organizer only, always sees raw status."""
    parsed: List[Application] = []
    for doc in ApplicationsApi.list_applications_for_market(market_id):
        try:
            parsed.append(Application(**doc))
        except Exception as e:
            # Where it failed and never the input, which holds the applicant's answers.
            logger.warning(
                "Failed to parse application %s: %s", doc.get("id", "?"), parse_failure_detail(e),
            )

    # Whether each table-share request can be met depends on the market's other applications, so
    # it is derived here, where all of them are in hand, and never stored (E27/F01/S03).
    unpaired = TableShare.why_unpaired(
        [_share_request(app) for app in parsed],
        answered={
            app.applicant_email for app in parsed
            if EssentialFields.answered_table_share(ApplicationsApi.effective_answers(app))
        },
    )
    result = []
    for app in parsed:
        notice = unpaired.get(app.applicant_email)
        result.append({
            **_application_response_organizer(app),
            "tableShareNotice": notice.as_payload() if notice else None,
        })
    return {"applications": result}, 200


def _share_request(app: Application) -> TableShare.ShareRequest:
    answers = ApplicationsApi.effective_answers(app)
    return TableShare.ShareRequest(
        email=app.applicant_email,
        table_choice=answers.get(EssentialFields.TABLE_CHOICE_KEY),
        partners=(
            str(answers.get(EssentialFields.TABLE_SHARE_EMAIL_KEY) or ""),
            *(str(a) for a in answers.get(EssentialFields.TABLE_SHARE_ALSO_KEY) or []),
        ),
        taking_part=app.status not in _NOT_TAKING_PART,
    )


# Applications nobody will be seated from: the solver reads approved ones, and these never will be.
_NOT_TAKING_PART = (ApplicationStatus.REVIEWER_REJECTED, ApplicationStatus.CANCELLED)


#: What a reviewer did to an application, in the words a refused reviewer is told (E34/F03/S01).
_DONE_SINCE = {
    ApplicationStatus.REVIEWER_APPROVED.value: "approved this application",
    ApplicationStatus.REVIEWER_REJECTED.value: "rejected this application",
    ApplicationStatus.NEEDS_FOLLOW_UP.value: "marked this application as needing a follow-up",
}
_STATUS_WORD = {
    ApplicationStatus.REVIEWER_APPROVED.value: "approved",
    ApplicationStatus.REVIEWER_REJECTED.value: "rejected",
    ApplicationStatus.NEEDS_FOLLOW_UP.value: "needing a follow-up",
}


#: Why a verdict naming nothing it saw is refused: the verdict is held on what the reviewer saw, so
#: without it nothing says it still is (E34/F03/S01).
SEEN_REQUIRED = "Say what the application was when you opened it."


def seen_from(raw: Any) -> Optional[Dict[str, Any]]:
    """What a reviewer saw of an application, from the wire's ``{status, verdictAt, updatedAt}``,
    or None when they sent nothing (E34/F03/S01)."""
    if not isinstance(raw, dict):
        return None
    return {"status": raw.get("status"), "verdict_at": raw.get("verdictAt"),
            "updated_at": raw.get("updatedAt")}


def _changed_since_seen(doc: Dict[str, Any], seen: Optional[Dict[str, Any]] = None) -> str:
    """Who changed an application since a reviewer opened it, and to what (E34/F03/S01)."""
    if (seen and seen.get("status") == doc.get("status")
            and (seen.get("verdict_at") or None) == (doc.get("verdict_at") or None)):
        return "Its answers changed since you opened it."
    done = _DONE_SINCE.get(str(doc.get("status")))
    by = doc.get("verdict_by") or {}
    if done and by.get("kind") == "rule":
        return (f"An automatic rejection {_STATUS_WORD[str(doc.get('status'))]} this application "
                "since you opened it.")
    if done and by.get("email"):
        return f"{by['email']} {done} since you opened it."
    return "This application changed since you opened it."


class Reviewing(NamedTuple):
    """The two rows a reviewer's verdict asks (E38/F06/S01): ``giving``, the Give verdicts asking
    that let them in, and ``changing``, the Change verdicts asking on top of it, which may refuse
    them. Its entry is recorded through the one the write took (``_verdict_asking``)."""

    giving: Actions.Asked
    changing: Actions.Asked


def review_application(
    market_id: str, application_id: str, new_status: ApplicationStatus, by: VerdictGiver,
    reviewing: Reviewing, owner: Optional[MarketPerson] = None,
    seen: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], int]:
    """Record a review verdict on an application, and who gave it (E34/F01/S01). Organizer only,
    always sees raw status.

    The verdict is written but NOT revealed to the applicant until results are published.

    ``seen`` is the application as the reviewer saw it - its status, its verdict's time and its
    answers' time - and the verdict is written only if it still is (E34/F03/S01); one naming none is
    refused (``SEEN_REQUIRED``). Two reviewers at once used to mean the last verdict silently won;
    now the second is refused with a 409 naming who changed it and to what, and the application as
    it stands, so they decide again on what is really there.

    What they saw says which event it is: a verdict on an application awaiting one gives it, and a
    write on one already approved or rejected changes a verdict, the table's change row
    (E38/F06/S01): ``reviewing.changing`` is that row's asking of this reviewer. While it refuses
    them, an application they saw decided is refused in its words, a 403, and one decided since they
    saw it is the 409 above, never written over. A change the table refuses (an added vendor's
    approval to anything but a rejection) is a 400 in the table's words.
    """
    change_refused = reviewing.changing.refused
    if new_status not in ReviewState.MARKED_STATUSES:
        return {"error": f"Invalid review status: {new_status.value}"}, 400
    if seen is None:
        return {"error": SEEN_REQUIRED}, 400

    app_doc = ApplicationsApi.find_application_by_id(application_id)
    if not app_doc or app_doc.get("market_id") != market_id:
        return {"error": "Application not found for this market."}, 404
    giving = not ReviewState.saw_decided(seen)
    if not giving and change_refused:
        return {"error": change_refused}, 403

    event = ReviewState.give_verdict if giving else ReviewState.change_verdict
    written = event(app_doc, seen, new_status, by, owner)
    if isinstance(written, ReviewState.Refused) and written.reason:
        return {"error": written.reason}, 400
    if not written:
        now = ApplicationsApi.find_application_by_id(application_id)
        if now is None:
            return {"error": "Application not found."}, 404
        return {
            "error": _changed_since_seen(now, seen),
            "application": _application_response_organizer(Application(**now)),
        }, 409

    stored = ApplicationsApi.find_application_by_id(application_id)
    _verdict_asking(reviewing, [app_doc]).record(
        kind=History.VERDICT,
        vendors=[app_doc.get("applicant_email")], subject={"application_id": application_id},
        detail=lambda: {"before": _verdict_state(app_doc), "after": _verdict_state(stored),
                        **_dealt_to(app_doc)},
    )
    app = Application(**stored)
    return {"application": _application_response_organizer(app),
            **(undo_window() if giving else {})}, 200


def _verdict_asking(reviewing: Reviewing, before: List[Dict[str, Any]]) -> Actions.Asked:
    """The asking of the table's row a reviewer's write took, which records its history entry:
    changing a verdict when any application it wrote was decided, else giving one (E38/F06/S01).
    Each is written only as its reviewer saw it (``seen``), so one read decided was seen decided,
    and only a reviewer the change row lets in writes it."""
    if any(ReviewState.is_decided(doc) for doc in before):
        return reviewing.changing
    return reviewing.giving


def _with_rules(
    answers: Optional[Dict[str, Any]], verdicts: RejectionRules.Judged, returned: bool,
) -> Optional[Dict[str, Any]]:
    """An applicant's changed answers, whether the rules rejected or returned the application as
    they landed, and ``returned_to_review`` when the change sent a verdict back to open (decision
    9.1); answers saved unchanged record nothing."""
    if not answers:
        return None
    return {**answers, "rejected_by_rules": bool(verdicts.rejected),
            "returned_by_rules": bool(verdicts.returned),
            **({"returned_to_review": True} if returned else {})}


def _dealt_to(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Whom the application was dealt to, for a verdict's entry beside who gave it (E38/F07/S02):
    ``dealt_to``, the reviewer's address, when it has one, and nothing otherwise."""
    reviewer = (doc.get("reviewer") or {}).get("email")
    return {"dealt_to": reviewer} if reviewer else {}


def _each_dealt_to(docs: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """``_dealt_to`` for a selection's entry: by application id, for those that were dealt."""
    dealt = {doc["id"]: _dealt_to(doc)["dealt_to"] for doc in docs if _dealt_to(doc)}
    return {"dealt_to": dealt} if dealt else {}


def _verdict_state(doc: Dict[str, Any]) -> Dict[str, Any]:
    """What a verdict changes, for its history entry: the status, and the follow-up's owner while
    there is one. Recorded whole even when a verdict is given again, since each one is recorded."""
    owner = (doc.get("follow_up_owner") or {}).get("email")
    return {"status": doc.get("status"), **({"follow_up_owner": owner} if owner else {})}


def review_selection(
    market_id: str, selection: List[Tuple[str, Optional[Dict[str, Any]]]],
    new_status: ApplicationStatus, by: VerdictGiver, reviewing: Reviewing,
) -> Tuple[Dict[str, Any], int]:
    """One verdict for a ticked selection (E34/F04/S02). Organizer only.

    Each is written as a single verdict is, only on what the reviewer saw (``seen``, F03/S01), and
    one naming nothing it saw is skipped with ``SEEN_REQUIRED``; one another reviewer holds open is
    not written at all, nor one of another market. The answer says which were written and, for
    each skipped, why - never an action on "everything matching". One already at the status asked
    for is skipped too: a follow-up marked again would quietly change hands. One already approved
    or rejected is skipped in the words of ``reviewing.changing`` while it refuses: this reviewer
    gives verdicts but may not change one (E38/F06/S01). One the table refuses is skipped with its
    words.
    """
    change_refused = reviewing.changing.refused
    if new_status not in ReviewState.MARKED_STATUSES:
        return {"error": f"Invalid review status: {new_status.value}"}, 400
    me = {"user_id": by.user_id, "email": by.email}
    written: List[str] = []
    was: Dict[str, Dict[str, Any]] = {}
    skipped: List[Dict[str, Any]] = []
    for app_id, seen in selection:
        doc = ApplicationsApi.find_application_by_id(app_id)
        if doc is None or doc.get("market_id") != market_id:
            skipped.append({"id": app_id, "email": None, "reason": "Not an application here."})
            continue
        if seen is None:
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": SEEN_REQUIRED})
            continue
        holder = ApplicationsApi.holder_of(doc)
        if holder is not None and holder != me:
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": f"{holder['email']} has it open."})
            continue
        if doc.get("status") == new_status.value:
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": f"Already {_STATUS_WORD[new_status.value]}."})
            continue
        # Decided as they saw it, or by now: either way not theirs to change, so the row says why.
        if change_refused and (ReviewState.saw_decided(seen) or ReviewState.is_decided(doc)):
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": change_refused})
            continue
        event = (ReviewState.change_verdict if ReviewState.saw_decided(seen)
                 else ReviewState.give_verdict)
        done = event(doc, seen, new_status, by)
        if done:
            written.append(app_id)
            was[app_id] = doc
        elif isinstance(done, ReviewState.Refused) and done.reason:
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": done.reason})
        else:
            now = ApplicationsApi.find_application_by_id(app_id) or doc
            skipped.append({"id": app_id, "email": doc.get("applicant_email"),
                            "reason": _changed_since_seen(now, seen)})
    if written:
        # One entry for the selection, as it was one action, naming every vendor it decided.
        _verdict_asking(reviewing, [was[app_id] for app_id in written]).record(
            kind=History.VERDICTS,
            vendors=[was[app_id].get("applicant_email") for app_id in written],
            subject={"application_ids": written},
            detail=lambda: {
                "before": {app_id: _verdict_state(was[app_id]) for app_id in written},
                "after": {
                    app_id: _verdict_state(ApplicationsApi.find_application_by_id(app_id))
                    for app_id in written
                },
                **_each_dealt_to(was[app_id] for app_id in written),
            },
        )
    # Undone only as a whole, so offered only when every one it wrote kept what it was.
    undoable = written and all(ReviewState.is_undecided(was[app_id]) for app_id in written)
    return {"written": written, "skipped": skipped, **(undo_window() if undoable else {})}, 200


#: Why an undo is refused when its verdict is not the reviewer's own any longer, or the window has
#: passed (E38/F10/S01): who may still change it, the change row's default.
UNDO_REFUSED = "This verdict can no longer be undone here. An Admin or the owner can change it."

#: Why an undo is refused when the follow-up it would bring back is owned by someone the reviewer
#: may not hand one to now (E38/F10/S01): its own words, since an undo hands it to nobody, and
#: words that never tell someone outside the organization whether the owner is in it.
UNDO_OWNER_REFUSED = (
    "This verdict can no longer be undone here: the follow-up it closed would come back to an "
    "owner you cannot see on this market. An Admin or the market's owner can change it."
)


def undo_window() -> Dict[str, int]:
    """How long a verdict just written may be undone by its giver, for its answer: the client times
    its Undo from this, so the window is kept in one place (E38/F10/S01). Answered only for a
    verdict that kept what the application was, so the client offers Undo only where it may."""
    return {"undoSeconds": int(ReviewState.UNDO_WINDOW.total_seconds())}


#: What a reviewer asks to undo: the application, and how they saw it once their verdict was written.
UndoAsked = Tuple[str, Optional[Dict[str, Any]]]
#: Whether a follow-up may come back owned by this address: the review route's own check of an
#: owner (``follow_up_owner``), asked of the market the caller read.
OwnerOffered = Callable[[str], bool]


def _undo_one(
    market_id: str, asked: UndoAsked, by: VerdictGiver, owner_offered: OwnerOffered,
    giving: Actions.Asked,
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[Tuple[str, int]]]:
    """Undo one verdict: the application as it was and as it is now, or why not and its status;
    one returned to open or follow-up is marked for the deal under ``giving``, the undo's asking.

    Asked in this order: an application of another market is not there; one changed since the
    reviewer's verdict is stale, never written over; one that is not their own verdict within the
    window, or kept nothing to return to, is refused; a follow-up whose owner the reviewer may no
    longer hand one to is refused in the undo's own words. It returns to what the verdict kept
    (``undo_to``), never to what a request names. The write is conditional on the status and the
    verdict's time the reviewer saw, so a verdict landing between this read and the write is the
    stale answer too.
    """
    app_id, seen = asked
    doc = ApplicationsApi.find_application_by_id(app_id)
    if doc is None or doc.get("market_id") != market_id:
        return None, None, ("Not an application here.", 404)
    pinned = {"status": (seen or {}).get("status"), "verdict_at": (seen or {}).get("verdict_at")}
    if (pinned["status"] != doc.get("status")
            or (pinned["verdict_at"] or None) != (doc.get("verdict_at") or None)):
        return doc, None, (_changed_since_seen(doc, seen), 409)
    if not ReviewState.undoable_by(doc, by.user_id):
        return doc, None, (UNDO_REFUSED, 403)
    owner = (doc["undo_to"].get("follow_up_owner") or {}).get("email")
    if owner and not owner_offered(owner):
        return doc, None, (UNDO_OWNER_REFUSED, 400)
    done = ReviewState.undo(doc, pinned, by, ReviewState.Arrival.of(giving))
    if isinstance(done, ReviewState.Refused):
        return doc, None, (UNDO_REFUSED, 403)
    if not done:
        now = ApplicationsApi.find_application_by_id(app_id) or doc
        return now, None, (_changed_since_seen(now, seen), 409)
    return doc, ApplicationsApi.find_application_by_id(app_id), None


def undo_verdict(
    market: Market, organization: Optional[Organization], asked: UndoAsked, by: VerdictGiver,
    owner_offered: OwnerOffered, giving: Actions.Asked,
) -> Tuple[Dict[str, Any], int]:
    """Undo the verdict, or the follow-up, this reviewer gave an application (E38/F10/S01).

    Theirs alone, within ``UNDO_WINDOW``, while they may still give verdicts (the caller asks
    ``verdict_refusal``) - giving, taken back, so never the change row: it is recorded through
    ``giving``, that row's asking. It returns the application to what the verdict found it as,
    open, or needs follow-up marked and owned as it was, and then deals it: still dealt to whom it
    was while they may review, else to the next reviewer in turn (E38/F07/S03). Refused with
    ``UNDO_REFUSED`` (403) once it is not theirs
    to undo, with ``UNDO_OWNER_REFUSED`` (400) for a follow-up whose owner it may no longer hand
    one to, and with the stale-verdict sentence and the application as it stands (409) when someone
    wrote over it since.
    """
    was, now, refused = _undo_one(market.id, asked, by, owner_offered, giving)
    if refused:
        reason, status = refused
        if status == 409 and was is not None:
            return {"error": reason,
                    "application": _application_response_organizer(Application(**was))}, 409
        return {"error": reason}, status
    giving.record(
        kind=History.VERDICT_UNDONE,
        vendors=[was.get("applicant_email")], subject={"application_id": asked[0]},
        detail=lambda: {"before": _verdict_state(was), "after": _verdict_state(now),
                        **_dealt_to(was)},
    )
    # After its entry, so the history reads the undo before the deal it waited for.
    if ReviewTeam.deal_waiting(market, organization):
        now = ApplicationsApi.find_application_by_id(asked[0]) or now
    return {"application": _application_response_organizer(Application(**now))}, 200


def undo_selection(
    market: Market, organization: Optional[Organization], selection: List[UndoAsked],
    by: VerdictGiver, owner_offered: OwnerOffered, giving: Actions.Asked,
) -> Tuple[Dict[str, Any], int]:
    """Undo what a selection's verdict wrote (E38/F10/S01), each as ``undo_verdict`` undoes one,
    answering which were written and, for each skipped, why - as ``review_selection`` answers."""
    written: List[str] = []
    was: Dict[str, Dict[str, Any]] = {}
    now: Dict[str, Dict[str, Any]] = {}
    skipped: List[Dict[str, Any]] = []
    for asked in selection:
        before, after, refused = _undo_one(market.id, asked, by, owner_offered, giving)
        if refused:
            skipped.append({"id": asked[0], "email": (before or {}).get("applicant_email"),
                            "reason": refused[0]})
            continue
        written.append(asked[0])
        was[asked[0]], now[asked[0]] = before, after
    if written:
        giving.record(
            kind=History.VERDICTS_UNDONE,
            vendors=[was[app_id].get("applicant_email") for app_id in written],
            subject={"application_ids": written},
            detail=lambda: {
                "before": {app_id: _verdict_state(was[app_id]) for app_id in written},
                "after": {app_id: _verdict_state(now[app_id]) for app_id in written},
                **_each_dealt_to(was[app_id] for app_id in written),
            },
        )
        ReviewTeam.deal_waiting(market, organization)
    return {"written": written, "skipped": skipped}, 200


def reassign_follow_up(
    market: Market, organization: Optional[Organization], application_id: str,
    owner: MarketPerson, giving: Actions.Asked,
) -> Tuple[Dict[str, Any], int]:
    """Hand a follow-up to someone else with a role on the market (E34/F02/S01), recorded through
    ``giving``, the signed-in reviewer's Give verdicts and follow-ups asking; then the deal keeps it
    with its new owner while they hold any role on the market, and hands it on to the next reviewer
    in turn otherwise (E38/F07/S03)."""
    app_doc = ApplicationsApi.find_application_by_id(application_id)
    if not app_doc or app_doc.get("market_id") != market.id:
        return {"error": "Application not found for this market."}, 404
    if not ReviewState.hand_on_follow_up(
            app_doc, owner, ReviewState.Arrival.of(giving)):
        return {"error": "Only an application that needs a follow-up has an owner."}, 409
    giving.record(
        kind=History.FOLLOW_UP_OWNER,
        vendors=[app_doc.get("applicant_email")], subject={"application_id": application_id},
        detail=lambda: History.changes(
            {"follow_up_owner": (app_doc.get("follow_up_owner") or {}).get("email")},
            {"follow_up_owner": owner.email},
        ),
    )
    ReviewTeam.deal_waiting(market, organization)
    app = Application(**ApplicationsApi.find_application_by_id(application_id))
    return {"application": _application_response_organizer(app)}, 200


def publish_results_refusal(
    market: Market, *, changed: Optional[Sequence[str]] = None,
) -> Optional[str]:
    """Why results cannot be published now, or None while they can (E36/F04/S01).

    The assignment's lifecycle owner says it (``lifecycle.publish_refusal``, T316): results wait
    for a table allocation that was run and is current, in assignment, so every applicant is told
    what the market will hold, and nobody's answer shifts under them through a later run. Served as
    ``publishWaitsReason``, beside the table's Publish results answer, so the button is offered
    exactly when the endpoint would take it.

    The same rule on both kinds of market: a Google Form market's vendors read their result on its
    vendor page, which opens with it (ADR 0022).
    """
    return Lifecycle.publish_refusal(market, changed=changed)


def applications_stop_refusal(market: Market) -> Optional[str]:
    """Why taking applications cannot be stopped or resumed now, or None while it can (E38/F04/S02).

    Inside the stage alone, and only where vendors apply on the market's own page: a Google Form
    market's form is the organizer's own, closed outside this product. Served on the market read as
    ``applicationsStopReason``, beside the table's Stop taking applications answer, so the rail
    offers the action exactly when the endpoint would take it.
    """
    if market.intake_mode is not IntakeMode.FORM:
        return "This market's vendors apply on its Google Form, so it has no application page to stop."
    if market.phase is not MarketPhase.APPLICATIONS:
        return "Applications are taken only in the Applications phase."
    return None


def set_applications_stopped(
    market_id: str, stopped: bool, asked: Actions.Asked,
) -> Tuple[Dict[str, Any], int]:
    """Stop taking applications, or take them again, on a market whose vendors apply on its page,
    recorded through ``asked``, the signed-in organizer's Stop taking applications asking.

    The write holds the phase and the intake mode the refusal judged (``write_market``), so a move
    into assignment that lands first leaves nothing to undo. Who may is the caller's to ask first.

    Raises:
        MarketChanged: the market moved, or its intake mode changed, since it was read.
    """
    from db_config import get_database
    db = get_database()

    doc = db["markets"].find_one(live({"id": market_id}))
    if not doc:
        return {"error": "Market not found."}, 404
    refusal = applications_stop_refusal(market_from_document(doc))
    if refusal:
        return {"error": refusal}, 409

    write_market(doc, {"$set": {market_doc_key("applications_stopped"): stopped}},
                 holds=(market_doc_key("intake_mode"),))
    # A stop restated records nothing.
    asked.record(detail=lambda: History.changes(
        {"applications_stopped": applications_stopped_from_market_document(doc)},
        {"applications_stopped": stopped}))
    return {"applications_stopped": stopped}, 200


def publish_results(market_id: str, asked: Actions.Asked) -> Tuple[Dict[str, Any], int]:
    """Flip the results_published flag on a market, making verdicts visible to applicants, and
    store the assignment revision it stood on (``lifecycle.publish``, T316), recorded through
    ``asked``, the signed-in organizer's Publish results asking.

    This is the single, deliberate, organizer-controlled moment the review verdicts become
    visible to the applicants who hold them. Before this call, every approved and rejected
    application reads as ``under_review`` to its applicant. After it, applicants see their
    actual outcome.

    On a Google Form market it is also what opens the vendor page (``vendor_page_market_by_slug``),
    since its vendors have nothing to read there before it.
    """
    from db_config import get_database
    db = get_database()

    doc = db["markets"].find_one(live({"id": market_id}))
    if not doc:
        return {"error": "Market not found."}, 404

    refusal = publish_results_refusal(market_from_document(doc))
    if refusal:
        return {"error": refusal}, 409

    # Holding what the refusal read, and storing the revision it stood on (T207, T316).
    Lifecycle.publish(doc)
    asked.record(detail=lambda: History.changes(
        {"results_published": False}, {"results_published": True}))
    return {"results_published": True}, 200
