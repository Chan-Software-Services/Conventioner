"""A change of reviewers and an arrival are dealt right in every order (E38/F07, ADR 0020).

Four rounds of review each found one more order of a change of reviewers against an arrival that
dealt an application twice or skipped a reviewer. Every deal now holds the market while it reads and
writes the turn, so the orders are not picked by hand here: each test lands the other deal before
every step, every read and write of the markets and applications, that the first one takes, and
checks after each that the shares are even, the turn is where the next arrival expects it, nothing
is left waiting or held, and no open application sits outside every share while an able reviewer
exists.

A return to open (an undo, a rule's return, a re-import's back to review) is a move into open like
an arrival, marked for the deal in its own write (T277 ticket 02, its ticket 03): it lands at every
step of a change of reviewers that removes the reviewer it was dealt to, and the change at every
step of it.
"""
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

from test_choosing_reviewers_deals_the_open_applications import (  # noqa: F401  (the fixture)
    ADMIN, ANA, BEN, CAT, MARKET, OPEN, _application, _choose, world,
)

import api.applications as ApplicationsApi
import api.markets as MarketsApi
import application_status as ReviewState
import history as History
import review_team as ReviewTeam
from datatypes import VerdictGiver


class Clock:
    """Counts the steps a deal takes, every call on a collection, and before the one it was set
    to land at runs the other deal once. The other deal's own steps are not counted."""

    def __init__(self, land_at, then):
        self.steps = 0
        self.land_at = land_at
        self.then = then
        self.landed = False
        self.inside = False

    def tick(self):
        if self.inside or self.landed:
            return
        self.steps += 1
        if self.steps == self.land_at:
            self.landed = True
            self.inside = True
            try:
                self.then()
            finally:
                self.inside = False


class Counted:
    """A collection whose every call is a step on the clock, one call at a time across threads."""

    lock = threading.RLock()

    def __init__(self, inner, clock):
        self.inner = inner
        self.clock = clock

    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if not callable(attr):
            return attr

        def step(*args, **kwargs):
            self.clock.tick()
            with Counted.lock:
                return attr(*args, **kwargs)
        return step


def _market(world):
    """The market as stored now. Every read and write of the world here is a collection's own
    call, so the same cases run over the real collections (``real_mongo/``)."""
    return world.markets.find_one({"id": MARKET})


def _dealt_seven(world):
    """Ana, Ben and Cat chosen over the seven open applications: 3, 2 and 2, the turn at 7."""
    world.market()
    world.applications.delete_many({})
    for v in OPEN:
        world.applications.insert_one(_application(v, int(v[1:])))
    world.history.delete_many({})
    assert _choose([ANA, BEN, CAT]).status_code == 200


def _held_by(world, deal, until):
    """Another deal's lease on the market, as ``_hold`` stores one."""
    world.markets.update_one(
        {"id": MARKET}, {"$set": {"reviewTeam.dealing": {"by": deal, "until": until}}})


def _arrive(world, name, day):
    """An application arrives open and marked for the deal, and is dealt, as an applicant's save
    stores it and deals it."""
    world.applications.insert_one(_application(
        name, day, arriving={"actor": f"{name}@vendor.test", "action": History.APPLY}))
    ReviewTeam.deal_arrivals(MarketsApi.market_from_document(_market(world)))


@contextmanager
def _counting(world, clock):
    """Every call on the markets and the applications a step on ``clock``, while it lasts."""
    places = [(ReviewTeam, "markets_collection", world.markets),
              (MarketsApi, "markets_collection", world.markets),
              (ApplicationsApi, "applications_collection", world.applications)]
    was = [getattr(module, name) for module, name, _inner in places]
    for module, name, inner in places:
        setattr(module, name, Counted(inner, clock))
    try:
        yield clock
    finally:
        for (module, name, _inner), before in zip(places, was):
            setattr(module, name, before)


def _steps_of(world, run):
    """How many steps ``run`` takes, counted on a market dealt seven."""
    _dealt_seven(world)
    with _counting(world, Clock(land_at=None, then=None)) as clock:
        run()
    return clock.steps


def _reviewer_of(world):
    return {doc["id"][len("app-"):]: (doc.get("reviewer") or {}).get("email")
            for doc in world.applications.find({})}


def _nothing_held(world):
    assert "dealing" not in (_market(world).get("reviewTeam") or {})


def _no_open_outside_every_share(world):
    """While a chosen reviewer may review, every open application is in an able reviewer's share,
    and nothing waits for the deal: no application is left for nobody."""
    market = MarketsApi.market_from_document(_market(world))
    able = {person.email for person in ReviewTeam.eligible(market, None)}
    if not able:
        return
    for doc in world.applications.find({}):
        if ReviewState.state_of(doc) is ReviewState.State.OPEN:
            assert (doc.get("reviewer") or {}).get("email") in able, doc["id"]
        assert not doc.get(ApplicationsApi.ARRIVING_FIELD), doc["id"]


def _nothing_left_waiting_or_held(world):
    assert not any(doc.get(ApplicationsApi.ARRIVING_FIELD) for doc in world.applications.find({}))
    _nothing_held(world)
    _no_open_outside_every_share(world)


def _first_come_first_served(world, land_at):
    """With no reviewers chosen: nothing held, nobody dealt anything; an arrival may wait for the
    deal a choice of reviewers makes."""
    _nothing_held(world)
    assert set(_reviewer_of(world).values()) == {None}, land_at
    assert _market(world)["reviewTeam"]["reviewers"] == []


def _assert_even_and_next(world, names, team, turn):
    """Each of ``names`` dealt to ``team``, as evenly as round robin deals, the turn at ``turn``,
    and the next arrival to the reviewer that turn names: nobody skipped."""
    dealt = _reviewer_of(world)
    counts = {person: [dealt[n] for n in names].count(person) for person in team}
    assert sorted(counts.values(), reverse=True) == [
        len(names) // len(team) + (1 if i < len(names) % len(team) else 0)
        for i in range(len(team))], dealt
    assert _market(world)["reviewTeam"]["turn"] == turn
    _arrive(world, "next", 40)
    assert _reviewer_of(world)["next"] == team[turn % len(team)]
    assert _market(world)["reviewTeam"]["turn"] == turn + 1


def _last_deal_of(world, name):
    return [e for e in world.history.find({}) if e["kind"] == History.DEALT
            and f"app-{name}" in e["subject"]["application_ids"]][-1]


class TestAnArrivalAtEveryStepOfAChange:
    def _land_at_each_step(self, world, team, check):
        change = lambda: _choose(team)  # noqa: E731
        steps = _steps_of(world, change)
        assert steps > 5
        for land_at in range(1, steps + 2):
            _dealt_seven(world)
            with _counting(world, Clock(land_at, lambda: _arrive(world, "x", 21))):
                assert change().status_code == 200
            if land_at == steps + 1:
                _arrive(world, "x", 21)
            check(world, land_at)

    def test_a_new_team_deals_it_evenly_and_skips_no_one(self, world):
        def check(world, land_at):
            _nothing_left_waiting_or_held(world)
            assert _reviewer_of(world)["x"] == _last_deal_of(world, "x")["detail"]["after"][
                "app-x"]["reviewer"], land_at
            _assert_even_and_next(world, [*OPEN, "x"], [BEN, CAT], turn=8)

        self._land_at_each_step(world, [BEN, CAT], check)

    def test_no_team_leaves_it_first_come_first_served(self, world):
        self._land_at_each_step(world, [], _first_come_first_served)


class TestAChangeAtEveryStepOfAnArrival:
    """The orders notes 10, 13 and 14 found: a change landing as an arrival takes its turn, and
    after. The change waits for the arrival to let go of the market, so it runs on a thread of its
    own, as a second request would."""

    @pytest.mark.parametrize("team", [[BEN, CAT], []], ids=["a new team", "no team"])
    def test_the_change_deals_after_the_arrival_and_skips_no_one(self, world, monkeypatch, team):
        monkeypatch.setattr(ReviewTeam, "HOLD_PAUSE_SECONDS", 0.001)
        arrival = lambda: _arrive(world, "x", 21)  # noqa: E731
        steps = _steps_of(world, arrival)
        assert steps > 3
        for land_at in range(1, steps + 1):
            _dealt_seven(world)
            answers = []
            change = threading.Thread(target=lambda: answers.append(_choose(team)))
            with _counting(world, Clock(land_at, change.start)):
                arrival()
                change.join(timeout=10)
            assert [a.status_code for a in answers] == [200], land_at
            if team:
                _nothing_left_waiting_or_held(world)
                _assert_even_and_next(world, [*OPEN, "x"], team, turn=8)
            else:
                _first_come_first_served(world, land_at)


class TestTwoArrivalsAtOnce:
    def test_at_every_step_of_one_the_other_takes_the_next_turn(self, world):
        arrival = lambda: _arrive(world, "x", 21)  # noqa: E731
        steps = _steps_of(world, arrival)
        for land_at in range(1, steps + 1):
            _dealt_seven(world)
            with _counting(world, Clock(land_at, lambda: _arrive(world, "y", 22))):
                arrival()
            _nothing_left_waiting_or_held(world)
            dealt = _reviewer_of(world)
            # Ana, Ben, Cat, Ana, Ben, Cat, Ana: the eighth and ninth are Ben's and Cat's.
            assert sorted([dealt["x"], dealt["y"]]) == [BEN, CAT], land_at
            _assert_even_and_next(world, [*OPEN, "x", "y"], [ANA, BEN, CAT], turn=9)


class TestTheMarketsHold:
    def test_one_left_by_a_deal_that_stopped_lets_the_next_in(self, world):
        _dealt_seven(world)
        _held_by(world, "a-deal-that-stopped", "2026-01-01T00:00:00+00:00")

        _arrive(world, "x", 21)

        assert _reviewer_of(world)["x"] == BEN
        _nothing_left_waiting_or_held(world)

    def test_while_another_deal_holds_it_a_change_is_refused_in_words(self, world, monkeypatch):
        _dealt_seven(world)
        monkeypatch.setattr(ReviewTeam, "CHOICE_WAITS", 0)
        _held_by(world, "another", "2999-01-01T00:00:00+00:00")

        response = _choose([BEN, CAT])

        assert response.status_code == 409
        assert response.get_json()["error"] == ReviewTeam.DEALING_BUSY

    def test_an_arrival_that_finds_it_held_waits_for_whoever_holds_it_next(self, world):
        _dealt_seven(world)
        _held_by(world, "another", "2999-01-01T00:00:00+00:00")
        _arrive(world, "x", 21)
        assert _reviewer_of(world)["x"] is None

        world.markets.update_one({"id": MARKET}, {"$unset": {"reviewTeam.dealing": ""}})
        _arrive(world, "y", 22)

        dealt = _reviewer_of(world)
        assert (dealt["x"], dealt["y"]) == (BEN, CAT)
        _nothing_left_waiting_or_held(world)


class TestEveryLetGoLooksAgain:
    """An arrival that finds the market held leaves its application to the holder, so whoever lets
    go of the market looks again: however long a burst runs, and when the holding deal fails."""

    def test_a_burst_of_arrivals_each_landing_while_the_last_is_dealt_is_all_dealt(
            self, world, monkeypatch):
        _dealt_seven(world)
        real = ReviewState.deal
        burst = [f"b{n}" for n in range(12)]
        landed = []

        def another_lands_as_each_is_dealt(app_id, reviewer, was):
            if len(landed) < len(burst):
                landed.append(burst[len(landed)])
                _arrive(world, landed[-1], 22 + len(landed))
            return real(app_id, reviewer, was)

        monkeypatch.setattr(ReviewState, "deal", another_lands_as_each_is_dealt)
        _arrive(world, "x", 21)
        monkeypatch.setattr(ReviewState, "deal", real)

        assert landed == burst
        _nothing_left_waiting_or_held(world)
        _assert_even_and_next(world, [*OPEN, "x", *burst], [ANA, BEN, CAT], turn=20)

    def test_a_change_that_fails_holding_the_market_still_deals_what_arrived_meanwhile(
            self, world, monkeypatch):
        _dealt_seven(world)
        real = ReviewState.deal
        failed = []

        def an_arrival_lands_then_the_change_fails(app_id, reviewer, was):
            if failed:
                return real(app_id, reviewer, was)
            failed.append(True)
            _arrive(world, "x", 21)
            raise RuntimeError("the database went away")

        monkeypatch.setattr(ReviewState, "deal", an_arrival_lands_then_the_change_fails)
        with pytest.raises(RuntimeError):
            ReviewTeam.choose(MarketsApi.market_from_document(_market(world)), None,
                              [person for person in ReviewTeam.team_of(
                                  MarketsApi.market_from_document(_market(world))).reviewers
                               if person.email != ANA], ANA)
        monkeypatch.setattr(ReviewState, "deal", real)

        # The change stays unfinished, its pool still Ana's, until the same choice again finishes
        # it (``test_a_retried_change_of_reviewers_finishes_its_deal.py``); what arrived meanwhile
        # was dealt.
        assert not any(doc.get(ApplicationsApi.ARRIVING_FIELD)
                       for doc in world.applications.find({}))
        _nothing_held(world)
        assert _reviewer_of(world)["x"] is not None

    def test_a_deal_of_arrivals_that_fails_looks_again_before_its_error_goes_on(
            self, world, monkeypatch):
        _dealt_seven(world)
        real = ReviewState.deal
        failed = []

        def y_lands_then_the_deal_of_x_fails(app_id, reviewer, was):
            if app_id == "app-x" and not failed:
                failed.append(True)
                _arrive(world, "y", 22)
                raise RuntimeError("the database went away")
            return real(app_id, reviewer, was)

        monkeypatch.setattr(ReviewState, "deal", y_lands_then_the_deal_of_x_fails)
        with pytest.raises(RuntimeError):
            _arrive(world, "x", 21)
        monkeypatch.setattr(ReviewState, "deal", real)

        # Looking again dealt both: x, still waiting, then y.
        dealt = _reviewer_of(world)
        assert (dealt["x"], dealt["y"]) == (BEN, CAT)
        _nothing_left_waiting_or_held(world)


# --- A return to open, against a change of reviewers ----------------------------------------------

ANA_GIVER = VerdictGiver(kind="person", user_id="user-ana", email=ANA)
#: ``r`` arrived after the seven and before any arrival here, so the deal reads it in that place.
RETURNED_DAY = 20


def _decided_by_ana(world, how):
    """The seven dealt, then ``r``, dealt to Ana, decided as ``how`` returns it from: Ana's own
    approval a moment ago, kept what it found for her undo; a rule's rejection; or an approval of
    answers a re-import then changes."""
    _dealt_seven(world)
    now = datetime.now(timezone.utc).isoformat()
    ana = {"user_id": "user-ana", "email": ANA}
    verdict = {
        "undo": {"status": "reviewer_approved", "verdict_by": ANA_GIVER.model_dump(),
                 "undo_to": {"status": "open", "verdict_by": None, "verdict_at": None,
                             "follow_up_owner": None}},
        "rule": {"status": "reviewer_rejected", "verdict_reason": "Answered no",
                 "verdict_by": {"kind": "rule", "rule": "affiliation", "user_id": None,
                                "email": None}},
        "re-import": {"status": "reviewer_approved", "verdict_by": ANA_GIVER.model_dump()},
    }[how]
    world.applications.insert_one(_application(
        "r", RETURNED_DAY, reviewer=ana, **{**verdict, "verdict_at": now}))


def _return(world, how):
    """``r`` returns to open, as its write does: read, moved held on what was read and marked for
    the deal by the write it came by, then dealt."""
    read = ApplicationsApi.find_application_by_id("app-r")
    if how == "undo":
        written = ReviewState.undo(
            read, {"status": read["status"], "verdict_at": read["verdict_at"]}, ANA_GIVER,
            ReviewState.Arrival(ANA, "give-verdicts"))
    elif how == "rule":
        written = ReviewState.rule_returns(read, ReviewState.Arrival(ADMIN, "change-form"))
    else:
        written = ReviewState.answers_changed(
            read, ReviewState.Source.IMPORT,
            {"form_data": {"changed": True},
             "updated_at": datetime.now(timezone.utc).isoformat()},
            ReviewState.Arrival(ADMIN, "import-applications"))
    assert written
    ReviewTeam.deal_arrivals(MarketsApi.market_from_document(_market(world)))


RETURNS = ["undo", "rule", "re-import"]


def _returned_and_dealt_to_the_team_left(world, land_at):
    """``r`` is open, dealt with the seven between Ben and Cat as evenly as round robin deals,
    nothing waits or is held, and the next arrival takes the turn after the eighth."""
    doc = world.applications.find_one({"id": "app-r"})
    assert ReviewState.state_of(doc) is ReviewState.State.OPEN, land_at
    _nothing_left_waiting_or_held(world)
    _assert_even_and_next(world, [*OPEN, "r"], [BEN, CAT], turn=8)
    _no_open_outside_every_share(world)


class TestAReturnAtEveryStepOfAChange:
    """Ana is removed while an application dealt to her returns to open: the return lands before
    every step the change takes, and after its last."""

    @pytest.mark.parametrize("how", RETURNS)
    def test_it_is_dealt_to_a_reviewer_still_chosen(self, world, how):
        change = lambda: _choose([BEN, CAT])  # noqa: E731
        _decided_by_ana(world, how)
        with _counting(world, Clock(land_at=None, then=None)) as counted:
            assert change().status_code == 200
        steps = counted.steps
        assert steps > 5
        for land_at in range(1, steps + 2):
            _decided_by_ana(world, how)
            with _counting(world, Clock(land_at, lambda: _return(world, how))):
                assert change().status_code == 200
            if land_at == steps + 1:
                _return(world, how)
            _returned_and_dealt_to_the_team_left(world, land_at)


class TestAChangeAtEveryStepOfAReturn:
    """The change lands before every step a return takes. It waits for the return's deal to let
    go of the market, so it runs on a thread of its own, as a second request would."""

    @pytest.mark.parametrize("how", RETURNS)
    def test_the_return_is_dealt_to_a_reviewer_still_chosen(self, world, monkeypatch, how):
        monkeypatch.setattr(ReviewTeam, "HOLD_PAUSE_SECONDS", 0.001)
        _decided_by_ana(world, how)
        with _counting(world, Clock(land_at=None, then=None)) as counted:
            _return(world, how)
        steps = counted.steps
        assert steps > 3
        for land_at in range(1, steps + 1):
            _decided_by_ana(world, how)
            answers = []
            change = threading.Thread(target=lambda: answers.append(_choose([BEN, CAT])))
            with _counting(world, Clock(land_at, change.start)):
                _return(world, how)
                change.join(timeout=10)
            assert [a.status_code for a in answers] == [200], land_at
            _returned_and_dealt_to_the_team_left(world, land_at)
