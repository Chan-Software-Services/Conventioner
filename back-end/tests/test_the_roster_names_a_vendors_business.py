"""The door's roster carries each vendor's business name (T502).

An organizer at the door finds a vendor by the name on their name tag, and for some that is a
business name. Each roster row carries it beside the two names (``vendorBusinessName``), read as
the organizer reads answers: an organizer's update stands over the vendor's own answer, and a
vendor with none, or whose business name an organizer removed, has ``""``.
"""
import pytest

from conftest import FakeApplicationsCollection, FakeMarketsCollection, stored_market

import api.applications as ApplicationsApi
import api.attendance as AttendanceApi
import essential_fields as EF
from datatypes import MarketPhase

MARKET = "market-123"
DAY = "2026-06-10"
ANA, BEN, CY, DEE, ED = (
    "ana@example.com", "ben@example.com", "cy@example.com", "dee@example.com", "ed@example.com",
)


def seat(email, table_code):
    return {
        "email": email, "date": DAY, "tableCode": table_code, "tableChoice": "Full Table",
        "section": "A", "tier": "Platinum", "location": "North Wing",
    }


def application(email, answers, updates=None, application_type="main"):
    return {
        "market_id": MARKET, "applicant_email": email, "application_type": application_type,
        "form_data": {EF.FULL_NAME_KEY: email.split("@")[0].title(), **answers},
        **({"answer_updates": updates} if updates else {}),
    }


def update(value, over=None):
    return {"value": value, "by": "owner@example.com", "at": "2026-06-01T09:00:00Z", "over": over}


@pytest.fixture
def roster(monkeypatch):
    """A running market's roster: four vendors seated on a day, and one checked in with no seat."""
    market = stored_market(
        phase=MarketPhase.MARKET_DAYS,
        setupObject={"marketDates": [{"date": DAY}]},
        assignmentObject={"vendorAssignments": [
            seat(ANA, "A 1"), seat(BEN, "A 2"), seat(CY, "A 3"), seat(DEE, "A 4"),
        ]},
    )
    applications = FakeApplicationsCollection()
    applications.documents = [
        application(ANA, {EF.BUSINESS_NAME_KEY: "Paper & Pine"}),
        # A vendor who gave none stores no key at all.
        application(BEN, {}),
        # An organizer corrected the spelling: their update stands over the vendor's answer.
        application(
            CY, {EF.BUSINESS_NAME_KEY: "Cy Ceramcs"},
            {EF.BUSINESS_NAME_KEY: update("Cy Ceramics", over="Cy Ceramcs")}),
        # An organizer removed it: the update is "", which reads as none.
        application(
            DEE, {EF.BUSINESS_NAME_KEY: "Dee's Dyes"},
            {EF.BUSINESS_NAME_KEY: update("", over="Dee's Dyes")}),
        application(ED, {EF.BUSINESS_NAME_KEY: "  Ed's Eggs  "}),
    ]
    attendance = FakeApplicationsCollection()
    attendance.documents = [{
        "market_id": MARKET, "vendor_email": ED, "date": DAY, "table_code": "A 9",
        "checked_in_at": "2026-06-10T09:00:00+00:00",
    }]
    monkeypatch.setattr(AttendanceApi, "markets_collection", FakeMarketsCollection(market))
    monkeypatch.setattr(AttendanceApi, "attendance_collection", attendance)
    monkeypatch.setattr(ApplicationsApi, "applications_collection", applications)
    monkeypatch.setattr(ApplicationsApi, "ensure_application_indexes", lambda: None)
    rows = AttendanceApi.attendance_roster(market)["roster"]
    return {row["vendorEmail"]: row for row in rows}


class TestTheRosterNamesAVendorsBusiness:
    def test_a_seated_row_carries_the_business_name_the_vendor_gave(self, roster):
        assert roster[ANA]["vendorBusinessName"] == "Paper & Pine"
        # Beside the name, never in its place.
        assert roster[ANA]["vendorName"] == "Ana"

    def test_a_vendor_who_gave_none_has_an_empty_one(self, roster):
        assert roster[BEN]["vendorBusinessName"] == ""

    def test_an_organizers_update_stands_over_the_vendors_answer(self, roster):
        assert roster[CY]["vendorBusinessName"] == "Cy Ceramics"

    def test_a_business_name_an_organizer_removed_reads_as_none(self, roster):
        assert roster[DEE]["vendorBusinessName"] == ""

    def test_a_row_with_no_seat_carries_it_too_stripped(self, roster):
        assert roster[ED]["state"] == AttendanceApi.HERE_WITHOUT_SEAT
        assert roster[ED]["vendorBusinessName"] == "Ed's Eggs"


class TestReadingBusinessNamesOffTheApplications:
    def _names(self, monkeypatch, docs):
        applications = FakeApplicationsCollection()
        applications.documents = docs
        monkeypatch.setattr(ApplicationsApi, "applications_collection", applications)
        monkeypatch.setattr(ApplicationsApi, "ensure_application_indexes", lambda: None)
        return ApplicationsApi.vendor_business_names_for_market(MARKET)

    def test_only_a_vendor_with_a_business_name_has_an_entry_keyed_lowercased(self, monkeypatch):
        names = self._names(monkeypatch, [
            application("Ana@Example.com", {EF.BUSINESS_NAME_KEY: "Paper & Pine"}),
            application(BEN, {}),
            application(CY, {EF.BUSINESS_NAME_KEY: "   "}),
            application(DEE, {EF.BUSINESS_NAME_KEY: 7}),
        ])

        assert names == {ANA: "Paper & Pine"}

    def test_another_markets_applications_are_not_read(self, monkeypatch):
        names = self._names(monkeypatch, [
            {**application(ANA, {EF.BUSINESS_NAME_KEY: "Paper & Pine"}), "market_id": "other"},
        ])

        assert names == {}

    def test_the_main_application_answers_for_a_vendor_who_holds_a_waitlist_one_too(
        self, monkeypatch,
    ):
        names = self._names(monkeypatch, [
            application(ANA, {EF.BUSINESS_NAME_KEY: "Paper & Pine"}),
            application(ANA, {EF.BUSINESS_NAME_KEY: "Pine Only"}, application_type="waitlist"),
        ])

        assert names == {ANA: "Paper & Pine"}
