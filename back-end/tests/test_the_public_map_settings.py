"""The Public map card's write: what the market's public map shows and whether it is open (T422).

``PUT /markets/<id>/public-map`` takes any of ``enabled``, ``nameQuestion``, ``websiteQuestion`` and
``instagramQuestion``, asks the table's "Publish the map" row (an Admin's by default, D25), writes
through the market write holding the settings as read, and records each change in the market's
history with each question's label beside its key. Every request goes through the Flask client as
the card sends it.
"""
import copy

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import api.market_actions as Actions  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import history as History  # noqa: E402
import market_write as MarketWrite  # noqa: E402
from datatypes import MarketPhase, MarketRole  # noqa: E402
from essential_fields import BUSINESS_NAME_KEY  # noqa: E402
from test_discord_connection import ADMIN, MARKET, client, world  # noqa: E402,F401 - fixtures

CHANGED = {"error": MarketWrite.MARKET_CHANGED, "code": "market_changed"}
NAME = {"key": "business_name", "label": "Business name", "type": "text"}
WEBSITE = {"key": "website", "label": "Website", "type": "text"}
INSTAGRAM = {"key": "instagram", "label": "Instagram handle", "type": "text"}
DAYS = {"key": "days", "label": "Days", "type": "select", "options": ["One", "Two"]}
STORY = {"key": "story", "label": "Your story", "type": "textarea"}
FORM = {"applicationForm": {"fields": [NAME, WEBSITE, INSTAGRAM, DAYS, STORY]}}
OFF = {"enabled": False, "nameQuestion": None, "websiteQuestion": None, "instagramQuestion": None}
ON = {"enabled": True, "nameQuestion": "business_name", "websiteQuestion": "website",
      "instagramQuestion": "instagram"}
#: A form that asks no short text question of its own.
NO_TEXT_FORM = {"applicationForm": {"fields": [DAYS, STORY]}}


def _save(client, body):
    return client.put(f"/markets/{MARKET}/public-map", json=body)


def _entries(world):
    return [entry for entry in world.history.documents if entry.get("kind") == History.PUBLIC_MAP]


class TestTheWrite:
    def test_an_admin_chooses_the_questions_and_turns_the_map_on(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, ON)

        assert response.status_code == 200, response.get_json()
        assert response.get_json() == {"publicMap": ON}
        assert world.markets.doc["publicMap"] == ON

    def test_a_market_never_set_reads_as_off(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {"websiteQuestion": "website"})

        assert response.get_json() == {"publicMap": {**OFF, "websiteQuestion": "website"}}

    def test_a_market_the_product_made_stores_none_first(self, client, world):
        """``POST /markets`` stores ``publicMap: null``, under which no field can be created: the
        first write stores the settings whole."""
        world.market(MarketPhase.MARKET_DAYS, publicMap=None, **FORM)

        response = _save(client, {"nameQuestion": "business_name"})

        assert response.status_code == 200, response.get_json()
        assert world.markets.doc["publicMap"] == {**OFF, "nameQuestion": "business_name"}

    def test_a_question_is_cleared_with_null_and_the_rest_kept(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)

        response = _save(client, {"instagramQuestion": None})

        assert response.get_json() == {"publicMap": {**ON, "instagramQuestion": None}}

    def test_the_map_is_turned_off_whatever_its_questions(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)

        response = _save(client, {"enabled": False, "nameQuestion": None})

        assert response.get_json() == {"publicMap": {**ON, "enabled": False, "nameQuestion": None}}

    @pytest.mark.parametrize("phase", [MarketPhase.DRAFT, MarketPhase.APPLICATIONS,
                                       MarketPhase.ASSIGNMENT, MarketPhase.MARKET_DAYS])
    def test_every_phase_but_archived_takes_it(self, client, world, phase):
        world.market(phase, **FORM)

        assert _save(client, {"nameQuestion": "business_name"}).status_code == 200

    def test_the_market_read_serves_it(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, _id="mongo-market-123", **FORM)
        _save(client, ON)

        assert client.get(f"/markets/{MARKET}").get_json()["market"]["publicMap"] == ON


class TestTheBuiltInBusinessName:
    """The public name may be the built-in business name every form asks (T502, ADR 0042)."""

    def test_it_is_the_public_name_on_a_form_with_no_short_text_question(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **NO_TEXT_FORM)

        response = _save(client, {"enabled": True, "nameQuestion": BUSINESS_NAME_KEY})

        assert response.status_code == 200, response.get_json()
        assert world.markets.doc["publicMap"] == {
            **OFF, "enabled": True, "nameQuestion": "essential_business_name"}

    def test_a_map_already_naming_it_is_turned_on(self, client, world):
        world.market(MarketPhase.MARKET_DAYS,
                     publicMap={**OFF, "nameQuestion": BUSINESS_NAME_KEY}, **NO_TEXT_FORM)

        assert _save(client, {"enabled": True}).status_code == 200
        assert world.markets.doc["publicMap"]["enabled"] is True

    @pytest.mark.parametrize("field", ["websiteQuestion", "instagramQuestion"])
    def test_it_is_no_website_and_no_instagram_question(self, client, world, field):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {field: BUSINESS_NAME_KEY})

        assert response.status_code == 400
        assert response.get_json()["error"] == "Choose one of the form's short text questions."
        assert "publicMap" not in world.markets.doc

    def test_the_history_names_the_choice_business_name(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **NO_TEXT_FORM)

        _save(client, {"nameQuestion": BUSINESS_NAME_KEY})

        [entry] = _entries(world)
        assert entry["detail"] == {
            "before": {"name_question": None, "name_question_label": None},
            "after": {"name_question": "essential_business_name",
                      "name_question_label": "Business name"},
        }

    def test_changing_from_it_to_a_form_question_records_both_labels(self, client, world):
        shop = {"key": "shop", "label": "Shop name", "type": "text"}
        world.market(MarketPhase.MARKET_DAYS, applicationForm={"fields": [shop]},
                     publicMap={**OFF, "nameQuestion": BUSINESS_NAME_KEY})

        _save(client, {"nameQuestion": "shop"})

        [entry] = _entries(world)
        assert entry["detail"] == {
            "before": {"name_question": "essential_business_name",
                       "name_question_label": "Business name"},
            "after": {"name_question": "shop", "name_question_label": "Shop name"},
        }


class TestItsRefusals:
    @pytest.mark.parametrize("body,named", [
        ({"enabled": True, "showEmail": True}, "showEmail"),
        ({"phoneQuestion": "phone"}, "phoneQuestion"),
        ({"name_question": "business_name"}, "name_question"),
    ])
    def test_another_key_is_refused_by_its_name(self, client, world, body, named):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, body)

        assert response.status_code == 400
        assert named in response.get_json()["error"]
        assert "publicMap" not in world.markets.doc

    @pytest.mark.parametrize("enabled", ["true", 1, None, {"$ne": False}])
    def test_the_switch_is_a_boolean(self, client, world, enabled):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {"enabled": enabled, "nameQuestion": "business_name"})

        assert response.status_code == 400
        assert response.get_json()["error"] == "enabled must be true or false."

    @pytest.mark.parametrize("question", [5, True, ["business_name"], {"$ne": ""}])
    def test_a_question_is_a_string_or_null(self, client, world, question):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {"websiteQuestion": question})

        assert response.status_code == 400
        assert response.get_json()["error"] == "websiteQuestion must be a question's key or null."

    @pytest.mark.parametrize("key", ["days", "story", "no_such_question", "essential_full_name"])
    @pytest.mark.parametrize("field", ["nameQuestion", "websiteQuestion", "instagramQuestion"])
    def test_a_question_is_one_of_the_forms_short_text_questions(self, client, world, field, key):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {field: key})

        assert response.status_code == 400
        assert response.get_json()["error"] == "Choose one of the form's short text questions."

    def test_the_map_is_not_turned_on_without_a_name_question(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        response = _save(client, {"enabled": True, "websiteQuestion": "website"})

        assert response.status_code == 400
        assert response.get_json()["error"] == (
            "Choose the question that holds each vendor's public name before turning the public "
            "map on.")
        assert "publicMap" not in world.markets.doc

    def test_nor_is_its_name_question_taken_away_while_it_is_on(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)

        response = _save(client, {"nameQuestion": None})

        assert response.status_code == 400
        assert world.markets.doc["publicMap"] == ON

    def test_nor_left_on_with_a_name_question_the_form_no_longer_asks(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap={**ON, "nameQuestion": "gone"}, **FORM)

        response = _save(client, {"enabled": True})

        assert response.status_code == 400

    @pytest.mark.parametrize("role", [MarketRole.EDITOR, MarketRole.VIEWER])
    def test_the_row_refuses_below_an_admin_in_its_own_words(self, client, world, role):
        world.market(MarketPhase.MARKET_DAYS, role=role, **FORM)

        response = _save(client, ON)

        assert response.status_code == 403
        assert response.get_json()["error"] == Actions.refusal_sentence(Actions.PUBLISH_MAP)
        assert response.get_json()["error"] == (
            "Only an Admin or the owner may turn the public map on or off and choose what it shows.")
        assert "publicMap" not in world.markets.doc

    def test_an_archived_market_refuses_it(self, client, world):
        world.market(MarketPhase.ARCHIVED, publicMap=copy.deepcopy(ON), **FORM)

        response = _save(client, {"enabled": False})

        assert response.status_code == 403
        assert response.get_json()["error"] == MarketsApi.ARCHIVED_REFUSAL
        assert world.markets.doc["publicMap"] == ON

    def test_a_market_whose_settings_changed_since_they_were_read_refuses_it(
            self, client, world, monkeypatch):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)
        load = MarketsApi._market_change

        def read_then_changed_in_another_tab(*args):
            change = load(*args)
            world.markets.doc["publicMap"]["websiteQuestion"] = None
            return change

        monkeypatch.setattr(MarketsApi, "_market_change", read_then_changed_in_another_tab)

        response = _save(client, {"instagramQuestion": None})

        assert response.status_code == 409
        assert response.get_json() == CHANGED
        assert world.markets.doc["publicMap"] == {**ON, "websiteQuestion": None}
        assert _entries(world) == []


class TestTheHistory:
    def test_a_change_records_what_changed_with_each_questions_label(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        _save(client, {"enabled": True, "nameQuestion": "business_name"})

        [entry] = _entries(world)
        assert (entry["actor"], entry["action"]) == (ADMIN, Actions.PUBLISH_MAP.id)
        assert entry["detail"] == {
            "before": {"enabled": False, "name_question": None, "name_question_label": None},
            "after": {"enabled": True, "name_question": "business_name",
                      "name_question_label": "Business name"},
        }

    def test_a_question_cleared_records_the_label_it_had(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)

        _save(client, {"instagramQuestion": None})

        [entry] = _entries(world)
        assert entry["detail"] == {
            "before": {"instagram_question": "instagram",
                       "instagram_question_label": "Instagram handle"},
            "after": {"instagram_question": None, "instagram_question_label": None},
        }

    def test_a_write_that_changes_nothing_records_nothing_and_writes_nothing(
            self, client, world):
        world.market(MarketPhase.MARKET_DAYS, publicMap=copy.deepcopy(ON), **FORM)
        before = copy.deepcopy(world.markets.doc)

        response = _save(client, {"enabled": True, "websiteQuestion": "website"})

        assert response.status_code == 200
        assert response.get_json() == {"publicMap": ON}
        assert world.markets.doc == before
        assert _entries(world) == []

    def test_a_refused_write_records_nothing(self, client, world):
        world.market(MarketPhase.MARKET_DAYS, **FORM)

        _save(client, {"nameQuestion": "days"})

        assert _entries(world) == []
