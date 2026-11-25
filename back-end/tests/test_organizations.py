"""
Unit tests for organization CRUD operations and role management.
"""
import pytest
import sys
import os
import uuid
from types import SimpleNamespace

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import FakeOrganizations, install_organizations
from test_the_organizations_history import History_

import api.organizations as OrgsApi
import history as History
from client_errors import ConflictError
from datatypes import Organization, organization_people_of
from tombstone import DELETING, new_tombstone


def _new_id() -> str:
    return str(uuid.uuid4())


class TestOrganizationStructure:
    """Test organization structure and validation."""

    @pytest.mark.parametrize("people", [
        {"admin-id": "admin", "member-id": "member"},
        {"one": "owner", "two": "owner"},
        {},
    ])
    def test_a_map_with_no_owner_or_two_is_refused(self, people):
        with pytest.raises(ValueError, match="An organization has exactly one owner"):
            Organization(id=_new_id(), name="Test Org", people=people, markets=[])

    def test_a_place_that_is_not_one_of_the_three_is_refused(self):
        with pytest.raises(ValueError):
            Organization(
                id=_new_id(), name="Test Org", markets=[],
                people={"owner-id": "owner", "someone": "superuser"},
            )

    def test_a_people_that_is_not_a_map_is_refused(self):
        with pytest.raises(ValueError):
            Organization(id=_new_id(), name="Test Org", markets=[], people=["owner-id"])


    def test_organization_role_structure(self):
        """Test organization role structure."""
        org = Organization(
            id=_new_id(),
            name="Test Org",
            people={"owner-id": "owner", "admin1-id": "admin", "admin2-id": "admin",
                    "member1-id": "member", "member2-id": "member"},
            markets=["market1-id", "market2-id"]
        )

        assert list(org.people.items()) == [
            ("owner-id", "owner"), ("admin1-id", "admin"), ("admin2-id", "admin"),
            ("member1-id", "member"), ("member2-id", "member"),
        ]
        assert len(org.markets) == 2

    def test_an_organization_with_no_people_map_is_refused(self):
        """The lists are no longer read (T583): an organization with only them grants nobody."""
        with pytest.raises(ValueError):
            Organization(id=_new_id(), name="Test Org", owner="owner-id", admins=["a"],
                         members=["m"], markets=[])

    def test_a_stored_document_whose_stale_lists_disagree_with_its_map_parses_to_the_map(self):
        """Until the migration removes them, a stored organization still carries the lists; the
        model reads its map and names no list (T583)."""
        org = Organization(**{
            "id": "org-1", "name": "Test Org", "markets": [],
            "people": {"new-owner": "owner", "old-owner": "admin", "member-id": "member"},
            "owner": "old-owner", "admins": ["new-owner", "gone-id"], "members": [],
        })

        assert org.people == {"new-owner": "owner", "old-owner": "admin", "member-id": "member"}
        assert set(org.model_dump()) == {"id", "name", "people", "markets", "theme"}


class TestTheOneRead:
    """``organization_people_of``, the one read of a raw document's people: its map alone."""

    def test_a_document_with_people_reads_its_map(self):
        people = {"x": "owner", "o": "admin"}
        assert organization_people_of({"people": people}) == people

    def test_a_documents_stale_lists_are_not_read(self):
        people = {"x": "owner", "o": "admin"}
        assert organization_people_of({"people": people, "owner": "o", "admins": ["x"],
                                       "members": ["m"]}) == people

    @pytest.mark.parametrize("document", [
        {"owner": "o", "admins": ["a"], "members": ["m"]},
        {"people": None, "owner": "o"},
        {"people": ["o"], "owner": "o"},
        {"people": "o"},
        {},
    ])
    def test_a_document_with_no_people_map_reads_as_nobody(self, document):
        assert organization_people_of(document) == {}


class TestANameIsUniqueAmongYourOrganizations:
    """An organization's name is unique among the live organizations its creator or owner belongs
    to, ignoring case and outer spaces, on create and on rename alike (T352, Q4 a). Nobody else's
    organizations are read for it, so no answer says whether a name is taken elsewhere."""

    OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
    OTHER = SimpleNamespace(id="user-other", email="other@example.com")

    @pytest.fixture
    def stored(self, monkeypatch):
        organizations = install_organizations(monkeypatch, FakeOrganizations(
            {"_id": "o1", "id": "org-mine", "name": "Ember Markets",
             "people": {self.OWNER.id: "owner"}, "markets": []},
            {"_id": "o2", "id": "org-second", "name": "Harbour Fair",
             "people": {self.OWNER.id: "owner"}, "markets": []},
            {"_id": "o3", "id": "org-theirs", "name": "Lantern Collective",
             "people": {self.OTHER.id: "owner"}, "markets": []},
            {"_id": "o4", "id": "org-going", "name": "Willow Night Market",
             "people": {self.OWNER.id: "owner"}, "markets": [],
             DELETING: new_tombstone(self.OWNER.email)},
        ))
        people = {person.email: person for person in (self.OWNER, self.OTHER)}
        monkeypatch.setattr(OrgsApi.UsersApi, "get_user", people.get)
        history = History_()
        monkeypatch.setattr(History, "history_collection", history)
        return organizations

    def names(self, stored):
        return sorted(doc["name"] for doc in stored.docs)

    @pytest.mark.parametrize("name", ["Ember Markets", "ember markets", "EMBER MARKETS",
                                      "  Ember Markets  "])
    def test_creating_one_named_as_one_of_yours_is_refused(self, stored, name):
        with pytest.raises(ConflictError) as refused:
            OrgsApi.create_organization(self.OWNER.email, name)

        assert refused.value.status == 409
        assert refused.value.message == (
            'You already belong to an organization named "Ember Markets".')
        assert self.names(stored).count("Ember Markets") == 1

    def test_one_you_are_a_member_of_counts_as_yours(self, stored):
        stored.docs[2]["people"][self.OWNER.id] = "member"

        with pytest.raises(ConflictError, match='named "Lantern Collective"'):
            OrgsApi.create_organization(self.OWNER.email, "lantern collective")

    def test_creating_one_named_as_another_persons_is_allowed(self, stored):
        OrgsApi.create_organization(self.OWNER.email, "Lantern Collective")

        assert self.names(stored).count("Lantern Collective") == 2

    def test_creating_one_named_as_one_being_deleted_is_allowed(self, stored):
        OrgsApi.create_organization(self.OWNER.email, "Willow Night Market")

        assert self.names(stored).count("Willow Night Market") == 2

    def test_creating_one_named_as_one_deleted_is_allowed(self, stored, monkeypatch):
        monkeypatch.setattr(OrgsApi, "markets_collection",
                            SimpleNamespace(find=lambda _q, _projection=None: iter([])))
        monkeypatch.setattr(OrgsApi.DeletionTrail, "is_recorded", lambda _trail_id: False)
        monkeypatch.setattr(OrgsApi.DeletionTrail, "record_organization_deletion",
                            lambda *_args: None)
        OrgsApi.delete_organization("org-mine", self.OWNER.email)

        OrgsApi.create_organization(self.OWNER.email, "Ember Markets")

        assert self.names(stored).count("Ember Markets") == 1

    def test_the_names_compared_are_your_live_organizations_alone(self, stored):
        OrgsApi.create_organization(self.OWNER.email, "Something New")

        assert all(query != {"name": "Something New"} for query in stored.queries), \
            "no lookup of the name across every organization"

    @pytest.mark.parametrize("name", ["Harbour Fair", "harbour fair "])
    def test_renaming_onto_another_of_yours_is_refused(self, stored, name):
        with pytest.raises(ConflictError) as refused:
            OrgsApi.update_organization("org-mine", self.OWNER.email, name)

        assert refused.value.message == (
            'You already belong to an organization named "Harbour Fair".')
        assert stored.docs[0]["name"] == "Ember Markets"

    def test_renaming_to_its_own_name_in_other_capitals_is_allowed(self, stored):
        OrgsApi.update_organization("org-mine", self.OWNER.email, "EMBER markets")

        assert stored.docs[0]["name"] == "EMBER markets"

    def test_renaming_onto_another_persons_name_is_allowed(self, stored):
        OrgsApi.update_organization("org-mine", self.OWNER.email, "Lantern Collective")

        assert stored.docs[0]["name"] == "Lantern Collective"
