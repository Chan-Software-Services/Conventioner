"""The migration that drops the organization lists (T583) removes ``owner``, ``admins`` and
``members`` from every organization holding a people map and drops their three indexes; it refuses,
writing and dropping nothing, while any organization holds no people map, naming each by id; and a
second run, a run cut before its drops, a run beside another and an organization stored during it
leave nobody without their place."""
import copy

import pytest
from pymongo.errors import AutoReconnect, OperationFailure

import db_config
import migrate_drop_organization_lists as Migration
from conftest import FakeOrganizations
from migrate_drop_organization_lists import migrate

BOOT_INDEXES = {
    "_id_": {"v": 2, "key": [("_id", 1)]},
    "id_1": {"v": 2, "key": [("id", 1)]},
    "people.$**_1": {"v": 2, "key": [("people.$**", 1)]},
    "owner_1": {"v": 2, "key": [("owner", 1)]},
    "admins_1": {"v": 2, "key": [("admins", 1)]},
    "members_1": {"v": 2, "key": [("members", 1)]},
}
LIST_INDEXES = ["owner_1", "admins_1", "members_1"]
NAMES = ("Fixture Owners Club", "Fixture Admins Guild", "Fixture Cleared Co", "Fixture Going Co")


class FakeIndexedOrganizations(FakeOrganizations):
    """The organizations collection with its indexes, as ``index_information`` answers them.

    ``drop_fails``, when set, is called with the name of the next index dropped, before it is
    dropped, and may raise as the server would."""

    def __init__(self, *docs, indexes=None):
        super().__init__(*docs)
        self.indexes = copy.deepcopy(BOOT_INDEXES if indexes is None else indexes)
        self.dropped = []
        self.drop_fails = None

    def index_information(self):
        return copy.deepcopy(self.indexes)

    def drop_index(self, name):
        if self.drop_fails:
            fail, self.drop_fails = self.drop_fails, None
            fail(name)
        if name not in self.indexes:
            raise OperationFailure(f"index not found with name [{name}]", code=27)
        del self.indexes[name]
        self.dropped.append(name)


class FakeDb:
    def __init__(self, organizations):
        self.organizations = organizations


def _organizations():
    """Two organizations holding their map and their mirror, one holding its map alone, and one
    being deleted, holding both."""
    return FakeIndexedOrganizations(
        {"id": "org-1", "name": NAMES[0], "markets": ["m-1"], "theme": {"accent": "teal"},
         "people": {"u-owner": "owner", "u-admin": "admin", "u-member": "member"},
         "owner": "u-owner", "admins": ["u-admin"], "members": ["u-member"]},
        {"id": "org-2", "name": NAMES[1], "markets": [], "theme": None,
         "people": {"u-owner": "owner"}, "owner": "u-owner", "admins": [], "members": []},
        {"id": "org-3", "name": NAMES[2], "markets": [], "theme": None,
         "people": {"u-owner": "owner", "u-member": "member"}},
        {"id": "org-4", "name": NAMES[3], "markets": [], "theme": None,
         "deleting": {"at": "2026-11-20T00:00:00+00:00", "by": "u-owner", "trail_id": "t-1"},
         "people": {"u-owner": "owner"}, "owner": "u-owner", "admins": [], "members": []},
    )


def _without_lists(doc):
    return {key: value for key, value in doc.items() if key not in ("owner", "admins", "members")}


def test_a_run_removes_the_lists_from_every_organization_and_drops_their_indexes(capsys):
    organizations = _organizations()
    before = copy.deepcopy(organizations.docs)

    counts = migrate(FakeDb(organizations))

    assert organizations.docs == [_without_lists(doc) for doc in before]
    assert sorted(organizations.indexes) == ["_id_", "id_1", "people.$**_1"]
    assert counts == {"no_map": 0, "removed": 3, "already_clear": 1, "indexes": LIST_INDEXES,
                      "refused": False}
    out = capsys.readouterr().out
    assert ("Removed owner, admins and members from 3 organization(s); 1 already held only their "
            "people map.") in out
    assert "Dropped the index(es): owner_1, admins_1, members_1." in out
    assert "Nothing to remove" not in out


def test_it_leaves_every_other_index_on_the_lists_alone():
    others = {
        "owner_1_name_1": {"v": 2, "key": [("owner", 1), ("name", 1)]},
        "admins_-1": {"v": 2, "key": [("admins", -1)]},
        "members_sparse": {"v": 2, "key": [("members", 1)], "sparse": True},
    }
    organizations = _organizations()
    organizations.indexes.update(copy.deepcopy(others))

    counts = migrate(FakeDb(organizations))

    assert counts["indexes"] == LIST_INDEXES
    assert sorted(organizations.indexes) == sorted(["_id_", "id_1", "people.$**_1", *others])


def test_it_drops_a_list_index_by_whatever_name_it_holds():
    organizations = _organizations()
    organizations.indexes["by_owner"] = organizations.indexes.pop("owner_1")

    counts = migrate(FakeDb(organizations))

    assert counts["indexes"] == ["admins_1", "members_1", "by_owner"]
    assert sorted(organizations.indexes) == ["_id_", "id_1", "people.$**_1"]


def test_a_dry_run_writes_and_drops_nothing_and_says_what_a_run_would(capsys):
    organizations = _organizations()
    before = copy.deepcopy(organizations.docs)

    dry = migrate(FakeDb(organizations), dry_run=True)

    assert organizations.docs == before and organizations.writes == []
    assert organizations.dropped == [] and sorted(organizations.indexes) == sorted(BOOT_INDEXES)
    out = capsys.readouterr().out
    assert ("Would remove owner, admins and members from 3 organization(s); 1 already held only "
            "their people map.") in out
    assert "Would drop the index(es): owner_1, admins_1, members_1." in out
    assert migrate(FakeDb(organizations)) == dry


@pytest.mark.parametrize("people", ["absent", [], None, "u-owner"],
                         ids=["no people", "people a list", "people null", "people a string"])
@pytest.mark.parametrize("dry_run", [False, True], ids=["run", "dry run"])
def test_it_refuses_writing_and_dropping_nothing_while_an_organization_holds_no_map(
        people, dry_run, capsys):
    organizations = _organizations()
    unfolded = {"id": "org-old", "name": "Fixture Old Co", "markets": [], "owner": "u-owner",
                "admins": ["u-admin"], "members": []}
    if people != "absent":
        unfolded["people"] = people
    organizations.docs.insert(1, unfolded)
    before = copy.deepcopy(organizations.docs)

    counts = migrate(FakeDb(organizations), dry_run=dry_run)

    assert counts == {"no_map": 1, "removed": 0, "already_clear": 0, "indexes": [],
                      "refused": True}
    assert organizations.docs == before and organizations.writes == []
    assert organizations.dropped == [] and sorted(organizations.indexes) == sorted(BOOT_INDEXES)
    assert capsys.readouterr().out.splitlines() == [
        "Refused: 1 organization(s) hold no people map, so their lists are the only record of "
        "their people. Nothing was changed.",
        "  ! org-old: no people map",
        "Fold them first with migrate_organization_people.py from the last commit that holds it, "
        "then run this again:",
        '  cd "$(git rev-parse --show-toplevel)"',
        '  git worktree add ../fold "$(git rev-list -n 1 HEAD -- '
        'back-end/migrations/migrate_organization_people.py)^"',
    ]


def test_its_lines_name_each_organization_by_id_never_by_name(capsys):
    organizations = _organizations()
    for i, name in enumerate(NAMES):
        organizations.docs.append({"id": f"org-old-{i}", "name": name, "owner": "u-owner"})

    migrate(FakeDb(organizations))
    for doc in organizations.docs:
        doc["people"] = {"u-owner": "owner"}
    migrate(FakeDb(organizations), dry_run=True)
    migrate(FakeDb(organizations))

    out = capsys.readouterr().out
    assert all(f"  ! org-old-{i}: no people map" in out for i in range(len(NAMES)))
    assert not [name for name in NAMES if name in out]


def test_a_second_run_changes_nothing_and_says_so(capsys):
    organizations = _organizations()
    migrate(FakeDb(organizations))
    after = copy.deepcopy(organizations.docs)
    capsys.readouterr()

    again = migrate(FakeDb(organizations))

    assert organizations.docs == after and organizations.dropped == LIST_INDEXES
    assert again == {"no_map": 0, "removed": 0, "already_clear": 4, "indexes": [],
                     "refused": False}
    assert capsys.readouterr().out.splitlines() == [
        "Removed owner, admins and members from 0 organization(s); 4 already held only their "
        "people map.",
        "No list index left to drop.",
        "Nothing to remove: the migration has already run.",
    ]


def test_a_run_cut_before_its_drops_is_finished_by_the_next():
    # The connection is lost at the first drop, after the lists' removal landed: the run fails,
    # the documents stay cleared and the indexes stay, and the next run drops them, finding no
    # list to remove.
    organizations = _organizations()
    before = copy.deepcopy(organizations.docs)

    def connection_lost(_name):
        raise AutoReconnect("connection closed")

    organizations.drop_fails = connection_lost

    with pytest.raises(AutoReconnect):
        migrate(FakeDb(organizations))

    assert organizations.docs == [_without_lists(doc) for doc in before]
    assert sorted(organizations.indexes) == sorted(BOOT_INDEXES)

    again = migrate(FakeDb(organizations))

    assert again["removed"] == 0 and again["indexes"] == LIST_INDEXES
    assert sorted(organizations.indexes) == ["_id_", "id_1", "people.$**_1"]


def test_an_index_another_run_dropped_first_counts_as_dropped(capsys):
    organizations = _organizations()

    def another_run_drops_it(name):
        del organizations.indexes[name]

    organizations.drop_fails = another_run_drops_it

    counts = migrate(FakeDb(organizations))

    assert counts["indexes"] == LIST_INDEXES
    assert sorted(organizations.indexes) == ["_id_", "id_1", "people.$**_1"]
    assert "Dropped the index(es): owner_1, admins_1, members_1." in capsys.readouterr().out


def test_any_other_failure_of_a_drop_is_raised():
    organizations = _organizations()

    def not_allowed(_name):
        raise OperationFailure("not authorized", code=13)

    organizations.drop_fails = not_allowed

    with pytest.raises(OperationFailure):
        migrate(FakeDb(organizations))


def test_an_organization_with_no_map_stored_during_the_run_keeps_its_lists():
    # A restore stores an organization from before the map after the refusal's read and before
    # the write: the write, filtered on a map, leaves its lists, and the next run refuses on it.
    organizations = _organizations()
    restored = {"id": "org-restored", "name": "Fixture Restored Co", "markets": [],
                "owner": "u-owner", "admins": ["u-admin"], "members": ["u-member"]}
    organizations.before_write = lambda: organizations.docs.append(copy.deepcopy(restored))

    counts = migrate(FakeDb(organizations))

    assert counts["removed"] == 3
    assert organizations.docs[-1] == restored
    assert migrate(FakeDb(organizations))["refused"] is True
    assert organizations.docs[-1] == restored


@pytest.mark.parametrize("extra, code", [
    ({}, 0),
    ({"id": "org-old", "name": "Fixture Old Co", "owner": "u-owner"}, 1),
], ids=["a run", "a refusal"])
def test_main_exits_1_on_a_refusal_and_0_otherwise(extra, code, monkeypatch):
    organizations = _organizations()
    if extra:
        organizations.docs.append(extra)
    monkeypatch.setattr(db_config, "get_database", lambda: FakeDb(organizations))
    monkeypatch.setattr("sys.argv", ["migrate_drop_organization_lists.py"])

    with pytest.raises(SystemExit) as exited:
        Migration.main()

    assert exited.value.code == code
