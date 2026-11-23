"""A vendor's save from a page drawn from an older form is refused (T507).

The vendor's page reads, with the form, the form's version as the page draws it: its own questions
and what the essential questions offer. Every save carries that version, and a save whose version
is not the form's version now is answered 409 ``form_changed`` before anything is judged or
written, so no answer lands against a form the vendor never saw, and a reload brings them the form
as it now asks.

The world's market already holds applications, so the form lock refuses its form route: each test
changes the stored market document in place (``world.markets.doc``), as a trip back to draft would
leave it; the form's write and its lock are their own tests'.

Driven through the routes, as the vendor's page reaches them.
"""
import copy

import pytest

from conftest import applicant_form_version_now, seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import ADMIN, MARKET, _client
from test_each_arrival_is_dealt import BUSINESS, STUDENT, world  # noqa: F401
from test_essential_fields import VALID_ANSWERS

import app as app_module
import api.applicants as ApplicantsApi
import essential_fields as EF
from datatypes import ApplicationStatus, MarketPhase

VENDOR = "stale@vendor.test"
SLUG = "test-market"
WEBSITE = {"key": "website", "label": "Website", "type": "text", "required": False,
           "options": [], "order": 2}


def _read_version():
    """The form version the vendor's page reads with the form."""
    return applicant_form_version_now(SLUG)


def _save(world, form_version, **answers):
    """``VENDOR`` saves, as their page sends it, carrying ``form_version``."""
    return _send(world, {"formVersion": form_version}, answers)


def _save_from_an_old_tab(world, **answers):
    """``VENDOR`` saves from a tab opened before the form version existed, which names none."""
    return _send(world, {}, answers)


def _send(world, version_part, answers):
    world.vendor = VENDOR
    return app_module.app.test_client().put(
        f"/public/markets/{SLUG}/applicant/application",
        json={"formData": {**VALID_ANSWERS, "business_name": "Paper & Pine", **answers},
              **version_part})


def _theirs(world):
    return [d for d in world.applications.documents if d["applicant_email"] == VENDOR]


def _form(world):
    return world.markets.doc["applicationForm"]


def _a_question_added_and_one_taken_away(world):
    """The organizer, back in draft, took the student question away and asked a website."""
    _form(world)["fields"] = [BUSINESS, WEBSITE]
    world.markets.doc["formRevision"] = world.markets.doc.get("formRevision", 0) + 1


def _refused(response):
    assert response.status_code == 409, response.get_json()
    assert response.get_json() == {
        "error": "This form changed since you opened it. Reload to continue.",
        "code": "form_changed",
    }


def _approved(world):
    """``VENDOR`` applied from the form as it is and an Admin approved them."""
    assert _save(world, _read_version(), student="No").status_code == 200
    [doc] = _theirs(world)
    response = _client(ADMIN).put(
        f"/markets/{MARKET}/applications/{doc['id']}/review",
        json={"status": "reviewer_approved", "seen": seen_as_stored(doc["id"])})
    assert response.status_code == 200, response.get_json()
    return doc["id"]


class TestTheFormsVersion:
    def test_the_read_serves_it_and_a_save_carrying_it_is_taken(self, world):
        version = _read_version()

        assert isinstance(version, str) and version
        assert _save(world, version).status_code == 200
        [doc] = _theirs(world)
        assert doc["form_data"]["business_name"] == "Paper & Pine"

    def test_the_read_and_the_save_hold_the_same_one(self, world):
        assert _read_version() == ApplicantsApi.applicant_form_version(world.markets.doc)


class TestASaveFromAnOlderForm:
    def test_is_refused_and_leaves_nothing_for_a_vendor_who_had_not_applied(self, world):
        version = _read_version()
        _a_question_added_and_one_taken_away(world)
        history = copy.deepcopy(world.history.documents)

        _refused(_save(world, version, student="No"))

        assert _theirs(world) == []
        assert _form(world).get("essentialOptions") is None
        assert world.history.documents == history

    def test_is_refused_and_leaves_an_approved_application_as_it_was(self, world):
        app_id = _approved(world)
        version = _read_version()
        _a_question_added_and_one_taken_away(world)
        before = copy.deepcopy(_theirs(world))
        history = copy.deepcopy(world.history.documents)

        _refused(_save(world, version, student="Yes", business_name="Other Wares"))

        assert _theirs(world) == before
        assert before[0]["id"] == app_id
        assert before[0]["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert world.history.documents == history

    def test_is_refused_when_the_plans_dates_changed_before_any_offering_froze(self, world):
        version = _read_version()
        world.markets.doc["setupObject"]["marketDates"].append({"date": "2026-08-22"})
        assert _form(world).get("essentialOptions") is None

        _refused(_save(world, version))

        assert _theirs(world) == []

    def test_is_refused_the_same_way_when_sent_again(self, world):
        version = _read_version()
        _a_question_added_and_one_taken_away(world)

        _refused(_save(world, version))
        _refused(_save(world, version))

        assert _theirs(world) == []

    @pytest.mark.parametrize("sent", [None, 7, ["a version"]], ids=["null", "a number", "a list"])
    def test_naming_a_version_that_is_not_a_string_is_refused(self, world, sent):
        _refused(_save(world, sent))

        assert _theirs(world) == []

    def test_naming_no_version_is_refused_and_leaves_nothing_for_a_vendor_who_had_not_applied(
            self, world):
        history = copy.deepcopy(world.history.documents)

        _refused(_save_from_an_old_tab(world, student="No"))

        assert _theirs(world) == []
        assert _form(world).get("essentialOptions") is None
        assert world.history.documents == history

    def test_naming_no_version_is_refused_and_leaves_an_approved_application_as_it_was(
            self, world):
        app_id = _approved(world)
        before = copy.deepcopy(_theirs(world))
        history = copy.deepcopy(world.history.documents)

        _refused(_save_from_an_old_tab(world, student="Yes", business_name="Other Wares"))

        assert _theirs(world) == before
        assert before[0]["id"] == app_id
        assert before[0]["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert world.history.documents == history

    def test_to_a_market_no_longer_taking_applications_says_so(self, world):
        version = _read_version()
        _a_question_added_and_one_taken_away(world)
        world.markets.doc["phase"] = MarketPhase.ASSIGNMENT.value

        response = _save(world, version)

        assert response.status_code == 403, response.get_json()
        assert response.get_json()["error"].startswith(
            "Applications are no longer open for this market.")


class TestWhatTheVendorCannotSee:
    def test_a_form_saved_unchanged_and_a_layout_saved_leave_the_version_and_a_save_is_taken(
            self, world):
        version = _read_version()
        # A form save that changed nothing counts the form's revision; a layout save past draft
        # counts the plan's and moves its tables, which no question offers.
        world.markets.doc["formRevision"] = world.markets.doc.get("formRevision", 0) + 1
        world.markets.doc["planRevision"] = world.markets.doc.get("planRevision", 0) + 1
        floorplan = world.markets.doc["setupObject"]["floorplans"][1]
        floorplan["tables"] = [
            {"id": "t1", "tableTypeId": "Full Table", "xMm": 400.0, "yMm": 900.0}]
        floorplan["revision"] = floorplan.get("revision", 0) + 1

        assert _read_version() == version
        assert _save(world, version).status_code == 200

    def test_a_phase_move_leaves_the_version(self, world):
        version = _read_version()
        world.markets.doc["phase"] = MarketPhase.ASSIGNMENT.value

        assert _read_version() == version


def _version(doc):
    return ApplicantsApi.applicant_form_version(doc)


class TestWhatTheVersionCovers:
    """One part the vendor sees at a time, through the one function the read and the save call."""

    @pytest.fixture
    def doc(self, world):
        return copy.deepcopy(world.markets.doc)

    @pytest.mark.parametrize("part, value", [
        ("label", "Are you studying?"),
        ("helpText", "Full-time students only."),
        ("options", ["Yes", "No", "Not sure"]),
        ("required", True),
    ])
    def test_a_questions_own_part_moves_it(self, doc, part, value):
        before = _version(doc)
        doc["applicationForm"]["fields"][1][part] = value

        assert _version(doc) != before

    def test_the_order_moves_it(self, doc):
        before = _version(doc)
        doc["applicationForm"]["fields"][1]["order"] = 5

        assert _version(doc) != before

    def test_a_question_added_moves_it(self, doc):
        before = _version(doc)
        doc["applicationForm"]["fields"].append(WEBSITE)

        assert _version(doc) != before

    def test_an_unasked_essential_moves_it(self, doc):
        before = _version(doc)
        doc["applicationForm"]["unaskedEssentials"] = [EF.SECTION_RANKING_KEY]

        assert _version(doc) != before

    def test_a_frozen_offering_wins_over_a_changed_plan(self, doc):
        doc["applicationForm"]["essentialOptions"] = EF.essential_options_payload(
            EF.effective_essential_options(doc))
        before = _version(doc)
        doc["setupObject"]["marketDates"].append({"date": "2026-08-22"})
        doc["setupObject"]["sections"].append({"name": "Annex", "count": 2})

        assert _version(doc) == before

    def test_a_market_with_no_form_has_one(self, doc):
        doc["applicationForm"] = None

        assert isinstance(_version(doc), str)
        assert _version(doc) != _version({**doc, "applicationForm": {"fields": [STUDENT]}})
