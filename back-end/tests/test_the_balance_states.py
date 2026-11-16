"""A vendor's balance state is the server's to read (T335).

How what a vendor paid compares with what they owe (owes, paid in full, paid more than owed, or
none) is read once, by ``Payments.compares`` and ``Payments.balance_state``, and served on every
account the server answers, so no screen keeps a copy of the rule. The cases are one table both
sides run (``fixtures/balance_states.json``): ``balanceStates.test.ts`` words and tones each case's
served fields, so a case added there is checked on screen too.
"""
import json
from pathlib import Path

import pytest

from test_a_vendors_payments import (  # noqa: F401
    ANA, EDITOR, MARKET, SAT, market, plant_amount_owed, stores)

import api.payments as PaymentsApi
import payments as Payments

#: The balance cases both sides are tested against.
BALANCE_STATES = json.loads(
    (Path(__file__).parent / "fixtures" / "balance_states.json").read_text("utf-8"))


def account_of(case):
    """An account owing and paid as the case says: one line owing it, one entry paying it."""
    lines = [{"owedCents": case["owedCents"]}] if case["owedCents"] else []
    paid = [{"cents": case["paidCents"]}] if case["paidCents"] else []
    return Payments.account(case["currency"], lines, paid)


class TestTheCases:
    @pytest.mark.parametrize("case", BALANCE_STATES, ids=lambda case: case["name"])
    def test_each_case_compares_and_is_in_its_state(self, case):
        held = account_of(case)

        assert (held["owedCents"], held["paidCents"]) == (case["owedCents"], case["paidCents"])
        assert Payments.compares(held) is case["compares"]
        assert Payments.balance_state(held) == case["balanceState"]

    @pytest.mark.parametrize("case", BALANCE_STATES, ids=lambda case: case["name"])
    def test_every_account_serves_its_state(self, case):
        held = account_of(case)

        assert (held["balanceState"], held["compares"]) == (case["balanceState"], case["compares"])

    def test_the_table_holds_every_state_priced_and_not(self):
        read = {(case["currency"] is not None, case["balanceState"]) for case in BALANCE_STATES}

        assert read >= {(priced, state) for priced in (True, False)
                        for state in (*Payments.BALANCE_STATES, None)}
        assert len({case["name"] for case in BALANCE_STATES}) == len(BALANCE_STATES)


class TestTheServedAccount:
    def test_the_payment_tab_reads_its_state(self, market):
        got = PaymentsApi.vendor_account(MARKET, ANA, EDITOR)

        assert (got["owedCents"], got["paidCents"]) == (7000, 0)
        assert (got["balanceState"], got["compares"]) == (Payments.OWES, True)

    def test_a_write_answers_the_state_it_left(self, market):
        got = PaymentsApi.record_payment(
            MARKET, ANA, {"cents": 7000, "method": "cash", "paidOn": "2099-04-01", "note": ""},
            EDITOR)

        assert (got["balanceState"], got["compares"]) == (Payments.PAID_IN_FULL, True)

    def test_a_market_with_no_prices_serves_no_state_until_an_amount_is_set(self, market):
        market.doc["setupObject"]["pricing"] = None
        PaymentsApi.record_payment(
            MARKET, ANA, {"cents": 3500, "method": "cash", "paidOn": "2099-04-01", "note": ""},
            EDITOR)

        got = PaymentsApi.vendor_account(MARKET, ANA, EDITOR)
        assert (got["currency"], got["balanceState"], got["compares"]) == (None, None, False)

        plant_amount_owed(MARKET, ANA, SAT, 2000, "admin@example.com")
        got = PaymentsApi.vendor_account(MARKET, ANA, EDITOR)
        assert (got["balanceState"], got["compares"]) == (Payments.PAID_MORE, True)


class TestWhetherTheMarketOffersPaymentStates:
    def test_a_market_with_prices_offers_them_with_nobody_on_it(self):
        assert Payments.offers_payment_states("CAD", {}) is True

    def test_a_market_with_no_prices_offers_them_only_where_some_account_compares(self):
        nothing = Payments.account(None, [], [{"cents": 3500}])
        set_by_hand = Payments.account(None, [{"owedCents": 2000}], [])

        assert Payments.offers_payment_states(None, {}) is False
        assert Payments.offers_payment_states(None, {ANA: nothing}) is False
        assert Payments.offers_payment_states(None, {ANA: nothing, "ben@example.com": set_by_hand}) is True
