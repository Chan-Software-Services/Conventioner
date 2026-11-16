"""An added vendor whom a re-import brings in stays approved and is seated by the run (T277 P7).

A vendor added by hand in Assignment holds only a name. After Back to review, a Google Form
market's re-import brought their row: the import saw changed answers, sent the approval back to
review with ``added_by`` kept, and once approved again the run still left them out, since it read
only applications nobody added. Where an application came from is now its own field: the import
moves an added vendor's origin to ``imported`` and keeps the approval, and the run reads every
approved application that is not still an added one.

Driven through the routes, as an organizer reaches it.
"""
from conftest import seen_as_stored
from test_back_to_review import MARKET, OWNER_EMAIL, _back, _begin, _market, world  # noqa: F401

import application_status as ReviewState
import assignment.vendor_input as VendorInput
import essential_fields as EssentialFields
from datatypes import ApplicationStatus

VENDOR = "walk.in@example.com"
HEADERS = ["Email Address", "Full name", "Days", "Table", "Tiers", "Sections", "Shop"]
MAPPING = {
    "applicant_email": 0,
    EssentialFields.FULL_NAME_KEY: 1,
    EssentialFields.AVAILABLE_DATES_KEY: 2,
    EssentialFields.TABLE_CHOICE_KEY: 3,
    EssentialFields.TIER_PREFERENCE_KEY: 4,
    EssentialFields.SECTION_RANKING_KEY: 5,
    "shop": 6,
}
ROW = f'{VENDOR},Walk-in Wares,2099-08-01,full,Gold,"Main Hall, Garden",Kiln'


def _csv(*rows):
    return "\n".join([",".join(HEADERS), *rows])


def _application(world):
    [doc] = [d for d in world.applications.documents if d["applicant_email"] == VENDOR]
    return doc


def _added_then_imported(world):
    """Added in Assignment, the review reopened, and the file imported with their row."""
    world.applications.documents = []
    markets = world.install(_market(intake="csv"))
    added = world.client.post(f"/markets/{MARKET}/vendors",
                              json={"name": "Walk-in Wares", "email": VENDOR})
    assert added.status_code == 201, added.get_json()
    assert _back(world.client).status_code == 200
    imported = world.client.post(f"/markets/{MARKET}/applications/import",
                                 json={"csvContent": _csv(ROW), "mapping": MAPPING})
    assert imported.status_code == 200, imported.get_json()
    return markets, imported.get_json()


class TestAnAddedVendorImported:
    def test_the_import_keeps_their_approval_and_moves_their_origin(self, world):
        _markets, body = _added_then_imported(world)

        doc = _application(world)
        assert doc["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert doc["origin"] == "imported"
        assert doc["form_data"]["shop"] == "Kiln"
        # Who added them stays the record of it.
        assert doc["added_by"]["email"] == OWNER_EMAIL
        assert (body["updated"], body["returnedToReview"]) == (1, 0)

    def test_the_run_reads_them_and_seats_them(self, world):
        markets, _body = _added_then_imported(world)
        assert _begin(world.client).status_code == 200

        ran = world.client.post(f"/markets/{MARKET}/assignment")

        assert ran.status_code == 200, ran.get_json()
        seats = markets.doc["assignmentObject"]["vendorAssignments"]
        assert [(seat["email"], seat["handPlaced"]) for seat in seats] == [(VENDOR, False)]
        assert _application(world)["status"] == ApplicationStatus.REVIEWER_APPROVED.value

    def test_one_still_added_is_left_to_be_seated_by_hand(self, world):
        world.applications.documents = []
        world.install(_market(intake="csv"))
        added = world.client.post(f"/markets/{MARKET}/vendors",
                                  json={"name": "Walk-in Wares", "email": VENDOR})
        assert added.status_code == 201, added.get_json()

        vendors, _incomplete = VendorInput.approved_solver_vendors(
            MARKET, EssentialFields.effective_essential_options({}))

        assert vendors == []
        assert _application(world)["origin"] == "added"


def _verdict(world, status):
    app_id = _application(world)["id"]
    response = world.client.put(f"/markets/{MARKET}/applications/{app_id}/review",
                                json={"status": status, "seen": seen_as_stored(app_id)})
    assert response.status_code == 200, response.get_json()


class TestAnAddedVendorRejectedThenImported:
    """An added vendor whose approval was changed to a rejection, then imported with their row: the
    rejection goes back to Open, as any person's does, and their answers make them an applicant, so
    once approved again they are approved by a person and the run seats them."""

    def _rejected_then_imported(self, world):
        world.applications.documents = []
        markets = world.install(_market(intake="csv"))
        added = world.client.post(f"/markets/{MARKET}/vendors",
                                  json={"name": "Walk-in Wares", "email": VENDOR})
        assert added.status_code == 201, added.get_json()
        assert _back(world.client).status_code == 200
        _verdict(world, ApplicationStatus.REVIEWER_REJECTED.value)
        imported = world.client.post(f"/markets/{MARKET}/applications/import",
                                     json={"csvContent": _csv(ROW), "mapping": MAPPING})
        assert imported.status_code == 200, imported.get_json()
        return markets, imported.get_json()

    def test_the_import_returns_them_to_open_as_an_import(self, world):
        _markets, body = self._rejected_then_imported(world)

        doc = _application(world)
        assert doc["status"] == ApplicationStatus.OPEN.value
        assert doc["origin"] == "imported"
        assert body["returnedToReview"] == 1

    def test_approved_again_they_are_seated_by_the_run(self, world):
        markets, _body = self._rejected_then_imported(world)
        _verdict(world, ApplicationStatus.REVIEWER_APPROVED.value)
        assert ReviewState.state_of(_application(world)) is ReviewState.State.APPROVED_BY_A_PERSON
        assert _begin(world.client).status_code == 200

        ran = world.client.post(f"/markets/{MARKET}/assignment")

        assert ran.status_code == 200, ran.get_json()
        seats = markets.doc["assignmentObject"]["vendorAssignments"]
        assert [(seat["email"], seat["handPlaced"]) for seat in seats] == [(VENDOR, False)]
