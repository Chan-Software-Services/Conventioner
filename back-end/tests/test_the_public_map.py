"""The public map's read and its image, for anyone (T422, ADR 0035).

``GET /public/markets/<slug>/map`` answers an allowlist (D26): the market's name and dates, its
table types, each laid-out location's sections and layout, and each seat with three of its vendor's
answers, the ones the organizer chose, cleaned (D28) and read as the organizer reads them (D29).
Nothing else of an application ever leaves: these tests seed every other part of one with a marker
and look for it in the answer's text. Behind one gate (D30), a market whose map is closed answers
byte for byte as a slug naming no market, and so does its image.
"""
import copy
import json
from types import SimpleNamespace

import pytest

from conftest import FakeSlugMarketsCollection, stored_assignment, stored_market

import app as app_module
import db_config as test_db_config
import services.gridfs_service as GridfsService
from datatypes import MarketPhase, market_name_slug

SLUG = market_name_slug("Test Market")
MARKET = "market-123"
DAY_ONE, DAY_TWO = "2099-08-01", "2099-08-02"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
ANNEX = {"id": "loc-annex", "name": "East Wing"}
GOLD = {"id": 0, "name": "Gold"}
SIX_FOOT = {"id": "tt-six", "name": "Standard 6 ft", "widthMm": 1830, "depthMm": 760}
FORM = {"fields": [
    {"key": "business_name", "label": "Business name", "type": "text"},
    {"key": "website", "label": "Website", "type": "text"},
    {"key": "instagram", "label": "Instagram handle", "type": "text"},
    {"key": "phone", "label": "Phone", "type": "text"},
    {"key": "days", "label": "Days", "type": "select", "options": ["One", "Two"]},
]}
ON = {"enabled": True, "nameQuestion": "business_name", "websiteQuestion": "website",
      "instagramQuestion": "instagram"}

#: Every part of an application the map must never send, each a marker found nowhere else.
MARKERS = {
    "essential_full_name": "Zqfullname Marker",
    "essential_preferred_name": "Zqpreferred Marker",
    "phone": "+1 555 0199 zqphone",
    "days": "zqchoice",
}
NOTE = "zqnote brings a trolley"
VENDORS = ("ana@ember.test", "ben@kiln.test", "cleo@loom.test", "dev@dough.test")


def _table(table_id, section, number, x=3000.0, rotation=0.0):
    return {"id": table_id, "sectionId": section, "number": number, "tableTypeId": "tt-six",
            "xMm": x, "yMm": 5000.0, "rotation": rotation}


def _layouts(image_id):
    north = {
        "id": "fp-north", "locationId": NORTH["id"], "revision": 3, "imageGridfsId": image_id,
        "imageWidth": 800, "imageHeight": 600, "scalePxPerUnit": 800 / 30_000,
        "referenceLineStart": [0, 300], "referenceLineEnd": [800, 300],
        "referenceLineLengthMm": 30_000,
        "tables": [
            _table("t-a1", "sec-a", 1, 3000), _table("t-a2", "sec-a", 2, 5000),
            _table("t-a3", "sec-a", 3, 7000, rotation=90), _table("t-a4", "sec-a", 4, 9000),
            _table("t-loose", None, None, 20_000),
        ],
        "zones": [{"id": "z-stage", "label": "Stage", "xMm": 15_000, "yMm": 10_000,
                   "widthMm": 6000, "depthMm": 3000, "rotation": 30}],
        "sectionStyles": [
            {"sectionId": "sec-a", "color": 3, "labelAt": {"xMm": 3000, "yMm": 3500}},
            {"sectionId": "sec-gone", "color": 5, "labelAt": None},
        ],
        "startingCounts": [{"sectionId": "sec-a", "count": 4}],
        "followsPlan": False,
    }
    south = {
        "id": "fp-south", "locationId": SOUTH["id"], "revision": 1, "imageGridfsId": None,
        "imageWidth": None, "imageHeight": None, "scalePxPerUnit": 800 / 30_000,
        "tables": [_table("t-b1", "sec-b", 1), _table("t-b2", "sec-b", 2, 5000),
                   _table("t-b3", "sec-b", 3, 7000)],
        "zones": [], "sectionStyles": [], "startingCounts": [],
    }
    # Laid out with no scale, so the map does not draw it.
    annex = {"id": "fp-annex", "locationId": ANNEX["id"], "revision": 1,
             "tables": [_table("t-r1", "sec-r", 1)]}
    return [north, south, annex]


def _plan(image_id):
    return {
        "priority": [], "marketDates": [{"date": DAY_TWO}, {"date": DAY_ONE}],
        "tiers": [GOLD],
        "locations": [copy.deepcopy(NORTH), copy.deepcopy(SOUTH), copy.deepcopy(ANNEX)],
        "sections": [
            {"id": "sec-a", "name": "Aisle A", "count": 4, "location": copy.deepcopy(NORTH),
             "tier": GOLD},
            {"id": "sec-b", "name": "Aisle B", "count": 3, "location": copy.deepcopy(SOUTH),
             "tier": GOLD},
            {"id": "sec-r", "name": "Annex row", "count": 1, "location": copy.deepcopy(ANNEX),
             "tier": GOLD},
        ],
        "assignmentOptions": {},
        "tableTypes": [copy.deepcopy(SIX_FOOT)],
        "floorplans": _layouts(image_id),
    }


def _seat(email, date, code, choice="Full Table", section="Aisle A", location="North Wing"):
    return {"email": email, "date": date, "tableCode": code, "tableChoice": choice,
            "section": section, "tier": "Gold", "location": location, "handPlaced": True}


SEATS = [
    _seat("Dev@Dough.test", DAY_ONE, "Aisle B 2", section="Aisle B", location="South Wing"),
    _seat("cleo@loom.test", DAY_ONE, "Aisle A 3", "Half Table (Right)"),
    _seat("ana@ember.test", DAY_ONE, "Aisle A 1"),
    _seat("ben@kiln.test", DAY_ONE, "Aisle A 3", "Half Table (Left)"),
    _seat("ana@ember.test", DAY_TWO, "Aisle A 2"),
    # None of these is on the map: a table no layout has, a day that is no market date, a location
    # whose layout is not drawn.
    _seat("ben@kiln.test", DAY_TWO, "Aisle A 9"),
    _seat("cleo@loom.test", "2099-09-09", "Aisle A 1"),
    _seat("dev@dough.test", DAY_TWO, "Annex row 1", section="Annex row", location="East Wing"),
]


def _application(email, answers, updates=None):
    return {
        "id": f"app-{email.split('@')[0]}", "market_id": MARKET, "applicant_email": email,
        "application_type": "main", "status": "reviewer_approved",
        "form_data": {**MARKERS, **answers},
        **({"answer_updates": updates} if updates else {}),
    }


@pytest.fixture
def world(monkeypatch, applications, market_records):
    """A market in its market days, its map on, two locations laid out, four vendors seated."""
    image_id = GridfsService.upload_image(b"\x89PNG north wing", "north.png", MARKET)
    doc = stored_market(
        MarketPhase.MARKET_DAYS, intakeMode="csv", applicationForm=copy.deepcopy(FORM),
        setupObject=_plan(image_id), publicMap=copy.deepcopy(ON),
        assignmentObject=stored_assignment("run", SEATS, made_from={"vendors": "a-run"}),
    )
    holder = SimpleNamespace(collection=FakeSlugMarketsCollection([doc]), doc=doc,
                             image_id=image_id, images=market_records.images)

    class _Db(dict):
        def __getitem__(self, name):
            return holder.collection if name == "markets" else FakeSlugMarketsCollection([])

    monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: _Db())
    for application in (
        _application("ana@ember.test", {"business_name": "  Ember   Ceramics ",
                                        "website": "ember-ceramics.test",
                                        "instagram": "https://www.instagram.com/example.ember/"}),
        _application("ben@kiln.test", {"business_name": "orders@kiln-studio.test",
                                       "website": "javascript:alert(1)",
                                       "instagram": "kiln studio"}),
        _application("cleo@loom.test", {}),
        _application("dev@dough.test", {"business_name": "Dev's Donuts",
                                        "website": "https://dough.test/menu"},
                     updates={"business_name": {"value": "Dev's Doughnuts",
                                                "by": "owner@example.com",
                                                "at": "2099-07-01T00:00:00+00:00",
                                                "over": "Dev's Donuts"}}),
    ):
        applications.insert_one(application)
    market_records.notes.insert_one({"market_id": MARKET, "vendor_email": "ana@ember.test",
                                     "note": NOTE})
    return holder


@pytest.fixture
def client():
    return app_module.app.test_client()


def _map(client, slug=SLUG):
    return client.get(f"/public/markets/{slug}/map")


def _image(client, location=NORTH["id"], slug=SLUG):
    return client.get(f"/public/markets/{slug}/map/image/{location}")


def _keys(value):
    return set(value)


class TestTheAllowlist:
    def test_the_answer_holds_exactly_its_keys_at_every_level(self, client, world):
        body = _map(client).get_json()

        assert _keys(body) == {"marketName", "dates", "tableTypes", "locations", "seats"}
        assert all(_keys(kind) == {"id", "name", "widthMm", "depthMm"}
                   for kind in body["tableTypes"])
        assert body["locations"]
        for location in body["locations"]:
            assert _keys(location) == {"id", "name", "sections", "layout"}
            assert all(_keys(section) == {"id", "name"} for section in location["sections"])
            layout = location["layout"]
            assert _keys(layout) == {"id", "locationId", "imageWidth", "imageHeight",
                                     "scalePxPerUnit", "hasImage", "tables", "zones",
                                     "sectionStyles"}
            assert all(_keys(table) == {"id", "sectionId", "number", "tableTypeId", "xMm", "yMm",
                                        "rotation"} for table in layout["tables"])
            assert all(_keys(zone) == {"id", "label", "xMm", "yMm", "widthMm", "depthMm",
                                       "rotation"} for zone in layout["zones"])
            for style in layout["sectionStyles"]:
                assert _keys(style) == {"sectionId", "color", "labelAt"}
                assert style["labelAt"] is None or _keys(style["labelAt"]) == {"xMm", "yMm"}
        assert body["seats"]
        assert all(_keys(seat) == {"date", "tableId", "half", "name", "website", "instagram"}
                   for seat in body["seats"])

    def test_nothing_else_of_an_application_is_anywhere_in_it(self, client, world):
        text = _map(client).get_data(as_text=True)

        for marker in (*MARKERS.values(), NOTE):
            assert marker not in text
        for email in VENDORS:
            assert email not in text.lower()
        assert "@" not in text

    def test_a_public_name_that_is_an_email_address_is_withheld(self, client, world):
        seats = _map(client).get_json()["seats"]

        ben = next(seat for seat in seats if seat["half"] == "left")
        assert ben == {"date": DAY_ONE, "tableId": "t-a3", "half": "left", "name": None,
                       "website": None, "instagram": None}

    def test_it_carries_cache_control_for_a_minute(self, client, world):
        assert _map(client).headers["Cache-Control"] == "public, max-age=60"


class TestWhatItAnswers:
    def test_the_market_its_dates_in_order_and_its_types(self, client, world):
        body = _map(client).get_json()

        assert body["marketName"] == "Test Market"
        assert body["dates"] == [DAY_ONE, DAY_TWO]
        assert body["tableTypes"] == [SIX_FOOT]

    def test_only_the_locations_laid_out_in_the_plans_order(self, client, world):
        locations = _map(client).get_json()["locations"]

        assert [location["name"] for location in locations] == ["North Wing", "South Wing"]
        assert locations[0]["sections"] == [{"id": "sec-a", "name": "Aisle A"}]

    def test_a_layout_as_drawn_its_tables_in_a_section_alone(self, client, world):
        north = _map(client).get_json()["locations"][0]["layout"]

        assert {key: north[key] for key in ("id", "locationId", "imageWidth", "imageHeight",
                                           "scalePxPerUnit", "hasImage")} == {
            "id": "fp-north", "locationId": NORTH["id"], "imageWidth": 800, "imageHeight": 600,
            "scalePxPerUnit": 800 / 30_000, "hasImage": True}
        assert [table["id"] for table in north["tables"]] == ["t-a1", "t-a2", "t-a3", "t-a4"]
        assert north["tables"][2] == {"id": "t-a3", "sectionId": "sec-a", "number": 3,
                                     "tableTypeId": "tt-six", "xMm": 7000.0, "yMm": 5000.0,
                                     "rotation": 90.0}
        assert north["zones"] == [{"id": "z-stage", "label": "Stage", "xMm": 15_000.0,
                                  "yMm": 10_000.0, "widthMm": 6000.0, "depthMm": 3000.0,
                                  "rotation": 30.0}]
        assert north["sectionStyles"] == [
            {"sectionId": "sec-a", "color": 3, "labelAt": {"xMm": 3000.0, "yMm": 3500.0}}]

    def test_a_layout_with_no_image_says_so(self, client, world):
        south = _map(client).get_json()["locations"][1]["layout"]

        assert south["hasImage"] is False

    def test_each_seat_on_the_map_in_order_with_its_vendors_answers(self, client, world):
        seats = _map(client).get_json()["seats"]

        assert seats == [
            {"date": DAY_ONE, "tableId": "t-a1", "half": "whole", "name": "Ember Ceramics",
             "website": "https://ember-ceramics.test", "instagram": "example.ember"},
            {"date": DAY_ONE, "tableId": "t-a3", "half": "left", "name": None, "website": None,
             "instagram": None},
            {"date": DAY_ONE, "tableId": "t-a3", "half": "right", "name": None, "website": None,
             "instagram": None},
            {"date": DAY_ONE, "tableId": "t-b2", "half": "whole", "name": "Dev's Doughnuts",
             "website": "https://dough.test/menu", "instagram": None},
            {"date": DAY_TWO, "tableId": "t-a2", "half": "whole", "name": "Ember Ceramics",
             "website": "https://ember-ceramics.test", "instagram": "example.ember"},
        ]

    def test_the_name_is_the_one_the_organizer_reads(self, client, world):
        """An organizer's update of the public name ("Update info") is what the map answers."""
        seats = _map(client).get_json()["seats"]

        assert "Dev's Doughnuts" in [seat["name"] for seat in seats]
        assert "Dev's Donuts" not in [seat["name"] for seat in seats]

    @pytest.mark.parametrize("main_first", [True, False], ids=["main-first", "waitlist-first"])
    def test_a_vendor_with_a_waitlist_application_too_is_named_by_the_main_one(
            self, client, world, applications, main_first):
        """The unique index is the market, the address and the type, so a vendor may have a main
        and a waitlist application; the map reads the main one's answers, whichever is read last."""
        email = "eve@glass.test"
        main = {**_application(email, {"business_name": "Eve's Glass"}), "id": "app-eve-main"}
        waitlist = {**_application(email, {}), "id": "app-eve-waitlist",
                    "application_type": "waitlist"}
        for application in ((main, waitlist) if main_first else (waitlist, main)):
            applications.insert_one(application)
        world.doc["assignmentObject"]["vendorAssignments"].append(
            _seat(email, DAY_ONE, "Aisle A 4"))

        seats = _map(client).get_json()["seats"]

        assert [seat["name"] for seat in seats if seat["tableId"] == "t-a4"] == ["Eve's Glass"]

    def test_a_question_not_chosen_answers_none(self, client, world):
        world.doc["publicMap"] = {**ON, "websiteQuestion": None, "instagramQuestion": None}

        seats = _map(client).get_json()["seats"]

        assert seats[0] == {"date": DAY_ONE, "tableId": "t-a1", "half": "whole",
                            "name": "Ember Ceramics", "website": None, "instagram": None}

    @pytest.mark.parametrize("stale", ["gone", "days"])
    def test_a_question_the_form_no_longer_asks_as_text_reads_as_not_chosen(
            self, client, world, stale):
        world.doc["publicMap"] = {**ON, "websiteQuestion": stale}

        seats = _map(client).get_json()["seats"]

        assert seats[0]["website"] is None

    def test_a_market_whose_results_are_published_before_its_days_opens(self, client, world):
        world.doc.update(phase=MarketPhase.ASSIGNMENT.value, resultsPublished=True)

        assert _map(client).status_code == 200


def _absent(doc):
    doc["publicMap"] = None


def _off(doc):
    doc["publicMap"]["enabled"] = False


def _results_not_out(doc):
    doc.update(phase=MarketPhase.ASSIGNMENT.value, resultsPublished=False)


def _a_form_markets_results_not_out(doc):
    """A form market's vendor page opens before its results do, so the gate's own check of the
    results is what keeps this one closed (D30): every other case is closed by the vendor page's
    lookup too."""
    doc.update(phase=MarketPhase.ASSIGNMENT.value, intakeMode="form", resultsPublished=False,
               phaseHistory=[
                   {"phase": phase, "enteredAt": "2099-07-01T00:00:00+00:00",
                    "by": "owner@example.com"}
                   for phase in ("draft", "applications", "assignment")])


def _archived(doc):
    """An archived market that ran, whose vendor page is still open."""
    doc.update(phase=MarketPhase.ARCHIVED.value, resultsPublished=True, phaseHistory=[
        {"phase": phase, "enteredAt": "2099-07-01T00:00:00+00:00", "by": "owner@example.com"}
        for phase in ("draft", "applications", "assignment", "market_days", "archived")])


def _draft(doc):
    doc.update(phase=MarketPhase.DRAFT.value, isDraft=True, resultsPublished=True)


def _no_name_question(doc):
    doc["publicMap"]["nameQuestion"] = None


def _name_question_removed_from_the_form(doc):
    doc["applicationForm"]["fields"] = doc["applicationForm"]["fields"][1:]


def _name_question_no_longer_text(doc):
    doc["applicationForm"]["fields"][0]["type"] = "textarea"


def _no_table_in_a_section(doc):
    for layout in doc["setupObject"]["floorplans"]:
        for table in layout["tables"]:
            table.update(sectionId=None, number=None)


def _no_scale(doc):
    for layout in doc["setupObject"]["floorplans"]:
        layout["scalePxPerUnit"] = None


def _no_layout(doc):
    doc["setupObject"]["floorplans"] = None


CLOSED = [_absent, _off, _results_not_out, _a_form_markets_results_not_out, _archived, _draft, _no_name_question,
          _name_question_removed_from_the_form, _name_question_no_longer_text,
          _no_table_in_a_section, _no_scale, _no_layout]


def _answer(response):
    """The answer as a caller reads it: its status, its body and every header but its date."""
    headers = sorted((name, value) for name, value in response.headers.items() if name != "Date")
    return response.status_code, response.get_data(), headers


class TestTheGate:
    @pytest.mark.parametrize("close", CLOSED, ids=lambda close: close.__name__.strip("_"))
    def test_a_closed_map_answers_byte_for_byte_as_an_unknown_slug(self, client, world, close):
        close(world.doc)

        gated = _answer(_map(client))

        assert gated == _answer(_map(client, "no-such-market"))
        assert gated == _answer(client.get("/public/markets/no-such-market/vendor-page"))
        assert gated[0] == 404

    @pytest.mark.parametrize("close", CLOSED, ids=lambda close: close.__name__.strip("_"))
    def test_and_so_does_its_image(self, client, world, close):
        close(world.doc)

        assert _answer(_image(client)) == _answer(_image(client, slug="no-such-market"))
        assert _image(client).status_code == 404

    def test_the_open_map_answers(self, client, world):
        assert _map(client).status_code == 200
        assert _image(client).status_code == 200

    def test_it_reads_no_body_and_needs_no_sign_in(self, client, world):
        response = client.get(f"/public/markets/{SLUG}/map", data="{not json",
                              content_type="application/json")

        assert response.status_code == 200


class TestTheImage:
    def test_it_is_the_layouts_image_with_its_type_and_cache_header(self, client, world):
        world.images.files[next(iter(world.images.files))]["data"] = _png()

        response = _image(client)

        assert response.status_code == 200
        assert response.get_data() == _png()
        assert response.headers["Content-Type"] == "image/png"
        assert response.headers["Cache-Control"] == "public, max-age=300"

    @pytest.mark.parametrize("location", [SOUTH["id"], ANNEX["id"], "loc-nowhere", "fp-north"])
    def test_a_location_the_map_does_not_draw_or_with_no_image_is_absent(
            self, client, world, location):
        assert _answer(_image(client, location)) == _answer(_map(client, "no-such-market"))

    def test_it_is_found_by_the_location_never_by_an_images_id(self, client, world):
        assert _image(client, world.image_id).status_code == 404

    def test_an_image_stored_for_another_market_is_absent(self, client, world):
        other = GridfsService.upload_image(_png(), "other.png", "market-other")
        world.doc["setupObject"]["floorplans"][0]["imageGridfsId"] = other

        assert _image(client).status_code == 404

    def test_an_image_gone_from_the_store_is_absent(self, client, world):
        world.images.files.clear()

        assert _image(client).status_code == 404


def _png():
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (4, 3), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class TestTheRouteIsOneRead:
    def test_the_answer_is_json_of_plain_values(self, client, world):
        """Built key by key, never a model's dump: it round-trips as JSON whole."""
        body = _map(client).get_json()

        assert json.loads(json.dumps(body)) == body


class TestTheDoorIsNotOnTheMap:
    def test_a_check_in_and_a_check_out_change_nothing_it_answers(
            self, client, world, market_records):
        """The map shows who sits where, never who came or who left (T496)."""
        before = _map(client)
        assert before.status_code == 200
        ana = {"market_id": MARKET, "vendor_email": "ana@ember.test", "date": DAY_ONE}

        market_records.attendance.insert_one({
            **ana, "table_code": "Aisle A 1", "checked_in_at": "2099-08-01T09:00:00+00:00",
            "checked_in_by": None, "checked_in_via": "door_code"})
        checked_in = _map(client)
        market_records.attendance.update_one(ana, {"$set": {
            "checked_out_at": "2099-08-01T17:00:00+00:00", "checked_out_by": None,
            "checked_out_via": "door_code"}})
        checked_out = _map(client)

        assert checked_in.get_data() == before.get_data()
        assert checked_out.get_data() == before.get_data()
