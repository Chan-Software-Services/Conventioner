"""``organization_people.of_person`` on a real server (T283, T583): it finds an organization by the
person's key in its people map alone, never by a stale list, and the boot's ``people.$**`` wildcard
index serves it."""
import copy

import organization_people as OrganizationPeople
from test_a_persons_organizations_in_either_shape import ORGANIZATIONS, PERSON, THEIRS


def _stages(plan: dict) -> list:
    """Every stage name in a winning plan, depth first."""
    found = [plan.get("stage")]
    for key in ("inputStage", "inputStages"):
        children = plan.get(key)
        for child in children if isinstance(children, list) else [children] if children else []:
            found += _stages(child)
    return found


def test_the_server_finds_the_organizations_the_fakes_find(real_db):
    real_db["organizations"].insert_many([copy.deepcopy(org) for org in ORGANIZATIONS])

    found = real_db["organizations"].find(OrganizationPeople.of_person(PERSON.id))

    assert {org["id"] for org in found} == THEIRS


def test_the_filter_is_served_by_a_boot_index(boot_indexes):
    boot_indexes["organizations"].insert_many([copy.deepcopy(org) for org in ORGANIZATIONS])

    explained = boot_indexes["organizations"].find(
        OrganizationPeople.of_person(PERSON.id)).explain()
    stages = _stages(explained["queryPlanner"]["winningPlan"])

    assert "COLLSCAN" not in stages, stages
    assert "IXSCAN" in stages, stages
