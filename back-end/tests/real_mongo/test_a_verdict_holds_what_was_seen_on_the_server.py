"""A person's verdict is held on what the reviewer saw, run on a real server, where the filter is
read: the answers' time they saw is read as a string or null only, so a verdict on answers changed
since they opened the card matches nothing, whatever that time's type."""
import pytest

from datatypes import ApplicationStatus, VerdictGiver

import application_status as ReviewState

ALEX = VerdictGiver(kind="person", user_id="u-alex", email="alex@example.com")

#: Values of every JSON type but a string, for a time a reviewer saw.
NOT_A_TIME = [{"$ne": None}, ["2026-10-01T00:00:00Z"], 20261001, True]


@pytest.fixture
def opened_then_changed(applications):
    """An open application whose answers changed after the reviewer opened it."""
    applications.insert_one({
        "id": "app-seen", "market_id": "market-seen", "applicant_email": "seen@example.com",
        "form_data": {"business": "Fixture Stall"}, "status": ApplicationStatus.OPEN.value,
        "application_type": "main", "verdict_at": None, "updated_at": "2026-10-05T00:00:00Z",
    })
    return applications.find_one({"id": "app-seen"})


@pytest.mark.parametrize("value", NOT_A_TIME)
def test_a_verdict_held_on_a_time_of_another_type_matches_nothing(
        opened_then_changed, applications, value):
    seen = {"status": ApplicationStatus.OPEN.value, "verdict_at": None, "updated_at": value}

    written = ReviewState.give_verdict(
        opened_then_changed, seen, ApplicationStatus.REVIEWER_APPROVED, ALEX)

    assert not written
    after = applications.find_one({"id": "app-seen"})
    assert after["status"] == ApplicationStatus.OPEN.value
    assert "verdict_by" not in after


def test_a_verdict_held_on_the_time_stored_lands(opened_then_changed, applications):
    seen = {"status": ApplicationStatus.OPEN.value, "verdict_at": None,
            "updated_at": "2026-10-05T00:00:00Z"}

    assert ReviewState.give_verdict(
        opened_then_changed, seen, ApplicationStatus.REVIEWER_APPROVED, ALEX)
    assert applications.find_one({"id": "app-seen"})["status"] == (
        ApplicationStatus.REVIEWER_APPROVED.value)
