"""Two role changes at once each land on the person they name, and never undo one another.

Giving a market role, by accepting an invitation, and changing and taking one each read the market,
judge the right of whoever gives, changes or takes it (an accept judges its inviter's) and the
person's role, and then write. Each test lands a second role change between that read and the write
(``interleave``), the invitee's accept through ``Invitees.accept`` or another organizer's change
through its own module function, and asserts what a person and a later reader see: each answer, the
roles as stored, and a history whose role entries, replayed over the roles the market started with,
give the roles stored. An accept landing after its inviter's own role changed is
``test_answering_an_invitation_on_the_server.py``'s.
"""
import pytest

import api.invitees as Invitees
import api.markets as MarketsApi
from api.markets import NO_LONGER_ON_THE_MARKET
from datatypes import MarketPhase
from market_write import MARKET_CHANGED
from real_mongo.test_a_judged_write_lands_only_on_the_market_it_judged import _history, _stored

OWNER = "fixture-owner@example.com"
ADMIN = "fixture-admin@example.com"
EDITOR = "fixture-editor@example.com"
NEWCOMER = "fixture-newcomer@example.com"
CHANGED = {"error": MARKET_CHANGED, "code": "market_changed"}
READ = "api.markets.load_market_context"
ROLE_KINDS = ("role_given", "role_changed", "role_taken")


@pytest.fixture
def mail(monkeypatch):
    import utils.email as Email
    monkeypatch.setattr(Email, "send_mail", lambda *_args: True)


@pytest.fixture
def people(boot_indexes, signed_in, market_in, mail):
    """An owner, an admin, an editor, and a newcomer with an account and no role, each signed in,
    on a market in Applications holding the first three."""
    owner, admin, editor, newcomer = (signed_in(email) for email in (OWNER, ADMIN, EDITOR, NEWCOMER))
    market = market_in(MarketPhase.APPLICATIONS, roles={
        owner.account_id: "owner", admin.account_id: "admin", editor.account_id: "editor"})
    return market, owner, admin, editor, newcomer


def _take(client, market, person):
    return client.delete(f"/markets/{market['id']}/roles/{person.account_id}")


def _invite(client, market, person, role="editor"):
    """``client``'s invitation of ``person`` to ``role``, sent before any race is set up, since the
    invite reads the market too; its id."""
    response = client.post(f"/markets/{market['id']}/invitations",
                           json={"email": person.email, "role": role})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["invitation"]["id"]


def _accept(person, invitation):
    return person.post(f"/invitations/{invitation}/accept")


def _change(client, market, person, role):
    return client.put(f"/markets/{market['id']}/roles/{person.account_id}", json={"role": role})


def _accepts(person, invitation):
    """``person`` accepting an invitation another organizer sent them, landed by ``interleave``
    through the accept's own module function, as a request inside the one interleaved cannot be."""
    return lambda: Invitees.accept(invitation, person.email)


def _takes(by, market, person):
    return lambda: MarketsApi.remove_market_role(market["id"], person.account_id, by.email)


def _replayed(market, market_records):
    """The roles the market started with, with every role entry in its history applied in order."""
    roles = dict(market["roles"])
    for entry in sorted(_role_entries(market_records, market), key=lambda entry: entry["at"]):
        person, after = entry["subject"]["user_id"], entry["detail"]["after"]["role"]
        if after is None:
            roles.pop(person, None)
        else:
            roles[person] = after
    return roles


def _role_entries(market_records, market):
    """The history's role entries, without the invitations that set up the race."""
    return [entry for entry in _history(market_records, market) if entry["kind"] in ROLE_KINDS]


def _kinds(market_records, market):
    return sorted((entry["kind"], entry["subject"]["email"])
                  for entry in _role_entries(market_records, market))


class TestATakeAndAnAcceptAtOnce:
    def test_a_take_landing_after_an_accept_it_did_not_read_keeps_the_one_given(
            self, people, interleave, real_db, market_records):
        market, owner, admin, editor, newcomer = people
        invitation = _invite(admin, market, newcomer)
        interleave(READ, _accepts(newcomer, invitation))

        response = _take(owner, market, editor)

        assert response.status_code == 200, response.get_json()
        roles = _stored(real_db, market)["roles"]
        assert editor.account_id not in roles
        assert roles[newcomer.account_id] == "editor"
        assert _kinds(market_records, market) == [("role_given", NEWCOMER), ("role_taken", EDITOR)]
        assert _replayed(market, market_records) == roles

    def test_an_accept_landing_after_a_take_it_did_not_read_never_gives_the_role_back(
            self, people, interleave, real_db, market_records):
        market, owner, admin, editor, newcomer = people
        invitation = _invite(admin, market, newcomer)
        interleave(READ, _takes(owner, market, editor))

        response = _accept(newcomer, invitation)

        assert response.status_code == 200, response.get_json()
        roles = _stored(real_db, market)["roles"]
        assert editor.account_id not in roles
        assert roles[newcomer.account_id] == "editor"
        assert _kinds(market_records, market) == [("role_given", NEWCOMER), ("role_taken", EDITOR)]
        assert _replayed(market, market_records) == roles

    def test_a_change_landing_after_an_accept_it_did_not_read_keeps_the_one_given(
            self, people, interleave, real_db, market_records):
        market, owner, admin, editor, newcomer = people
        invitation = _invite(admin, market, newcomer)
        interleave(READ, _accepts(newcomer, invitation))

        response = _change(owner, market, editor, "viewer")

        assert response.status_code == 200, response.get_json()
        roles = _stored(real_db, market)["roles"]
        assert roles[editor.account_id] == "viewer"
        assert roles[newcomer.account_id] == "editor"
        assert _replayed(market, market_records) == roles


class TestTwoChangesOfOnePerson:
    def test_a_second_take_of_one_person_answers_that_they_no_longer_have_a_role(
            self, people, interleave, real_db, market_records):
        market, owner, admin, editor, _newcomer = people
        interleave(READ, _takes(admin, market, editor))

        response = _take(owner, market, editor)

        assert response.status_code == 404, response.get_json()
        assert response.get_json()["error"] == NO_LONGER_ON_THE_MARKET
        assert editor.account_id not in _stored(real_db, market)["roles"]
        assert _kinds(market_records, market) == [("role_taken", EDITOR)]

    def test_a_change_landing_after_a_take_of_that_person_is_refused(
            self, people, interleave, real_db, market_records):
        market, owner, admin, editor, _newcomer = people
        interleave(READ, _takes(admin, market, editor))

        response = _change(owner, market, editor, "viewer")

        assert response.status_code == 409, response.get_json()
        assert response.get_json() == CHANGED
        assert editor.account_id not in _stored(real_db, market)["roles"]
        assert _kinds(market_records, market) == [("role_taken", EDITOR)]
