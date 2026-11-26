"""An organization's people on a real server, with real threads meeting (T283).

Each change to a person's place is one write conditional on the places it judged, and handing the
organization on is one write filtered on the giver being owner. A place is given only by an
invitation accepted, which claims the invitation before it writes, and judges again and writes
again when its write meets another change. The hermetic suite proves that logic over the shared
fake (``test_one_writer_holds_each_place_it_judged.py``,
``test_an_organizations_people_stay_one_map.py``); these run the losing branch where it lives:
each racing thread judges on its own read, and only then do the writes meet on the server.
"""
import threading
from types import SimpleNamespace

import pytest

import invitations as Invitations
import organization_people as OrganizationPeople
from client_errors import BadRequestError
from organization_people import ALREADY_IN_IT, OrganizationChanged
from real_mongo import harness
from test_an_organizations_people_stay_one_map import assert_one_map

ORG = "org-race"
OWNER = "race-owner@example.com"
ADMIN = "race-admin@example.com"
MEMBER = "race-member@example.com"
NEW = "race-new@example.com"
#: How long a racing thread waits for the other at a meeting point, so a bug fails, not hangs.
MEETING_TIMEOUT_SECONDS = 20
#: The one conditional write of a place, as the module holds it before any test wraps it.
WRITE = OrganizationPeople._write


@pytest.fixture
def people(real_db):
    """An account for each address, and their ids by address."""
    import api.users as UsersApi
    from create_account import create_account

    return {email: create_account(UsersApi.users_collection, email, "fixture-password-1")
            for email in (OWNER, ADMIN, MEMBER, NEW)}


@pytest.fixture
def organization(real_db, people):
    """The organization: its owner, an admin and a member, stored with its people map. Answers a
    reader of it as stored."""
    doc = {"id": ORG, "name": "Race Markets",
           "people": {people[OWNER]: "owner", people[ADMIN]: "admin", people[MEMBER]: "member"},
           "markets": [], "theme": None}
    real_db["organizations"].insert_one(doc)
    harness.warm(real_db["organizations"], 2)
    return lambda: real_db["organizations"].find_one({"id": ORG}, {"_id": 0})


@pytest.fixture
def judged_then(monkeypatch):
    """``judged_then(meet)``: each racing thread runs ``meet(thread)`` once, ``thread`` its index,
    when its change has read and judged and is about to make its first conditional write (an
    accept, after its claim too), so the changes meet after their reads, before their writes. A
    write made again, by an accept that met a change, meets nothing."""
    here = threading.local()

    def install(meet):
        def written(*args, **kwargs):
            if not getattr(here, "met", True):
                here.met = True
                meet(here.thread)
            return WRITE(*args, **kwargs)
        monkeypatch.setattr(OrganizationPeople, "_write", written)

    def as_thread(i, fn):
        here.thread, here.met = i, False
        return fn()

    install.as_thread = as_thread
    return install


def _outcomes(answered):
    """Which threads landed (answered no error) and which met the other's change; any other answer
    fails the test with it."""
    unexpected = [a for a in answered
                  if isinstance(a, BaseException) and not isinstance(a, OrganizationChanged)]
    assert unexpected == []
    return ([i for i, a in enumerate(answered) if not isinstance(a, BaseException)],
            [i for i, a in enumerate(answered) if isinstance(a, OrganizationChanged)])


def _invited(people, email, place, by):
    """``by``'s invitation of ``email`` to ``place``, written as the invite writes it: as the
    invitee reads it to accept it."""
    sent = Invitations.invite(Invitations.ORGANIZATION, ORG, email, place, people[by], by,
                              Invitations.now())
    return Invitations.addressed(sent["id"], email)


def _accept(people, invitation):
    """The invitee accepting ``invitation``, through the module function the accept route calls."""
    email = invitation["email"]
    return OrganizationPeople.place_by_invitation(
        invitation, SimpleNamespace(id=people[email], email=email))


def test_a_member_place_judged_before_the_owner_hands_that_person_the_organization_is_refused(
        organization, people, judged_then, race):
    # Thread 0, NEW, accepts the admin's invitation to be a member. Between its judgment and its
    # write, thread 1, the owner, invites NEW to be an admin, NEW accepts, and the owner hands them
    # the organization. On dev a member's place written then landed the new owner in members,
    # which did not parse. Judged again, NEW owns it, so the invitation ends.
    member_invitation = _invited(people, NEW, "member", ADMIN)
    member_judged, handed_on = threading.Event(), threading.Event()

    def meet(thread):
        if thread == 0:
            member_judged.set()
            assert handed_on.wait(MEETING_TIMEOUT_SECONDS)

    judged_then(meet)

    def owner_places_and_hands_on():
        assert member_judged.wait(MEETING_TIMEOUT_SECONDS)
        try:
            _accept(people, _invited(people, NEW, "admin", OWNER))
            OrganizationPeople.transfer(ORG, OWNER, NEW)
        finally:
            handed_on.set()

    changes = [lambda: _accept(people, member_invitation), owner_places_and_hands_on]
    answered = race(2, lambda i: judged_then.as_thread(i, changes[i]))

    assert answered[1] is None, answered
    assert isinstance(answered[0], BadRequestError), answered
    assert answered[0].message == ALREADY_IN_IT
    stored = organization()
    assert stored["people"][people[NEW]] == "owner"
    assert_one_map(stored)


def test_two_transfers_by_the_owner_to_two_people_land_one(organization, people, judged_then, race):
    both_judged = threading.Barrier(2, timeout=MEETING_TIMEOUT_SECONDS)
    judged_then(lambda _thread: both_judged.wait())
    to = [ADMIN, MEMBER]

    answered = race(2, lambda i: judged_then.as_thread(
        i, lambda: OrganizationPeople.transfer(ORG, OWNER, to[i])))

    landed, refused = _outcomes(answered)
    assert len(landed) == 1 and len(refused) == 1, answered
    stored = organization()
    assert stored["people"][people[to[landed[0]]]] == "owner"
    assert stored["people"][people[OWNER]] == "admin"
    assert stored["people"][people[to[refused[0]]]] != "owner"
    assert_one_map(stored)


@pytest.mark.parametrize("first", [0, 1], ids=["the transfer writes first",
                                             "the accept writes first"])
def test_a_transfer_to_an_admin_beside_another_accepting_admin(
        organization, people, judged_then, race, first):
    # The transfer holds only the giver's and the new owner's keys (T583), so an admin placed by
    # the owner's invitation meanwhile is no change to it: written first, the accept lands and so
    # does the transfer. Written first, the transfer makes the owner an admin, so the accept, which
    # holds its inviter's place as read, meets it, judges again, and ends: an admin may not give an
    # admin's place. Either way the map holds one owner. Both judge on one read, then the one named
    # writes first and the other only once it has returned.
    admin_invitation = _invited(people, NEW, "admin", OWNER)
    both_judged = threading.Barrier(2, timeout=MEETING_TIMEOUT_SECONDS)
    written = threading.Event()

    def meet(thread):
        both_judged.wait()
        if thread != first:
            assert written.wait(MEETING_TIMEOUT_SECONDS)

    judged_then(meet)
    changes = [lambda: OrganizationPeople.transfer(ORG, OWNER, ADMIN),
               lambda: _accept(people, admin_invitation)]

    def change(i):
        try:
            return changes[i]()
        finally:
            if i == first:
                written.set()

    answered = race(2, lambda i: judged_then.as_thread(i, lambda: change(i)))

    stored = organization()
    assert stored["people"][people[ADMIN]] == "owner"
    assert stored["people"][people[OWNER]] == "admin"
    if first == 0:
        assert answered[0] is None, answered
        assert isinstance(answered[1], Invitations.InvitationEnded), answered
        assert people[NEW] not in stored["people"]
    else:
        assert _outcomes(answered) == ([0, 1], []), answered
        assert stored["people"][people[NEW]] == "admin"
    assert_one_map(stored)
