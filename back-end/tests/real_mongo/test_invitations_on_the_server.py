"""Invitations on a real server (T538): one per address and target, however many are sent at once,
and the indexes the boot builds for them.

An invitation is one upsert on its target and address. Two that land at once both match nothing,
and only the boot's unique index keeps them one document; the hermetic suite proves the retry
through a fake that raises the index's refusal, and these run the race where the index lives.
"""
from datetime import datetime, timedelta, timezone

import pytest

import invitations as Invitations
import utils.email as Email
from datatypes import MarketPhase

OWNER = "fixture-owner@example.com"
ADMIN = "fixture-admin@example.com"
INVITED = "fixture-invited@example.com"


@pytest.fixture
def mail(monkeypatch):
    """The addresses every email was sent to, each send answering sent."""
    sent = []

    def send(_kind, email, *_message):
        sent.append(email)
        return True
    monkeypatch.setattr(Email, "send_mail", send)
    return sent


@pytest.fixture
def market(boot_indexes, signed_in, market_in):
    """A market in Applications, its owner and an Admin each signed in."""
    owner, admin = signed_in(OWNER), signed_in(ADMIN)
    document = market_in(MarketPhase.APPLICATIONS, roles={
        owner.account_id: "owner", admin.account_id: "admin"})
    return document, owner, admin


class TestTheBootsIndexes:
    def test_the_boot_builds_the_unique_the_invitee_and_the_expiry_indexes(self, boot_indexes):
        indexes = boot_indexes[Invitations.INVITATIONS_COLLECTION].index_information()

        assert indexes[Invitations.UNIQUE_INDEX]["key"] == [
            ("target_kind", 1), ("target_id", 1), ("email", 1)]
        assert indexes[Invitations.UNIQUE_INDEX]["unique"] is True
        assert indexes[Invitations.EMAIL_INDEX]["key"] == [("email", 1)]
        assert indexes[Invitations.EXPIRY_INDEX]["key"] == [("expires_at", 1)]
        assert indexes[Invitations.EXPIRY_INDEX]["expireAfterSeconds"] == 0


class TestInvitingAtOnce:
    def test_two_invitations_of_one_address_at_once_leave_one(self, market, race, mail,
                                                               market_records):
        document, owner, admin = market
        clients = (owner, admin)

        answers = race(2, lambda i: clients[i].post(
            f"/markets/{document['id']}/invitations",
            json={"email": INVITED, "role": ("editor", "viewer")[i]}))

        assert [answer.status_code for answer in answers] == [200, 200]
        stored = list(market_records.invitations.find({"target_id": document["id"]}))
        assert len(stored) == 1
        assert {answer.get_json()["invitation"]["id"] for answer in answers} == {stored[0]["id"]}
        assert mail == [INVITED, INVITED]

    def test_many_upserts_at_once_leave_one_with_one_id(self, boot_indexes, race):
        at = datetime.now(timezone.utc)

        answers = race(8, lambda i: Invitations.invite(
            Invitations.MARKET, "market-at-once", INVITED, "editor", f"user-{i}",
            f"inviter-{i}@example.com", at + timedelta(seconds=i)))

        assert [answer for answer in answers if isinstance(answer, BaseException)] == []
        stored = list(boot_indexes[Invitations.INVITATIONS_COLLECTION].find(
            {"target_id": "market-at-once"}))
        assert len(stored) == 1
        assert {answer["id"] for answer in answers} == {stored[0]["id"]}

    def test_a_stored_time_is_served_in_utc(self, market, mail):
        document, owner, _admin = market

        invitation = owner.post(f"/markets/{document['id']}/invitations",
                                json={"email": INVITED, "role": "editor"}).get_json()["invitation"]
        listed = owner.get(f"/markets/{document['id']}/invitations").get_json()["invitations"]

        assert [row["id"] for row in listed] == [invitation["id"]]
        sent = datetime.fromisoformat(listed[0]["sentAt"])
        assert sent.utcoffset() == timedelta(0)
        assert datetime.fromisoformat(listed[0]["endsAt"]) - sent == Invitations.LIFETIME
