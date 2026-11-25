"""``migrations/migrate_drop_organization_lists.py`` on the server, run as an operator runs it: on a
database holding every index the boot builds and the three list indexes the release before built,
whose ``$type`` filter, ``$unset`` and index listing and drops the hermetic fake only models.
"""
import pytest

from migrate_drop_organization_lists import migrate

LIST_INDEXES = ["owner_1", "admins_1", "members_1"]


@pytest.fixture
def organizations(boot_indexes):
    """The organizations collection with the boot's indexes and the three list indexes, built by
    hand as the release before built them, so this holds whether or not the boot still builds
    them; and two organizations holding their map and their mirror, one holding its map alone and
    one being deleted, holding both."""
    collection = boot_indexes["organizations"]
    for field in ("owner", "admins", "members"):
        collection.create_index([(field, 1)])
    collection.insert_many([
        {"id": "org-1", "name": "Fixture One", "markets": ["m-1"], "theme": None,
         "people": {"u-owner": "owner", "u-admin": "admin", "u-member": "member"},
         "owner": "u-owner", "admins": ["u-admin"], "members": ["u-member"]},
        {"id": "org-2", "name": "Fixture Two", "markets": [], "theme": None,
         "people": {"u-owner": "owner"}, "owner": "u-owner", "admins": [], "members": []},
        {"id": "org-3", "name": "Fixture Three", "markets": [], "theme": None,
         "people": {"u-owner": "owner", "u-member": "member"}},
        {"id": "org-4", "name": "Fixture Four", "markets": [], "theme": None,
         "deleting": {"at": "2026-11-20T00:00:00+00:00", "by": "u-owner", "trail_id": "t-1"},
         "people": {"u-owner": "owner"}, "owner": "u-owner", "admins": [], "members": []},
    ])
    return collection


def _stored(collection):
    return {doc["id"]: doc for doc in collection.find({}, {"_id": 0})}


def _without_lists(doc):
    return {key: value for key, value in doc.items() if key not in ("owner", "admins", "members")}


def test_a_run_clears_every_organization_and_drops_exactly_the_three_list_indexes(organizations):
    before = _stored(organizations)
    indexes = set(organizations.index_information())
    assert {"id_1", "people.$**_1", *LIST_INDEXES} <= indexes

    counts = migrate(organizations.database)

    assert _stored(organizations) == {key: _without_lists(doc) for key, doc in before.items()}
    assert set(organizations.index_information()) == indexes - set(LIST_INDEXES)
    assert sorted(counts.pop("indexes")) == sorted(LIST_INDEXES)
    assert counts == {"no_map": 0, "removed": 3, "already_clear": 1, "refused": False}

    again = migrate(organizations.database)

    assert _stored(organizations) == {key: _without_lists(doc) for key, doc in before.items()}
    assert again == {"no_map": 0, "removed": 0, "already_clear": 4, "indexes": [],
                     "refused": False}


@pytest.mark.parametrize("dry_run", [False, True], ids=["run", "dry run"])
def test_a_refused_run_changes_neither_the_documents_nor_the_indexes(organizations, dry_run):
    organizations.insert_many([
        {"id": "org-old", "name": "Fixture Old", "markets": [], "owner": "u-owner",
         "admins": ["u-admin"], "members": []},
        {"id": "org-list", "name": "Fixture List", "markets": [], "people": ["u-owner"],
         "owner": "u-owner", "admins": [], "members": []},
        {"id": "org-null", "name": "Fixture Null", "markets": [], "people": None,
         "owner": "u-owner", "admins": [], "members": []},
    ])
    before = _stored(organizations)
    indexes = organizations.index_information()

    counts = migrate(organizations.database, dry_run=dry_run)

    assert counts["refused"] is True and counts["no_map"] == 3
    assert _stored(organizations) == before
    assert organizations.index_information() == indexes


def test_what_the_release_before_puts_back_is_cleared_by_a_second_run(organizations):
    # Rolled back to the release before after a run, its boot builds a list index again and its
    # writes put a partial list back beside the map, as adding an admin does there; after the roll
    # forward, a second run clears both.
    migrate(organizations.database)
    organizations.create_index([("owner", 1)])
    organizations.update_one({"id": "org-3"}, {"$set": {"people.u-new": "admin"},
                                               "$addToSet": {"admins": "u-new"}})
    organizations.update_one({"id": "org-2"}, {"$set": {"owner": "u-owner"}})

    counts = migrate(organizations.database)

    assert counts["removed"] == 2 and counts["indexes"] == ["owner_1"]
    stored = _stored(organizations)
    assert not [doc for doc in stored.values() if {"owner", "admins", "members"} & set(doc)]
    assert stored["org-3"]["people"] == {"u-owner": "owner", "u-member": "member",
                                         "u-new": "admin"}
    assert not {"owner_1", "admins_1", "members_1"} & set(organizations.index_information())
