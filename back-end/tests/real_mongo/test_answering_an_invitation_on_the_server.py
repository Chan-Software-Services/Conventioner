"""Accepting an invitation on a real server (T538): two accepts at once give one role and one
entry, and an accept landing on a market whose roles moved since its read judges again in the same
request, ending the invitation it claimed when the inviter can no longer give it; the same for an
organization's place.

Accepting reads the market, judges the inviter's right and the invitee's role, claims the invitation
and writes the role holding both as read (``_write_role``); an organization's place is written
holding the inviter's key and the invitee's as read (``organization_people._write``). The hermetic
suite lands the change through a fake that applies the holds; these run them where the conditional
write is the server's.
"""
from datetime import datetime

import pytest

import api.markets as MarketsApi
import organization_people as OrganizationPeople
import sign_in_limits
from datatypes import MarketPhase, MarketRole
from real_mongo.test_a_judged_write_lands_only_on_the_market_it_judged import _history, _stored

OWNER = "fixture-owner@example.com"
ADMIN = "fixture-admin@example.com"
INVITED = "fixture-invited@example.com"
READ = "api.markets.load_market_context"


@pytest.fixture
def mail(monkeypatch):
    import utils.email as Email
    monkeypatch.setattr(Email, "send_mail", lambda *_args: True)


@pytest.fixture
def invited(boot_indexes, signed_in, market_in, mail):
    """A market in Applications with its owner and an Admin, and an account the Admin invited as an
    Editor, each signed in; the invitation's id."""
    owner, admin, invitee = signed_in(OWNER), signed_in(ADMIN), signed_in(INVITED)
    market = market_in(MarketPhase.APPLICATIONS, roles={
        owner.account_id: "owner", admin.account_id: "admin"})
    response = admin.post(f"/markets/{market['id']}/invitations",
                          json={"email": INVITED, "role": "editor"})
    assert response.status_code == 200, response.get_json()
    return market, owner, admin, invitee, response.get_json()["invitation"]["id"]


def _given(market_records, market):
    return [entry for entry in _history(market_records, market) if entry["kind"] == "role_given"]


def test_two_accepts_at_once_give_one_role_and_one_entry(invited, race, real_db, market_records):
    market, _owner, _admin, invitee, invitation = invited

    answers = race(2, lambda _i: invitee.post(f"/invitations/{invitation}/accept"))

    statuses = sorted(answer.status_code for answer in answers)
    assert statuses[0] == 200 and statuses[1] in (400, 404), statuses
    assert _stored(real_db, market)["roles"][invitee.account_id] == "editor"
    assert len(_given(market_records, market)) == 1
    assert list(market_records.invitations.find({"id": invitation})) == []


def test_an_accept_landing_after_the_inviters_role_changed_has_ended_it(
        invited, interleave, real_db, market_records):
    market, owner, admin, invitee, invitation = invited
    interleave(READ, lambda: MarketsApi.update_market_role(
        market["id"], admin.account_id, MarketRole.VIEWER, owner.email))

    response = invitee.post(f"/invitations/{invitation}/accept")

    assert (response.status_code, response.get_json()["code"]) == (404, "invitation_ended")
    roles = _stored(real_db, market)["roles"]
    assert invitee.account_id not in roles
    assert roles[admin.account_id] == "viewer"
    assert _given(market_records, market) == []
    assert list(market_records.invitations.find({"id": invitation})) == []


def test_an_accept_landing_after_the_invitee_was_given_a_role_writes_nothing(
        invited, interleave, real_db, market_records):
    market, owner, _admin, invitee, invitation = invited
    interleave(READ, lambda: MarketsApi.add_market_role(
        market["id"], INVITED, MarketRole.VIEWER, owner.email))

    response = invitee.post(f"/invitations/{invitation}/accept")

    assert response.status_code == 400, response.get_json()
    assert _stored(real_db, market)["roles"][invitee.account_id] == "viewer"
    assert len(_given(market_records, market)) == 1
    assert list(market_records.invitations.find({"id": invitation})) == []


def test_the_invitee_lists_it_by_name_and_accepting_takes_its_counts_back(invited):
    """The list's reads, and the take-back's window over a time the driver hands back zoneless."""
    market, _owner, admin, invitee, invitation = invited

    listed = invitee.get("/invitations").get_json()["invitations"]
    assert [(row["id"], row["targetName"]) for row in listed] == [(invitation, market["name"])]

    assert invitee.post(f"/invitations/{invitation}/accept").status_code == 200

    sent = datetime.fromisoformat(listed[0]["sentAt"])
    keys = [sign_in_limits._window(limit, subject, sent)[0] for limit, subject in (
        (sign_in_limits.INVITATION_PER_INVITER, admin.account_id),
        (sign_in_limits.INVITATION_PER_ADDRESS, INVITED))]
    assert [sign_in_limits.attempts_collection.find_one({"_id": key})["count"]
            for key in keys] == [0, 0]


ORGANIZATION_READ = "organization_people.organization_people_of"


@pytest.fixture
def invited_to_an_organization(boot_indexes, signed_in, real_db, mail):
    """An organization with its owner and an admin, and an account the admin invited as a member,
    each signed in; the organization's id and the invitation's."""
    owner, admin, invitee = signed_in(OWNER), signed_in(ADMIN), signed_in(INVITED)
    org_id = "org-invited"
    people = {owner.account_id: "owner", admin.account_id: "admin"}
    real_db["organizations"].insert_one({
        "id": org_id, "name": "Invited Markets", "people": people, "owner": owner.account_id,
        "admins": [admin.account_id], "members": [], "markets": [], "theme": None})
    response = admin.post(f"/organizations/{org_id}/invitations",
                          json={"email": INVITED, "place": "member"})
    assert response.status_code == 200, response.get_json()
    return org_id, owner, admin, invitee, response.get_json()["invitation"]["id"]


def _organization(real_db, org_id):
    return real_db["organizations"].find_one({"id": org_id}, {"_id": 0})


def _placed(market_records, org_id):
    return [entry for entry in market_records.history.find({"organization_id": org_id})
            if entry["kind"] == "role_given"]


def test_two_accepts_of_an_organizations_invitation_give_one_place_and_one_entry(
        invited_to_an_organization, race, real_db, market_records):
    org_id, _owner, _admin, invitee, invitation = invited_to_an_organization

    answers = race(2, lambda _i: invitee.post(f"/invitations/{invitation}/accept"))

    statuses = sorted(answer.status_code for answer in answers)
    assert statuses[0] == 200 and statuses[1] in (400, 404), statuses
    stored = _organization(real_db, org_id)
    assert stored["people"][invitee.account_id] == "member"
    assert stored["members"] == [invitee.account_id]
    assert len(_placed(market_records, org_id)) == 1
    assert list(market_records.invitations.find({"id": invitation})) == []


def test_an_accept_landing_after_the_inviters_place_changed_has_ended_it(
        invited_to_an_organization, interleave, real_db, market_records):
    org_id, owner, admin, invitee, invitation = invited_to_an_organization
    interleave(ORGANIZATION_READ, lambda: OrganizationPeople.change_place(
        org_id, admin.account_id, "member", owner.email))

    response = invitee.post(f"/invitations/{invitation}/accept")

    assert (response.status_code, response.get_json()["code"]) == (404, "invitation_ended")
    stored = _organization(real_db, org_id)
    assert invitee.account_id not in stored["people"]
    assert stored["people"][admin.account_id] == "member"
    assert _placed(market_records, org_id) == []
    assert list(market_records.invitations.find({"id": invitation})) == []
