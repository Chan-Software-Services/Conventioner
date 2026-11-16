"""A run that drops a day drops the amount an Admin set for it, and the history says so (T335).

An Admin set what Ana owes for Sunday to $0, a waiver, while she held a Gold table that day. A run
that then left her without a Sunday table kept the $0 with no line to show it, so nobody could
see it or take it back ("That vendor holds no table that day"), and once she was seated on Sunday
again, at another table, the day owed $0 with the old Admin's name on it: a waiver given for a
seat she no longer held. The amount goes with the day the run drops (Daniel's choice, T335), and
the market's history records one entry naming the amount and who set it.

Sent through the routes, as the screen sends them.
"""
import pytest

from conftest import accounts_by_id, sessions_load_through_get_user, skip_without_real_dependencies

skip_without_real_dependencies()

import app as app_module  # noqa: E402
import api.users as UsersApi  # noqa: E402
from test_a_held_seat_wins_over_a_free import SATURDAY_ELSEWHERE, a_run_that_seats  # noqa: E402
from test_a_vendors_payments import ANA, MARKET, SAT, SUN, market, stores  # noqa: E402,F401
from test_changing_owed_and_paid import ADMIN, admin, holding  # noqa: E402,F401
from test_every_write_records import _account  # noqa: E402

OWED_DROPPED = "owed_dropped"


@pytest.fixture
def client(monkeypatch, admin):  # noqa: F811
    """The Admin, signed in."""
    monkeypatch.setattr(app_module.login_manager, "session_protection", None)
    monkeypatch.setattr(UsersApi, "get_user", _account)
    accounts_by_id(monkeypatch, lambda user_id: _account(f"{user_id[len('user-'):]}@example.com"))
    sessions_load_through_get_user(monkeypatch)
    client = app_module.app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = ADMIN
        session["_fresh"] = True
    return client


SUNDAY_OWED = f"/markets/{MARKET}/payments/{ANA}/owed/{SUN}"
NO_LINE = "That vendor holds no table that day, so nothing is owed for it."


def dropped_entries(stores):  # noqa: F811
    return [entry for entry in stores.history.documents if entry["kind"] == OWED_DROPPED]


class TestARunDropsTheAmountSetForADayItDrops:
    def test_the_waiver_goes_with_the_day_and_a_new_seat_owes_its_price(
            self, client, stores, market, monkeypatch):  # noqa: F811
        waived = client.put(SUNDAY_OWED, json={"cents": 0})
        assert waived.status_code == 200

        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)
        ran = client.post(f"/markets/{MARKET}/assignment")
        assert ran.status_code == 200
        kept_of_sunday = [doc for doc in stores.owed.documents if doc["date"] == SUN]
        dropped = dropped_entries(stores)

        taken_back = client.delete(SUNDAY_OWED)
        kept_after_the_delete = [doc for doc in stores.owed.documents if doc["date"] == SUN]

        seated = client.put(f"/markets/{MARKET}/placements", json={
            "email": ANA, "date": SUN, "tableCode": "Landing 1", "tableChoice": "Full Table"})
        assert seated.status_code == 200
        got = client.get(f"/markets/{MARKET}/payments/{ANA}")
        assert got.status_code == 200
        sunday = next(line for line in got.get_json()["lines"] if line["date"] == SUN)

        # Every step at once, so a failure shows each: the run left Ana without a Sunday table,
        # so nothing is kept of Sunday and one entry says the $0.00 went; with no line, "Use the
        # calculated price" is refused and writes nothing; and seated again on Sunday at a Silver
        # table, the day owes the Silver price, set by nobody.
        assert {
            "records kept of Sunday after the run": len(kept_of_sunday),
            "owed_dropped entries after the run": len(dropped),
            "the DELETE's status": taken_back.status_code,
            "records kept of Sunday after the DELETE": len(kept_after_the_delete),
            "the re-seated Sunday owes": sunday["owedCents"],
            "the re-seated Sunday was set by": sunday["owedSetBy"],
        } == {
            "records kept of Sunday after the run": 0,
            "owed_dropped entries after the run": 1,
            "the DELETE's status": 404,
            "records kept of Sunday after the DELETE": 0,
            "the re-seated Sunday owes": 3000,
            "the re-seated Sunday was set by": None,
        }

        [entry] = dropped
        assert (entry["action"], entry["actor"], entry["vendors"]) == ("assign", ADMIN, [ANA])
        assert entry["subject"] == {"date": SUN, "currency": "CAD", "set_by": ADMIN}
        assert entry["detail"] == {"before": {"owed_cents": 0}, "after": {"owed_cents": None}}
        assert taken_back.get_json()["error"] == NO_LINE
        assert (sunday["tableCode"], sunday["tier"], sunday["owedSetAt"], sunday["owedByFree"]) == (
            "Landing 1", "Silver", None, False)
        assert len(dropped_entries(stores)) == 1

    def test_a_day_the_run_keeps_keeps_its_amount(self, client, stores, market, monkeypatch):  # noqa: F811
        """Saturday stays Ana's, at another table: the $20.00 the Admin set holds, as a move's."""
        client.put(f"/markets/{MARKET}/payments/{ANA}/owed/{SAT}", json={"cents": 2000})
        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)

        client.post(f"/markets/{MARKET}/assignment")

        saturday = next(line for line in client.get(
            f"/markets/{MARKET}/payments/{ANA}").get_json()["lines"] if line["date"] == SAT)
        assert (saturday["tableCode"], saturday["owedCents"], saturday["owedSetBy"]) == (
            "Landing 2", 2000, ADMIN)
        assert dropped_entries(stores) == []

    def test_a_dropped_day_nobody_set_records_nothing(self, client, stores, market, monkeypatch):  # noqa: F811
        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)

        client.post(f"/markets/{MARKET}/assignment")

        assert stores.owed.documents == []
        assert dropped_entries(stores) == []


class TestAnAmountNeverStaysHiddenOnADayNotHeld:
    """An Admin's amount on a day not held is a line nobody sees; the owner never leaves one."""

    def test_an_amount_set_as_a_run_drops_the_day_is_refused(
            self, client, stores, market, monkeypatch):  # noqa: F811
        """The run lands its seats and its tidy of the owed days between the Admin's request's read
        of the market and its write of Sunday's amount: the amount would stand on a day no longer
        held, so the request is refused as one for a day with no line, and nothing is kept."""
        import api.placements as PlacementsApi
        import payments as Payments

        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)
        owner = Payments.owed_day_transition

        def a_run_lands_first(*args, **kwargs):
            if args[3] == Payments.OwedEvent.ADMIN_SETS:
                PlacementsApi.run_assignment(MARKET, ADMIN)
            return owner(*args, **kwargs)

        monkeypatch.setattr(Payments, "owed_day_transition", a_run_lands_first)

        waived = client.put(SUNDAY_OWED, json={"cents": 0})

        assert (waived.status_code, waived.get_json()["error"]) == (404, NO_LINE)
        assert [doc for doc in stores.owed.documents if doc["date"] == SUN] == []
        assert [entry["kind"] for entry in stores.history.documents
                if entry["kind"].startswith("owed_")] == []

    def test_an_amount_a_run_drops_after_it_was_set_is_answered_and_recorded_as_set(
            self, client, stores, market, monkeypatch):  # noqa: F811
        """The run lands its seats and its tidy between the owner's write of Sunday's amount and
        the request's second read of the assignment: the tidy dropped the amount and recorded the
        drop, naming it and the Admin, so the amount was set, and the history says it was, before
        it says the run dropped it."""
        import api.placements as PlacementsApi
        import payments as Payments

        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)
        owner = Payments.owed_day_transition

        def a_run_lands_after(*args, **kwargs):
            moved = owner(*args, **kwargs)
            if args[3] == Payments.OwedEvent.ADMIN_SETS:
                PlacementsApi.run_assignment(MARKET, ADMIN)
            return moved

        monkeypatch.setattr(Payments, "owed_day_transition", a_run_lands_after)

        waived = client.put(SUNDAY_OWED, json={"cents": 0})

        assert waived.status_code == 200
        assert [line["date"] for line in waived.get_json()["lines"]] == [SAT]
        assert [doc for doc in stores.owed.documents if doc["date"] == SUN] == []
        owed = sorted((entry for entry in stores.history.documents
                       if entry["kind"].startswith("owed_")), key=lambda entry: entry["at"])
        assert [(entry["kind"], entry["actor"]) for entry in owed] == [
            ("owed_set", ADMIN), (OWED_DROPPED, ADMIN)]
        assert owed[0]["at"] < owed[1]["at"]
        assert owed[0]["detail"]["after"] == {"owed_cents": 0}
        assert owed[1]["subject"]["set_by"] == ADMIN

    def test_seating_a_day_holding_a_hidden_amount_records_its_drop(
            self, client, stores, market, monkeypatch):  # noqa: F811
        """A record left holding an Admin's $0 on a day Ana holds no table (a release before this
        one, or a tidy that missed): seating her that day again drops it, and says so."""
        import payments as Payments

        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)
        assert client.post(f"/markets/{MARKET}/assignment").status_code == 200
        hidden = Payments.SetByHand(Payments.HandAmount(0, ADMIN, "2099-04-01T00:00:00+00:00"))
        stores.owed.insert_one({
            "market_id": MARKET, "vendor_email": ANA, "date": SUN,
            "state": hidden.to_stored(), **Payments.legacy_fields(hidden), "revision": 1})

        seated = client.put(f"/markets/{MARKET}/placements", json={
            "email": ANA, "date": SUN, "tableCode": "Landing 1", "tableChoice": "Full Table"})

        assert seated.status_code == 200
        assert [doc for doc in stores.owed.documents if doc["date"] == SUN] == []
        [entry] = dropped_entries(stores)
        assert (entry["action"], entry["actor"], entry["vendors"]) == ("assign", ADMIN, [ANA])
        assert entry["subject"] == {"date": SUN, "currency": "CAD", "set_by": ADMIN,
                                    "held_no_table": True}
        assert entry["detail"] == {"before": {"owed_cents": 0}, "after": {"owed_cents": None}}


class TestATidyThatMissesNeverFailsTheWrite:
    def test_it_is_logged_as_a_failure_a_route_goes_on_past(
            self, client, stores, market, monkeypatch, caplog):  # noqa: F811
        """The run's seats have landed, so a day whose record kept changing is logged once, as an
        error naming the market and the date, by its frames and never the vendor's address."""
        import logging

        import payments as Payments

        client.put(SUNDAY_OWED, json={"cents": 0})
        a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)

        def kept_changing(*args, **kwargs):
            raise Payments.OwedDayChanged()

        monkeypatch.setattr(Payments, "owed_day_transition", kept_changing)

        with caplog.at_level(logging.ERROR, logger="api.payments"):
            ran = client.post(f"/markets/{MARKET}/assignment")

        assert ran.status_code == 200
        [logged] = [record for record in caplog.records if record.name == "api.payments"]
        assert logged.levelno == logging.ERROR
        assert f"market {MARKET}, date {SUN}" in logged.getMessage()
        assert "OwedDayChanged" in logged.getMessage()
        assert ANA not in logged.getMessage()
        assert logged.exc_info is None
