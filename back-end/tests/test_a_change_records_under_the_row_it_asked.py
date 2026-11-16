"""A change records under the row it asked (T105-9).

Asking a row of the table (``Actions.ask``) answers whether the person may and, when they may,
is the one way to record the change under that row: the entry names the row the request was let
through on, never one passed by hand beside a check made elsewhere. A write loads its market and
asks its row in one call (``MarketsApi._market_change``), and the plan's rules ask the Assign row
only when they change (``Actions.ask_assign_if_the_rules_change``).

The records no request asked have their own door, ``History.unasked``, tested with the history.
"""
import pytest

from conftest import COMPLETE_PLAN, FakeMarketsCollection, client_market, stored_market
from test_the_history import history  # noqa: F401 - the fixture
import api.market_actions as Actions
import api.markets as MarketsApi
import api.permissions as PermissionsApi
from client_errors import BadRequestError, ForbiddenError
from datatypes import AssignmentOptionObject, MarketPhase, MarketRole

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

    def test_a_record_that_cannot_be_saved_is_swallowed(self, holding, monkeypatch):
        """The change has landed by the time it is recorded, as ``History.record`` holds."""
        import history as History

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
        """As the old loaders answered: who may not take the row is told so, archived or not."""
        stored(MarketPhase.ARCHIVED)
        holding(MarketRole.VIEWER)

        with pytest.raises(ForbiddenError) as refused:
            MarketsApi._market_change("market-123", ASKER, Actions.CHANGE_SETUP)

        assert str(refused.value) == Actions.refusal_sentence(Actions.CHANGE_SETUP)

    @pytest.mark.parametrize("loader", [
        MarketsApi._load_market_to_change, MarketsApi._load_market_and_organization_to_change,
    ], ids=lambda loader: loader.__name__)
    def test_the_old_loaders_load_through_it(self, monkeypatch, loader):
        market, organization = client_market(), object()
        calls = []

        def change(*args):
            calls.append(args)
            return MarketsApi.MarketChange(market, organization, None)

        monkeypatch.setattr(MarketsApi, "_market_change", change)

        loaded = loader("market-123", ASKER, Actions.CHANGE_FORM)

        assert calls == [("market-123", ASKER, Actions.CHANGE_FORM)]
        if loader is MarketsApi._load_market_to_change:
            assert loaded is market
        else:
            assert loaded == MarketsApi.LoadedMarket(market, organization)


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
