"""A no-table zone may be turned (T422, the QC walk of 2026-11-16, item 19; D16): the layout page
adds a zone turned about its centre, the save stores the turn from 0 up to 360, and the layout's
history counts a turn as a changed zone, as any other change to it.

A turn that is no finite number is refused with the floorplan's bounds sentence
(``test_a_layouts_stored_shapes.py``). Every save goes through the Flask client as the layout page
sends it.
"""
import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

from test_a_floorplan_save_keeps_the_market_readable import (  # noqa: E402,F401 - fixtures by name
    _floorplan, _floorplan_entries, _save, _saved_plan, _with_plan, client, market,
)


def _stage(rotation, **overrides):
    zone = {"id": "z-stage", "label": "Stage", "xMm": 2000, "yMm": 1500, "widthMm": 3000,
            "depthMm": 1000, "rotation": rotation}
    zone.update(overrides)
    return zone


@pytest.fixture
def laid_out(client, market, market_records):
    """Hall A's layout saved with a stage turned 30°, its history then cleared."""
    _with_plan(market)
    response = _save(client, _floorplan("fp-1", zones=[_stage(30)]))
    assert response.status_code == 200, response.get_json()
    market_records.history.documents.clear()
    return response.get_json()["floorplan"]


class TestAZoneAddedTurned:
    def test_it_is_stored_and_answered_turned(self, client, market, laid_out):
        assert laid_out["zones"][0]["rotation"] == 30.0
        (zone,) = _saved_plan(market).floorplans[0].zones
        assert zone.rotation == 30.0
        assert (zone.x_mm, zone.y_mm, zone.width_mm, zone.depth_mm) == (2000, 1500, 3000, 1000)

    @pytest.mark.parametrize("sent", [-1e-14, 360.0, 720.0])
    def test_a_turn_a_whisker_short_of_a_circle_or_a_whole_one_is_stored_as_none(
            self, client, market, sent):
        _with_plan(market)

        response = _save(client, _floorplan("fp-1", zones=[_stage(sent)]))

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["floorplan"]["zones"][0]["rotation"] == 0.0
        (zone,) = _saved_plan(market).floorplans[0].zones
        assert 0 <= zone.rotation < 360


class TestATurnInTheHistory:
    def test_a_zone_turned_counts_as_changed(self, client, market, market_records, laid_out):
        response = _save(client, {**laid_out, "zones": [_stage(45)]})

        assert response.status_code == 200, response.get_json()
        (entry,) = _floorplan_entries(market_records)
        assert entry["detail"] == {"zones": {"added": 0, "changed": 1, "removed": 0}}

    def test_a_turn_restated_a_circle_on_records_nothing(
            self, client, market, market_records, laid_out):
        response = _save(client, {**laid_out, "zones": [_stage(390)]})

        assert response.status_code == 200, response.get_json()
        assert _floorplan_entries(market_records) == []
