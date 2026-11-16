"""Single owner of an application's review state: the only code that writes it.

The review state is the fields a verdict, a follow-up, a deal, an addition or an undo moves:
``OWNED_FIELDS``. Every write of any of them is a function here, and
``tests/test_one_writer_of_the_review_state.py`` fails when any other module writes one, so a rule
about how an application moves between open, follow-up, approved and rejected is written once and
cannot be bypassed by a second writer that forgot it (ADR 0034).

Imported by its callers as ``ReviewState``, since ``datatypes.ApplicationStatus`` is the stored
spelling of one of its fields.

``api/applications.py`` still owns the collection's storage contract (its key spelling, its
identity index, its reads) and binds the collection: every write here goes through
``ApplicationsApi.applications_collection``, read at the call, so the suite's fakes and the
real-MongoDB world rebind one name. It keeps the claim's writes and the deletes, which name no
field owned here. The two modules import each other, and neither reads the other at import.

``review_team.py`` stays the single owner of dealing (ADR 0020): it decides whom an application
goes to, holding the market, and calls the deal functions here to write it.
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

import api.applications as ApplicationsApi
from datatypes import AnswerUpdate, Application, ApplicationStatus, MarketPerson, VerdictGiver

#: The fields only this module writes: an application's review state. Each move between states
#: writes several of them in one update, which is why they are owned together. ``origin`` is how an
#: application came to the market, owned before anything stores it, so its first writer is here.
OWNED_FIELDS = (
    "status", "verdict_by", "verdict_at", "verdict_reason", "follow_up_owner", "undo_to",
    "added_by", "added_at", "origin", "arriving", "reviewer",
)

#: Statuses nobody has decided yet.
UNDECIDED_STATUSES = (ApplicationStatus.OPEN.value, ApplicationStatus.UNDER_REVIEW.value)
#: The statuses a reviewer gives, each with who gave it: a verdict, or a follow-up (E34).
MARKED_STATUSES = (ApplicationStatus.REVIEWER_APPROVED, ApplicationStatus.REVIEWER_REJECTED,
                   ApplicationStatus.NEEDS_FOLLOW_UP)
#: The verdicts: an application at one is decided, and a reviewer's write over it changes a verdict
#: (E38/F06/S01). A follow-up is marked, not decided: deciding one is giving a verdict.
VERDICT_STATUSES = (ApplicationStatus.REVIEWER_APPROVED.value,
                    ApplicationStatus.REVIEWER_REJECTED.value)


def is_decided(doc: Dict[str, Any]) -> bool:
    """Whether an application, as stored or as a reviewer saw it, carries a verdict."""
    return doc.get("status") in VERDICT_STATUSES


def is_judgeable(application: Dict[str, Any]) -> bool:
    """Whether a market's automatic rejections may judge this stored application: an undecided
    one, or one a rule rejected; never one a person decided. The import's preview asks it of an
    application as the import would leave it (E38/F03/S02)."""
    status = application.get("status")
    return status in UNDECIDED_STATUSES or (
        status == ApplicationStatus.REVIEWER_REJECTED.value
        and (application.get("verdict_by") or {}).get("kind") == "rule")


#: How long the person who gave a verdict, or marked a follow-up, may take it back themselves
#: (E38/F10/S01): long enough to notice a slip while reading the next card, short enough that
#: nobody else has acted on it. After it, changing a verdict is the change row's (E38/F06/S01).
UNDO_WINDOW = timedelta(minutes=2)
#: What an undo returns an application to, kept on it by the verdict that left it (``undo_to``): its
#: status, giver, time and follow-up owner as they were, while it was awaiting a verdict. Kept by the
#: server, so an undo never returns an application to what a request names; a verdict that changed
#: one keeps nothing, since an undo is never a change of a verdict.
UNDO_KEEPS = ("status", "verdict_by", "verdict_at", "follow_up_owner")


def undo_to_of(doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What undoing a verdict given on this application, as read, would return it to (E38/F10/S01):
    its ``UNDO_KEEPS`` while it awaits a verdict - undecided or needing a follow-up - else None."""
    if doc.get("status") not in UNDECIDED_STATUSES + (ApplicationStatus.NEEDS_FOLLOW_UP.value,):
        return None
    return {key: doc.get(key) for key in UNDO_KEEPS}


def undoable_by(doc: Dict[str, Any], user_id: Optional[str]) -> bool:
    """Whether this person may still undo what they marked on this application: a verdict or a
    follow-up that they gave, by user id, within ``UNDO_WINDOW`` of it, which kept what the
    application was before it (``undo_to``, E38/F10/S01)."""
    if doc.get("status") not in {status.value for status in MARKED_STATUSES} or not user_id:
        return False
    if not isinstance(doc.get("undo_to"), dict):
        return False
    by = doc.get("verdict_by") or {}
    if by.get("kind") != "person" or by.get("user_id") != user_id:
        return False
    try:
        at = datetime.fromisoformat(str(doc.get("verdict_at")))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - at <= UNDO_WINDOW


# --- An application arrives, or is added ----------------------------------------------------------

def find_or_create_application(app: Application) -> Application:
    """Store this application, unless one already exists for the applicant it belongs to.

    A single conditional upsert, so that a request which loses the race to another one for the same
    address does not leave a second document behind: the identity fields are the filter, the rest of
    the document is written only on insert, and the unique index in
    ``ApplicationsApi.ensure_application_indexes`` is what makes the losing insert fail rather than
    duplicate.

    That failure is a ``DuplicateKeyError``, which an upsert can raise even though it matched
    nothing -- the winner's insert lands between this one's read and its own write -- so it is caught
    and the winner's document is returned. Either way the caller gets the one application that
    exists, which is what it asked for.
    """
    ApplicationsApi.ensure_application_indexes()
    identity = ApplicationsApi.applicant_filter(
        app.market_id, app.applicant_email, app.application_type.value,
    )
    # The identity fields come from the filter, which is where an upsert takes them from; repeating
    # them in the insert body would only be a second chance to disagree with it.
    body = {key: value for key, value in app.model_dump().items() if key not in identity}

    for _attempt in range(2):
        try:
            stored = ApplicationsApi.applications_collection.find_one_and_update(
                identity,
                {"$setOnInsert": body},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
            if stored:
                return Application(**stored)
        except DuplicateKeyError:
            pass
        existing = ApplicationsApi.applications_collection.find_one(identity)
        if existing:
            return Application(**existing)

    # Named by its market and never its address: this escapes to the 500 log, which holds none.
    raise PyMongoError(
        f"Could not store an application for market {app.market_id}: a concurrent write for the "
        f"same applicant keeps winning, and no document for them can be read back."
    )


# --- The answers ----------------------------------------------------------------------------------

def update_application_form_data(
    app_id: str, form_data: Dict[str, Any], submitted_at: str, updated_at: str,
    *, held: Optional[Dict[str, Any]] = None, back_to_review: bool = False,
) -> bool:
    """Write form answers and timestamps for an application. Returns whether it matched.

    ``held`` is the application as the caller read it: the write lands only while its status and
    its verdict's time are still those (null and absent alike), so answers are never stored under a
    verdict given after the caller decided what to write (a re-import, T270).

    ``back_to_review`` returns it to open in the same update, clearing what
    ``update_application_status`` clears for a status without a giver: the verdict's giver, time
    and reason, the follow-up's owner, the claim and ``undo_to``. One update, so no stop between
    the answers and the status can leave a vendor approved on answers nobody saw.
    """
    ApplicationsApi.ensure_application_indexes()
    query: Dict[str, Any] = {"id": app_id}
    if held is not None:
        query["status"] = held.get("status")
        query["verdict_at"] = held.get("verdict_at") or {"$in": [None]}
    update: Dict[str, Any] = {"$set": {
        "form_data": form_data,
        "submitted_at": submitted_at,
        "updated_at": updated_at,
    }}
    if back_to_review:
        update["$set"]["status"] = ApplicationStatus.OPEN.value
        update["$unset"] = {"verdict_by": "", "verdict_at": "", "verdict_reason": "",
                            "follow_up_owner": "", "undo_to": "", **ApplicationsApi.CLAIM_UNSET}
    result = ApplicationsApi.applications_collection.update_one(query, update)
    return result.matched_count > 0


def write_answer_updates(
    app_id: str, updates: Dict[str, AnswerUpdate], cleared: Iterable[str],
) -> bool:
    """Store these updates of an application's answers, and take the ``cleared`` ones away, each by
    its own question's path, so two organizers updating different answers at once both land.

    Either moves ``updated_at``, the answers' version, in the same update: what every reader reads
    as the answers changed, so a verdict on a card opened before is refused (T270). With nothing to
    store or take away it writes nothing."""
    ApplicationsApi.ensure_application_indexes()
    field = ApplicationsApi.ANSWER_UPDATES_FIELD
    stored = {f"{field}.{key}": value.model_dump() for key, value in updates.items()}
    gone = {f"{field}.{key}": "" for key in cleared}
    if not stored and not gone:
        return True
    version = datetime.now(timezone.utc).isoformat()
    update: Dict[str, Any] = {"$set": {**stored, "updated_at": version}}
    if gone:
        update["$unset"] = gone
    return ApplicationsApi.applications_collection.update_one(
        {"id": app_id}, update).matched_count > 0


# --- A verdict, a follow-up, an undo --------------------------------------------------------------

def update_application_status(
    app_id: str, status: ApplicationStatus, by: Optional[VerdictGiver] = None,
    reason: Optional[str] = None, if_unchanged_since: Optional[Dict[str, Any]] = None,
    owner: Optional[MarketPerson] = None, unless_decided: bool = False,
    kept_for_undo: Optional[Dict[str, Any]] = None,
) -> bool:
    """Set a new status on an application. Returns whether it was written.

    A verdict is written with its giver and time in the same update (E34/F01/S01), and a rule's
    with its reason (E33/F03/S02); one without a giver is refused, so no application claims a
    verdict nobody gave. Any other status clears all three, and a person's verdict over a rule's
    leaves no rule's reason behind.

    ``if_unchanged_since`` is the application as the caller read it: the write lands only if its
    status, its verdict's time and its answers' time (``updated_at``) are still those, so neither a
    verdict given in between nor answers changed in between - an applicant's edit, a re-import, an
    organizer's update (T270) - is written over (E33/F03/S02, E34/F03/S01).

    A follow-up is marked like a verdict, by someone, and has an ``owner``: the marker unless named
    (E34/F01/S02). Any other status clears the owner.

    ``unless_decided`` writes only on an application that carries no verdict, for a reviewer who
    gives verdicts but may not change one (E38/F06/S01): asked in the write itself, so a verdict
    landing between the caller's read and this is never written over.

    ``kept_for_undo`` is what ``undo_to_of`` made of the application as a person giving a verdict
    read it (E38/F10/S01): kept on it as ``undo_to``, and the write lands only while the status, the
    verdict's time and the follow-up's owner are still those, so what is kept is what was there.
    Any other status written here clears it, so only the verdict that kept it can be undone.
    """
    if status in MARKED_STATUSES and by is None:
        raise ValueError("A verdict is written with the person or rule that gave it.")
    ApplicationsApi.ensure_application_indexes()
    update: Dict[str, Any] = {"$set": {"status": status.value}}
    if by is None:
        update["$unset"] = {"verdict_by": "", "verdict_at": "", "verdict_reason": ""}
    else:
        update["$set"]["verdict_by"] = by.model_dump()
        update["$set"]["verdict_at"] = datetime.now(timezone.utc).isoformat()
        if reason:
            update["$set"]["verdict_reason"] = reason
        else:
            update["$unset"] = {"verdict_reason": ""}
    if status is ApplicationStatus.NEEDS_FOLLOW_UP:
        named = owner or MarketPerson(user_id=by.user_id, email=by.email or "")  # the marker
        update["$set"]["follow_up_owner"] = named.model_dump()
    else:
        update.setdefault("$unset", {})["follow_up_owner"] = ""
    # A new status releases whoever held it (E34/F03/S02): the card it was open on is done with.
    update.setdefault("$unset", {}).update(ApplicationsApi.CLAIM_UNSET)
    query: Dict[str, Any] = {"id": app_id}
    if if_unchanged_since is not None:
        query["status"] = if_unchanged_since.get("status")
        # Null or absent alike: an application is stored with ``verdict_at: null`` until a verdict.
        query["verdict_at"] = if_unchanged_since.get("verdict_at") or {"$in": [None]}
        if if_unchanged_since.get("updated_at"):
            query["updated_at"] = if_unchanged_since["updated_at"]
    if kept_for_undo is not None and by is not None and by.kind == "person":
        pins = {"status": kept_for_undo.get("status"),
                "verdict_at": kept_for_undo.get("verdict_at") or {"$in": [None]},
                "follow_up_owner": kept_for_undo.get("follow_up_owner")}
        if any(key in query and query[key] != value for key, value in pins.items()):
            return False  # what the caller saw is not what it read: it cannot be both
        query.update(pins)
        update["$set"]["undo_to"] = kept_for_undo
    else:
        update["$unset"]["undo_to"] = ""
    if unless_decided:
        query["$nor"] = [{"status": {"$in": list(VERDICT_STATUSES)}}]
    result = ApplicationsApi.applications_collection.update_one(query, update)
    return result.matched_count > 0


def restore_before_verdict(app_id: str, undo_to: Dict[str, Any],
                           if_unchanged_since: Dict[str, Any]) -> bool:
    """Return an application to what a verdict found it as (``undo_to``, E38/F10/S01): its status,
    giver, time and follow-up owner as they were, so a follow-up comes back marked by whoever
    marked it. Written only while the status and the verdict's time are those the undoer saw, which
    are the verdict's that kept ``undo_to``. Returns whether it was written.
    """
    ApplicationsApi.ensure_application_indexes()
    kept = {key: undo_to.get(key) for key in UNDO_KEEPS}
    update: Dict[str, Any] = {
        "$set": {key: value for key, value in kept.items() if value is not None},
        "$unset": {**{key: "" for key, value in kept.items() if value is None},
                   "undo_to": "", "verdict_reason": "", **ApplicationsApi.CLAIM_UNSET},
    }
    result = ApplicationsApi.applications_collection.update_one({
        "id": app_id, "status": if_unchanged_since.get("status"),
        "verdict_at": if_unchanged_since.get("verdict_at") or {"$in": [None]},
    }, update)
    return result.matched_count > 0


def reassign_follow_up_owner(app_id: str, owner: MarketPerson) -> bool:
    """Hand a follow-up to someone else (E34/F02/S01). Written only while it still needs one."""
    ApplicationsApi.ensure_application_indexes()
    result = ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": ApplicationStatus.NEEDS_FOLLOW_UP.value},
        {"$set": {"follow_up_owner": owner.model_dump()}},
    )
    return result.matched_count > 0


# --- Whose share it is (E38/F07/S02, ADR 0020): written only for ``review_team.py`` ---------------

def deal(app_id: str, reviewer: Optional[MarketPerson], was: Optional[Dict[str, Any]]) -> bool:
    """Deal an application to ``reviewer``, or back to first come, first served with None.

    Written only while it is still open and still dealt to whom the caller read (``was``), so a
    verdict landing mid-deal is never touched and no other deal is written over. Only
    ``review_team.py`` calls it.
    """
    ApplicationsApi.ensure_application_indexes()
    arriving = ApplicationsApi.ARRIVING_FIELD
    # Dealt, it is no longer an arrival waiting for a deal (``mark_arriving``).
    update: Dict[str, Any] = (
        {"$set": {"reviewer": reviewer.model_dump()}, "$unset": {arriving: ""}} if reviewer
        else {"$unset": {"reviewer": ""}}
    )
    result = ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": {"$in": list(UNDECIDED_STATUSES)},
         # Null or absent alike, as a verdict's condition reads them.
         "reviewer": was if was else {"$in": [None]}},
        update,
    )
    return result.matched_count > 0


def mark_arriving(app_id: str, actor: Optional[str], action: str) -> bool:
    """Mark an open, undealt application as waiting to be dealt as it arrived, by ``action`` of
    ``actor``; one already waiting keeps the write it first arrived by. Only ``review_team.py``
    calls it, and whichever deal next holds the market deals it."""
    ApplicationsApi.ensure_application_indexes()
    arriving = ApplicationsApi.ARRIVING_FIELD
    result = ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": {"$in": list(UNDECIDED_STATUSES)},
         "reviewer": {"$in": [None]}, arriving: {"$exists": False}},
        {"$set": {arriving: {"actor": actor, "action": action}}},
    )
    return result.matched_count > 0


def mark_all_arriving(market_id: str, actor: Optional[str], action: str) -> int:
    """Mark every open, undealt application of a market as waiting to be dealt as it arrived, by
    ``action`` of ``actor``; one already waiting keeps the write it first arrived by. Only
    ``review_team.py`` calls it, and whichever deal next holds the market deals them. The ids are
    read as a projection of ``id`` alone, never every application's answers."""
    ApplicationsApi.ensure_application_indexes()
    ids = ApplicationsApi.applications_collection.find(
        {ApplicationsApi.MARKET_ID_FIELD: market_id, "status": {"$in": list(UNDECIDED_STATUSES)},
         "reviewer": {"$in": [None]}, ApplicationsApi.ARRIVING_FIELD: {"$exists": False}},
        {"_id": 0, "id": 1},
    )
    marked = 0
    for doc in ids:
        if mark_arriving(doc["id"], actor, action):
            marked += 1
    return marked


def deal_arrival(app_id: str, reviewer: Optional[MarketPerson]) -> bool:
    """Deal an application waiting as it arrived to ``reviewer``, or with None let it go undealt:
    either way it waits no longer. The reviewer is written only while it is still open and undealt,
    so one decided meanwhile is let go with its verdict alone."""
    ApplicationsApi.ensure_application_indexes()
    arriving = ApplicationsApi.ARRIVING_FIELD
    if reviewer is not None:
        result = ApplicationsApi.applications_collection.update_one(
            {"id": app_id, "status": {"$in": list(UNDECIDED_STATUSES)},
             "reviewer": {"$in": [None]}, arriving: {"$exists": True}},
            {"$set": {"reviewer": reviewer.model_dump()}, "$unset": {arriving: ""}},
        )
        if result.matched_count > 0:
            return True
    ApplicationsApi.applications_collection.update_one({"id": app_id}, {"$unset": {arriving: ""}})
    return False


def deal_follow_up(app_id: str, reviewer: MarketPerson, owner_was: Dict[str, Any]) -> bool:
    """Hand a removed reviewer's follow-up to the reviewer it is dealt to: its owner and its
    reviewer both become them, and it keeps its status. Written only while it still needs a
    follow-up from ``owner_was``, so one taken on or decided meanwhile is left as it is. Only
    ``review_team.py`` calls it."""
    ApplicationsApi.ensure_application_indexes()
    result = ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": ApplicationStatus.NEEDS_FOLLOW_UP.value,
         "follow_up_owner": owner_was},
        {"$set": {"follow_up_owner": reviewer.model_dump(), "reviewer": reviewer.model_dump()}},
    )
    return result.matched_count > 0


# --- The offers' deadline -------------------------------------------------------------------------

def sweep_unanswered_offers(market_id: str) -> int:
    """Mark every ``assignment_sent`` application for a market as ``vendor_refused``.

    This is the deadline mechanism: the admin holds the deadline, and this operation
    is what records it. Returns the number of applications swept.
    """
    ApplicationsApi.ensure_application_indexes()
    result = ApplicationsApi.applications_collection.update_many(
        {**ApplicationsApi.market_filter(market_id),
         "status": ApplicationStatus.ASSIGNMENT_SENT.value},
        {"$set": {"status": ApplicationStatus.VENDOR_REFUSED.value}},
    )
    return result.modified_count
