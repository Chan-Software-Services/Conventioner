"""Changed answers are one event, whoever changes them (Daniel's decision 9.1, T277 ticket 02).

The applicant's own edit, a re-import and an organizer's update each treated changed answers
their own way: a re-import sent an approval back to review when an answer the solver reads moved,
the applicant's edit kept every verdict, and nothing said which change undid which. Now one event
of the review state writes the answers and what they do to the verdict, in one update: a change by
the applicant or an import sends a person's approval or rejection back to open, marked for the
deal; an added vendor stays approved, and in any state becomes an applicant; a rule's rejection is
the rules' to judge again; and an organizer's own update keeps every verdict, since they made both.

The applicant's save now holds the application as it read it, as the import's rows do: a verdict
landing inside it is read again and the save lands on what is stored then, three times, and then
the applicant is asked to save again.

Driven through the routes, as an applicant and an organizer reach them.
"""
import pytest

from conftest import applicant_form_version_now, seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import ADMIN, MARKET, _client
from test_csv_import import GOOD_ROW, MAPPING, _csv
from test_csv_import import _market_doc as _import_market_doc
from test_each_arrival_is_dealt import NO_STUDENTS, _id_of, _submit, world  # noqa: F401

import app as app_module
import api.applicants as ApplicantsApi
import api.applications as ApplicationsApi
import application_status as ReviewState
import history as History
from datatypes import ApplicationStatus, MarketPerson, MarketPhase

VENDOR = "v8@vendor.test"
ADDER = MarketPerson(user_id="user-admin", email=ADMIN)
CHANGED = "Changed Wares"


def _doc(world, app_id):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _verdict(app_id, status):
    response = _client(ADMIN).put(f"/markets/{MARKET}/applications/{app_id}/review",
                                  json={"status": status, "seen": seen_as_stored(app_id)})
    assert response.status_code == 200, response.get_json()


def _decided(world, status, **answers):
    """``VENDOR`` applied, and an Admin gave ``status``."""
    _submit(world, VENDOR, **answers)
    app_id = _id_of(world, VENDOR)
    _verdict(app_id, status)
    return app_id


def _save(world, **answers):
    """``VENDOR`` saves their application again, as their page sends it."""
    world.vendor = VENDOR
    from test_essential_fields import VALID_ANSWERS

    return app_module.app.test_client().put(
        "/public/markets/test-market/applicant/application",
        json={"formData": {**VALID_ANSWERS, "business_name": VENDOR, **answers},
              "formVersion": applicant_form_version_now("test-market")})


def _edits(world, app_id):
    return [e for e in world.history.documents
            if e["action"] == History.APPLY and e["kind"] == History.EDITED
            and e["subject"]["application_id"] == app_id]


def _update(app_id, **answers):
    response = _client(ADMIN).put(f"/markets/{MARKET}/applications/{app_id}/answers",
                                  json={"answers": answers})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


class TestTheApplicantsSave:
    @pytest.mark.parametrize("status", ["reviewer_approved", "reviewer_rejected"])
    def test_changed_answers_send_a_persons_verdict_back_to_open_marked(self, world, status):
        app_id = _decided(world, status)

        response = _save(world, business_name=CHANGED)

        assert response.status_code == 200, response.get_json()
        doc = _doc(world, app_id)
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert not doc.get("verdict_by") and not doc.get("verdict_at")
        assert doc["form_data"]["business_name"] == CHANGED
        # Marked for the deal by the applicant's save; no reviewer is chosen, so it waits.
        assert doc[ApplicationsApi.ARRIVING_FIELD] == {"actor": VENDOR, "action": History.APPLY}
        [entry] = _edits(world, app_id)
        assert entry["detail"]["returned_to_review"] is True

    def test_answers_saved_unchanged_keep_the_verdict_and_record_nothing(self, world):
        app_id = _decided(world, "reviewer_approved")

        assert _save(world).status_code == 200

        assert _doc(world, app_id)["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert _edits(world, app_id) == []

    def test_a_change_to_an_open_application_says_nothing_of_a_return(self, world):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)

        assert _save(world, business_name=CHANGED).status_code == 200

        [entry] = _edits(world, app_id)
        assert "returned_to_review" not in entry["detail"]
        assert _doc(world, app_id)["status"] == ApplicationStatus.OPEN.value

    def test_a_rules_rejection_is_judged_again_by_the_rules(self, world):
        world.applicant_market(rejectionRules=NO_STUDENTS)
        _submit(world, VENDOR, student="Yes")
        app_id = _id_of(world, VENDOR)
        assert ReviewState.state_of(_doc(world, app_id)) is ReviewState.State.REJECTED_BY_A_RULE

        # Still a student: still the rule's.
        assert _save(world, student="Yes", business_name=CHANGED).status_code == 200
        assert ReviewState.state_of(_doc(world, app_id)) is ReviewState.State.REJECTED_BY_A_RULE
        # No longer: the rules return it.
        assert _save(world, student="No").status_code == 200
        assert _doc(world, app_id)["status"] == ApplicationStatus.OPEN.value

    def test_an_added_vendor_stays_approved_and_becomes_an_applicant(self, world):
        added = ReviewState.add(MARKET, VENDOR, {"essential_full_name": "Walk-in Wares"}, ADDER)

        assert _save(world).status_code == 200

        doc = _doc(world, added.id)
        assert doc["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert doc["origin"] == "applied"
        assert ReviewState.state_of(doc) is ReviewState.State.APPROVED_BY_A_PERSON
        assert ApplicantsApi.organizer_view(doc)["origin"] == "applied"

    def test_an_added_vendor_rejected_goes_back_to_open_as_an_applicant(self, world):
        added = ReviewState.add(MARKET, VENDOR, {"essential_full_name": "Walk-in Wares"}, ADDER)
        _verdict(added.id, ApplicationStatus.REVIEWER_REJECTED.value)

        assert _save(world).status_code == 200

        doc = _doc(world, added.id)
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert doc["origin"] == "applied"
        _verdict(added.id, ApplicationStatus.REVIEWER_APPROVED.value)
        assert ReviewState.state_of(_doc(world, added.id)) is ReviewState.State.APPROVED_BY_A_PERSON


class TestTheOrganizersUpdate:
    @pytest.mark.parametrize("status", [
        "reviewer_approved", "reviewer_rejected", "needs_follow_up"])
    def test_it_keeps_every_verdict(self, world, status):
        app_id = _decided(world, status)
        before = dict(_doc(world, app_id))

        _update(app_id, business_name=CHANGED)

        after = _doc(world, app_id)
        assert ReviewState.state_of(after) is ReviewState.state_of(before)
        assert (after["status"], after.get("verdict_at")) == (status, before.get("verdict_at"))
        # Nothing marked for the deal by the update: no state moved.
        assert after.get(ApplicationsApi.ARRIVING_FIELD) == before.get(
            ApplicationsApi.ARRIVING_FIELD)
        assert after["answer_updates"]["business_name"]["value"] == CHANGED

    def test_an_added_vendor_stays_an_added_one(self, world):
        added = ReviewState.add(MARKET, VENDOR, {"essential_full_name": "Walk-in Wares"}, ADDER)

        served = _update(added.id, business_name=CHANGED)

        assert ReviewState.state_of(_doc(world, added.id)) is ReviewState.State.APPROVED_ADDED
        assert served["origin"] == "added"

    def test_a_rules_rejection_is_judged_again_by_the_rules(self, world):
        world.applicant_market(rejectionRules=NO_STUDENTS)
        _submit(world, VENDOR, student="Yes")
        app_id = _id_of(world, VENDOR)

        _update(app_id, business_name=CHANGED)
        assert ReviewState.state_of(_doc(world, app_id)) is ReviewState.State.REJECTED_BY_A_RULE
        _update(app_id, student="No")
        assert _doc(world, app_id)["status"] == ApplicationStatus.OPEN.value


class TestAReImport:
    def _import(self, row):
        response = _client().post(f"/markets/{MARKET}/applications/import",
                                  json={"csvContent": _csv(row), "mapping": MAPPING})
        assert response.status_code == 200, response.get_json()
        return response.get_json()

    def test_an_unchanged_row_writes_nothing(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        self._import(GOOD_ROW)
        app_id = _id_of(world, "nadia@ember.test")
        _verdict(app_id, "reviewer_approved")
        before = dict(_doc(world, app_id))

        body = self._import(GOOD_ROW)

        assert (body["unchanged"], body["updated"], body["returnedToReview"]) == (1, 0, 0)
        assert _doc(world, app_id) == before

    def test_a_persons_rejection_whose_row_changed_goes_back_to_open(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        self._import(GOOD_ROW)
        app_id = _id_of(world, "nadia@ember.test")
        _verdict(app_id, "reviewer_rejected")

        body = self._import(GOOD_ROW.replace("Ember Ceramics", "Ember Ceramics Studio"))

        assert (body["updated"], body["returnedToReview"]) == (1, 1)
        doc = _doc(world, app_id)
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert doc[ApplicationsApi.ARRIVING_FIELD] == {"actor": ADMIN,
                                                        "action": "import-applications"}


def _before_each_answers_write(monkeypatch, applications, step):
    """Run ``step`` just before each write that stores an application's answers."""
    original = applications.update_one
    calls = []

    def update_one(query, update, **kwargs):
        if "form_data" in (update.get("$set") or {}):
            calls.append(query)
            step(len(calls))
        return original(query, update, **kwargs)

    monkeypatch.setattr(applications, "update_one", update_one)
    return calls


def _approve_directly(world, app_id, at):
    """A reviewer's approval, landing as its own write does, between the save's read and write."""
    world.applications.update_one({"id": app_id}, {"$set": {
        "status": ApplicationStatus.REVIEWER_APPROVED.value, "verdict_at": at,
        "verdict_by": {"kind": "person", "user_id": "user-admin", "email": ADMIN}}})


class TestAVerdictInsideTheSave:
    def test_it_is_read_again_and_the_save_lands_on_it(self, world, monkeypatch):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)

        def a_reviewer_approves(call):
            if call == 1:
                _approve_directly(world, app_id, "2026-11-17T10:00:00+00:00")

        writes = _before_each_answers_write(monkeypatch, world.applications, a_reviewer_approves)
        response = _save(world, business_name=CHANGED)

        assert response.status_code == 200, response.get_json()
        assert len(writes) == 2
        doc = _doc(world, app_id)
        # The approval landed first, on answers nobody judged since: back to open, with them.
        assert doc["form_data"]["business_name"] == CHANGED
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert _edits(world, app_id)[-1]["detail"]["returned_to_review"] is True

    def test_three_moves_in_a_row_ask_the_applicant_to_save_again(self, world, monkeypatch):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)
        before = dict(_doc(world, app_id))

        def a_reviewer_decides_again(call):
            _approve_directly(world, app_id, f"2026-11-17T1{call}:00:00+00:00")

        writes = _before_each_answers_write(
            monkeypatch, world.applications, a_reviewer_decides_again)
        response = _save(world, business_name=CHANGED)

        assert len(writes) == 3
        assert response.status_code == 409
        assert response.get_json() == {
            "error": "Your application changed while it was saved. Save again."}
        assert _doc(world, app_id)["form_data"] == before["form_data"]
        assert _edits(world, app_id) == []


class Stopped(Exception):
    """The host ending the request: the route answers it as any failure, a 500 with no detail."""


class TestASaveCutShort:
    def test_a_save_cut_after_its_write_leaves_the_answers_and_the_state_together(
        self, world, monkeypatch,
    ):
        app_id = _decided(world, "reviewer_approved")
        original = world.applications.update_one

        def update_one(query, update, **kwargs):
            result = original(query, update, **kwargs)
            if "form_data" in (update.get("$set") or {}):
                raise Stopped()  # the event's write landed; nothing after it did
            return result

        monkeypatch.setattr(world.applications, "update_one", update_one)
        assert _save(world, business_name=CHANGED).status_code == 500

        doc = _doc(world, app_id)
        assert doc["form_data"]["business_name"] == CHANGED
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert not doc.get("verdict_by")
        assert doc[ApplicationsApi.ARRIVING_FIELD] == {"actor": VENDOR, "action": History.APPLY}
