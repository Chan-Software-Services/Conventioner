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
from datatypes import Organization, organization_people_of, people_from_lists
from tombstone import DELETING, new_tombstone


def _new_id() -> str:
    return str(uuid.uuid4())


class TestOrganizationStructure:
    """Test organization structure and validation."""

    def test_organization_has_owner(self):
        """Test that organization has exactly one owner."""
        org = Organization(
            id=_new_id(),
            name="Test Org",
            owner="owner-id",
            admins=[],
            members=[],
            markets=[]
        )
        assert org.owner == "owner-id"
        assert isinstance(org.admins, list)
        assert isinstance(org.members, list)

    def test_an_owner_also_in_admins_or_members_parses_with_the_owner_winning(self):
        """Stored before the people map, an organization whose owner also stood in ``admins`` or
        ``members`` failed the model and granted nothing on its markets (T283): it parses now."""
        org = Organization(
            id=_new_id(), name="Test Org", owner="owner-id",
            admins=["owner-id", "admin-id"], members=["owner-id", "member-id"], markets=[],
        )

        assert org.people == {"owner-id": "owner", "admin-id": "admin", "member-id": "member"}
        assert (org.owner, org.admins, org.members) == ("owner-id", ["admin-id"], ["member-id"])

    def test_an_admin_also_listed_as_a_member_is_an_admin_once(self):
        org = Organization(
            id=_new_id(), name="Test Org", owner="owner-id",
            admins=["admin-id"], members=["admin-id", "member-id"], markets=[],
        )

        assert org.admins == ["admin-id"]
        assert org.members == ["member-id"]

    def test_a_people_map_overrides_the_lists(self):
        org = Organization(
            id=_new_id(), name="Test Org",
            people={"new-owner": "owner", "old-owner": "admin", "member-id": "member"},
            owner="old-owner", admins=["new-owner"], members=[], markets=[],
        )

        assert (org.owner, org.admins, org.members) == ("new-owner", ["old-owner"], ["member-id"])

    def test_the_lists_follow_the_maps_order(self):
        org = Organization(
            id=_new_id(), name="Test Org", markets=[],
            people={"b": "admin", "owner-id": "owner", "c": "member", "a": "admin"},
        )

        assert org.admins == ["b", "a"]
        assert org.members == ["c"]

    @pytest.mark.parametrize("people", [
        {"admin-id": "admin", "member-id": "member"},
        {"one": "owner", "two": "owner"},
        {},
    ])
    def test_a_map_with_no_owner_or_two_is_refused(self, people):
        with pytest.raises(ValueError, match="An organization has exactly one owner"):
            Organization(id=_new_id(), name="Test Org", people=people, markets=[])

    def test_lists_with_no_owner_are_refused(self):
        with pytest.raises(ValueError, match="An organization has exactly one owner"):
            Organization(id=_new_id(), name="Test Org", owner="", admins=["a"], markets=[])

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
            owner="owner-id",
            admins=["admin1-id", "admin2-id"],
            members=["member1-id", "member2-id"],
            markets=["market1-id", "market2-id"]
        )

        assert len(org.admins) == 2
        assert len(org.members) == 2
        assert len(org.markets) == 2
        assert "admin1-id" in org.admins
        assert "member1-id" in org.members


class TestTheFold:
    """``people_from_lists`` and ``organization_people_of``, the one rule every reader reads by."""

    def test_the_owner_then_the_admins_then_the_members_in_list_order(self):
        assert list(people_from_lists("o", ["a2", "a1"], ["m2", "m1"]).items()) == [
            ("o", "owner"), ("a2", "admin"), ("a1", "admin"), ("m2", "member"), ("m1", "member"),
        ]

    def test_the_owner_wins_over_both_lists(self):
        assert people_from_lists("o", ["o"], ["o"]) == {"o": "owner"}

    def test_an_admin_wins_over_the_members(self):
        assert people_from_lists("o", ["a"], ["a", "m"]) == {"o": "owner", "a": "admin", "m": "member"}

    def test_a_person_listed_twice_in_one_list_is_placed_once(self):
        assert people_from_lists("o", ["a", "a"], []) == {"o": "owner", "a": "admin"}

    @pytest.mark.parametrize("not_a_list", [None, "a", {"a": 1}, 3])
    def test_a_value_that_is_not_a_list_reads_as_empty(self, not_a_list):
        assert people_from_lists("o", not_a_list, not_a_list) == {"o": "owner"}

    @pytest.mark.parametrize("owner", [None, ""])
    def test_no_owner_gives_a_map_with_no_owner(self, owner):
        assert people_from_lists(owner, ["a"], ["m"]) == {"a": "admin", "m": "member"}

    def test_a_document_with_people_reads_its_map(self):
        people = {"x": "owner", "o": "admin"}
        assert organization_people_of({"people": people, "owner": "o", "admins": ["x"]}) == people

    def test_a_document_without_people_reads_its_lists_folded(self):
        assert organization_people_of({"owner": "o", "admins": ["o", "a"]}) == {
            "o": "owner", "a": "admin"}

    def test_a_document_missing_its_lists_reads_its_owner_alone(self):
        assert organization_people_of({"owner": "o"}) == {"o": "owner"}


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
