"""Single owner of dealing a market's review among the reviewers chosen for it (E38/F07, ADR 0020).

An Admin or the owner chooses reviewers, and the open applications (the undecided:
``UNDECIDED_STATUSES``) are dealt among them round robin, in the order the applications arrived and
the order the reviewers' addresses sort, so the deal is the same whoever chose them and a test can
predict it. A deal never counts what each reviewer has left open: being quick earns nobody more.

The team is stored on the market (``Market.review_team``, ``reviewTeam``), and each application's
share on it (``Application.reviewer``). Nothing else writes either: the routes call this module.
The reviewer is whose share it is; who is looking at it now is the claim of ADR 0014, which a deal
never moves.

With no reviewers chosen, everything is first come, first served, as before this existed.

**Every move into open, every undo back into a follow-up, and every hand-on of a follow-up, waits
for the deal**: an arrival, an undo (into open or back into a follow-up), a rule's return, a re-import's or an applicant's back to review and a follow-up's hand-on
each mark their application (``arriving``, ``ReviewState.Arrival``) in their own write, whether
or not reviewers are chosen and whoever its reviewer is, and the deal judges who is able. So no open application is left outside every share
while an able reviewer exists, whichever order a change of reviewers and the move land in.

**Every deal holds the market** (``reviewTeam.dealing``, a short lease, ``_hold``): a change of
reviewers from writing its team to writing its turn, and a deal of what waits from reading the turn
to writing it. So the turn is only ever read and written by the one deal holding the market, and no
interleaving of a change and an arrival can deal an application twice or skip a reviewer. A move
never waits for the market: its application is marked before it tries to hold, and it deals every
application so marked if it can hold the market; if it cannot, the deal holding it deals them when
it lets go (``_settle``), since every holder looks for marked ones after letting go. A holder the
host ended never lets go: its lease runs out, and the next deal deals what it left, which a
reviewer's next card starts (``deal_waiting``), so a quiet spell after it leaves no reviewer's share
short. With nobody chosen able, the marks are left for the next deal once someone is. Every write a deal makes to the market names its lease and
reads whether it matched: one that did not finds another deal holding the market, its own lease
lapsed, so a change of reviewers is refused (``DEALING_BUSY``) and a deal of arrivals says so in
the log.
"""
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import api.applications as ApplicationsApi
import api.market_actions as Actions
import api.organizations as OrgsApi
import api.permissions as PermissionsApi
import application_status as ReviewState
import history as History
from assignment.utils import convert_keys_to_camel_case, convert_keys_to_snake_case
from client_errors import ConflictError
from datatypes import (
    ApplicationStatus, Market, MarketPerson, MarketPhase, Organization, ReviewTeam,
)
from db_config import get_database
from market_documents import market_doc_field, market_doc_key, market_from_document
from tombstone import live
from utils.email_address import normalized_email

logger = logging.getLogger(__name__)

db = get_database()
markets_collection = db["markets"]

#: Why a deal moved what it moved, in its history entry: a change of reviewers, or a move into
#: open or follow-up that waited for the deal (an arrival, an undo, a rule's return...).
REVIEWERS_CHANGED = "reviewers_changed"
ARRIVED = "arrived"

_TURN = f"{market_doc_key('review_team')}.turn"
_REVIEWERS = f"{market_doc_key('review_team')}.reviewers"
_DEALING = f"{market_doc_key('review_team')}.dealing"
_DEALING_BY = f"{_DEALING}.by"
_DEALING_UNTIL = f"{_DEALING}.until"
#: A change of reviewers is unfinished from its team write to its last write: beside the team on
#: the stored document, never on the model, as ``dealing`` is. It holds the addresses of the
#: reviewers the change removed, so the change that finishes it hands on their follow-ups too.
_UNFINISHED = f"{market_doc_key('review_team')}.unfinishedChoice"
_UNFINISHED_FIELD = "unfinishedChoice"

#: How long a deal holds the market at most: far longer than any deal takes, so a deal that stopped
#: half way (a crashed worker) lets the next one in.
DEALING_LEASE = timedelta(seconds=30)
#: A change of reviewers waits this many short pauses for another deal to let go of the market.
CHOICE_WAITS = 100
HOLD_PAUSE_SECONDS = 0.05

DEALING_BUSY = (
    "The reviewers are being dealt applications right now. Try again in a moment."
)


class Chosen(NamedTuple):
    """What a choice left: the team as it now stands, and how many applications it moved."""
    team: ReviewTeam
    dealt: int


def team_of(market: Market) -> ReviewTeam:
    """The market's reviewers; none when none were ever chosen."""
    return market.review_team or ReviewTeam()


def in_deal_order(people: List[MarketPerson]) -> List[MarketPerson]:
    """The people in the order a deal hands out to them: by address, each once."""
    by_address = {normalized_email(person.email): person for person in people}
    return [by_address[address] for address in sorted(by_address)]


def _addresses(people: List[MarketPerson]) -> List[str]:
    return [normalized_email(person.email) for person in people]


def eligible(market: Market, organization: Optional[Organization]) -> List[MarketPerson]:
    """The chosen reviewers who may still review here: those who still hold a role on the market
    that the table's ``review-when-chosen`` row lets be chosen (``Actions.may_be_chosen``)."""
    return [person for person in team_of(market).reviewers
            if Actions.may_be_chosen(person.user_id, market, organization)]


def served(
    team: ReviewTeam, market: Market, organization: Optional[Organization],
) -> Dict[str, Any]:
    """The reviewers as every reader of the market is served them, each with whether they may still
    review here; the turn is the deal's own and is never served."""
    able = {person.user_id for person in eligible(market.model_copy(update={"review_team": team}),
                                                   organization)}
    return {"reviewers": [
        {"email": person.email, "able": person.user_id in able} for person in team.reviewers
    ]}


def choose(
    market: Market, organization: Optional[Organization], reviewers: List[MarketPerson],
    asked: Actions.Asked,
) -> Chosen:
    """Make ``reviewers`` the market's review team and deal every open application among them,
    recording both through ``asked``, the Choose reviewers asking its caller was let in on.

    Holding the market, the team is written with its turn reset, then the pool is read and dealt
    round robin from the first able reviewer (``eligible``) in arrival order, and the turn is
    written as the pool's size, so the next arrival goes to the reviewer after the last one dealt.
    The pool is every open application, those waiting for the deal included, and each
    follow-up whose owner was a reviewer and is not one now: it keeps its status and is handed to
    the reviewer it is dealt to, as its owner and its reviewer, so someone still reaches out. A
    follow-up owned by a reviewer still chosen, or by someone who never was one, and every decided
    application, are never written here. Once it lets go of the market, it deals what waits for the
    deal: what was marked while it held it, and what it left where it was (``_settle``); a waiting
    follow-up stays with an owner who may still own one here, whether or not they may be chosen to
    review, and is handed on only once its owner holds no role on the market.

    Each write is conditioned on the application still being as the pool read it (open and dealt
    as it was, or the follow-up still owned by the removed reviewer), so a verdict or a hand-on
    landing mid-deal is never written over. With none chosen, every open application goes back to
    first come, first served, and every follow-up stays with its owner.

    The team write marks the change unfinished (``reviewTeam.unfinishedChoice``) and its last write,
    the turn's, takes the mark away, so a change that stopped between them is finished by the same
    choice again: an unchanged set writes and records nothing only when no change is unfinished;
    otherwise it deals the pool as the change would have, with no second "reviewers changed" entry.

    Refused with ``ConflictError`` when another deal holds the market for longer than a choice
    waits, and when the change finds another deal holding it at its team write (it then deals
    nothing) or at its last write (it then stays unfinished, for the same choice to finish).
    """
    # A market never given a team has had no team write, so no change of it can be unfinished.
    if (_addresses(in_deal_order(reviewers)) == _addresses(team_of(market).reviewers)
            and (market.review_team is None
                 or _unfinished_choice(markets_collection.find_one(live({"id": market.id}))) is None)):
        return Chosen(team_of(market), 0)
    deal = str(uuid.uuid4())
    if not _hold(market.id, deal, waits=CHOICE_WAITS):
        raise ConflictError(DEALING_BUSY)
    try:
        return _choose_holding(market, organization, reviewers, asked, deal)
    finally:
        # Every let-go looks again, a failed change's too: an arrival that found the market held
        # left its application to whoever held it.
        _let_go(market.id, deal)
        _settle(market, organization)


def _choose_holding(
    market: Market, organization: Optional[Organization], reviewers: List[MarketPerson],
    asked: Actions.Asked, deal: str,
) -> Chosen:
    """``choose``'s writes, made while it holds the market: the team as it stands now is read
    again, since another choice may have landed between the request's read and the hold.

    A change writes the team, marked unfinished, and records it; finishing one (the same set over
    a marked team) writes neither. Both then deal the pool from turn 0, record the deal, and end in
    the last write, the turn with the mark taken away."""
    stored = markets_collection.find_one(live({"id": market.id})) or {}
    before = _team_of_document(stored)
    unfinished = _unfinished_choice(stored)
    chosen = in_deal_order(reviewers)
    kept = set(_addresses(chosen))
    # Whom a change removed, and whom an unfinished change before it removed and is not chosen now:
    # their follow-ups are handed on. With none chosen, every follow-up stays with its owner.
    removed = ((set(_addresses(before.reviewers)) | set(unfinished or ())) - kept
               if chosen else set())
    if _addresses(chosen) == _addresses(before.reviewers):
        if unfinished is None:
            return Chosen(before, 0)
    else:
        _write_holding(market.id, deal, {"$set": {
            _REVIEWERS: [convert_keys_to_camel_case(person.model_dump()) for person in chosen],
            _TURN: 0,
            _UNFINISHED: {"removed": sorted(removed)},
        }})
        asked.record(
            kind=History.REVIEWERS,
            detail=lambda: History.changes(
                {"reviewers": _addresses(before.reviewers)}, {"reviewers": _addresses(chosen)}))

    team = ReviewTeam(reviewers=chosen, turn=0)
    able = eligible(market.model_copy(update={"review_team": team}), organization)
    pool = ApplicationsApi.undecided_in_arrival_order(market.id, follow_ups_of=removed)
    if chosen and not able:
        # Nobody chosen may review here: nothing is dealt, and what waits for the deal keeps
        # waiting until someone chosen may review again.
        _finish(market.id, deal, 0)
        return Chosen(team, 0)

    moved = []
    for index, doc in enumerate(pool):
        to = able[index % len(able)] if able else None
        was = doc.get("reviewer") or None
        if doc.get("status") == ApplicationStatus.NEEDS_FOLLOW_UP.value:
            owner = doc.get("follow_up_owner")
            if ReviewState.deal_follow_up(doc["id"], to, owner):
                moved.append((doc, was, to, owner))
            continue
        if was == (to.model_dump() if to else None):
            continue
        if ReviewState.deal(doc["id"], to, was):
            moved.append((doc, was, to, None))
    turn = len(pool) if able else 0

    if moved:
        asked.record(
            kind=History.DEALT,
            vendors=[doc.get("applicant_email") for doc, *_rest in moved],
            subject={"application_ids": [doc["id"] for doc, *_rest in moved]},
            detail=lambda: {
                "cause": REVIEWERS_CHANGED,
                "before": {doc["id"]: _share(was, owner) for doc, was, _to, owner in moved},
                "after": {doc["id"]: _share(to.model_dump() if to else None,
                                            to.model_dump() if owner else None)
                          for doc, _was, to, owner in moved},
            })
    _finish(market.id, deal, turn)
    return Chosen(team.model_copy(update={"turn": turn}), len(moved))


def _finish(market_id: str, deal: str, turn: int) -> None:
    """A change's last write: the turn, so the next arrival goes to the reviewer after the last one
    dealt, with the change's mark taken away."""
    _write_holding(market_id, deal, {"$set": {_TURN: turn}, "$unset": {_UNFINISHED: ""}})


def _write_holding(market_id: str, deal: str, update: Dict[str, Any]) -> None:
    """A change's write to the market under its lease; refused with ``ConflictError`` when another
    deal holds the market now, as one does once this one's lease lapsed."""
    written = markets_collection.update_one(live({"id": market_id, _DEALING_BY: deal}), update)
    if written.matched_count == 0:
        raise ConflictError(DEALING_BUSY)


def _unfinished_choice(stored: Optional[Dict[str, Any]]) -> Optional[List[str]]:
    """The reviewers an unfinished change of reviewers removed; None when no change is
    unfinished."""
    team = market_doc_field(stored or {}, "review_team") or {}
    if _UNFINISHED_FIELD not in team:
        return None
    return list((team[_UNFINISHED_FIELD] or {}).get("removed") or [])


def _share(reviewer: Optional[Dict[str, Any]], owner: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """An application's place in a deal's entry: its reviewer, and a follow-up's owner beside it."""
    return {"reviewer": _address(reviewer),
            **({"follow_up_owner": _address(owner)} if owner else {})}


def _address(person: Optional[Dict[str, Any]]) -> Optional[str]:
    return (person or {}).get("email") or None


def deal_arrivals(market: Market) -> int:
    """Deal every application waiting for the deal (E38/F07/S03), as a write that marked one ends,
    for a caller holding the market alone: an applicant's save, an import, and the writes whose
    automatic rejections can return one to open, once that write's rules have judged. Each is
    recorded under the write that marked it, never the one dealing. Answers how many it dealt.

    With no reviewers chosen it reads and writes nothing, and the marks wait for the next deal,
    which a choice of reviewers makes."""
    return deal_waiting(market, _organization(market))


def deal_waiting(market: Market, organization: Optional[Organization]) -> int:
    """Deal every application waiting for the deal, holding the market, as the next card a reviewer
    asks for does: a deal the host ended while it held the market never let go, a request the host
    ended between its move and its deal never dealt, and nobody may have been able when one was
    marked, so the marks wait for whichever deal comes next, and a quiet spell brings none. Each is
    recorded under the write that marked it, never the one asking. While a live deal holds the
    market it answers at once, and that deal deals them as it lets go. With no reviewers chosen,
    or on an archived market, it reads and writes nothing. Answers how many it dealt.

    Only a write calls it: ``utils/request_origin.py`` lets a ``GET`` through on the promise that
    it changes nothing, so no read deals."""
    if not team_of(market).reviewers or market.phase is MarketPhase.ARCHIVED:
        return 0
    return _settle(market, organization)


def _settle(market: Market, organization: Optional[Organization], again: bool = True) -> int:
    """Deal every application waiting for the deal, holding the market, and look again each time
    it lets go, for as long as any waits, it can hold the market and its last round dealt or
    settled one: a move that found the market held marked its application before it tried, so the
    holder that looks after letting go finds it, however long a burst of arrivals runs. Stops when
    none waits, when another deal holds the market, which looks again itself when it lets go, and
    after a round that did nothing, which leaves marks nobody chosen can take for the next deal. A
    round that fails lets go and looks again once before its error goes on, so an arrival that came
    in meanwhile is not left. Answers how many it dealt."""
    dealt = 0
    while ApplicationsApi.any_arriving(market.id):
        deal = str(uuid.uuid4())
        if not _hold(market.id, deal):
            return dealt
        try:
            round_ = _deal_arriving(market, organization, deal)
        except Exception:
            _let_go(market.id, deal)
            if again:
                _settle(market, organization, again=False)
            raise
        _let_go(market.id, deal)
        dealt += round_.dealt
        if not round_.dealt and not round_.settled:
            return dealt
    return dealt


#: Why the deal of a waiting application is recorded with no request asking its row: the write
#: that marked it asked its own (an applicant's save asks none), and stored it and its person beside
#: the application, so whichever deal next holds the market records it under them, never its own.
ARRIVALS_DEAL_UNASKED = (
    "an arriving application is dealt by whichever deal next holds the market, under the row and "
    "the person the write it arrived by stored")


class _Dealt(NamedTuple):
    """One waiting application a deal dealt: as it read it, whom it was dealt to before, as stored,
    and whom to now; a follow-up's owner before too, as the owner and the reviewer both become
    ``to``."""
    doc: Dict[str, Any]
    was: Optional[Dict[str, Any]]
    to: MarketPerson
    follow_up: bool = False
    owner_was: Optional[Dict[str, Any]] = None

    def before(self) -> Dict[str, Any]:
        return {"reviewer": _address(self.was),
                **({"follow_up_owner": _address(self.owner_was)} if self.follow_up else {})}

    def after(self) -> Dict[str, Any]:
        return {"reviewer": self.to.email,
                **({"follow_up_owner": self.to.email} if self.follow_up else {})}


class _Round(NamedTuple):
    """What one deal of the waiting applications did: how many it dealt, and how many it left where
    they were, their wait ended."""
    dealt: int
    settled: int


def _deal_arriving(market: Market, organization: Optional[Organization], deal: str) -> _Round:
    """Deal the applications waiting for the deal, holding the market, in arrival order, reading the
    roles with the turn:

    - one decided since it was marked waits no longer, its verdict kept;
    - an open one whose reviewer is an able chosen reviewer keeps them, the turn unmoved;
    - any other open one is dealt to the able reviewer the turn names, the turn moving on by one;
    - a follow-up whose owner may still own one here keeps its owner: anyone with a role on the
      market, who may be picked as a follow-up's owner (``PermissionsApi.people_with_market_role``),
      whether or not they may be chosen to review, so the person an organizer picked keeps it;
    - any other follow-up, its owner no longer able to own one here, is handed on, as its owner and
      its reviewer, to the able reviewer the turn names, the turn moving on by one;
    - with nobody able, an undecided one is left waiting, never let go (T277 P5).

    The turn is written once at the end. Records one entry per write they were marked by, under its
    action and actor, through the unasked door (``ARRIVALS_DEAL_UNASKED``), each application's
    reviewer and a follow-up's owner before as stored."""
    stored = markets_collection.find_one(live({"id": market.id})) or {}
    team = _team_of_document(stored)
    if not team.reviewers:
        return _Round(0, 0)
    # The roles and the table as they stand now, read with the turn: someone whose role was taken,
    # or whose role the table no longer lets be chosen, is skipped.
    now = (market_from_document(stored) if stored else market).model_copy(
        update={"review_team": team})
    able = eligible(now, organization)
    able_ids = {person.user_id for person in able}
    may_own = set(PermissionsApi.people_with_market_role(now, organization))
    turn = team.turn
    settled = 0
    dealt: List[_Dealt] = []
    for doc in ApplicationsApi.arriving_in_arrival_order(market.id):
        state = ReviewState.state_of(doc)
        was = doc.get("reviewer") or None
        owner = doc.get("follow_up_owner") or None
        if not state.undecided:
            keep = True
        elif state is ReviewState.State.OPEN:
            keep = bool(was) and was.get("user_id") in able_ids
        else:
            keep = bool(owner) and owner.get("user_id") in may_own
        if keep:
            settled += ReviewState.settle_waiting(doc)
            continue
        if not able:
            continue
        to = able[turn % len(able)]
        if state is ReviewState.State.OPEN:
            if ReviewState.deal(doc["id"], to, was):
                dealt.append(_Dealt(doc, was, to))
                turn += 1
        elif ReviewState.deal_follow_up(doc["id"], to, owner):
            dealt.append(_Dealt(doc, was, to, follow_up=True, owner_was=owner))
            turn += 1
    if dealt and markets_collection.update_one(
            live({"id": market.id, _DEALING_BY: deal}), {"$set": {_TURN: turn}}).matched_count == 0:
        # Its lease lapsed and another deal holds the market: the applications are dealt, and the
        # next deal reads a turn that has not moved on, so one turn of fairness is lost.
        logger.warning(
            "A deal of waiting applications on market %s lost its hold before writing the turn; it "
            "dealt %d application(s), and the turn did not move on.", market.id, len(dealt))
    by_write: Dict[Tuple[Optional[str], str], List[_Dealt]] = {}
    for one in dealt:
        marked = one.doc.get(ApplicationsApi.ARRIVING_FIELD) or {}
        by_write.setdefault((marked.get("actor"), marked.get("action")), []).append(one)
    for (actor, action), deals in by_write.items():
        History.unasked(
            market.id, actor, action or History.APPLY, because=ARRIVALS_DEAL_UNASKED,
        ).record(
            kind=History.DEALT,
            vendors=[one.doc.get("applicant_email") for one in deals],
            subject={"application_ids": [one.doc["id"] for one in deals]},
            detail=lambda deals=deals: {
                "cause": ARRIVED,
                "before": {one.doc["id"]: one.before() for one in deals},
                "after": {one.doc["id"]: one.after() for one in deals},
            })
    return _Round(len(dealt), settled)


def _team_of_document(stored: Dict[str, Any]) -> ReviewTeam:
    return ReviewTeam(**convert_keys_to_snake_case(market_doc_field(stored, "review_team") or {}))


def _hold(market_id: str, deal: str, waits: int = 0) -> bool:
    """Hold the market for one deal: a lease on ``reviewTeam.dealing``, taken only while no other
    deal's stands, trying again ``waits`` times a short pause apart. A market that never had a team
    is given an empty one first, so the lease has somewhere to stand."""
    markets_collection.update_one(
        live({"id": market_id, market_doc_key("review_team"): {"$in": [None]}}),
        {"$set": {market_doc_key("review_team"): {"reviewers": [], "turn": 0}}})
    for attempt in range(waits + 1):
        now = datetime.now(timezone.utc)
        held = markets_collection.update_one(
            live({"id": market_id, "$nor": [{_DEALING_UNTIL: {"$gt": now.isoformat()}}]}),
            {"$set": {_DEALING: {"by": deal, "until": (now + DEALING_LEASE).isoformat()}}})
        if held.matched_count > 0:
            return True
        if attempt < waits:
            time.sleep(HOLD_PAUSE_SECONDS)
    return False


def _let_go(market_id: str, deal: str) -> None:
    markets_collection.update_one({"id": market_id, _DEALING_BY: deal}, {"$unset": {_DEALING: ""}})


def _organization(market: Market) -> Optional[Organization]:
    """The market's organization, whose people hold roles on it too; None when it has none."""
    if not market.organization_id:
        return None
    found = OrgsApi.get_organization(market.organization_id)
    if not found:
        return None
    try:
        return Organization(**{key: value for key, value in found.items() if key != "_id"})
    except Exception:
        logger.warning("Stored organization %s failed validation", market.organization_id)
        return None
