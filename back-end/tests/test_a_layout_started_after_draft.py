"""A layout started after Draft follows the plan (T422 ticket 03, D21 to D23, ADR 0033).

On a market past Draft a location with no layout can now be given one. Its tables draw the seats
Section Setup already settled and never change them: each section's tables are numbered once each
from 1 to the section's count, fewer than the count saving, and the section's count stays as typed
on every write of the plan. Past Draft its tables may still be added, removed, renumbered and put
in another section of its location; the market's table types and the layouts started in Draft
still settle as before. The layout keeps which kind it is (``followsPlan``), set by the server as
it starts and never changed after. Every save and plan write goes through the Flask client as the
layout page and Market Setup send them.
"""
import copy

import pytest

from conftest import skip_without_real_dependencies, stored_market

skip_without_real_dependencies()

import api.markets as MarketsApi  # noqa: E402
import history as History  # noqa: E402
import services.gridfs_service as GridfsService  # noqa: E402
from datatypes import MarketPhase  # noqa: E402
from market_documents import market_from_document  # noqa: E402
from test_the_plan_holds_layouts import (  # noqa: E402,F401 - fixtures by name
    MARKET_ID, SIX_FOOT, _layout, _plan, _put, client, market,
)

AFTER_DRAFT = [p for p in MarketPhase if p not in (MarketPhase.DRAFT, MarketPhase.ARCHIVED)]

#: The sentence each section's numbering is refused with, for Gold row's 13 seats.
GOLD_NUMBERING = "Gold row's tables are numbered 1 to 13, each number once."


def _past_draft(market, phase=MarketPhase.ASSIGNMENT, **plan_overrides):
    """The market past Draft, its plan settled: Gold row's 13 seats and Blue row's 7, typed."""
    market.doc = stored_market(phase, roles={"user-owner": "owner"},
                               setupObject=_plan(tableTypes=[dict(SIX_FOOT)], **plan_overrides))


def _save(client, floorplan, revision):
    return client.post("/floorplans/save-to-market", json={
        "market_id": MARKET_ID, "floorplan": floorplan, "revision": revision})


def _gold(table_id, number, x=1000.0, section="sec-gold"):
    return {"id": table_id, "sectionId": section, "number": number, "tableTypeId": "tt-six",
            "xMm": x, "yMm": 1000.0, "rotation": 0.0}


def _start(client, market, tables=()):
    """Upper Hall's layout started, calibrated 30 m across, then given ``tables``; answers the
    layout as stored."""
    image = GridfsService.upload_image(b"\x89PNG upper hall", "upper.png", MARKET_ID)
    response = _save(client, {
        "id": "fp-upper", "locationId": "loc-upper", "imageGridfsId": image, "imageWidth": 800,
        "imageHeight": 600, "scalePxPerUnit": 800 / 30_000}, 0)
    assert response.status_code == 200, response.get_json()
    started = response.get_json()["floorplan"]
    if not tables:
        return started
    response = _save(client, {**started, "tables": list(tables)}, started["revision"])
    assert response.status_code == 200, response.get_json()
    return response.get_json()["floorplan"]


def _stored(market):
    return market.doc["setupObject"]


def _counts(market):
    return {section["name"]: section["count"] for section in _stored(market)["sections"]}


def _entries(market_records):
    return [entry for entry in market_records.history.documents
            if entry.get("kind") == History.FLOORPLAN]


class TestItsStart:

    @pytest.mark.parametrize("phase", AFTER_DRAFT)
    def test_past_draft_a_layout_starts_and_follows_the_plan(self, client, market, phase):
        _past_draft(market, phase)

        started = _start(client, market)

        assert started["followsPlan"] is True
        assert _stored(market)["floorplans"][0]["followsPlan"] is True

    def test_in_draft_it_does_not(self, client, market):
        market.doc["setupObject"] = _plan(tableTypes=[dict(SIX_FOOT)])

        assert _start(client, market)["followsPlan"] is False

    def test_the_bodys_word_is_never_taken(self, client, market):
        _past_draft(market)
        image = GridfsService.upload_image(b"\x89PNG", "upper.png", MARKET_ID)

        response = _save(client, {"id": "fp-upper", "locationId": "loc-upper",
                                  "imageGridfsId": image, "followsPlan": False}, 0)
        started = response.get_json()["floorplan"]
        again = _save(client, {**started, "followsPlan": False}, started["revision"])

        assert started["followsPlan"] is True
        assert again.get_json()["floorplan"]["followsPlan"] is True

    def test_it_follows_the_plan_still_once_the_market_is_back_in_draft(self, client, market):
        _past_draft(market, MarketPhase.APPLICATIONS)
        started = _start(client, market)
        market.doc["phase"], market.doc["isDraft"] = MarketPhase.DRAFT.value, True

        response = _save(client, {**started, "tables": [_gold("g-5", 5)]}, started["revision"])

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["floorplan"]["followsPlan"] is True
        assert _counts(market)["Gold row"] == 13

    def test_its_first_save_is_recorded_as_its_start(self, client, market, market_records):
        _past_draft(market)

        _start(client, market)

        (entry,) = _entries(market_records)
        assert entry["subject"]["location"] == "Upper Hall"
        assert entry["detail"]["started"] is True

    def test_a_market_with_no_table_type_is_given_the_standard_one(self, client, market):
        _past_draft(market)
        _stored(market)["tableTypes"] = []

        started = _start(client, market)

        (table_type,) = _stored(market)["tableTypes"]
        assert (table_type["name"], table_type["widthMm"], table_type["depthMm"]) == (
            "Standard 6 ft", 1830, 760)
        response = _save(client, {**started, "tables": [
            {**_gold("g-1", 1), "tableTypeId": table_type["id"]}]}, started["revision"])
        assert response.status_code == 200, response.get_json()

    def test_a_market_with_types_keeps_them(self, client, market):
        _past_draft(market)

        _start(client, market)

        assert _stored(market)["tableTypes"] == [SIX_FOOT]


class TestItsSectionsKeepTheirCounts:

    def test_the_save_answers_the_typed_counts(self, client, market):
        _past_draft(market)
        started = _start(client, market)

        response = _save(client, {**started, "tables": [_gold("g-1", 1), _gold("g-2", 2)]},
                         started["revision"])

        assert {s["name"]: s["count"] for s in response.get_json()["sections"]} == {
            "Gold row": 13, "Blue row": 7}
        assert _counts(market) == {"Gold row": 13, "Blue row": 7}

    def test_a_plan_write_keeps_them_whatever_the_layout_holds(self, client, market):
        _past_draft(market)
        _start(client, market, [_gold("g-1", 1), _gold("g-2", 2)])

        response = _put(client, _stored(market))

        assert response.status_code == 200, response.get_json()
        assert _counts(market) == {"Gold row": 13, "Blue row": 7}

    def test_in_draft_a_typed_count_still_writes(self, client, market):
        _past_draft(market, MarketPhase.APPLICATIONS)
        _start(client, market, [_gold("g-1", 1)])
        market.doc["phase"], market.doc["isDraft"] = MarketPhase.DRAFT.value, True
        plan = copy.deepcopy(_stored(market))
        plan["sections"][0]["count"] = 20

        response = _put(client, plan)

        assert response.status_code == 200, response.get_json()
        assert _counts(market)["Gold row"] == 20


class TestItsNumbering:

    @pytest.mark.parametrize("numbers", [[1, 1], [14], [0], [2.5]],
                             ids=["repeated", "past the count", "zero", "not whole"])
    def test_a_numbering_off_the_plan_is_refused_and_writes_nothing(
            self, client, market, market_records, numbers):
        _past_draft(market)
        started = _start(client, market)
        before = copy.deepcopy(market.doc)

        response = _save(client, {**started, "tables": [
            _gold(f"g-{i}", n, x=1000.0 * (i + 1)) for i, n in enumerate(numbers)]},
            started["revision"])

        assert response.status_code == 400, response.get_json()
        assert response.get_json() == {"error": GOLD_NUMBERING}
        assert market.doc == before
        assert len(_entries(market_records)) == 1

    def test_fewer_tables_than_the_count_save(self, client, market):
        _past_draft(market)
        started = _start(client, market)

        response = _save(client, {**started, "tables": [_gold("g-13", 13), _gold("g-4", 4)]},
                         started["revision"])

        assert response.status_code == 200, response.get_json()
        assert [t["number"] for t in response.get_json()["floorplan"]["tables"]] == [13, 4]

    def test_a_number_not_whole_on_a_layout_started_in_draft_is_refused_as_before(
            self, client, market):
        market.doc["setupObject"] = _plan(tableTypes=[dict(SIX_FOOT)])
        started = _start(client, market)

        response = _save(client, {**started, "tables": [_gold("g-1", 2.5)]}, started["revision"])

        assert response.status_code == 400
        assert "number" in response.get_json()["error"]
        assert response.get_json()["error"] != GOLD_NUMBERING


class TestPastDraftItsSeatsChange:

    @pytest.mark.parametrize("change", ["added", "removed", "renumbered", "another section"])
    def test_a_seat_changed_saves(self, client, market, change):
        _past_draft(market, sections=[
            *_plan()["sections"],
            {"id": "sec-silver", "name": "Silver aisle", "count": 4,
             "location": {"id": "loc-upper", "name": "Upper Hall"},
             "tier": {"id": 0, "name": "Gold"}}])
        held = _start(client, market, [_gold("g-1", 1), _gold("g-2", 2, x=3000.0)])
        tables = copy.deepcopy(held["tables"])
        if change == "added":
            tables.append(_gold("g-3", 9, x=5000.0))
        elif change == "removed":
            tables.pop(0)
        elif change == "renumbered":
            tables[0]["number"], tables[1]["number"] = 2, 1
        else:
            tables[1].update(sectionId="sec-silver", number=4)

        response = _save(client, {**held, "tables": tables}, held["revision"])

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["floorplan"]["tables"] == tables
        assert _counts(market) == {"Gold row": 13, "Blue row": 7, "Silver aisle": 4}

    def test_the_table_types_write_is_still_refused(self, client, market):
        _past_draft(market)
        _start(client, market)

        response = client.put(f"/markets/{MARKET_ID}/table-types", json={"tableTypes": [
            {**SIX_FOOT, "depthMm": 900}]})

        assert response.status_code == 409
        assert "settled" in response.get_json()["error"]

    def test_a_layout_started_in_draft_beside_it_still_keeps_its_seats(self, client, market):
        lower = {**_layout(0, location="loc-lower", floorplan_id="fp-lower", image=None),
                 "tables": [_gold("b-1", 1, section="sec-blue")]}
        sections = _plan()["sections"]
        sections[1]["count"] = 1
        _past_draft(market, floorplans=[lower], sections=sections)
        _start(client, market, [_gold("g-1", 1)])

        response = _save(client, {**lower, "tables": [
            _gold("b-1", 1, section="sec-blue"), _gold("b-2", 2, x=3000.0, section="sec-blue")]},
            lower["revision"])

        assert response.status_code == 409
        assert "settled" in response.get_json()["error"]


class TestAPlanWriteBelowItsNumbers:

    def _back_in_draft_holding_table_9(self, client, market):
        _past_draft(market, MarketPhase.APPLICATIONS)
        _start(client, market, [_gold("g-3", 3), _gold("g-9", 9, x=3000.0)])
        market.doc["phase"], market.doc["isDraft"] = MarketPhase.DRAFT.value, True
        return copy.deepcopy(_stored(market))

    def test_a_count_below_a_number_its_layout_holds_is_refused(self, client, market):
        plan = self._back_in_draft_holding_table_9(client, market)
        plan["sections"][0]["count"] = 8

        response = _put(client, plan)

        assert response.status_code == 400, response.get_json()
        assert response.get_json() == {
            "error": "Gold row's layout holds table 9. Remove it from the layout first."}
        assert _counts(market)["Gold row"] == 13

    def test_a_count_at_its_highest_number_writes(self, client, market):
        plan = self._back_in_draft_holding_table_9(client, market)
        plan["sections"][0]["count"] = 9

        response = _put(client, plan)

        assert response.status_code == 200, response.get_json()
        assert market_from_document(market.doc).setup_object.sections[0].count == 9

    def test_the_settled_sentence_still_answers_first_past_draft(self, client, market):
        _past_draft(market)
        _start(client, market, [_gold("g-9", 9)])
        plan = copy.deepcopy(_stored(market))
        plan["sections"][0]["count"] = 8

        response = _put(client, plan)

        assert response.status_code == 400
        assert response.get_json()["error"] == MarketsApi.setup_lock_reason(
            market_from_document(market.doc))
