"""The organizations a person is in are found by one filter, ``organization_people.of_person``, by
their key in its people map alone (T283, ADR 0025, T583): never by the old ``owner``, ``admins`` or
``members`` lists a stored organization may still carry until the migration removes them. Nothing
else spells that query.
"""
from types import SimpleNamespace

import pytest

from conftest import FakeOrganizations, mongo_matches
import api.organizations as OrgsApi
import api.permissions as PermissionsApi
import api.users as UsersApi
import organization_people as OrganizationPeople
from tombstone import live

PERSON = SimpleNamespace(id="user-person", email="person@example.com")
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")


def organization(org_id, people, **lists):
    return {"_id": f"mongo-{org_id}", "id": org_id, "name": org_id, "people": people,
            "markets": [], **lists}


ORGANIZATIONS = (
    organization("their-admin", {OWNER.id: "owner", PERSON.id: "admin"}),
    organization("their-member", {OWNER.id: "owner", PERSON.id: "member"}),
    organization("their-own", {PERSON.id: "owner"}),
    # Not theirs: one whose stale lists still name them, and one they were never in.
    organization("a-stale-list", {OWNER.id: "owner"},
                 owner=PERSON.id, admins=[PERSON.id], members=[PERSON.id]),
    organization("someone-elses", {OWNER.id: "owner", "user-other": "admin"}),
)
THEIRS = {"their-admin", "their-member", "their-own"}


@pytest.mark.parametrize("org", ORGANIZATIONS, ids=lambda org: org["id"])
def test_the_filter_finds_an_organization_by_the_persons_one_place(org):
    assert mongo_matches(org, OrganizationPeople.of_person(PERSON.id)) is (org["id"] in THEIRS)


@pytest.fixture
def stored(monkeypatch):
    collection = FakeOrganizations(*ORGANIZATIONS)
    monkeypatch.setattr(OrgsApi, "organizations_collection", collection)
    monkeypatch.setattr(PermissionsApi, "organizations_collection", collection)
    monkeypatch.setattr(UsersApi, "get_user", {PERSON.email: PERSON, OWNER.email: OWNER}.get)
    return collection


def test_the_markets_list_and_the_organizations_page_find_the_same_organizations(stored):
    assert {org["id"] for org in OrgsApi.organization_documents_of(PERSON.id)} == THEIRS
    assert {org.id for org in PermissionsApi.get_user_organizations(PERSON.email)} == THEIRS
    assert stored.queries == [live(OrganizationPeople.of_person(PERSON.id))] * 2


@pytest.mark.parametrize("not_an_id", [None, "", 7, "a.b", "$where"])
def test_an_id_unfit_for_a_dotted_path_is_a_programming_error(not_an_id):
    with pytest.raises(RuntimeError):
        OrganizationPeople.of_person(not_an_id)
