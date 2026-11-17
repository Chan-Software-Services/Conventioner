"""Single owner of an application's review state: the only code that writes it.

The review state is the fields a verdict, a follow-up, a deal, an addition or an undo moves:
``OWNED_FIELDS``. Every write of any of them is a function here, and
``tests/test_one_writer_of_the_review_state.py`` fails when any other module writes one, so a rule
about how an application moves between open, follow-up, approved and rejected is written once and
cannot be bypassed by a second writer that forgot it (ADR 0037).

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
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional, Tuple, Union

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

import api.applications as ApplicationsApi
from datatypes import (
    Application, ApplicationOrigin, ApplicationStatus, ApplicationType, IntakeMode, MarketPerson,
    VerdictGiver,
)

if TYPE_CHECKING:
    import api.market_actions as Actions

#: The fields only this module writes: an application's review state. Each move between states
#: writes several of them in one update, which is why they are owned together. ``origin`` is how an
#: application came to the market, owned before anything stores it, so its first writer is here.
OWNED_FIELDS = (
    "status", "verdict_by", "verdict_at", "verdict_reason", "follow_up_owner", "undo_to",
    "added_by", "added_at", "origin", "arriving", "reviewer",
)

#: Statuses nobody has decided yet, as a filter on the stored status reads them: an open
#: application is stored ``open``, or ``under_review`` from before. The deal's pool, its write and
#: the claim filter on this list.
UNDECIDED_STATUSES = (ApplicationStatus.OPEN.value, ApplicationStatus.UNDER_REVIEW.value)
#: The statuses a reviewer gives, each with who gave it: a verdict, or a follow-up (E34).
MARKED_STATUSES = (ApplicationStatus.REVIEWER_APPROVED, ApplicationStatus.REVIEWER_REJECTED,
                   ApplicationStatus.NEEDS_FOLLOW_UP)


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

    @property
    def served(self) -> "Served":
        """This state as every organizer read serves it (``review.state``): the four states a
        screen tells apart, an approval and a rejection each whoever gave it."""
        return _SERVED[self]


class Served(str, Enum):
    """An application's review state as the organizer is served it (``review.state``): open,
    follow-up, approved or rejected. What every screen, the export and the guard read to decide
    anything, never the stored status, which keeps old spellings."""

    OPEN = "open"
    FOLLOW_UP = "follow_up"
    APPROVED = "approved"
    REJECTED = "rejected"


_SERVED = {
    State.OPEN: Served.OPEN,
    State.FOLLOW_UP: Served.FOLLOW_UP,
    State.APPROVED_BY_A_PERSON: Served.APPROVED,
    State.APPROVED_ADDED: Served.APPROVED,
    State.REJECTED_BY_A_PERSON: Served.REJECTED,
    State.REJECTED_BY_A_RULE: Served.REJECTED,
}


#: The statuses the old offers flow carried an approval on to (``NoApprovedApplicationsGuard``:
#: "the solver must have resolved every approved application to either assigned or unassigned").
#: Never written today; each still reads as the approval it came from.
_CARRIED_APPROVALS = (
    ApplicationStatus.UNASSIGNED.value, ApplicationStatus.ASSIGNED.value,
    ApplicationStatus.ASSIGNMENT_SENT.value, ApplicationStatus.VENDOR_ACCEPTED.value,
    ApplicationStatus.VENDOR_REFUSED.value,
)


def origin_of(doc: Dict[str, Any], intake: Optional[IntakeMode] = None) -> ApplicationOrigin:
    """How this application came to the market, its own axis apart from the verdict: its stored
    ``origin``; else, for one stored before the origin was kept, ``added`` when someone added it
    by hand (``added_by``), else ``imported`` on a market whose vendors are imported and
    ``applied`` on one whose vendors apply, or with no ``intake`` given, since then only "added or
    not" is asked."""
    try:
        return ApplicationOrigin(doc.get("origin"))
    except ValueError:
        pass
    if doc.get("added_by"):
        return ApplicationOrigin.ADDED
    return ApplicationOrigin.IMPORTED if intake is IntakeMode.CSV else ApplicationOrigin.APPLIED


def is_added(doc: Dict[str, Any]) -> bool:
    """Whether this application is a vendor added by hand whose answers never arrived since: seated
    by hand and never read by the run (E36/F03/S01). Once an import or their own save brings their
    answers, they are an applicant like any other (T277 P7)."""
    return origin_of(doc) is ApplicationOrigin.ADDED


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
        return State.APPROVED_ADDED if is_added(doc) else State.APPROVED_BY_A_PERSON
    if status == ApplicationStatus.REVIEWER_REJECTED.value:
        by_rule = (doc.get("verdict_by") or {}).get("kind") == "rule"
        return State.REJECTED_BY_A_RULE if by_rule else State.REJECTED_BY_A_PERSON
    if status == ApplicationStatus.CANCELLED.value:
        return State.REJECTED_BY_A_PERSON
    raise ValueError(f"No application status is spelled {status!r}.")


def is_undecided(doc: Dict[str, Any]) -> bool:
    """Whether an application, as stored, awaits a verdict: open, or a follow-up."""
    return state_of(doc).undecided


def is_decided(doc: Dict[str, Any]) -> bool:
    """Whether an application, as stored, carries a verdict: a reviewer's write over it changes a
    verdict (E38/F06/S01). What a reviewer saw is read by ``saw_decided``."""
    return not is_undecided(doc)


#: Every status a state names, as ``state_of`` reads it.
_STATED_STATUSES = (None, "", *(status.value for status in ApplicationStatus))


def _stored_as(state: State) -> List[Optional[str]]:
    """Every stored status ``state_of`` reads as ``state`` on its own, missing and empty among
    them: walked off the rule, so a count filtering on them names no spelling a second time."""
    return [status for status in _STATED_STATUSES if state_of({"status": status}) is state]


def undecided_counts(market_id: str) -> Tuple[int, int]:
    """How many of a market's applications are open, and how many need a follow-up, whatever
    their stored spelling: what Begin assignment's guard counts (``AllApplicationsReviewedGuard``).
    A stored status alone decides whether an application is undecided, so two counts filtered on
    the spellings of each undecided state count exactly what ``state_of`` reads so."""
    return (
        ApplicationsApi.count_applications_with_any_status(market_id, _stored_as(State.OPEN)),
        ApplicationsApi.count_applications_with_any_status(market_id, _stored_as(State.FOLLOW_UP)),
    )


def saw_decided(seen: Dict[str, Any]) -> bool:
    """Whether a reviewer saw an application carrying a verdict, so their write over it changes
    one (E38/F06/S01). A status no state names is nothing they could have seen: it reads as not
    decided, and the write held on it matches nothing, as no application is stored so."""
    return seen.get("status") in _STATED_STATUSES and is_decided(seen)


def is_judgeable(application: Dict[str, Any]) -> bool:
    """Whether a market's automatic rejections may judge this stored application: an open one, or
    one a rule rejected; never one a person decided, nor a follow-up. The import's preview asks it
    of an application as the import would leave it (E38/F03/S02)."""
    return state_of(application) in (State.OPEN, State.REJECTED_BY_A_RULE)


#: How long the person who gave a verdict, or marked a follow-up, may take it back themselves
#: (E38/F10/S01): long enough to notice a slip while reading the next card, short enough that
#: nobody else has acted on it. After it, changing a verdict is the change row's (E38/F06/S01).
UNDO_WINDOW = timedelta(minutes=2)
#: What an undo returns an application to, kept on it by the verdict that left it (``undo_to``):
#: its status, giver, time and follow-up owner as they were, while it was awaiting a verdict. Kept
#: by the server, so an undo never returns an application to what a request names; a verdict that
#: changed one keeps nothing, since an undo is never a change of a verdict.
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


# --- Waiting for the deal (E38/F07/S03, ADR 0020) -------------------------------------------------

@dataclass(frozen=True)
class Arrival:
    """The write that moved an application into open or follow-up: who made it and by which action.

    Every such move but a person's own follow-up marks the application for the deal in its own
    update, storing this as ``arriving``, whether or not reviewers are chosen and whoever its
    reviewer is. The deal, holding
    the market, then keeps an able reviewer or deals it to the next one in turn
    (``review_team.py``), and records the deal under this write. Marking every move, and judging who
    is able only in the deal that holds the market, is what closes the race between a change of
    reviewers and the move: a move landing after the change read its pool is still marked, and
    the change's let-go deals it."""

    actor: Optional[str]
    action: str

    @classmethod
    def of(cls, asked: "Actions.Asked") -> "Arrival":
        """The arrival of a write a row let through (T352): its row and its person, as the asking
        named them, so the deal is recorded under the row the write was let through on. A refused
        asking raises ``RecordedARefusal`` and marks nothing, as recording through it does."""
        # Here, not at the top: the market's actions reach this module through the assignment.
        import api.market_actions as Actions
        if asked.refused is not None:
            raise Actions.RecordedARefusal(
                f"An application on market {asked.market_id} was marked for the deal under "
                f"{asked.row.id!r}, which its person was refused.")
        return cls(asked.actor, asked.row.id)

    def stored(self) -> Dict[str, Any]:
        return {"actor": self.actor, "action": self.action}


# --- An application arrives, or is added ----------------------------------------------------------

def _upsert(app: Application, body: Dict[str, Any]) -> Tuple[Application, bool]:
    """Store ``app``, written as ``body``, unless one already exists for the applicant it belongs
    to: the one application that exists, and whether this call made it.

    A single conditional upsert, so that a request which loses the race to another one for the same
    address does not leave a second document behind: the identity fields are the filter, the rest of
    the document is written only on insert, and the unique index in
    ``ApplicationsApi.ensure_application_indexes`` is what makes the losing insert fail rather than
    duplicate.

    That failure is a ``DuplicateKeyError``, which an upsert can raise even though it matched
    nothing -- the winner's insert lands between this one's read and its own write -- so it is
    caught and the winner's document is returned. Either way the caller gets the one application
    that exists, which is what it asked for.
    """
    ApplicationsApi.ensure_application_indexes()
    identity = ApplicationsApi.applicant_filter(
        app.market_id, app.applicant_email, app.application_type.value,
    )
    # The identity fields come from the filter, which is where an upsert takes them from; repeating
    # them in the insert body would only be a second chance to disagree with it.
    body = {key: value for key, value in body.items() if key not in identity}

    for _attempt in range(2):
        try:
            # The document as it was: none when this upsert inserted it.
            was = ApplicationsApi.applications_collection.find_one_and_update(
                identity,
                {"$setOnInsert": body},
                upsert=True,
                return_document=ReturnDocument.BEFORE,
            )
            if was:
                return Application(**was), False
            made = ApplicationsApi.applications_collection.find_one(identity)
            if made:
                return Application(**made), True
        except DuplicateKeyError:
            pass
        existing = ApplicationsApi.applications_collection.find_one(identity)
        if existing:
            return Application(**existing), False

    # Named by its market and never its address: this escapes to the 500 log, which holds none.
    raise PyMongoError(
        f"Could not store an application for market {app.market_id}: a concurrent write for the "
        f"same applicant keeps winning, and no document for them can be read back."
    )


def arrive(market_id: str, email: str, origin: ApplicationOrigin, submitted_at: Optional[str],
           arrival: Arrival, *, application_type: ApplicationType = ApplicationType.MAIN,
           ) -> Application:
    """An application arrives: the "(none)" row of the table. Stored open with no answers yet, its
    ``origin`` (``applied`` by the applicant's first save, ``imported`` by an import row) and marked
    for the deal by ``arrival``, the write it came by; the answers follow by ``answers_changed``.
    Answers the application already stored for this applicant, the winner's on a lost race."""
    app = Application(
        market_id=market_id, applicant_email=email, form_data={}, status=ApplicationStatus.OPEN,
        origin=origin, submitted_at=submitted_at, application_type=application_type,
    )
    body = {**app.model_dump(), ApplicationsApi.ARRIVING_FIELD: arrival.stored()}
    return _upsert(app, body)[0]


def add(market_id: str, email: str, form_data: Dict[str, Any],
        adder: MarketPerson) -> Optional[Application]:
    """A vendor who never applied is added by hand (E36/F03/S01): from "(none)" alone, to
    ``approved(added)``, approved by ``adder`` as they add them, origin ``added``. None when the
    market already holds an application for the address, which the caller refuses: adding never
    writes over one."""
    now = datetime.now(timezone.utc).isoformat()
    app = Application(
        market_id=market_id, applicant_email=email, form_data=form_data,
        status=ApplicationStatus.REVIEWER_APPROVED, verdict_by=adder.as_giver(), verdict_at=now,
        added_by=adder, added_at=now, origin=ApplicationOrigin.ADDED,
    )
    stored, made = _upsert(app, app.model_dump())
    return stored if made else None


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
    """The giver of a verdict takes it back within ``UNDO_WINDOW`` (E38/F10/S01), by ``arrival``."""

    user_id: Optional[str]
    arrival: Arrival


@dataclass(frozen=True)
class RuleRejects:
    """An automatic rejection meets the answers (E33/F03/S02)."""

    rule: str
    reason: str


@dataclass(frozen=True)
class RuleReturns:
    """No automatic rejection meets the answers of an application a rule rejected any longer: the
    rules judged after ``arrival``, the write that changed the answers or the rules."""

    arrival: Arrival


@dataclass(frozen=True)
class HandOnFollowUp:
    """A follow-up is handed to someone else (E34/F02/S01), by ``arrival``."""

    owner: MarketPerson
    arrival: Arrival


class Source(str, Enum):
    """Who changed an application's answers: the applicant's own save, a row of an import, or an
    organizer's update beside the vendor's answer (E41/F01/S01)."""

    APPLICANT = "applicant"
    IMPORT = "import"
    ORGANIZER = "organizer"


#: What an added vendor becomes once their answers arrive by each source (T277 P7).
_ORIGIN_BY_SOURCE = {Source.APPLICANT: ApplicationOrigin.APPLIED,
                     Source.IMPORT: ApplicationOrigin.IMPORTED}


@dataclass(frozen=True)
class AnswersChanged:
    """An application's answers are written, by ``source`` (Daniel's decision 9.1, T277).

    ``form_data`` is the vendor's answers as the write will store them, for the applicant and an
    import, so the move can tell answers that changed from a save that restates them; an
    organizer's update is written beside them and passes none. ``arrival`` is the write, for the
    deal, should the move send a verdict back to open."""

    source: Source
    form_data: Optional[Dict[str, Any]] = None
    arrival: Optional[Arrival] = None


Event = Union[GiveVerdict, ChangeVerdict, Undo, RuleRejects, RuleReturns, HandOnFollowUp,
              AnswersChanged]

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
    # Answers change in every state; what that does to the verdict is ``move``'s (decision 9.1).
    AnswersChanged: tuple(State),
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

    def applied(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        """The application as this move leaves it, for a preview that writes nothing."""
        left = {key: value for key, value in doc.items() if key not in self.unset}
        return {**left, **self.set}


def returned_to_review(read: Dict[str, Any], moved: "Move") -> bool:
    """Whether this move, from the application as read, sends its verdict back to open: what an
    applicant's history entry and an import's count say (decision 9.1)."""
    return is_decided(read) and moved.to is State.OPEN


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
    write all read the same answer. Every move but a hand-on (held on its still needing a
    follow-up) and an organizer's update holds the status and the verdict's time as read; a
    verdict, a rule's and a person's, holds the answers' time (``updated_at``) too, so neither a
    verdict nor answers changed in between are written over (E33/F03/S02, E34/F03/S01, T270).
    An undo, a rule's return, a hand-on and answers changed under a person's verdict mark the
    application for the deal by the event's ``arrival``; a person's follow-up keeps whatever mark
    it had; every verdict ends the wait. Changed answers hold only the status and the verdict's
    time, and an organizer's nothing (``_answers_move``).
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

    if isinstance(event, AnswersChanged):
        return _answers_move(doc, state, event, held)

    if isinstance(event, Undo):
        undo_to = doc.get("undo_to")
        if not undoable_by(doc, event.user_id, now) or not isinstance(undo_to, dict):
            return Refused()
        kept = {key: undo_to.get(key) for key in UNDO_KEEPS}
        return Move(
            to=state_of(kept),
            set={**{key: value for key, value in kept.items() if value is not None},
                 ApplicationsApi.ARRIVING_FIELD: event.arrival.stored()},
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
            set={"status": ApplicationStatus.OPEN.value,
                 ApplicationsApi.ARRIVING_FIELD: event.arrival.stored()},
            unset=(*_VERDICT, "follow_up_owner", "undo_to", *_CLAIM),
            pins={**held, **_held(doc, "updated_at")},
        )

    # HandOnFollowUp: held on its still needing one, whoever marked it; what an undo returns to
    # stays, so the marking can still be undone by whoever gave it.
    return Move(
        to=State.FOLLOW_UP,
        set={"follow_up_owner": event.owner.model_dump(),
             ApplicationsApi.ARRIVING_FIELD: event.arrival.stored()},
        unset=(),
        pins={"status": ApplicationStatus.NEEDS_FOLLOW_UP.value},
    )


def _answers_move(doc: Dict[str, Any], state: State, event: AnswersChanged,
                  held: Dict[str, Any]) -> Move:
    """What changed answers do to the verdict (decision 9.1), the answers' own fields aside.

    An organizer's update keeps every verdict, since they made both, and holds nothing, so two
    organizers updating different answers at once both land. A change by the applicant or an
    import, held on the status and the verdict's time as read: a person's approval or rejection
    goes back to open, marked for the deal, since nobody judged the answers as they read now; an
    added vendor stays approved; a rule's rejection stays, for the caller's rules to judge again;
    open and follow-up stay. Whatever the state, an added vendor whose answers arrive becomes an
    applicant (its origin moves, T277 P7), so one whose approval was changed to a rejection is
    approved by a person once approved again. A save that restates the answers moves nothing. One
    stored with no status is given the ``open`` it reads as.
    """
    if event.source is Source.ORGANIZER:
        return Move(to=state, set={}, unset=(), pins={})
    sets: Dict[str, Any] = {}
    if doc.get("status") in (None, ""):
        sets["status"] = ApplicationStatus.OPEN.value
    changed = event.form_data != (doc.get("form_data") or {})
    if changed and is_added(doc):
        sets["origin"] = _ORIGIN_BY_SOURCE[event.source].value
    if changed and state in (State.APPROVED_BY_A_PERSON, State.REJECTED_BY_A_PERSON):
        if event.arrival is None:
            raise ValueError("A return to open is marked for the deal by the write it came by.")
        return Move(
            to=State.OPEN,
            set={**sets, "status": ApplicationStatus.OPEN.value,
                 ApplicationsApi.ARRIVING_FIELD: event.arrival.stored()},
            unset=(*_VERDICT, "follow_up_owner", "undo_to", *_CLAIM),
            pins=held,
        )
    return Move(to=state_of({**doc, **sets}), set=sets, unset=(), pins=held)


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


def _a_seen_time(value: Any) -> bool:
    """Whether a time a reviewer saw is one an application holds: a string, or null."""
    return value is None or isinstance(value, str)


def _as_seen(read: Dict[str, Any], seen: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The answers' time a reviewer saw, to hold a verdict on, or None when what they saw is not
    what was read since: another status or verdict, which the write must not land over. Its times
    are read as a string or null only (a request value is a string): any other is nothing they
    could have seen, so it is None, as a ``seen`` whose status no state names matches nothing."""
    if not (_a_seen_time(seen.get("verdict_at")) and _a_seen_time(seen.get("updated_at"))):
        return None
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


def undo(read: Dict[str, Any], seen: Dict[str, Any], by: VerdictGiver,
         arrival: Arrival) -> Written:
    """Return an application to what its giver's verdict found it as (``undo_to``, E38/F10/S01): its
    status, giver, time and follow-up owner as they were, so a follow-up comes back marked by
    whoever marked it, and marked for the deal by ``arrival``. Refused once it is not theirs to
    undo; False when it changed since ``seen``, the verdict as written."""
    if _as_seen(read, seen) is None:
        return False
    return _write(read, Undo(by.user_id, arrival))


def rule_rejects(read: Dict[str, Any], rule: str, reason: str) -> Written:
    """An automatic rejection by ``rule``, for ``reason``, of an open application, or again of one
    a rule rejected for another reason (E33/F03/S02). Refused for one it already rejected so."""
    return _write(read, RuleRejects(rule, reason))


def rule_returns(read: Dict[str, Any], arrival: Arrival) -> Written:
    """Return an application a rule rejected to open, once no rule meets it, marked for the deal by
    ``arrival``, the write whose rules returned it."""
    return _write(read, RuleReturns(arrival))


def hand_on_follow_up(read: Dict[str, Any], owner: MarketPerson, arrival: Arrival) -> Written:
    """Hand a follow-up to someone else (E34/F02/S01), marked for the deal by ``arrival``: the deal
    keeps the new owner while they hold any role on the market, and hands it on otherwise. Written
    only while it still needs one."""
    return _write(read, HandOnFollowUp(owner, arrival))


def answers_changed(read: Dict[str, Any], source: Source, answers: Dict[str, Any],
                    arrival: Optional[Arrival] = None,
                    cleared: Iterable[str] = ()) -> Optional[Move]:
    """Write an application's answers, by ``source``, and what that does to its verdict
    (``AnswersChanged``, decision 9.1), in one update: no stop between the answers and the state
    can leave a vendor approved on answers nobody read, nor open in nobody's share.

    ``answers`` is the part of the update the caller built, which names no owned field: the
    vendor's ``form_data``, ``submitted_at`` and ``updated_at`` for the applicant and an import;
    the dotted ``answer_updates`` paths and ``updated_at`` for an organizer, with the paths it
    takes away in ``cleared``. ``arrival`` is the write, marking a verdict sent back to open for
    the deal. The move written, or None when the application changed since ``read`` and the held
    write matched nothing: the caller reads it again.
    """
    cleared = list(cleared)
    owned = [key for key in [*answers, *cleared] if key.split(".")[0] in OWNED_FIELDS]
    if owned:
        raise ValueError(f"The answers' write names fields the review state owns: {owned}.")
    moved = move(read, AnswersChanged(source, answers.get("form_data"), arrival))
    if not isinstance(moved, Move):  # every state takes changed answers (``TABLE``)
        raise ValueError(f"No state refuses changed answers, yet {state_of(read)} did.")
    update = moved.update()
    update["$set"] = {**answers, **update.get("$set", {})}
    gone = {key: "" for key in cleared}
    if gone:
        update["$unset"] = {**gone, **update.get("$unset", {})}
    ApplicationsApi.ensure_application_indexes()
    written = ApplicationsApi.applications_collection.update_one(moved.query(read["id"]), update)
    return moved if written.matched_count > 0 else None


# --- Whose share it is (E38/F07/S02, ADR 0020): written only for ``review_team.py`` ---------------

def deal(app_id: str, reviewer: Optional[MarketPerson], was: Optional[Dict[str, Any]]) -> bool:
    """Deal an application to ``reviewer``, or back to first come, first served with None.

    Written only while it is still open and still dealt to whom the caller read (``was``), so a
    verdict landing mid-deal is never touched and no other deal is written over. Dealt to someone,
    it waits for the deal no longer. Only ``review_team.py`` calls it, holding the market.
    """
    ApplicationsApi.ensure_application_indexes()
    arriving = ApplicationsApi.ARRIVING_FIELD
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


def deal_follow_up(app_id: str, reviewer: MarketPerson,
                   owner_was: Optional[Dict[str, Any]]) -> bool:
    """Hand a follow-up on to the reviewer it is dealt to, a removed reviewer's or one whose owner
    may no longer own a follow-up here: its owner and its reviewer both become them, it keeps its
    status, and it waits for the deal no longer. Written only while it still needs a follow-up
    from ``owner_was``, so one taken on or decided meanwhile is left as it is. Only
    ``review_team.py`` calls it, holding the market."""
    ApplicationsApi.ensure_application_indexes()
    result = ApplicationsApi.applications_collection.update_one(
        {"id": app_id, "status": ApplicationStatus.NEEDS_FOLLOW_UP.value,
         "follow_up_owner": owner_was if owner_was else {"$in": [None]}},
        {"$set": {"follow_up_owner": reviewer.model_dump(), "reviewer": reviewer.model_dump()},
         "$unset": {ApplicationsApi.ARRIVING_FIELD: ""}},
    )
    return result.matched_count > 0


def settle_waiting(read: Dict[str, Any]) -> bool:
    """End the wait of an application the deal leaves where it is: decided since it was marked,
    open with an able reviewer, or a follow-up whose owner may still own one here. Held on its
    status and its mark as the deal read them, so a move landing in between keeps the mark it wrote
    for the next round. Only ``review_team.py`` calls it, holding the market."""
    ApplicationsApi.ensure_application_indexes()
    arriving = ApplicationsApi.ARRIVING_FIELD
    return ApplicationsApi.applications_collection.update_one(
        {"id": read["id"], "status": _as_read(read.get("status")),
         arriving: _as_read(read.get(arriving))},
        {"$unset": {arriving: ""}},
    ).matched_count > 0


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
