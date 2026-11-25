"""The organizations read names everyone in one database read, and serves each person with their id (T204).

The Organizations page and Manage organization read every organization the reader is in, and the
read looked up each owner, admin and member by id, one database read each: an organization of 150
members cost 150 reads on every open. It now reads its organizations, then every person all of them
name in one ``get_users_by_ids``.

It serves each organization's admins and members as ``{userId, email}`` pairs, ``adminPeople`` and
``memberPeople``, in the stored order, an account that is gone left out. Manage organization paired
``adminEmails[idx]`` with ``admins[idx]``, so one deleted account shifted every later row onto the
next person's id, and Remove named one person and removed another. The address lists kept for a
tab on the old bundle went with the old ``owner``, ``admins`` and ``members`` lists (T583): every
person is served from the people map alone.
"""
import copy
from types import SimpleNamespace

import pytest

from conftest import mongo_matches
import api.organizations as OrgsApi
import api.users as UsersApi

READER = SimpleNamespace(id="user-reader", email="reader@example.com")
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
ADA = SimpleNamespace(id="user-ada", email="ada@example.com")
GONE = SimpleNamespace(id="user-gone", email="gone@example.com")
BEA = SimpleNamespace(id="user-bea", email="bea@example.com")
CAL = SimpleNamespace(id="user-cal", email="cal@example.com")
DEV = SimpleNamespace(id="user-dev", email="dev@example.com")
PEOPLE = (READER, OWNER, ADA, BEA, CAL, DEV)


class Organizations:
    """The organizations collection, answering the list's filter as the server does."""

    def __init__(self, *docs):
        self.docs = [copy.deepcopy(doc) for doc in docs]

    def find(self, query):
        return [copy.deepcopy(doc) for doc in self.docs if mongo_matches(doc, query)]


class Markets:
    def find(self, _query, _projection=None):
        return []


def organization(org_id, owner, admins, members):
    """An organization as it is stored, its people map holding the owner, then each admin, then
    each member, in that order."""
    return {
        "_id": f"mongo-{org_id}", "id": org_id, "name": f"Example {org_id}",
        "people": {
            owner.id: "owner",
            **{person.id: "admin" for person in admins},
            **{person.id: "member" for person in members},
        },
        "markets": [], "theme": None,
    }


def folded(org_id, people):
    """An organization stored with its people map (T283), ``people`` its (person, place) pairs in
    the map's order."""
    return {
        "_id": f"mongo-{org_id}", "id": org_id, "name": f"Example {org_id}",
        "people": {person.id: place for person, place in people},
        "markets": [], "theme": None,
    }


@pytest.fixture
def reads(monkeypatch):
    """Install the organizations and count every read of an account: by address, alone by id, and
    each batch by id. ``GONE`` names an account that has been deleted."""
    by_id = {person.id: person for person in PEOPLE}
    counted = SimpleNamespace(by_email=[], by_id=[], batches=[])

    def get_user(email):
        counted.by_email.append(email)
        return next((person for person in PEOPLE if person.email == email), None)

    def get_user_by_id(user_id):
        counted.by_id.append(user_id)
        return by_id.get(user_id)

    def get_users_by_ids(user_ids):
        user_ids = list(user_ids)
        counted.batches.append(user_ids)
        return {user_id: by_id[user_id] for user_id in user_ids if user_id in by_id}

    monkeypatch.setattr(UsersApi, "get_user", get_user)
    monkeypatch.setattr(UsersApi, "get_user_by_id", get_user_by_id)
    monkeypatch.setattr(UsersApi, "get_users_by_ids", get_users_by_ids)
    monkeypatch.setattr(OrgsApi, "markets_collection", Markets())

    def install(*docs):
        monkeypatch.setattr(OrgsApi, "organizations_collection", Organizations(*docs))
        return counted

    return install


def test_every_person_of_every_organization_is_read_at_once(reads):
    counted = reads(
        organization("org-1", OWNER, [READER, ADA], [BEA, CAL]),
        organization("org-2", READER, [DEV], [ADA, CAL]),
    )

    listed = OrgsApi.get_organizations_for_user(READER.email)

    assert [org["id"] for org in listed] == ["org-1", "org-2"]
    # The reader, by the address they signed in with; everyone else in one batch, never alone.
    assert counted.by_email == [READER.email]
    assert counted.by_id == []
    [batch] = counted.batches
    assert set(batch) == {OWNER.id, READER.id, ADA.id, BEA.id, CAL.id, DEV.id}


def test_an_organization_serves_its_people_with_their_ids_in_the_stored_order(reads):
    reads(organization("org-1", OWNER, [READER, ADA], [CAL, BEA]))

    [listed] = OrgsApi.get_organizations_for_user(READER.email)

    assert listed["adminPeople"] == [
        {"userId": READER.id, "email": READER.email}, {"userId": ADA.id, "email": ADA.email},
    ]
    assert listed["memberPeople"] == [
        {"userId": CAL.id, "email": CAL.email}, {"userId": BEA.id, "email": BEA.email},
    ]
    assert listed["ownerEmail"] == listed["owner_email"] == OWNER.email
    # Neither the old lists nor the addresses kept for the old bundle are served (T583).
    assert not {"owner", "admins", "members", "adminEmails", "admin_emails", "memberEmails",
                "member_emails"} & set(listed)


def test_a_deleted_admin_leaves_every_other_admin_with_their_own_id(reads):
    reads(organization("org-1", READER, [ADA, GONE, BEA, CAL], [DEV]))

    [listed] = OrgsApi.get_organizations_for_user(READER.email)

    # The stored map still names the gone account; the pairs leave it out and shift no one.
    assert listed["people"][GONE.id] == "admin"
    assert listed["adminPeople"] == [
        {"userId": ADA.id, "email": ADA.email},
        {"userId": BEA.id, "email": BEA.email},
        {"userId": CAL.id, "email": CAL.email},
    ]


def test_a_deleted_owner_serves_no_owner_address(reads):
    reads(organization("org-1", GONE, [READER], [DEV]))

    [listed] = OrgsApi.get_organizations_for_user(READER.email)

    assert "ownerEmail" not in listed
    assert "owner_email" not in listed


def test_a_reader_in_no_organization_reads_no_account_by_id(reads):
    counted = reads(organization("org-1", OWNER, [ADA], [BEA]))

    assert OrgsApi.get_organizations_for_user(READER.email) == []
    assert counted.by_id == []
    assert not any(counted.batches)


def test_an_organization_with_stale_lists_serves_its_people_from_the_map_in_its_order(reads):
    """Lists it still stores until the migration removes them, which disagree with its map, are
    never read: its owner, admins and members are served from the map alone, in the map's order,
    and a member made an admin is listed once, among the admins (T283, T583)."""
    stale = {"owner": DEV.id, "admins": [ADA.id, DEV.id], "members": [CAL.id, READER.id, BEA.id]}
    reads({
        **folded("org-1", [(CAL, "member"), (OWNER, "owner"), (ADA, "admin"), (READER, "member"),
                           (BEA, "admin")]),
        **stale,
    })

    [listed] = OrgsApi.get_organizations_for_user(READER.email)

    # Served as stored until the migration removes them, never derived again; no screen reads them.
    assert {key: listed[key] for key in stale} == stale
    assert listed["adminPeople"] == [
        {"userId": ADA.id, "email": ADA.email}, {"userId": BEA.id, "email": BEA.email},
    ]
    assert listed["memberPeople"] == [
        {"userId": CAL.id, "email": CAL.email}, {"userId": READER.id, "email": READER.email},
    ]
    assert listed["ownerEmail"] == OWNER.email
    assert listed["userRole"] == "member"
