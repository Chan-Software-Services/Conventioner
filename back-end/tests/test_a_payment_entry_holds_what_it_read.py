"""A payment entry's edit and removal land only on the entry as the server read it (T335).

Each reads the entry, judges it standing, and writes. A write that lands on whatever is stored by
then blurs what the entry's own history (``changes``) says it read before, when two Admins edit
one entry at once, and an edit could land on an entry removed a moment earlier. Each write now
holds the entry as read: standing, with the same number of ``changes``; otherwise it is refused
with a 409 saying the entry changed or was removed, carrying the account as it stands, which the
dialog shows behind its refusal, and no history entry is recorded for it.

The other write is landed between the request's read and its write, through the routes.
"""
import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import api.payments as PaymentsApi  # noqa: E402
import history as History  # noqa: E402
import payments as Payments  # noqa: E402
from real_mongo import harness  # noqa: E402
from test_a_vendors_payments import ANA, MARKET, market, stores  # noqa: E402,F401
from test_an_owed_day_has_one_state import client  # noqa: E402,F401
from test_changing_owed_and_paid import ADMIN, admin, holding  # noqa: E402,F401

OTHER_ADMIN = "other-admin@example.com"
EDITED = {"cents": 3500, "method": "cash", "paidOn": "2099-04-01", "note": "Miscounted"}
OTHER_EDIT = {"cents": 2500, "method": "e-transfer", "paidOn": "2099-04-02", "note": "Partly"}

EDIT_OF_A_CHANGED = ("This {kind} changed while your change was being saved, so it was not "
                     "saved. It now reads as shown behind this: close this and edit it again if "
                     "it should still change.")
EDIT_OF_A_REMOVED = ("This {kind} was removed while your change was being saved, so it was not "
                     "saved.")
REMOVAL_OF_A_CHANGED = ("This {kind} changed while it was being removed, so it was not removed. "
                        "It now reads as shown behind this: close this and remove it again if it "
                        "should still go.")
REMOVAL_OF_A_REMOVED = "This {kind} was already removed."


def entry_path(entry_id):
    return f"/markets/{MARKET}/payment-entries/{entry_id}"


def recorded(kind):
    record = PaymentsApi.record_payment if kind == Payments.PAYMENT else PaymentsApi.record_refund
    return record(MARKET, ANA, {"cents": 3000, "method": "cash", "paidOn": "2099-04-01"},
                  ADMIN)["payments"][0]


def edit(entry_id, by=ADMIN, body=None):
    return PaymentsApi.edit_payment(MARKET, entry_id, body or EDITED, by)


def remove(entry_id, by=ADMIN):
    return PaymentsApi.remove_payment(MARKET, entry_id, by)


def adjustments(stores):  # noqa: F811
    return [entry for entry in stores.history.documents if entry["action"] == "adjust-paid"]


#: The four meetings: the request's write, and the other Admin's that lands under it.
MEETINGS = {
    "an edit meeting an edit": (
        lambda client, entry_id: client.put(entry_path(entry_id), json=EDITED),
        lambda entry_id: edit(entry_id, OTHER_ADMIN, OTHER_EDIT), EDIT_OF_A_CHANGED),
    "an edit meeting a removal": (
        lambda client, entry_id: client.put(entry_path(entry_id), json=EDITED),
        lambda entry_id: remove(entry_id, OTHER_ADMIN), EDIT_OF_A_REMOVED),
    "a removal meeting an edit": (
        lambda client, entry_id: client.delete(entry_path(entry_id)),
        lambda entry_id: edit(entry_id, OTHER_ADMIN, OTHER_EDIT), REMOVAL_OF_A_CHANGED),
    "a removal meeting a removal": (
        lambda client, entry_id: client.delete(entry_path(entry_id)),
        lambda entry_id: remove(entry_id, OTHER_ADMIN), REMOVAL_OF_A_REMOVED),
}


class TestAWriteMeetingAnotherIsRefused:
    @pytest.mark.parametrize("kind", [Payments.PAYMENT, Payments.REFUND])
    @pytest.mark.parametrize("meeting", list(MEETINGS))
    def test_it_answers_409_with_the_account_as_it_stands_and_records_nothing(
            self, client, stores, monkeypatch, meeting, kind):  # noqa: F811
        send, other, sentence = MEETINGS[meeting]
        entry = recorded(kind)
        # The request reads the entry, then the other Admin's write lands, then the request writes.
        harness.interleave(monkeypatch, "payments.payment", lambda: other(entry["id"]))
        before = len(adjustments(stores))

        answered = send(client, entry["id"])

        assert answered.status_code == 409, answered.get_json()
        body = answered.get_json()
        assert body["error"] == sentence.format(kind=kind)
        assert body["account"] == PaymentsApi.vendor_account(MARKET, ANA, ADMIN)
        # Only the other Admin's write is in the history, and in the entry's own.
        assert len(adjustments(stores)) == before + 1
        [stored] = stores.payments.documents
        assert [(change["by"], change["what"]) for change in stored["changes"]] == [
            (OTHER_ADMIN, "removed" if "meeting a removal" in meeting else "edited")]
        assert stored["changes"][0]["before"]["cents"] == entry["cents"]

    def test_the_account_behind_an_edit_refused_shows_the_other_admins_edit(
            self, client, stores, monkeypatch):  # noqa: F811
        entry = recorded(Payments.PAYMENT)
        harness.interleave(monkeypatch, "payments.payment",
                           lambda: edit(entry["id"], OTHER_ADMIN, OTHER_EDIT))

        answered = client.put(entry_path(entry["id"]), json=EDITED)

        [shown] = answered.get_json()["account"]["payments"]
        assert (shown["cents"], shown["note"], shown["editedBy"]) == (2500, "Partly", OTHER_ADMIN)
        assert answered.get_json()["account"]["paidCents"] == 2500


class TestAWriteMeetingNothingLands:
    def test_each_landed_write_keeps_one_line_of_what_it_read(self, admin, stores):  # noqa: F811
        entry = recorded(Payments.PAYMENT)

        edit(entry["id"])
        edit(entry["id"], OTHER_ADMIN, OTHER_EDIT)
        remove(entry["id"])

        [stored] = stores.payments.documents
        assert [(change["by"], change["what"], change["before"]["cents"])
                for change in stored["changes"]] == [
            (ADMIN, "edited", 3000), (OTHER_ADMIN, "edited", 3500), (ADMIN, "removed", 2500)]
        assert [(entry["kind"], entry["detail"]["before"].get("cents"))
                for entry in adjustments(stores)] == [
            (History.PAYMENT_EDITED, 3000), (History.PAYMENT_EDITED, 3500),
            (History.PAYMENT_REMOVED, 2500)]

    def test_the_history_records_the_entry_the_write_held(self, admin, stores):  # noqa: F811
        """The history's before and the entry's own are the one read the write held."""
        entry = recorded(Payments.PAYMENT)

        edit(entry["id"])

        [stored] = stores.payments.documents
        [entry_recorded] = adjustments(stores)
        assert entry_recorded["detail"]["before"]["cents"] == stored["changes"][0]["before"][
            "cents"] == 3000
        assert entry_recorded["detail"]["after"]["cents"] == stored["cents"] == 3500


class TestTheHeldFilter:
    """The write's filter, read on its own: the entry standing, with the changes it read."""

    @pytest.mark.parametrize("changes, held", [
        (None, {"$or": [{"changes": {"$exists": False}}, {"changes": {"$size": 0}}]}),
        ([], {"$or": [{"changes": {"$exists": False}}, {"changes": {"$size": 0}}]}),
        ([{"what": "edited"}, {"what": "edited"}], {"changes": {"$size": 2}}),
    ], ids=["none recorded", "an empty list", "two"])
    def test_it_holds_the_id_the_entry_standing_and_the_number_of_changes(self, changes, held):
        read = {"market_id": MARKET, "id": "entry-1", "cents": 3000}
        if changes is not None:
            read["changes"] = changes

        assert Payments.entry_as_read(read) == {
            "market_id": MARKET, "id": "entry-1", "removed_at": None, **held}

    def test_a_changed_or_removed_entry_raises_saying_which(self, admin, stores):  # noqa: F811
        entry = recorded(Payments.PAYMENT)
        read = Payments.payment(MARKET, entry["id"])
        Payments.edit_payment(MARKET, read, Payments.PaymentEntry(
            cents=1, method="cash", paid_on="2099-04-01"), OTHER_ADMIN)

        with pytest.raises(Payments.EntryChanged) as changed:
            Payments.remove_payment(MARKET, read, ADMIN)
        assert changed.value.removed is False

        Payments.remove_payment(MARKET, Payments.payment(MARKET, entry["id"]), OTHER_ADMIN)
        with pytest.raises(Payments.EntryChanged) as removed:
            Payments.edit_payment(MARKET, read, Payments.PaymentEntry(
                cents=2, method="cash", paid_on="2099-04-01"), ADMIN)
        assert removed.value.removed is True
