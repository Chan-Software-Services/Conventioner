"""A signed-in floorplan image is kept by the browser alone and asked about again on each use (T501).

``GET /floorplans/<id>`` answers ``Cache-Control: private, no-cache`` and a strong ``ETag`` of the
image's id, which never names other bytes (a replaced floorplan gets a new id). So a browser keeps
the body but asks before every use, and a request whose ``If-None-Match`` names the tag gets ``304``
with no body, after the access check and without reading the image: a reload downloads no body, and
nobody the route refuses is ever served from the browser's copy. The public image keeps its own
headers.
"""
import pytest
from bson import ObjectId

from conftest import skip_without_real_dependencies, stored_market
from test_floorplan_access import (  # noqa: F401 - the fixtures
    ROLES,
    UNREADABLE_SETUP,
    _hall_png,
    hall,
    images,
    market,
    sign_in,
)

skip_without_real_dependencies()

import app as app_module
import api.floorplans as FloorplansApi
from datatypes import MarketPhase

CACHE_CONTROL = "private, no-cache"


def _tag(gridfs_id):
    return f'"{gridfs_id}"'


def _read(client, gridfs_id, *, if_none_match=None):
    headers = {"If-None-Match": if_none_match} if if_none_match is not None else {}
    return client.get(f"/floorplans/{gridfs_id}", headers=headers)


@pytest.fixture
def reads(monkeypatch):
    """Every GridFS read of an image's bytes the route makes, by id."""
    asked = []
    read = FloorplansApi.get_image

    def counted(gridfs_id):
        asked.append(gridfs_id)
        return read(gridfs_id)

    monkeypatch.setattr(FloorplansApi, "get_image", counted)
    return asked


class TestAnAllowedReader:
    @pytest.mark.parametrize("email", [
        "owner@example.com", "editor@example.com", "viewer@example.com",
    ])
    def test_gets_the_image_with_the_cache_rule_and_its_tag(self, sign_in, market, hall, email):
        response = _read(sign_in(email), hall)

        assert response.status_code == 200
        assert response.data == _hall_png()
        assert response.headers["Cache-Control"] == CACHE_CONTROL
        assert response.headers["ETag"] == _tag(hall)

    def test_an_archived_markets_reader_does_too(self, sign_in, market, hall):
        market.doc = stored_market(MarketPhase.ARCHIVED, roles=dict(ROLES))

        response = _read(sign_in("viewer@example.com"), hall)

        assert response.status_code == 200
        assert response.data == _hall_png()
        assert response.headers["Cache-Control"] == CACHE_CONTROL
        assert response.headers["ETag"] == _tag(hall)

    @pytest.mark.parametrize("email", [
        "owner@example.com", "editor@example.com", "viewer@example.com",
    ])
    @pytest.mark.parametrize("asked", ["tag", "star", "among others", "weak"])
    def test_asking_about_its_copy_gets_not_modified_and_no_read(
            self, sign_in, market, hall, reads, email, asked):
        if_none_match = {
            "tag": _tag(hall),
            "star": "*",
            "among others": f'"{ObjectId()}", {_tag(hall)}',
            "weak": f"W/{_tag(hall)}",
        }[asked]

        response = _read(sign_in(email), hall, if_none_match=if_none_match)

        assert response.status_code == 304
        assert response.data == b""
        assert response.headers["Cache-Control"] == CACHE_CONTROL
        assert response.headers["ETag"] == _tag(hall)
        assert reads == []

    def test_an_archived_markets_reader_asking_gets_not_modified(
            self, sign_in, market, hall, reads):
        market.doc = stored_market(MarketPhase.ARCHIVED, roles=dict(ROLES))

        response = _read(sign_in("viewer@example.com"), hall, if_none_match=_tag(hall))

        assert response.status_code == 304
        assert response.data == b""
        assert reads == []

    @pytest.mark.parametrize("stale", [
        "another image's", "one character short", "an empty list",
    ])
    def test_a_wrong_or_stale_tag_gets_the_image(self, sign_in, market, hall, reads, stale):
        if_none_match = {
            "another image's": f'"{ObjectId()}"',
            "one character short": _tag(hall[:-1]),
            "an empty list": "",
        }[stale]

        response = _read(sign_in("owner@example.com"), hall, if_none_match=if_none_match)

        assert response.status_code == 200
        assert response.data == _hall_png()
        assert response.headers["Cache-Control"] == CACHE_CONTROL
        assert response.headers["ETag"] == _tag(hall)
        assert reads == [hall]


class TestARefusalIsTheSameWithATag:
    """Whoever the route refuses gets today's answer whether or not they ask about a copy, so a
    tag reveals nothing and no refusal is ever a 304."""

    @pytest.mark.parametrize("if_none_match", ["tag", "*"])
    def test_a_signed_in_stranger_finds_no_image(self, sign_in, market, hall, reads, if_none_match):
        tag = _tag(hall) if if_none_match == "tag" else "*"

        response = _read(sign_in("outsider@example.com"), hall, if_none_match=tag)

        assert response.status_code == 404
        assert response.get_json() == {"error": "Image not found"}
        assert "ETag" not in response.headers
        assert reads == []

    @pytest.mark.parametrize("if_none_match", ["tag", "*"])
    def test_a_signed_out_caller_is_asked_to_sign_in(self, market, hall, reads, if_none_match):
        tag = _tag(hall) if if_none_match == "tag" else "*"

        response = _read(app_module.app.test_client(), hall, if_none_match=tag)

        assert response.status_code == 401
        assert response.data != _hall_png()
        assert "ETag" not in response.headers
        assert reads == []

    def test_an_unknown_image_is_not_found(self, sign_in, market, images, reads):
        unknown = str(ObjectId())

        response = _read(sign_in("owner@example.com"), unknown, if_none_match=_tag(unknown))

        assert response.status_code == 404
        assert response.get_json() == {"error": "Image not found"}
        assert "ETag" not in response.headers

    @pytest.mark.parametrize("metadata", [None, {}])
    def test_an_image_stored_without_a_market_is_not_found(
            self, sign_in, market, images, reads, metadata):
        unowned = str(images.put(_hall_png(), filename="hall.png", metadata=metadata))

        response = _read(sign_in("owner@example.com"), unowned, if_none_match=_tag(unowned))

        assert response.status_code == 404
        assert response.get_json() == {"error": "Image not found"}
        assert "ETag" not in response.headers
        assert reads == []

    def test_a_deleted_image_is_not_found(self, sign_in, market, hall, images, reads):
        assert _read(sign_in("owner@example.com"), hall).status_code == 200
        del images.files[ObjectId(hall)]

        response = _read(sign_in("owner@example.com"), hall, if_none_match=_tag(hall))

        assert response.status_code == 404
        assert response.get_json() == {"error": "Image not found"}
        assert "ETag" not in response.headers

    def test_an_image_whose_market_does_not_parse_is_not_found(self, sign_in, market, hall, reads):
        market.doc["setupObject"] = UNREADABLE_SETUP

        response = _read(sign_in("owner@example.com"), hall, if_none_match=_tag(hall))

        assert response.status_code == 404
        assert response.get_json() == {"error": "Image not found"}
        assert reads == []
