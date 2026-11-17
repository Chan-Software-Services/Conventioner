"""What a layout stores that the day map draws (T422): a no-table zone's turn, and whether the
layout follows the plan.

A zone is turned ``rotation`` degrees clockwise about its centre, stored 0 to 360 (D16), and a turn
that is not a finite number is refused with the floorplan's bounds sentence. ``followsPlan`` is the
server's: false on a layout started in Draft, and kept on every later save whatever a body sends
(ticket 03 starts one after Draft, true). Every save goes through the Flask client as the layout
page sends it.
"""
import copy

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import floorplan_limits as FloorplanLimits  # noqa: E402
import services.gridfs_service as GridfsService  # noqa: E402
from datatypes import FloorplanZone  # noqa: E402
from test_the_plan_holds_layouts import (  # noqa: E402,F401 - fixtures by name
    MARKET_ID, _plan, client, market,
)


def _zone(rotation):
    return {"id": "z-stage", "label": "Stage", "xMm": 15_000, "yMm": 10_000, "widthMm": 6000,
            "depthMm": 3000, "rotation": rotation}


def _save(client, market, floorplan, revision):
    return client.post("/floorplans/save-to-market", json={
        "market_id": MARKET_ID, "floorplan": floorplan, "revision": revision})


@pytest.fixture
def started(client, market):
    """Upper Hall's layout started in Draft, calibrated 30 m across; answers it as stored."""
    market.doc["setupObject"] = _plan()
    image = GridfsService.upload_image(b"\x89PNG upper hall", "upper.png", MARKET_ID)
    response = _save(client, market, {
        "id": "fp-upper", "locationId": "loc-upper", "imageGridfsId": image, "imageWidth": 800,
        "imageHeight": 600, "scalePxPerUnit": 800 / 30_000}, 0)
    assert response.status_code == 200, response.get_json()
    return response.get_json()["floorplan"]


def _stored(market):
    return market.doc["setupObject"]["floorplans"][0]


class TestAZonesTurn:
    @pytest.mark.parametrize("sent,stored", [
        (30, 30.0), (0, 0.0), (359.5, 359.5), (360, 0.0), (-30, 330.0), (750, 30.0)])
    def test_it_is_stored_turned_within_one_circle(self, client, market, started, sent, stored):
        response = _save(client, market, {**started, "zones": [_zone(sent)]},
                         started["revision"])

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["floorplan"]["zones"][0]["rotation"] == stored
        assert _stored(market)["zones"][0]["rotation"] == stored

    def test_a_zone_sent_with_no_turn_is_not_turned(self, client, market, started):
        zone = _zone(0)
        zone.pop("rotation")

        _save(client, market, {**started, "zones": [zone]}, started["revision"])

        assert _stored(market)["zones"][0]["rotation"] == 0.0

    def test_a_zone_stored_before_turns_reads_as_not_turned(self):
        assert FloorplanZone.model_validate(
            {"id": "z", "x_mm": 1, "y_mm": 1, "width_mm": 1, "depth_mm": 1}).rotation == 0.0

    @pytest.mark.parametrize("turn", [float("nan"), float("inf"), float("-inf")])
    def test_a_turn_that_is_no_finite_number_is_refused(self, client, market, started, turn):
        floorplan = copy.deepcopy({**started, "zones": [_zone(0)]})
        floorplan["zones"][0]["rotation"] = turn

        response = _save(client, market, floorplan, started["revision"])

        assert response.status_code == 400
        assert response.get_json()["error"] == FloorplanLimits.UNBOUNDED_MEASUREMENT
        assert _stored(market)["zones"] == []


class TestWhetherItFollowsThePlan:
    def test_a_layout_started_in_draft_does_not(self, client, market, started):
        assert started["followsPlan"] is False
        assert _stored(market)["followsPlan"] is False

    def test_a_first_save_saying_it_does_is_not_believed(self, client, market):
        market.doc["setupObject"] = _plan()

        response = _save(client, market, {"id": "fp-upper", "locationId": "loc-upper",
                                          "followsPlan": True}, 0)

        assert response.status_code == 200, response.get_json()
        assert _stored(market)["followsPlan"] is False

    @pytest.mark.parametrize("held", [False, True])
    def test_a_later_save_keeps_what_is_stored_whatever_it_sends(
            self, client, market, started, held):
        _stored(market)["followsPlan"] = held

        response = _save(client, market, {**started, "followsPlan": not held},
                         started["revision"])

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["floorplan"]["followsPlan"] is held
        assert _stored(market)["followsPlan"] is held
