"""A change records under the row it asked (T105-9).

Asking a row of the table (``Actions.ask``) answers whether the person may and, when they may,
is the one way to record the change under that row: the entry names the row the request was let
through on, never one passed by hand beside a check made elsewhere. A write loads its market and
asks its row in one call (``MarketsApi._market_change``), and the plan's rules ask the Assign row
only when they change (``Actions.ask_assign_if_the_rules_change``).

The records no request asked have their own door, ``History.unasked``, tested with the history.
That nothing else writes a market's history is held by
``test_only_an_asking_writes_a_markets_history.py``.
"""
import pytest

from conftest import COMPLETE_PLAN, FakeMarketsCollection, client_market, stored_market
from test_the_history import history  # noqa: F401 - the fixture
import api.applicants as ApplicantsApi
import api.market_actions as Actions
import api.markets as MarketsApi
import api.permissions as PermissionsApi
import application_status as ReviewState
import history as History
import review_team as ReviewTeam
from client_errors import BadRequestError, ForbiddenError
from datatypes import AssignmentOptionObject, MarketPerson, MarketPhase, MarketRole

ASKER = "dana@example.com"

#: Lowest first, as the table's roles reach.
LADDER = [None, MarketRole.VIEWER, MarketRole.EDITOR, MarketRole.ADMIN, MarketRole.OWNER]


@pytest.fixture
def holding(monkeypatch):
    """The asker holds this role on the market, resolved as every check resolves it."""
    def hold(role):
        monkeypatch.setattr(PermissionsApi, "get_user_market_role", lambda *_a, **_k: role)
    return hold


class TestAsking:
    def test_a_row_the_person_may_take_is_let_in_under_that_row(self, holding):
        holding(MarketRole.EDITOR)

        asked = Actions.ask(Actions.CHANGE_SETUP, ASKER, client_market(), None)

        assert asked.refused is None
        assert asked.row is Actions.CHANGE_SETUP
        assert asked.market_id == "market-123"
        assert asked.actor == ASKER

    def test_a_row_the_person_may_not_take_is_refused_in_its_words(self, holding):
        holding(MarketRole.VIEWER)

        asked = Actions.ask(Actions.CHANGE_SETUP, ASKER, client_market(), None)

        assert asked.refused == (
            "Only an Editor, an Admin or the owner may change this market's setup.")

    @pytest.mark.parametrize("role", LADDER, ids=lambda role: getattr(role, "value", "none"))
    @pytest.mark.parametrize("row", Actions.ACTIONS.values(), ids=lambda row: row.id)
    def test_it_answers_as_the_refusal_does(self, holding, row, role):
        """The reads and screens that only ask keep ``refusal``; the two never disagree."""
        holding(role)
        market = client_market()

        assert (Actions.ask(row, ASKER, market, None).refused
                == Actions.refusal(row, ASKER, market, None))

    def test_a_row_on_top_of_another_asks_that_one_first(self, holding):
        holding(MarketRole.VIEWER)

        asked = Actions.ask(Actions.CHANGE_VERDICTS, ASKER, client_market(), None)

        assert asked.refused == Actions.refusal_sentence(Actions.GIVE_VERDICTS)

    def test_it_asks_through_the_refusal(self, monkeypatch):
        """Every check a test stubs, and the write-records spy, reads ``Actions.refusal``."""
        rows = []
        monkeypatch.setattr(
            Actions, "refusal", lambda row, *_a: rows.append(row) or "Asked through the stub.")

        asked = Actions.ask(Actions.ASSIGN, ASKER, client_market(), None)

        assert rows == [Actions.ASSIGN]
        assert asked.refused == "Asked through the stub."


class TestRecordingWhatWasAsked:
    def test_the_entry_is_under_the_row_asked_by_the_person_who_asked(self, holding, history):
        holding(MarketRole.EDITOR)
        asked = Actions.ask(Actions.CHANGE_SETUP, ASKER, client_market(), None)

        asked.record(kind="renamed", vendors=["Ana@Example.com"], subject={"part": "name"},
                     detail={"before": {"name": "A"}, "after": {"name": "B"}})

        [entry] = history.docs
        assert entry["market_id"] == "market-123"
        assert entry["actor"] == ASKER
        assert entry["action"] == "change-setup"
        assert entry["kind"] == "renamed"
        assert entry["vendors"] == ["ana@example.com"]
        assert entry["subject"] == {"part": "name"}
        assert entry["detail"] == {"before": {"name": "A"}, "after": {"name": "B"}}

    def test_a_detail_is_built_as_the_history_builds_it(self, holding, history):
        holding(MarketRole.EDITOR)
        asked = Actions.ask(Actions.ASSIGN, ASKER, client_market(), None)

        asked.record(detail=lambda: None)
        asked.record(detail=lambda: {}["missing"])
        asked.record(subject=lambda: {"table": "A1"}, detail=lambda: {"freed": True})

        [entry] = history.docs
        assert entry["subject"] == {"table": "A1"}
        assert entry["detail"] == {"freed": True}

    def test_an_entry_given_when_its_change_landed_is_at_that_time(
            self, holding, history, monkeypatch):
        """As the history's writer takes it: an Admin's amount owed recorded after a write that
        dropped it is at the time the amount was set (T335)."""
        monkeypatch.setattr(History, "_now", lambda: "2099-04-02T10:00:00+00:00")
        holding(MarketRole.ADMIN)
        asked = Actions.ask(Actions.CHANGE_OWED, ASKER, client_market(), None)

        asked.record(detail={}, at="2099-04-02T09:59:59+00:00")
        asked.record(detail={})

        assert [entry["at"] for entry in history.docs] == [
            "2099-04-02T09:59:59+00:00", "2099-04-02T10:00:00+00:00"]

    def test_a_record_that_cannot_be_saved_is_swallowed(self, holding, monkeypatch):
        """The change has landed by the time it is recorded, as the history's writer holds."""

        class Broken:
            def insert_one(self, _doc):
                raise RuntimeError("mongo is having a day")

        monkeypatch.setattr(History, "history_collection", Broken())
        holding(MarketRole.EDITOR)

        Actions.ask(Actions.CHANGE_SETUP, ASKER, client_market(), None).record(detail={})

    def test_recording_a_refused_asking_is_a_programming_error(self, holding, history):
        holding(MarketRole.VIEWER)
        asked = Actions.ask(Actions.CHANGE_SETUP, ASKER, client_market(), None)

        with pytest.raises(Actions.RecordedARefusal) as raised:
            asked.record(detail={"after": {"name": "B"}})

        assert isinstance(raised.value, AssertionError)
        assert "change-setup" in str(raised.value)
        assert history.docs == []


@pytest.fixture
def stored(monkeypatch):
    """The markets collection, holding one market in the phase given."""
    def store(phase=MarketPhase.APPLICATIONS, **overrides):
        fake = FakeMarketsCollection(stored_market(phase, **overrides))
        monkeypatch.setattr(MarketsApi, "markets_collection", fake)
        return fake
    return store


class TestLoadingAMarketToChange:
    def test_it_holds_the_market_its_organization_and_the_asking(self, stored, holding):
        stored()
        holding(MarketRole.EDITOR)

        change = MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

        assert change.market.id == "market-123"
        assert change.organization is None
        assert change.asked.row is Actions.CHANGE_SETUP
        assert change.asked.refused is None
        assert change.asked.market_id == "market-123"
        assert change.asked.actor == ASKER

    def test_a_market_not_there_is_not_found(self, stored, holding):
        stored(**{"id": "another-market"})
        holding(MarketRole.OWNER)

        with pytest.raises(MarketsApi.MarketNotFoundError):
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

    def test_a_market_that_cannot_be_read_is_refused(self, stored, holding, monkeypatch):
        stored()
        holding(MarketRole.OWNER)

        def unreadable(_document):
            raise ValueError("not a market")

        monkeypatch.setattr(MarketsApi, "market_from_document", unreadable)

        with pytest.raises(BadRequestError, match="Invalid market data"):
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

    def test_a_person_the_row_refuses_is_refused_in_its_words(self, stored, holding):
        stored()
        holding(MarketRole.VIEWER)

        with pytest.raises(ForbiddenError) as refused:
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

        assert not isinstance(refused.value, MarketsApi.MarketArchivedError)
        assert str(refused.value) == Actions.refusal_sentence(Actions.CHANGE_SETUP)

    def test_an_archived_market_refuses_whoever_may(self, stored, holding):
        stored(MarketPhase.ARCHIVED)
        holding(MarketRole.OWNER)

        with pytest.raises(MarketsApi.MarketArchivedError) as refused:
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

        assert str(refused.value) == MarketsApi.ARCHIVED_REFUSAL

    def test_on_an_archived_market_the_row_is_asked_first(self, stored, holding):
        """As the loaders before it answered: who may not take the row is told so, archived or
        not."""
        stored(MarketPhase.ARCHIVED)
        holding(MarketRole.VIEWER)

        with pytest.raises(ForbiddenError) as refused:
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

        assert str(refused.value) == Actions.refusal_sentence(Actions.CHANGE_SETUP)


class TestTheRulesAskAssignWhenTheyChange:
    @pytest.fixture
    def market(self):
        return MarketsApi.market_from_document(
            stored_market(MarketPhase.DRAFT, setupObject=COMPLETE_PLAN))

    def _changed(self, market):
        return market.setup_object.model_copy(update={
            "assignment_options": AssignmentOptionObject(max_assignments_per_vendor=1)})

    def test_restating_the_rules_asks_nothing(self, market, monkeypatch):
        rows = []
        monkeypatch.setattr(Actions, "refusal", lambda row, *_a: rows.append(row))

        assert Actions.ask_assign_if_the_rules_change(
            market, market.setup_object, ASKER, None) is None
        assert rows == []

    def test_changing_them_returns_the_assign_asking(self, market, holding):
        holding(MarketRole.EDITOR)

        asked = Actions.ask_assign_if_the_rules_change(market, self._changed(market), ASKER, None)

        assert asked.row is Actions.ASSIGN
        assert asked.refused is None
        assert asked.market_id == market.id
        assert asked.actor == ASKER

    def test_changing_them_is_refused_to_who_may_not_assign(self, market, holding):
        holding(MarketRole.VIEWER)

        with pytest.raises(ForbiddenError) as refused:
            Actions.ask_assign_if_the_rules_change(market, self._changed(market), ASKER, None)

        assert str(refused.value) == Actions.refusal_sentence(Actions.ASSIGN)


class TestAMoveRecordsThroughItsCallersRecorder:
    @pytest.fixture
    def moving(self, monkeypatch):
        moved = []
        monkeypatch.setattr(MarketsApi, "evaluate_transition", lambda *_a, **_k: [])
        monkeypatch.setattr(MarketsApi, "apply_phase_transition",
                            lambda _document, to_phase, by=None: moved.append((to_phase, by)))
        return moved

    def _context(self):
        market = client_market(phase=MarketPhase.DRAFT)
        return MarketsApi.MarketContext(
            document={"id": market.id}, market=market, organization=None, organization_dict=None)

    def test_the_move_is_recorded_under_the_recorders_row_as_its_actor(self, moving, history):
        recorder = History.unasked("market-123", ASKER, Actions.MOVE_PHASE, because="a test's move")

        assert MarketsApi.take_move(
            self._context(), MarketPhase.APPLICATIONS.value, recorder) == []

        assert moving == [(MarketPhase.APPLICATIONS.value, ASKER)]
        [entry] = history.docs
        assert entry["action"] == Actions.MOVE_PHASE.id
        assert entry["actor"] == ASKER
        assert entry["detail"] == History.changes(
            {"phase": MarketPhase.DRAFT.value}, {"phase": MarketPhase.APPLICATIONS.value})

    def test_the_move_a_request_asked_is_recorded_through_that_asking(self, moving, history, holding):
        holding(MarketRole.OWNER)
        context = self._context()
        asked = Actions.ask(Actions.MOVE_PHASE, ASKER, context.market, None)
        assert asked.refused is None

        MarketsApi.take_move(context, MarketPhase.APPLICATIONS.value, asked)

        [entry] = history.docs
        assert (entry["action"], entry["actor"]) == (Actions.MOVE_PHASE.id, ASKER)


class _Seat:
    def __init__(self, email, table_code, table_choice="Full"):
        self.email, self.table_code, self.table_choice = email, table_code, table_choice
        self.date = "2026-08-01"


#: Each placement writer, given a recorder: what the history's placement entries are written by.
PLACEMENT_WRITERS = {
    "placed": lambda recorder: History.record_placed(recorder, _Seat("ana@example.com", "A 1")),
    "freed": lambda recorder: History.record_freed(
        recorder, "ana@example.com", "2026-08-01", "A 1"),
    "swapped": lambda recorder: History.record_swapped(
        recorder, "2026-08-01", _Seat("ana@example.com", "A 1"), _Seat("ben@example.com", "A 2")),
    "assigned": lambda recorder: History.record_assignment_run(recorder, 3, 1),
}


class TestThePlacementWritersRecordThroughTheirCallersAsking:
    @pytest.mark.parametrize("kind", PLACEMENT_WRITERS)
    def test_the_entry_is_under_the_assign_asking_as_its_person(self, kind, history):
        PLACEMENT_WRITERS[kind](Actions.Asked(Actions.ASSIGN, "market-123", ASKER, None))

        [entry] = history.docs
        assert (entry["market_id"], entry["actor"], entry["action"], entry["kind"]) == (
            "market-123", ASKER, Actions.ASSIGN.id, kind)

    @pytest.mark.parametrize("kind", PLACEMENT_WRITERS)
    def test_no_row_is_named_by_the_writer_itself(self, kind, history):
        """The row is the recorder's: a writer given another row's asking records under that one,
        so only the asking a change was let through on can name it."""
        PLACEMENT_WRITERS[kind](Actions.Asked(Actions.CHANGE_OWED, "market-123", ASKER, None))

        [entry] = history.docs
        assert entry["action"] == Actions.CHANGE_OWED.id

    @pytest.mark.parametrize("kind", PLACEMENT_WRITERS)
    def test_a_refused_asking_records_nothing(self, kind, history):
        with pytest.raises(Actions.RecordedARefusal):
            PLACEMENT_WRITERS[kind](
                Actions.Asked(Actions.ASSIGN, "market-123", ASKER, "Only an Admin may."))

        assert history.docs == []


def _reviewing(changing_refused=None):
    return ApplicantsApi.Reviewing(
        giving=Actions.Asked(Actions.GIVE_VERDICTS, "market-123", ASKER, None),
        changing=Actions.Asked(Actions.CHANGE_VERDICTS, "market-123", ASKER, changing_refused))


class TestAVerdictRecordsUnderTheRowItTook:
    """A reviewer's write asks two rows, giving a verdict and changing one already given, and its
    entry is recorded through the one it took: changing, when any application it wrote was
    decided (E38/F06/S01)."""

    @pytest.mark.parametrize("statuses, row", [
        (["open"], Actions.GIVE_VERDICTS),
        (["needs_follow_up"], Actions.GIVE_VERDICTS),
        (["reviewer_approved"], Actions.CHANGE_VERDICTS),
        (["open", "reviewer_rejected"], Actions.CHANGE_VERDICTS),
    ], ids=["open", "follow-up", "decided", "one-decided-among-them"])
    def test_the_asking_is_the_row_the_write_took(self, statuses, row):
        before = [{"status": status} for status in statuses]

        assert ApplicantsApi._verdict_asking(_reviewing(), before).row is row

    def test_a_reviewer_refused_the_change_row_still_gives_a_verdict(self):
        asked = ApplicantsApi._verdict_asking(
            _reviewing("Only an Admin may."), [{"status": "open"}])

        assert (asked.row, asked.refused) == (Actions.GIVE_VERDICTS, None)


class TestTheReviewTeamRecordsThroughWhatItIsGiven:
    def test_a_change_of_reviewers_records_under_the_asking_its_caller_gave(
            self, history, monkeypatch):
        doc = stored_market(MarketPhase.APPLICATIONS)
        monkeypatch.setattr(ReviewTeam, "markets_collection", FakeMarketsCollection(doc))
        market = ReviewTeam.market_from_document(doc)
        monkeypatch.setattr(ReviewTeam.ApplicationsApi, "undecided_in_arrival_order",
                            lambda *_a, **_k: [])
        monkeypatch.setattr(ReviewTeam.ApplicationsApi, "any_arriving", lambda *_a: False)
        monkeypatch.setattr(ReviewTeam, "eligible", lambda *_a: [])
        asked = Actions.Asked(Actions.CHOOSE_REVIEWERS, market.id, ASKER, None)

        ReviewTeam.choose(market, None, [MarketPerson(user_id="u-ben", email="ben@example.com")],
                          asked)

        assert [(entry["action"], entry["actor"], entry["kind"]) for entry in history.docs] == [
            (Actions.CHOOSE_REVIEWERS.id, ASKER, History.REVIEWERS)]

    def test_a_refused_asking_records_no_change_of_reviewers(self, history, monkeypatch):
        doc = stored_market(MarketPhase.APPLICATIONS)
        monkeypatch.setattr(ReviewTeam, "markets_collection", FakeMarketsCollection(doc))
        market = ReviewTeam.market_from_document(doc)
        monkeypatch.setattr(ReviewTeam.ApplicationsApi, "any_arriving", lambda *_a: False)

        with pytest.raises(Actions.RecordedARefusal):
            ReviewTeam.choose(
                market, None, [MarketPerson(user_id="u-ben", email="ben@example.com")],
                Actions.Asked(Actions.CHOOSE_REVIEWERS, market.id, ASKER, "Only an Admin may."))

        assert history.docs == []

    def test_an_arrival_is_marked_under_the_asking_its_write_gave(self):
        """A move into open stores its arrival as ``arriving``, which the deal records under: the
        row and the person its write was let through on, never ones it names itself."""
        asked = Actions.Asked(Actions.UPDATE_VENDOR_INFO, "market-1", ASKER, None)

        assert ReviewState.Arrival.of(asked).stored() == {
            "actor": ASKER, "action": Actions.UPDATE_VENDOR_INFO.id}

    def test_a_refused_asking_marks_no_arrival(self):
        with pytest.raises(Actions.RecordedARefusal):
            ReviewState.Arrival.of(
                Actions.Asked(Actions.CHANGE_FORM, "market-1", ASKER, "Only an Admin may."))
