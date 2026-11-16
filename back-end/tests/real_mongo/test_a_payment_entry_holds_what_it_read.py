"""Two edits of one payment entry at once, on a real server with real threads (T335).

Each edit reads the entry, then writes holding it as read: standing, with as many lines in its own
history (``changes``) as it read. The hermetic suite lands the other write between the read and
the write through fakes; here both edits read the entry before either writes, and the server
decides which lands: exactly one does, the other is refused with a 409, and the entry's own
history holds one line, whose ``before`` is the entry as first recorded.
"""
import threading

import api.payments as PaymentsApi
import history as History
import payments as Payments
from datatypes import MarketPhase, PaymentEntry
from real_mongo import harness

OWNER = "entry-owner@example.com"
VENDOR = "entry-vendor@example.com"
#: How many times the race is run, each on an entry of its own.
ROUNDS = 20
FIRST = PaymentEntry(cents=3000, method="cash", paid_on="2099-04-01")


def _edit(i: int) -> dict:
    return {"cents": 3100 + i, "method": "e-transfer", "paidOn": "2099-04-02",
            "note": f"Edit {i}"}


def test_two_edits_at_once_land_one_and_refuse_the_other(
        real_db, signed_in, market_in, race, monkeypatch):
    signed_in(OWNER)
    market = market_in(MarketPhase.MARKET_DAYS)
    harness.warm(Payments.payments_collection, 2)
    read = Payments.payment

    for round_ in range(ROUNDS):
        stored = Payments.record_payment(market["id"], VENDOR, FIRST, OWNER)
        # Each request's read of the entry waits for the other's, so both stand on one read before
        # either writes; the read again that says why one was refused does not wait.
        barrier = threading.Barrier(2, timeout=harness.RACE_TIMEOUT_SECONDS)
        waited = threading.local()

        def reading(*args, **kwargs):
            found = read(*args, **kwargs)
            if not getattr(waited, "done", False):
                waited.done = True
                barrier.wait()
            return found

        monkeypatch.setattr(Payments, "payment", reading)
        answered = race(2, lambda i: PaymentsApi.edit_payment(
            market["id"], stored["id"], _edit(i), OWNER))
        monkeypatch.setattr(Payments, "payment", read)

        landed = [i for i, answer in enumerate(answered) if isinstance(answer, dict)]
        refused = [i for i, answer in enumerate(answered)
                   if isinstance(answer, PaymentsApi.EntryChangedMeanwhile)]
        assert (len(landed), len(refused)) == (1, 1), (round_, answered)
        loser = answered[refused[0]]
        assert loser.status == 409
        assert loser.message == PaymentsApi.ENTRY_CHANGED[("edit", False)].format(kind="payment")
        entry = Payments.payment(market["id"], stored["id"])
        assert entry["note"] == f"Edit {landed[0]}"
        assert [line["before"] for line in entry["changes"]] == [
            {"cents": 3000, "method": "cash", "paid_on": "2099-04-01", "note": ""}]
        shown = next(shown for shown in loser.account["payments"] if shown["id"] == stored["id"])
        assert shown["note"] == f"Edit {landed[0]}"
        edits = [recorded for recorded in History.history_collection.find(
            {"market_id": market["id"], "kind": History.PAYMENT_EDITED})
            if recorded["subject"]["payment_id"] == stored["id"]]
        assert len(edits) == 1
