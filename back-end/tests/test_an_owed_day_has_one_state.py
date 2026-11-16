"""A run that drops a day drops the amount an Admin set for it, and the history says so (T335).

An Admin set what Ana owes for Sunday to $0, a waiver, while she held a Gold table that day. A run
that then left her without a Sunday table kept the $0 with no line to show it, so nobody could
see it or take it back ("That vendor holds no table that day"), and once she was seated on Sunday
again, at another table, the day owed $0 with the old Admin's name on it: a waiver given for a
seat she no longer held. The amount goes with the day the run drops (Daniel's decision 9.3), and
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
