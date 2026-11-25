#!/usr/bin/env python3
"""Remove every stored organization's three lists of people, and their indexes (T583, ADR 0025).

Why: an organization keeps its people as ``people``, one map from user id to ``owner``, ``admin``
or ``member`` (T283). The release that brought the map kept ``owner``, ``admins`` and ``members``
beside it as an exact mirror, so a rollback to the release before it read the same people. That
release is now two back, and this one reads and writes the map alone, so the lists are a second
copy of who is in an organization that nothing keeps true; this is the follow-up ADR 0025 names.

What it writes:

- ``$unset`` of ``owner``, ``admins`` and ``members`` on every organization holding a people map,
  in one update filtered on that map, so an organization with no map, stored while this runs, is
  never left with nobody in it;
- a drop of each index of ``organizations`` on exactly one of those fields, ascending and with no
  other option, whatever its name: the three the boot built for the lists. An index another run
  dropped first counts as dropped. Any other index on those fields is left alone.

It refuses, writing and dropping nothing, while any organization holds no people map (none, or one
that is not a map), since its lists are then the only record of its people: it names each by id
and says how to fold it first. The dry run refuses the same way.

Safe to run repeatedly, and beside another run: a second run finds nothing to remove and no index
to drop. ``--dry-run`` prints what it would remove and drop, and writes nothing.

Run it after the deploy of the release that ships it, whenever the operator likes, and again, dry
run first, after any roll forward over a rollback to the release before: that release's boot builds
the three indexes again and its writes put partial lists back.

Usage, from ``back-end/`` (the production database address passed inline, never from ``.env``):
    MONGODB_URI='<production URI>' python migrations/migrate_drop_organization_lists.py --dry-run
    MONGODB_URI='<production URI>' python migrations/migrate_drop_organization_lists.py
"""
import argparse
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo.errors import OperationFailure  # noqa: E402

#: The three lists an organization kept its people in before the map.
LISTS = ("owner", "admins", "members")
#: An index's options that are not options: an index with any other is not one the boot built.
_NOT_OPTIONS = frozenset({"v", "key", "ns"})
#: The server's code for an index that is not there: another run dropped it first.
INDEX_NOT_FOUND = 27
#: An organization the lists can be removed from: one holding its people map and any list.
HOLDS_A_MAP_AND_A_LIST = {
    "people": {"$type": "object"},
    "$or": [{field: {"$exists": True}} for field in LISTS],
}


def list_indexes(organizations) -> List[str]:
    """The name of each index on exactly one list, ascending, with no other option."""
    return [name for name, info in organizations.index_information().items()
            if [tuple(part) for part in info["key"]] in ([(field, 1)] for field in LISTS)
            and set(info) <= _NOT_OPTIONS]


def _drop(organizations, name: str) -> None:
    try:
        organizations.drop_index(name)
    except OperationFailure as error:
        if error.code != INDEX_NOT_FOUND:
            raise


def migrate(db, dry_run: bool = False) -> Dict[str, Any]:
    """Remove the lists and drop their indexes, or say what would be. Returns the counts it
    printed: ``no_map``, ``removed``, ``already_clear``, ``indexes`` (the names dropped or to
    drop) and ``refused``."""
    organizations = db.organizations
    counts: Dict[str, Any] = {"no_map": 0, "removed": 0, "already_clear": 0, "indexes": [],
                              "refused": False}

    # Every organization, tombstoned ones too: one being deleted still holds its people.
    stored = list(organizations.find({}, {"id": 1, "people": 1}))
    no_map = [doc.get("id") for doc in stored if not isinstance(doc.get("people"), dict)]
    if no_map:
        counts.update(no_map=len(no_map), refused=True)
        print(f"Refused: {len(no_map)} organization(s) hold no people map, so their lists are the "
              "only record of their people. Nothing was changed.")
        for organization_id in no_map:
            print(f"  ! {organization_id}: no people map")
        print("Fold them first with migrate_organization_people.py from the last commit that "
              "holds it, then run this again:")
        print('  git worktree add ../fold "$(git rev-list -n 1 HEAD -- '
              'back-end/migrations/migrate_organization_people.py)^"')
        return counts

    if dry_run:
        counts["removed"] = len(list(organizations.find(HOLDS_A_MAP_AND_A_LIST, {"id": 1})))
    else:
        result = organizations.update_many(HOLDS_A_MAP_AND_A_LIST,
                                           {"$unset": {field: "" for field in LISTS}})
        counts["removed"] = result.matched_count
    counts["already_clear"] = max(len(stored) - counts["removed"], 0)

    counts["indexes"] = list_indexes(organizations)
    if not dry_run:
        for name in counts["indexes"]:
            _drop(organizations, name)

    print(f"{'Would remove' if dry_run else 'Removed'} owner, admins and members from "
          f"{counts['removed']} organization(s); {counts['already_clear']} already held only "
          "their people map.")
    if counts["indexes"]:
        print(f"{'Would drop' if dry_run else 'Dropped'} the index(es): "
              f"{', '.join(counts['indexes'])}.")
    else:
        print("No list index left to drop.")
    if not counts["removed"] and not counts["indexes"]:
        print("Nothing to remove: the migration has already run.")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="Say what would be removed and dropped; write nothing")
    args = parser.parse_args()

    from db_config import get_database

    counts = migrate(get_database(), dry_run=args.dry_run)
    sys.exit(1 if counts["refused"] else 0)


if __name__ == "__main__":
    main()
