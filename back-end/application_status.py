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
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

import api.applications as ApplicationsApi
from datatypes import (
    AnswerUpdate, Application, ApplicationStatus, IntakeMode, MarketPerson, VerdictGiver,
)

#: The fields only this module writes: an application's review state. Each move between states
#: writes several of them in one update, which is why they are owned together. ``origin`` is how an
#: application came to the market, owned before anything stores it, so its first writer is here.
OWNED_FIELDS = (
    "status", "verdict_by", "verdict_at", "verdict_reason", "follow_up_owner", "undo_to",
    "added_by", "added_at", "origin", "arriving", "reviewer",
)

#: Statuses nobody has decided yet, as the owner's own filters read them: an open application is
#: stored ``open``, or ``under_review`` from before. Every reader asks ``state_of`` instead.
UNDECIDED_STATUSES = (ApplicationStatus.OPEN.value, ApplicationStatus.UNDER_REVIEW.value)
#: The statuses a reviewer gives, each with who gave it: a verdict, or a follow-up (E34).
MARKED_STATUSES = (ApplicationStatus.REVIEWER_APPROVED, ApplicationStatus.REVIEWER_REJECTED,
                   ApplicationStatus.NEEDS_FOLLOW_UP)
#: The verdicts: an application at one is decided, and a reviewer's write over it changes a verdict
#: (E38/F06/S01). A follow-up is marked, not decided: deciding one is giving a verdict.
VERDICT_STATUSES = (ApplicationStatus.REVIEWER_APPROVED.value,
                    ApplicationStatus.REVIEWER_REJECTED.value)


# --- The states -----------------------------------------------------------------------------------

class State(str, Enum):
    """Where an application stands in its review: the six states of the transition table, which
    ``docs/implementation/data/application-document.md#the-review-state`` states once.

    Read off the stored fields by ``state_of``; never stored themselves, so no stored status
    changes its spelling. An approval and a rejection each say whose they are, since that decides
    what may happen to them next: a vendor added by hand is approved by being added, and a rule's
    rejection is judged again by the rules.
    """

    OPEN = "open"
    FOLLOW_UP = "follow_up"
    APPROVED_BY_A_PERSON = "approved(person)"
    APPROVED_ADDED = "approved(added)"
    REJECTED_BY_A_PERSON = "rejected(person)"
    REJECTED_BY_A_RULE = "rejected(rule)"

    @property
    def undecided(self) -> bool:
        """Whether no verdict is given yet: open, or waiting on a follow-up."""
        return self in (State.OPEN, State.FOLLOW_UP)


#: How an application came to the market, read by ``origin_of``: applied on its page, imported
#: from a file, or added by hand. Its own axis, apart from the verdict.
APPLIED, IMPORTED, ADDED = "applied", "imported", "added"
_ORIGINS = (APPLIED, IMPORTED, ADDED)

#: The statuses the old offers flow carried an approval on to (``NoApprovedApplicationsGuard``:
#: "the solver must have resolved every approved application to either assigned or unassigned").
#: Never written today; each still reads as the approval it came from.
_CARRIED_APPROVALS = (
    ApplicationStatus.UNASSIGNED.value, ApplicationStatus.ASSIGNED.value,
    ApplicationStatus.ASSIGNMENT_SENT.value, ApplicationStatus.VENDOR_ACCEPTED.value,
    ApplicationStatus.VENDOR_REFUSED.value,
)


def origin_of(doc: Dict[str, Any], intake: Optional[IntakeMode] = None) -> str:
    """How this application came to the market: its stored ``origin``; else ``added`` when someone
    added it by hand (``added_by``); else ``imported`` on a market whose vendors are imported, and
    ``applied`` on one whose vendors apply, or with no ``intake`` given, since then only "added or
    not" is asked."""
    stored = doc.get("origin")
    if stored in _ORIGINS:
        return stored
    if doc.get("added_by"):
        return ADDED
    return IMPORTED if intake is IntakeMode.CSV else APPLIED


def state_of(doc: Dict[str, Any]) -> State:
    """The state of an application, as stored or as a reviewer saw it, by one rule.

    ``open``, ``under_review`` or no status at all is open; a follow-up is a follow-up; an approval
    is approved by being added when the application was added by hand and never applied or was
    imported since, else by a person; a rejection is a rule's when a rule gave it, else a person's.
    The statuses nothing writes any more read as what the old flow reached them from: the offers'
    statuses as the approval they carried, ``cancelled`` as a person's rejection, since the
    table-share notice counts it with the rejected as not taking part. A status no member names is
    refused, as reading the application would refuse it.
    """
    status = doc.get("status")
    if status in (None, "") or status in UNDECIDED_STATUSES:
        return State.OPEN
    if status == ApplicationStatus.NEEDS_FOLLOW_UP.value:
        return State.FOLLOW_UP
    if status == ApplicationStatus.REVIEWER_APPROVED.value or status in _CARRIED_APPROVALS:
        return State.APPROVED_ADDED if origin_of(doc) == ADDED else State.APPROVED_BY_A_PERSON
    if status == ApplicationStatus.REVIEWER_REJECTED.value:
        by_rule = (doc.get("verdict_by") or {}).get("kind") == "rule"
        return State.REJECTED_BY_A_RULE if by_rule else State.REJECTED_BY_A_PERSON
    if status == ApplicationStatus.CANCELLED.value:
        return State.REJECTED_BY_A_PERSON
    raise ValueError(f"No application status is spelled {status!r}.")


def is_undecided(doc: Dict[str, Any]) -> bool:
    """Whether an application, as stored or as a reviewer saw it, awaits a verdict: open, or a
    follow-up."""
    return state_of(doc).undecided


def is_decided(doc: Dict[str, Any]) -> bool:
    """Whether an application, as stored or as a reviewer saw it, carries a verdict: a reviewer's
    write over it changes a verdict (E38/F06/S01)."""
    return not is_undecided(doc)


def is_judgeable(application: Dict[str, Any]) -> bool:
    """Whether a market's automatic rejections may judge this stored application: an open one, or
    one a rule rejected; never one a person decided, nor a follow-up. The import's preview asks it
    of an application as the import would leave it (E38/F03/S02)."""
    return state_of(application) in (State.OPEN, State.REJECTED_BY_A_RULE)


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
    its ``UNDO_KEEPS`` while it awaits a verdict - open or needing a follow-up - else None."""
    if not is_undecided(doc):
        return None
    return {key: doc.get(key) for key in UNDO_KEEPS}


def undoable_by(doc: Dict[str, Any], user_id: Optional[str],
                now: Optional[datetime] = None) -> bool:
    """Whether this person may still undo what they marked on this application: a verdict or a
    follow-up that they gave, by user id, within ``UNDO_WINDOW`` of it, on an application that was
    awaiting one, which kept what the application was before it (``undo_to``, E38/F10/S01)."""
    if state_of(doc) not in (State.FOLLOW_UP, State.APPROVED_BY_A_PERSON,
                             State.REJECTED_BY_A_PERSON) or not user_id:
        return False
    undo_to = doc.get("undo_to")
    if not isinstance(undo_to, dict) or not is_undecided(undo_to):
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
    return (now or datetime.now(timezone.utc)) - at <= UNDO_WINDOW


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

    ``back_to_review`` returns it to open in the same update, clearing what every move to open
    clears (``RuleReturns``'s move): the verdict's giver, time and reason, the follow-up's owner,
    the claim and ``undo_to``. One update, so no stop between
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


# --- The transition table, and the events that move along it --------------------------------------
#
# Each event is a value naming what happened; ``move`` reads where it takes an application from
# the state as read, or that the table refuses it. The event functions below write the move, held
# on what was read, so a write landing in between is never written over: the caller reads again or
# refuses.
# ``move`` is pure, so a preview and the write it previews read one answer.

@dataclass(frozen=True)
class GiveVerdict:
    """A person gives a verdict, or marks a follow-up, on an application awaiting one."""

    status: ApplicationStatus
    by: VerdictGiver
    owner: Optional[MarketPerson] = None


@dataclass(frozen=True)
class ChangeVerdict:
    """A person writes a verdict, or a follow-up, over a verdict already given (E38/F06/S01)."""

    status: ApplicationStatus
    by: VerdictGiver
    owner: Optional[MarketPerson] = None


@dataclass(frozen=True)
class Undo:
    """The giver of a verdict takes it back within ``UNDO_WINDOW`` (E38/F10/S01)."""

    user_id: Optional[str]


@dataclass(frozen=True)
class RuleRejects:
    """An automatic rejection meets the answers (E33/F03/S02)."""

    rule: str
    reason: str


@dataclass(frozen=True)
class RuleReturns:
    """No automatic rejection meets the answers of an application a rule rejected any longer."""


@dataclass(frozen=True)
class HandOnFollowUp:
    """A follow-up is handed to someone else (E34/F02/S01)."""

    owner: MarketPerson


Event = Union[GiveVerdict, ChangeVerdict, Undo, RuleRejects, RuleReturns, HandOnFollowUp]

#: The transition table, as data: the states each event moves an application from. A state an
#: event does not list is refused. Where an event moves to, and the narrower refusals inside a
#: listed state, are ``move``'s.
TABLE: Dict[type, Tuple[State, ...]] = {
    GiveVerdict: (State.OPEN, State.FOLLOW_UP),
    # A rule's rejection is a verdict: overturning it is a change, the change row's (E38/F06/S01).
    ChangeVerdict: (State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED, State.REJECTED_BY_A_PERSON,
                    State.REJECTED_BY_A_RULE),
    # Only a verdict given on an application awaiting one kept what to return to.
    Undo: (State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.REJECTED_BY_A_PERSON),
    # Again, with another rule or reason, so the reason shown is the rule that meets it now.
    RuleRejects: (State.OPEN, State.REJECTED_BY_A_RULE),
    RuleReturns: (State.REJECTED_BY_A_RULE,),
    HandOnFollowUp: (State.FOLLOW_UP,),
}

#: Why an added vendor's approval may only change to a rejection: nobody applied, so there is no
#: application to follow up on or to approve again.
ADDED_ONLY_REJECTED = "A vendor added by hand can only be rejected."


@dataclass(frozen=True)
class Refused:
    """The table refuses an event from the state read. ``reason`` is the table's own words, where
    it has some; without, the caller refuses as its route always has. Falsy, as a write that did
    not land is."""

    reason: Optional[str] = None

    def __bool__(self) -> bool:
        return False


@dataclass(frozen=True)
class Move:
    """What an event writes: the owned fields it sets and takes away, in one update, and the fields
    held as read, so it lands only on the application the caller read."""

    to: State
    set: Dict[str, Any]
    unset: Tuple[str, ...]
    pins: Dict[str, Any]

    def update(self) -> Dict[str, Any]:
        update: Dict[str, Any] = {}
        if self.set:
            update["$set"] = dict(self.set)
        if self.unset:
            update["$unset"] = {key: "" for key in self.unset}
        return update

    def query(self, app_id: str) -> Dict[str, Any]:
        return {"id": app_id, **self.pins}


#: What a write is answered with: whether it landed, or the table's refusal, which is falsy too.
Written = Union[bool, Refused]

_CLAIM = ("held_by", "held_until")
_VERDICT = ("verdict_by", "verdict_at", "verdict_reason")


def _as_read(value: Any) -> Any:
    """A field held as read: null and absent alike, as an application is stored with
    ``verdict_at: null`` until its first verdict."""
    return value if value is not None else {"$in": [None]}


def _held(doc: Dict[str, Any], *fields: str) -> Dict[str, Any]:
    return {field: _as_read(doc.get(field)) for field in fields}


def _a_persons_verdict(doc: Dict[str, Any], status: ApplicationStatus, by: VerdictGiver,
                       owner: Optional[MarketPerson], now: datetime,
                       ) -> Tuple[Dict[str, Any], List[str]]:
    """What a person's verdict, or follow-up, sets and takes away, whether given or changed: the
    status, its giver and time (E34/F01/S01), the follow-up's owner, the marker unless named
    (E34/F02/S02), and no rule's reason left behind. It releases whoever held the card
    (E34/F03/S02), and a verdict ends any wait for the deal. Whose share it was (``reviewer``)
    stays."""
    sets: Dict[str, Any] = {"status": status.value, "verdict_by": by.model_dump(),
                            "verdict_at": now.isoformat()}
    unset = ["verdict_reason", *_CLAIM]
    if status is ApplicationStatus.NEEDS_FOLLOW_UP:
        named = owner or MarketPerson(user_id=by.user_id, email=by.email or "")
        sets["follow_up_owner"] = named.model_dump()
    else:
        unset += ["follow_up_owner", ApplicationsApi.ARRIVING_FIELD]
    return sets, unset


def move(doc: Dict[str, Any], event: Event, now: Optional[datetime] = None) -> Union[Move, Refused]:
    """Where ``event`` takes this application, as read, or the table's refusal of it.

    Pure: it reads nothing and writes nothing, so the table-driven test, a preview and the event's
    write all read the same answer. Every move holds the status and the verdict's time as read; a
    verdict, a rule's and a person's, holds the answers' time (``updated_at``) too, so neither a
    verdict nor answers changed in between are written over (E33/F03/S02, E34/F03/S01, T270).
    """
    state = state_of(doc)
    if state not in TABLE[type(event)]:
        return Refused()
    now = now or datetime.now(timezone.utc)
    held = _held(doc, "status", "verdict_at")

    if isinstance(event, (GiveVerdict, ChangeVerdict)):
        if event.status not in MARKED_STATUSES:
            return Refused()
        rejected = event.status is ApplicationStatus.REVIEWER_REJECTED
        if state is State.APPROVED_ADDED and not rejected:
            return Refused(ADDED_ONLY_REJECTED)
        sets, unset = _a_persons_verdict(doc, event.status, event.by, event.owner, now)
        pins = {**held, **_held(doc, "updated_at")}
        if isinstance(event, GiveVerdict):
            # What its giver's undo returns it to, held as it is kept (E38/F10/S01).
            sets["undo_to"] = undo_to_of(doc)
            pins.update(_held(doc, "follow_up_owner"))
        else:
            unset.append("undo_to")
        return Move(to=state_of({**doc, **sets}), set=sets, unset=tuple(unset), pins=pins)

    if isinstance(event, Undo):
        undo_to = doc.get("undo_to")
        if not undoable_by(doc, event.user_id, now) or not isinstance(undo_to, dict):
            return Refused()
        kept = {key: undo_to.get(key) for key in UNDO_KEEPS}
        return Move(
            to=state_of(kept),
            set={key: value for key, value in kept.items() if value is not None},
            unset=(*(key for key, value in kept.items() if value is None),
                   "undo_to", "verdict_reason", *_CLAIM),
            pins=held,
        )

    if isinstance(event, RuleRejects):
        if (state is State.REJECTED_BY_A_RULE
                and (doc.get("verdict_by") or {}).get("rule") == event.rule
                and doc.get("verdict_reason") == event.reason):
            return Refused()
        return Move(
            to=State.REJECTED_BY_A_RULE,
            set={"status": ApplicationStatus.REVIEWER_REJECTED.value,
                 "verdict_by": VerdictGiver(kind="rule", rule=event.rule).model_dump(),
                 "verdict_at": now.isoformat(), "verdict_reason": event.reason},
            unset=("follow_up_owner", "undo_to", ApplicationsApi.ARRIVING_FIELD, *_CLAIM),
            pins={**held, **_held(doc, "updated_at")},
        )

    if isinstance(event, RuleReturns):
        return Move(
            to=State.OPEN,
            set={"status": ApplicationStatus.OPEN.value},
            unset=(*_VERDICT, "follow_up_owner", "undo_to", *_CLAIM),
            pins={**held, **_held(doc, "updated_at")},
        )

    # HandOnFollowUp: held on its still needing one, whoever marked it; what an undo returns to
    # stays, so the marking can still be undone by whoever gave it.
    return Move(
        to=State.FOLLOW_UP,
        set={"follow_up_owner": event.owner.model_dump()},
        unset=(),
        pins={"status": ApplicationStatus.NEEDS_FOLLOW_UP.value},
    )


def _write(read: Dict[str, Any], event: Event, pins: Optional[Dict[str, Any]] = None) -> Written:
    """Write ``event``'s move from the application as read, held on what was read: whether it
    landed, or the table's refusal."""
    moved = move(read, event)
    if isinstance(moved, Refused):
        return moved
    ApplicationsApi.ensure_application_indexes()
    query = {**moved.query(read["id"]), **(pins or {})}
    return ApplicationsApi.applications_collection.update_one(
        query, moved.update()).matched_count > 0


def _as_seen(read: Dict[str, Any], seen: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The answers' time a reviewer saw, to hold a verdict on, or None when what they saw is not
    what was read since: another status or verdict, which the write must not land over."""
    if (seen.get("status") != read.get("status")
            or (seen.get("verdict_at") or None) != (read.get("verdict_at") or None)):
        return None
    return {"updated_at": _as_read(seen.get("updated_at") or read.get("updated_at"))}


def give_verdict(read: Dict[str, Any], seen: Dict[str, Any], status: ApplicationStatus,
                 by: VerdictGiver, owner: Optional[MarketPerson] = None) -> Written:
    """A person's verdict, or follow-up, on an application awaiting one, as they saw it (``seen``:
    its status, verdict's time and answers' time) and as the caller read it since. It keeps what
    the application was for its giver's undo (``undo_to``, E38/F10/S01). False when it changed."""
    held = _as_seen(read, seen)
    if held is None:
        return False
    return _write(read, GiveVerdict(status, by, owner), held)


def change_verdict(read: Dict[str, Any], seen: Dict[str, Any], status: ApplicationStatus,
                   by: VerdictGiver, owner: Optional[MarketPerson] = None) -> Written:
    """A person's verdict, or follow-up, over a verdict already given (E38/F06/S01): the change
    row's, which the caller asks. It keeps nothing to undo. An added vendor's approval changes only
    to a rejection (``ADDED_ONLY_REJECTED``). False when the application changed since ``seen``."""
    held = _as_seen(read, seen)
    if held is None:
        return False
    return _write(read, ChangeVerdict(status, by, owner), held)


def undo(read: Dict[str, Any], seen: Dict[str, Any], by: VerdictGiver) -> Written:
    """Return an application to what its giver's verdict found it as (``undo_to``, E38/F10/S01): its
    status, giver, time and follow-up owner as they were, so a follow-up comes back marked by
    whoever marked it. Refused once it is not theirs to undo; False when it changed since ``seen``,
    the verdict as written."""
    if _as_seen(read, seen) is None:
        return False
    return _write(read, Undo(by.user_id))


def rule_rejects(read: Dict[str, Any], rule: str, reason: str) -> Written:
    """An automatic rejection by ``rule``, for ``reason``, of an open application, or again of one
    a rule rejected for another reason (E33/F03/S02). Refused for one it already rejected so."""
    return _write(read, RuleRejects(rule, reason))


def rule_returns(read: Dict[str, Any]) -> Written:
    """Return an application a rule rejected to open, once no rule meets it."""
    return _write(read, RuleReturns())


def hand_on_follow_up(read: Dict[str, Any], owner: MarketPerson) -> Written:
    """Hand a follow-up to someone else (E34/F02/S01). Written only while it still needs one."""
    return _write(read, HandOnFollowUp(owner))


def store_open(app_id: str) -> bool:
    """Give an application stored with no status the stored ``open`` it reads as, once its answers
    are written. Held on its still having none."""
    ApplicationsApi.ensure_application_indexes()
    return ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": {"$in": [None, ""]}},
        {"$set": {"status": ApplicationStatus.OPEN.value}},
    ).matched_count > 0


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

def sweep_offers(market_id: str) -> int:
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
