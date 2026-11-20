"""Single owner of the ``applications`` collection.

Every reader and writer of an application document goes through this module so the
storage contract lives in exactly one place, but for the review state: every write of an
application's status, verdict, follow-up, undo, addition or share is ``application_status.py``'s
(``ReviewState``, ADR 0037), through the collection bound here. This module keeps the reads, the
claim's writes, the deletes and the indexes.

Storage contract: application documents are persisted **snake_case**, matching the
``Application`` model in ``datatypes.py``. In particular the market foreign key is
``market_id``, not ``marketId`` - markets are camelCased on write, applications are not.
The D9 form lock counts applications by that key, so a writer that stored the market
reference under any other name would silently disable the lock.

Identity contract: (``market_id``, ``applicant_email``, ``application_type``) identifies an
application, and the database is what enforces that -- see ``ensure_application_indexes``.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from pymongo.errors import PyMongoError

import application_status as ReviewState
from datatypes import (
    AnswerUpdate, Application, ApplicationStatus, ApplicationType, FormField, MarketPerson,
)
from db_config import get_database
import essential_fields as EssentialFields
from utils.email_address import normalized_email

logger = logging.getLogger(__name__)

APPLICATIONS_COLLECTION = "applications"
MARKET_ID_FIELD = "market_id"
APPLICANT_EMAIL_FIELD = "applicant_email"
APPLICATION_TYPE_FIELD = "application_type"
STATUS_FIELD = "status"
ANSWER_UPDATES_FIELD = "answer_updates"
APPLICANT_IDENTITY_INDEX = "market_applicant_type_unique"

db = get_database()
applications_collection = db[APPLICATIONS_COLLECTION]

_indexes_ready = False


class ApplicationIndexError(RuntimeError):
    """The index that makes an applicant one applicant is not in place."""


def ensure_application_indexes() -> None:
    """The identity of an application, enforced where it can actually hold.

    An applicant is one applicant: one main application per (market, address), and one waitlist
    application beside it. Nothing in application code can promise that, because the write that
    creates the document is a read-then-insert on a public endpoint -- two concurrent requests for
    the same new address both find nothing and both insert, and the market is then left with two
    main applications for one person. Only one of them is reachable (every read of an applicant's
    application finds one document and takes it), so the other is an orphan that sits on the
    organizer's applicant list, double-counts the applicant through review and assignment, and
    double-counts the D9 form lock. It is reachable on purpose by racing the endpoint, and by
    accident through a double-click or a retried request.

    So uniqueness is the database's, and creation is written against it -- see
    ``application_status``'s ``arrive`` and ``add``.

    A build that fails raises, and the caller fails with it. This index is not a decoration on a
    guarantee the code keeps anyway: it *is* the guarantee, the whole of it, and a process that
    cannot build it is a process where ``arrive`` or ``add`` is a read-then-insert with
    nothing behind it. Logging that and serving anyway is the one thing this product does not do
    with a defense it cannot confirm - the market-key migration and the public-endpoint
    configuration both fail closed, and for the same reason: an unknown state is not a safe one.
    The likeliest cause is duplicates already in the collection, which is precisely the corruption
    the index exists to prevent, and which serving on would only deepen. ``app.py`` asserts this at
    boot, so a deployment that cannot hold it says so before it takes a request rather than in the
    middle of one.

    Built lazily rather than at import: an index build is a network call, and this module is
    imported by tooling and tests that never reach the database.
    """
    global _indexes_ready
    if _indexes_ready:
        return
    try:
        applications_collection.create_index(
            [(MARKET_ID_FIELD, 1), (APPLICANT_EMAIL_FIELD, 1), (APPLICATION_TYPE_FIELD, 1)],
            unique=True,
            name=APPLICANT_IDENTITY_INDEX,
        )
    except PyMongoError as exc:
        # The driver's message is not repeated, nor kept as the cause: a duplicate key error
        # quotes the applicant's address.
        message = (
            f"The unique index {APPLICANT_IDENTITY_INDEX} on "
            f"({MARKET_ID_FIELD}, {APPLICANT_EMAIL_FIELD}, {APPLICATION_TYPE_FIELD}) could not be "
            f"built ({type(exc).__name__}, code {getattr(exc, 'code', None)}), so nothing is "
            f"stopping one applicant from holding two applications at one market. If the "
            f"collection already holds duplicates, that is what is blocking the build, and they "
            f"have to be merged or removed before applications can be served. Applications "
            f"sharing an identity: {_duplicate_applications()}."
        )
        logger.critical("%s", message)
        raise ApplicationIndexError(message) from None
    _indexes_ready = True


def _duplicate_applications() -> str:
    """The applications sharing an identity, named by id, never by address, for the refusal."""
    try:
        stored = applications_collection.find(
            {}, {"id": 1, MARKET_ID_FIELD: 1, APPLICANT_EMAIL_FIELD: 1, APPLICATION_TYPE_FIELD: 1})
        by_identity: Dict[tuple, List[str]] = {}
        for doc in stored:
            identity = (doc.get(MARKET_ID_FIELD), doc.get(APPLICANT_EMAIL_FIELD),
                        doc.get(APPLICATION_TYPE_FIELD))
            by_identity.setdefault(identity, []).append(str(doc.get("id")))
    except PyMongoError as exc:
        return f"not read ({type(exc).__name__})"
    shared = [ids for ids in by_identity.values() if len(ids) > 1]
    return "; ".join(", ".join(ids) for ids in shared) or "none found"


def market_filter(market_id: str) -> Dict[str, Any]:
    """The canonical query for every application belonging to one market."""
    return {MARKET_ID_FIELD: market_id}


def applicant_filter(market_id: str, email: str, application_type: str) -> Dict[str, Any]:
    """The canonical query for the one application an applicant has of this type at this market."""
    return {
        MARKET_ID_FIELD: market_id,
        APPLICANT_EMAIL_FIELD: email,
        APPLICATION_TYPE_FIELD: application_type,
    }


def count_applications_for_market(market_id: str) -> int:
    """How many applications exist for a market. Drives the D9 application-form lock."""
    return applications_collection.count_documents(market_filter(market_id))


def _newest_first(query: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every application matching a query, newest first, with the driver's key stripped.

    The ``_id`` Mongo adds is not part of the storage contract this module owns, and a caller
    that saw it would be able to depend on it.
    """
    ensure_application_indexes()
    documents = []
    for doc in applications_collection.find(query).sort("submitted_at", -1):
        doc.pop("_id", None)
        documents.append(doc)
    return documents


def list_applications_for_market(market_id: str) -> List[Dict[str, Any]]:
    """Return every application belonging to one market, newest first."""
    return _newest_first(market_filter(market_id))


def vendor_names_for_market(market_id: str) -> Dict[str, str]:
    """Every applicant's name in one market, keyed by the address that identifies them.

    ``{email: name}``, and only for applications that stored one - an application written before
    ``essential_full_name`` existed simply has no entry, which is what lets every surface fall
    back to the email and render exactly as the product did before.

    The name is the one the vendor CHOSE where they gave one; see ``display_name``.

    Lowercased keys, because that is the form every other reader matches on: ``record_attendance``
    normalizes, the importer lowercases on the way in, and a map whose keys did not would miss
    the one vendor whose form capitalized their address.

    A projection, not the whole application: the surfaces that need this - the tables grid, the
    payoff screen - want a name against an address and nothing else, and 232 applications' worth
    of ``form_data`` is not a thing to ship in order to read one key from each.
    """
    # The name they CHOSE, falling back to the one on their identification - stated once, in the
    # module that owns both keys (E19/F02/S01).
    return _names_by_address(market_id, EssentialFields.display_name)


def vendor_full_names_for_market(market_id: str) -> Dict[str, str]:
    """Every applicant's full name, the one on their identification, keyed as
    ``vendor_names_for_market`` is: the download carries it beside the name they chose
    (E35/F03/S02)."""
    return _names_by_address(
        market_id,
        lambda form_data: str(form_data.get(EssentialFields.FULL_NAME_KEY) or "").strip(),
    )


def vendor_business_names_for_market(market_id: str) -> Dict[str, str]:
    """Every applicant's business name, keyed as ``vendor_names_for_market`` is, and only for those
    who have one (``business_name``): the door shows it under the vendor's name and finds them by it
    (T502). Read as the organizer reads answers, so an organizer's correction stands over the
    vendor's answer, and one an organizer removed has no entry."""
    return _names_by_address(
        market_id, EssentialFields.business_name, [EssentialFields.BUSINESS_NAME_KEY])


#: The questions whose answers identify a vendor rather than describe them: a business name, a
#: business email, a handle. A choice, a number or a date is shared by many and finds nobody.
SEARCHED_ANSWER_TYPES = ("text", "email")

#: The longest answer that still names someone rather than describes their work. A business name,
#: an address or a handle is short; "what do you sell" is a paragraph, and matching it would find
#: every vendor who mentions a word rather than the one the organizer is looking for.
SEARCHED_ANSWER_LENGTH = 80


def vendor_search_terms_for_market(
    market_id: str, fields: List[FormField], placed: Iterable[str],
) -> Dict[str, List[str]]:
    """What a search on the results finds a vendor by (E35/F02/S01), keyed as
    ``vendor_names_for_market`` is: the name they chose, the one on their identification, their
    business name, then their short answers to the form's text and email questions, in the form's
    order.

    Only the vendors in ``placed`` are read: the ones at a table, whom the search finds tables by,
    and the ones the placement dialog's pickers offer (E38/F08/S03). Blank and long answers are left
    out, and so is a vendor with nothing to search; the page matches the address itself. ``fields``
    is the market's own form: which questions are text is its to say.
    """
    asked = [field.key for field in fields if field.type in SEARCHED_ANSWER_TYPES]
    keys = [EssentialFields.PREFERRED_NAME_KEY, EssentialFields.FULL_NAME_KEY,
            EssentialFields.BUSINESS_NAME_KEY, *asked]
    at_a_table = {str(email).strip().lower() for email in placed}
    terms: Dict[str, List[str]] = {}
    for email, answers in _answers_by_address(market_id, keys).items():
        if email not in at_a_table:
            continue
        found = [str(answers[key]).strip() for key in keys if isinstance(answers.get(key), str)]
        found = [term for term in found if term and len(term) <= SEARCHED_ANSWER_LENGTH]
        if found:
            terms[email] = found
    return terms


def vendor_answers_for_market(market_id: str, keys: List[str]) -> Dict[str, Dict[str, Any]]:
    """Every applicant's answers to ``keys``, as the organizer reads them (``effective_answers``),
    keyed as ``vendor_names_for_market`` is: what the price groups read (E43/F01/S02)."""
    return _answers_by_address(market_id, keys)


def list_applications_with_answers(
    market_id: str, keys: List[str],
) -> List[Dict[str, Any]]:
    """Every application of a market, read as only their id and their answers to ``keys``: a
    projection of those keys alone, so a reader that wants one answer from each does not ship every
    application's whole ``form_data``. ``effective_answers`` still reads the partial documents."""
    ensure_application_indexes()
    projection = {"_id": 0, "id": 1, **{
        f"{field}.{key}": 1 for key in keys for field in ("form_data", ANSWER_UPDATES_FIELD)}}
    return list(applications_collection.find(market_filter(market_id), projection))


#: The two answers a vendor's name is read from.
_NAME_KEYS = (EssentialFields.FULL_NAME_KEY, EssentialFields.PREFERRED_NAME_KEY)


def _names_by_address(
    market_id: str, name_of, keys: Iterable[str] = _NAME_KEYS,
) -> Dict[str, str]:
    """``{lowercased address: name}`` for the applications that stored one, read off a projection
    of ``keys`` alone: the two name keys, unless the name asked for is read from another."""
    keys = list(keys)
    names = {
        email: name_of(answers) for email, answers in _answers_by_address(market_id, keys).items()
    }
    return {email: name for email, name in names.items() if name}


def _answers_by_address(market_id: str, keys: List[str]) -> Dict[str, Dict[str, Any]]:
    """The named answers of every application in a market, keyed by lowercased address: a
    projection of those keys alone, since 232 applications' worth of ``form_data`` is not a thing to
    read in order to show a name.

    A vendor may hold a main and a waitlist application (the unique index is the market, the
    address and the type); the main one's answers are theirs, whichever the read returns last.
    """
    ensure_application_indexes()
    projection = {"_id": 0, APPLICANT_EMAIL_FIELD: 1, APPLICATION_TYPE_FIELD: 1, **{
        f"{field}.{key}": 1 for key in keys for field in ("form_data", ANSWER_UPDATES_FIELD)}}
    answers: Dict[str, Dict[str, Any]] = {}
    from_main: set = set()
    for doc in applications_collection.find(market_filter(market_id), projection):
        email = str(doc.get(APPLICANT_EMAIL_FIELD) or "").strip().lower()
        if not email or email in from_main:
            continue
        answers[email] = effective_answers(doc)
        if doc.get(APPLICATION_TYPE_FIELD, ApplicationType.MAIN.value) == ApplicationType.MAIN.value:
            from_main.add(email)
    return answers


def effective_answers(application: Any) -> Dict[str, Any]:
    """An application's answers as the organizer reads them (E41/F01/S01): what the vendor gave,
    each updated answer read in its place. The one reader of them, for a stored document or an
    ``Application`` alike, so the organizer's views, the search, the export, the Stats tab and the
    automatic rejections read an update by construction, as does any reader added later that calls it.

    ``form_data`` itself is never written over by an update; only the vendor (their own edit) and
    an import write it.
    """
    if isinstance(application, Application):
        answers, updates = application.form_data, application.answer_updates
    else:
        answers = application.get("form_data")
        updates = application.get(ANSWER_UPDATES_FIELD)
    effective = dict(answers or {})
    for key, update in (updates or {}).items():
        effective[key] = update.value if isinstance(update, AnswerUpdate) else update.get("value")
    return effective


def find_application_by_id(app_id: str) -> Optional[Dict[str, Any]]:
    """Find one application by its ``id`` field."""
    ensure_application_indexes()
    doc = applications_collection.find_one({"id": app_id})
    if doc:
        doc.pop("_id", None)
    return doc


def main_applications_from(market_id: str, addresses: Iterable[str]) -> List[Dict[str, Any]]:
    """The main applications these addresses hold at this market, whatever their status."""
    wanted = sorted(set(addresses))
    if not wanted:
        return []
    return _newest_first({
        **market_filter(market_id),
        APPLICANT_EMAIL_FIELD: {"$in": wanted},
        APPLICATION_TYPE_FIELD: ApplicationType.MAIN.value,
    })


def find_application_by_email(market_id: str, email: str) -> Optional[Dict[str, Any]]:
    """Find one application by its market + email identity."""
    ensure_application_indexes()
    doc = applications_collection.find_one(
        applicant_filter(market_id, email, ApplicationType.MAIN.value)
    )
    if doc:
        doc.pop("_id", None)
    return doc


# --- Whose share it is (E38/F07/S02, ADR 0020) -----------------------------------------------------

def undecided_in_arrival_order(
    market_id: str, follow_ups_of: Iterable[str] = (),
) -> List[Dict[str, Any]]:
    """A market's open applications, the ones a deal hands out, earliest arrival first; and with
    them the follow-ups owned by any of the addresses ``follow_ups_of`` (a removed reviewer's)."""
    owners = {str(address).strip().lower() for address in follow_ups_of}

    def dealable(doc: Dict[str, Any]) -> bool:
        if doc.get(STATUS_FIELD) in ReviewState.UNDECIDED_STATUSES:
            return True
        owner = str((doc.get("follow_up_owner") or {}).get("email") or "").strip().lower()
        return doc.get(STATUS_FIELD) == ApplicationStatus.NEEDS_FOLLOW_UP.value and owner in owners

    return _in_arrival_order([doc for doc in list_applications_for_market(market_id)
                              if dealable(doc)])


#: An application waiting for the deal (E38/F07/S03): ``{actor, action}``, the write that moved it
#: into open or follow-up, for the deal's history entry (``ReviewState.Arrival``). Set by that
#: move's own write, cleared as the deal deals it or leaves it where it is.
ARRIVING_FIELD = "arriving"


#: What a deal reads of an application waiting for it: enough to order it, read its state, deal it
#: and record it.
_ARRIVING_PROJECTION = {"_id": 0, "id": 1, "applicant_email": 1, "submitted_at": 1,
                        ARRIVING_FIELD: 1, STATUS_FIELD: 1, "verdict_by": 1, "added_by": 1,
                        "origin": 1, "reviewer": 1, "follow_up_owner": 1}


def _waiting_filter(market_id: str) -> Dict[str, Any]:
    """The applications of a market waiting to be dealt: ``arriving`` is an object, which the
    ``market_id, arriving`` index serves with tight bounds, as it cannot an ``$exists`` (a regular
    index stores a missing field as null)."""
    return {MARKET_ID_FIELD: market_id, ARRIVING_FIELD: {"$type": "object"}}


def arriving_in_arrival_order(market_id: str) -> List[Dict[str, Any]]:
    """The market's applications waiting for the deal, earliest arrival first:
    those alone, and only what a deal reads of them, since it reads them while holding the market
    (the ``market_id, arriving`` lookup index)."""
    ensure_application_indexes()
    return _in_arrival_order(list(applications_collection.find(
        _waiting_filter(market_id), _ARRIVING_PROJECTION)))


def any_arriving(market_id: str) -> bool:
    """Whether any application of the market waits for the deal."""
    return applications_collection.find_one(
        _waiting_filter(market_id)) is not None


# --- Who is looking at it (E34/F03/S02) ------------------------------------------------------------

#: How long a claim holds without being renewed.
CLAIM_LEASE = timedelta(minutes=5)
#: What a write that releases a claim unsets: who held it and until when.
CLAIM_UNSET = {"held_by": "", "held_until": ""}


def _now(now: Optional[datetime]) -> datetime:
    return now or datetime.now(timezone.utc)


def _submitted(doc: Dict[str, Any]) -> Optional[datetime]:
    raw = doc.get("submitted_at")
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def _in_arrival_order(docs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Earliest submission first, those with none last, as the review shows them (``inArrivalOrder``
    in ``front-end/src/utils/reviewQueue.ts``)."""
    keyed = [(_submitted(doc), index, doc) for index, doc in enumerate(docs)]
    keyed.sort(key=lambda k: (k[0] is None, k[0] or datetime.min.replace(tzinfo=timezone.utc), k[1]))
    return [doc for _, _, doc in keyed]


def holds(
    held_by: Optional[Dict[str, Any]], held_until: Optional[str], now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Who holds an application right now, or None once the claim has lapsed."""
    if not held_by or not held_until:
        return None
    try:
        until = datetime.fromisoformat(held_until)
    except ValueError:
        return None
    return held_by if until > _now(now) else None


def holder_of(doc: Dict[str, Any], now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """``holds`` for a stored application."""
    return holds(doc.get("held_by"), doc.get("held_until"), now)


def claim_next_for_review(
    market_id: str, person: MarketPerson, after: Optional[str], include_follow_ups: bool,
    now: Optional[datetime] = None, want: Optional[str] = None, chosen: bool = False,
    mine_only: bool = False,
) -> Optional[Dict[str, Any]]:
    """Hand ``person`` the next card to review, claimed for them, or None when there is none to
    hand: every one left is held by someone else, or, for a ``chosen`` reviewer with ``mine_only``,
    every one left in their share is, or their share is empty (E34/F03/S02).

    The next undecided application in arrival order after ``after`` - the one they move on from,
    which comes round last, and keeps its place once a verdict takes it out of the queue - that
    nobody else holds. For a ``chosen`` reviewer, their share (ADR 0020: those dealt to them, and
    the follow-ups they own) comes first, each part in that order, and with ``mine_only`` nothing
    else (E38/F07/S04); for anyone else ``mine_only`` means nothing. ``want`` is one they asked for
    by name (a link to it), tried first. Taking it is conditioned on the claim and the status it
    read, so two reviewers asking at once are handed different cards, and a card decided between
    this read and its claim is passed over, never handed as if it were open (T277 P4). Their other
    claims are let go.
    """
    now = _now(now)
    statuses = ReviewState.UNDECIDED_STATUSES + (
        (ApplicationStatus.NEEDS_FOLLOW_UP.value,) if include_follow_ups else ())
    docs = list_applications_for_market(market_id)
    arrived = _in_arrival_order(docs)
    every = [doc["id"] for doc in arrived]
    start = every.index(after) + 1 if after in every else 0
    queue = [doc for doc in arrived[start:] + arrived[:start] if doc.get("status") in statuses]
    order = queue
    if chosen:
        share = [doc for doc in queue if _in_share_of(doc, person)]
        order = share if mine_only else share + [
            doc for doc in queue if not _in_share_of(doc, person)]
    wanted = [doc for doc in queue if doc["id"] == want]
    if wanted:
        order = wanted + [doc for doc in order if doc["id"] != want]
    mine = person.model_dump()
    for doc in order:
        holder = holder_of(doc, now)
        if holder is not None and holder != mine:
            continue
        taken = applications_collection.update_one(
            {"id": doc["id"], "held_until": {"$in": [doc.get("held_until")]},
             STATUS_FIELD: doc.get(STATUS_FIELD)},
            {"$set": {"held_by": mine,
                      "held_until": (now + CLAIM_LEASE).isoformat()}},
        )
        if taken.matched_count == 0:
            continue
        for other in docs:
            if other["id"] != doc["id"] and other.get("held_by") == mine:
                release_claim(other["id"], person)
        return find_application_by_id(doc["id"])
    return None


def _in_share_of(doc: Dict[str, Any], person: MarketPerson) -> bool:
    """Whether an application is in this person's share (ADR 0020), by address: dealt to them, or
    a follow-up they own, wherever it was dealt, since a follow-up stays with whoever holds it."""
    address = normalized_email(person.email)
    if normalized_email((doc.get("reviewer") or {}).get("email") or "") == address:
        return True
    return (doc.get("status") == ApplicationStatus.NEEDS_FOLLOW_UP.value
            and normalized_email((doc.get("follow_up_owner") or {}).get("email") or "") == address)


def renew_claim(app_id: str, person: MarketPerson, now: Optional[datetime] = None) -> bool:
    """Keep holding the open card for another lease. False once someone else has taken it."""
    result = applications_collection.update_one(
        {"id": app_id, "held_by": person.model_dump()},
        {"$set": {"held_until": (_now(now) + CLAIM_LEASE).isoformat()}},
    )
    return result.matched_count > 0


def release_claim(app_id: str, person: MarketPerson) -> bool:
    """Let go of a card on moving on or leaving. Only one's own claim is released."""
    result = applications_collection.update_one(
        {"id": app_id, "held_by": person.model_dump()}, {"$unset": CLAIM_UNSET},
    )
    return result.matched_count > 0


def judgeable_applications(
    market_id: str, application_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """The applications a market's automatic rejections may judge (E33/F03/S02): the undecided,
    and those a rule rejected. Never one a person decided. ``application_id`` narrows it to one."""
    if application_id is not None:
        doc = find_application_by_id(application_id)
        docs = [doc] if doc and doc.get("market_id") == market_id else []
    else:
        docs = list_applications_for_market(market_id)
    return [doc for doc in docs if ReviewState.is_judgeable(doc)]


def delete_applications_for_market(market_id: str) -> int:
    """Take a market's applications with the market (``market_deletion``). Returns how many went."""
    return applications_collection.delete_many(market_filter(market_id)).deleted_count


def delete_application(app_id: str) -> bool:
    """Remove one application. Only for undoing a create whose answers were then refused, so a
    write that failed leaves nothing behind: nothing an applicant or organizer did is ever deleted
    through here."""
    ensure_application_indexes()
    return applications_collection.delete_one({"id": app_id}).deleted_count > 0


def list_applications_with_status(
    market_id: str, status: str, application_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Every application for a market holding one status, newest first.

    The counting functions below answer "how many", which is all the phase guards ever needed.
    The solver needs the applications themselves: assignment reads the approved ones and nothing
    else. ``application_type`` narrows further, because an applicant's waitlist application is a
    second document for the same address and a caller that wants one vendor per person must say
    so.
    """
    query: Dict[str, Any] = {**market_filter(market_id), STATUS_FIELD: status}
    if application_type is not None:
        query[APPLICATION_TYPE_FIELD] = application_type
    return _newest_first(query)


def count_applications_with_status(market_id: str, status: str) -> int:
    """How many applications for a market hold a specific status."""
    ensure_application_indexes()
    return applications_collection.count_documents({
        **market_filter(market_id),
        STATUS_FIELD: status,
    })


def count_applications_with_any_status(market_id: str, statuses: List[str]) -> int:
    """How many applications for a market hold any of the given statuses."""
    ensure_application_indexes()
    return applications_collection.count_documents({
        **market_filter(market_id),
        STATUS_FIELD: {"$in": list(statuses)},
    })
