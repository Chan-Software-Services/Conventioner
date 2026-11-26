"""Inviting someone to an organization gives one answer for every address (T538, ADR 0047).

An organization's owner invites an admin or a member, and an admin a member: whether or not the
address has an account, the invite answers the same status and body, sends the same email and
records the same entry, whose subject is the address alone. Nobody is placed by being invited: the
invitation waits in ``invitations`` until someone signed in with that address accepts it. The owner
and the admins list the organization's waiting invitations, and withdraw one.

Pinned through the test client against the real app, over collections that apply the writes.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import (
    FakeOrganizations,
    install_organizations,
    sessions_load_through_get_user,
    skip_without_real_dependencies,
)

skip_without_real_dependencies()

import app as app_module  # noqa: E402
import api.organizations as OrgsApi  # noqa: E402
import api.users as UsersApi  # noqa: E402
import history as History  # noqa: E402
import invitations as Invitations  # noqa: E402
import sign_in_limits  # noqa: E402
import utils.email as Email  # noqa: E402

ORG_ID = "org-1"
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
ADMIN = SimpleNamespace(id="user-admin", email="admin@example.com")
MEMBER = SimpleNamespace(id="user-member", email="member@example.com")
#: An account holding no place in the organization.
ACCOUNT = SimpleNamespace(id="user-account", email="has-an-account@example.com")
#: An address no account has.
NO_ACCOUNT = "no-account@example.com"
PEOPLE = (OWNER, ADMIN, MEMBER, ACCOUNT)
PLACES = {OWNER.id: "owner", ADMIN.id: "admin", MEMBER.id: "member"}

SENT_AT = datetime(2026, 11, 24, 9, 30, tzinfo=timezone.utc)
ENDS_AT = SENT_AT + timedelta(days=14)


@pytest.fixture
def people(monkeypatch):
    by_email = {person.email: person for person in PEOPLE}
    by_id = {person.id: person for person in PEOPLE}

    def account(email):
        person = by_email.get(email)
        return person and SimpleNamespace(
            id=person.id, email=email, is_active=True, is_authenticated=True,
            is_anonymous=False, get_id=lambda e=email: e,
        )
    monkeypatch.setattr(UsersApi, "get_user", account)
    monkeypatch.setattr(UsersApi, "get_user_by_id", lambda user_id: by_id.get(user_id))
    monkeypatch.setattr(app_module.login_manager, "session_protection", None)
    sessions_load_through_get_user(monkeypatch)


@pytest.fixture
def clock(monkeypatch):
    """The invitations' clock, held at ``SENT_AT`` until a test moves it."""
    held = SimpleNamespace(now=SENT_AT)
    monkeypatch.setattr(Invitations, "now", lambda: held.now)
    return held


@pytest.fixture
def mail(monkeypatch):
    """Every email sent, as ``send_mail`` was asked to send it; ``fails`` makes each send fail."""
    sent = SimpleNamespace(messages=[], fails=False)

    def send(kind, email, subject, html, text):
        sent.messages.append(SimpleNamespace(
            kind=kind, email=email, subject=subject, html=html, text=text))
        return not sent.fails
    monkeypatch.setattr(Email, "send_mail", send)
    return sent


def an_organization(**overrides):
    return {
        "id": ORG_ID, "name": "Ember Markets", "people": dict(PLACES), "markets": [], "theme": None,
        **overrides,
    }


def organization_with(monkeypatch, **overrides):
    return install_organizations(monkeypatch, FakeOrganizations(an_organization(**overrides)))


@pytest.fixture
def organization(monkeypatch, people, clock, mail):
    return organization_with(monkeypatch)


@pytest.fixture
def invitations(market_records):
    return market_records.invitations


@pytest.fixture
def history(market_records):
    return market_records.history


def signed_in_as(person):
    client = app_module.app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = person.email
        session["_fresh"] = True
    return client


def invite(person, email, place="member", org_id=ORG_ID):
    return signed_in_as(person).post(
        f"/organizations/{org_id}/invitations", json={"email": email, "place": place})


def entries(history):
    return [doc for doc in history.documents
            if doc.get(History.ORGANIZATION_ID_FIELD) == ORG_ID]


def stored(invitations):
    return [{key: value for key, value in doc.items() if key != "_id"}
            for doc in invitations.documents]


def without_ids(entry):
    return {key: value for key, value in entry.items() if key not in ("_id", "id", "at")}


class TestOneAnswerForEveryAddress:
    def test_an_invitation_answers_alike_for_every_address(
        self, organization, invitations, history, mail,
    ):
        answers = []
        for address in (ACCOUNT.email, NO_ACCOUNT):
            response = invite(OWNER, address)
            body = response.get_json()
            answers.append((response.status_code, {
                **body, "invitation": {**body["invitation"], "id": None, "email": None}}))

        assert answers[0] == answers[1]
        assert answers[0][0] == 200
        assert [without_ids(entry) | {"subject": None} for entry in entries(history)] == [
            {"organization_id": ORG_ID, "actor": OWNER.email,
             "action": History.MANAGE_ORGANIZATION_MEMBERS, "kind": History.INVITED,
             "vendors": [], "subject": None, "detail": {"role": "member"}}] * 2
        assert [entry["subject"] for entry in entries(history)] == [
            {"email": ACCOUNT.email}, {"email": NO_ACCOUNT}]
        assert [message.email for message in mail.messages] == [ACCOUNT.email, NO_ACCOUNT]
        assert mail.messages[0].subject == mail.messages[1].subject
        assert mail.messages[0].text == mail.messages[1].text
        assert mail.messages[0].html == mail.messages[1].html

    @pytest.mark.parametrize("place", ["admins", "members"])
    @pytest.mark.parametrize("person", [ACCOUNT.email, NO_ACCOUNT])
    def test_no_route_adds_someone_to_an_organization_directly(
        self, organization, invitations, history, mail, place, person,
    ):
        response = signed_in_as(OWNER).post(
            f"/organizations/{ORG_ID}/{place}", json={"user_email": person})

        assert response.status_code == 404
        assert organization.doc == an_organization()
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []

    def test_a_transfer_outside_the_organization_says_one_sentence(
        self, organization, invitations, history, mail,
    ):
        answers = [
            signed_in_as(OWNER).post(
                f"/organizations/{ORG_ID}/transfer", json={"new_owner_email": address})
            for address in (ACCOUNT.email, NO_ACCOUNT)]

        assert [(response.status_code, response.get_json()) for response in answers] == [
            (400, {"error": "Transfer ownership only to one of the organization's admins or "
                            "members."})] * 2
        assert organization.doc == an_organization()
        assert entries(history) == []

    def test_nobody_is_placed_by_being_invited(self, organization, invitations):
        for address, place in ((ACCOUNT.email, "admin"), (NO_ACCOUNT, "member")):
            assert invite(OWNER, address, place=place).status_code == 200

        assert organization.doc == an_organization()
        assert len(invitations.documents) == 2

    def test_the_answer_serves_the_invitation(self, organization, invitations):
        response = invite(OWNER, "  Someone@Example.com ", place="admin")

        [doc] = stored(invitations)
        assert response.get_json() == {
            "invitation": {
                "id": doc["id"], "email": "someone@example.com", "role": "admin",
                "invitedBy": OWNER.email, "sentAt": SENT_AT.isoformat(),
                "endsAt": ENDS_AT.isoformat(),
            },
            "emailed": True,
        }
        assert doc == {
            "id": doc["id"], "target_kind": "organization", "target_id": ORG_ID,
            "email": "someone@example.com", "role": "admin", "invited_by": OWNER.id,
            "invited_by_email": OWNER.email, "sent_at": SENT_AT, "expires_at": ENDS_AT,
            "counted_at": SENT_AT,
        }


class TestSomeoneAlreadyInIt:
    @pytest.mark.parametrize("person, place, sentence", [
        (OWNER, "admin", f"{OWNER.email} owns this organization."),
        (OWNER, "member", f"{OWNER.email} owns this organization."),
        (ADMIN, "admin", f"{ADMIN.email} is already an admin of this organization."),
        (ADMIN, "member", f"{ADMIN.email} is already an admin of this organization."),
        (MEMBER, "member", f"{MEMBER.email} is already a member of this organization."),
        (MEMBER, "admin", f"{MEMBER.email} is already a member of this organization. Make them "
                          "an admin from their row."),
    ])
    def test_an_address_already_in_it_is_refused_saying_which_place(
        self, organization, invitations, history, mail, person, place, sentence,
    ):
        response = invite(OWNER, person.email, place=place)

        assert response.status_code == 400
        assert response.get_json() == {"error": sentence}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []

    def test_the_limits_come_before_whether_they_are_in_it(
        self, organization, invitations, monkeypatch,
    ):
        """Refused alike for every address: one already in it is counted, and told the limit."""
        monkeypatch.setattr(sign_in_limits, "INVITATION_PER_INVITER", sign_in_limits.SignInLimit(
            "invitation:inviter", attempts=1, window=timedelta(minutes=15)))
        assert invite(OWNER, NO_ACCOUNT).status_code == 200

        refusals = [invite(OWNER, address) for address in (ACCOUNT.email, MEMBER.email)]

        assert [response.status_code for response in refusals] == [429, 429]
        assert {response.get_json()["error"] for response in refusals} == {
            "You have sent many invitations. Try again in 15 minutes."}
        assert len(invitations.documents) == 1


class TestWhoMayInvite:
    @pytest.mark.parametrize("inviter, place, action", [
        (OWNER, "admin", History.MANAGE_ORGANIZATION_ADMINS),
        (OWNER, "member", History.MANAGE_ORGANIZATION_MEMBERS),
        (ADMIN, "member", History.MANAGE_ORGANIZATION_MEMBERS),
    ])
    def test_whoever_may_add_to_the_place_invites(
        self, organization, invitations, history, inviter, place, action,
    ):
        assert invite(inviter, NO_ACCOUNT, place=place).status_code == 200

        assert [doc["role"] for doc in invitations.documents] == [place]
        [entry] = entries(history)
        assert (entry["actor"], entry["action"]) == (inviter.email, action)

    @pytest.mark.parametrize("inviter, place, refusal", [
        (ADMIN, "admin", "Only organization owner can add admins"),
        (MEMBER, "member", "Only organization owner or admin can add members"),
        (MEMBER, "admin", "Only organization owner can add admins"),
        (ACCOUNT, "member", "Only organization owner or admin can add members"),
    ])
    def test_whoever_may_not_add_to_the_place_is_refused_before_anything_is_written(
        self, organization, invitations, history, mail, sign_in_attempts, inviter, place,
        refusal,
    ):
        response = invite(inviter, NO_ACCOUNT, place=place)

        assert response.status_code == 403
        assert response.get_json() == {"error": refusal}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []
        assert sign_in_attempts.docs == {}


class TestWhatIsRefusedFirst:
    @pytest.mark.parametrize("body", [
        {"place": "member"}, {"email": NO_ACCOUNT}, {"email": 7, "place": "member"},
        {"email": NO_ACCOUNT, "place": ["member"]}, {"email": "", "place": "member"},
    ])
    def test_an_address_and_a_place_are_required(self, organization, invitations, body):
        response = signed_in_as(OWNER).post(f"/organizations/{ORG_ID}/invitations", json=body)

        assert response.status_code == 400
        assert response.get_json() == {"error": "email and place required"}
        assert invitations.documents == []

    @pytest.mark.parametrize("typed", ["someone", "someone@example", "@", "someone@"])
    def test_what_is_not_an_address_is_refused(self, organization, invitations, typed):
        response = invite(OWNER, typed)

        assert response.status_code == 400
        assert response.get_json() == {
            "error": "Type an email address, such as name@example.com."}
        assert invitations.documents == []

    @pytest.mark.parametrize("place", ["owner", "Member", "viewer"])
    def test_a_place_is_admin_or_member(self, organization, invitations, place):
        response = invite(OWNER, NO_ACCOUNT, place=place)

        assert response.status_code == 400
        assert response.get_json() == {"error": "A place is admin or member."}
        assert invitations.documents == []

    def test_an_organization_that_does_not_exist(self, organization, invitations):
        response = invite(OWNER, NO_ACCOUNT, org_id="org-missing")

        assert response.status_code == 404
        assert response.get_json() == {"error": "Organization not found"}

    def test_an_organization_being_deleted_reads_as_absent(
        self, monkeypatch, people, clock, mail, invitations,
    ):
        organization_with(monkeypatch, deleting={
            "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"})

        assert invite(OWNER, NO_ACCOUNT).status_code == 404
        assert invitations.documents == []

    def test_signing_in_is_required(self, organization, invitations):
        response = app_module.app.test_client().post(
            f"/organizations/{ORG_ID}/invitations", json={"email": NO_ACCOUNT, "place": "member"})

        assert response.status_code == 401
        assert invitations.documents == []


class TestInvitingAgain:
    def test_inviting_an_address_again_replaces_its_invitation(
        self, organization, invitations, history, mail, clock,
    ):
        first = invite(ADMIN, NO_ACCOUNT, place="member").get_json()["invitation"]
        clock.now = SENT_AT + timedelta(days=3)

        again = invite(OWNER, NO_ACCOUNT.upper(), place="admin").get_json()["invitation"]

        [doc] = stored(invitations)
        assert again["id"] == first["id"] == doc["id"]
        assert again == {
            "id": first["id"], "email": NO_ACCOUNT, "role": "admin", "invitedBy": OWNER.email,
            "sentAt": clock.now.isoformat(), "endsAt": (clock.now + timedelta(days=14)).isoformat(),
        }
        assert doc["invited_by"] == OWNER.id
        assert len(mail.messages) == 2
        assert [(entry["action"], entry["detail"]) for entry in entries(history)] == [
            (History.MANAGE_ORGANIZATION_MEMBERS, {"role": "member"}),
            (History.MANAGE_ORGANIZATION_ADMINS, {"role": "admin"})]

    def test_a_markets_invitation_of_the_address_is_another(
        self, organization, invitations,
    ):
        invitations.insert_one({
            "id": "invitation-market", "target_kind": "market", "target_id": ORG_ID,
            "email": NO_ACCOUNT, "role": "editor", "invited_by": OWNER.id,
            "invited_by_email": OWNER.email, "sent_at": SENT_AT, "expires_at": ENDS_AT,
            "counted_at": SENT_AT,
        })

        invite(OWNER, NO_ACCOUNT)

        assert sorted(doc["target_kind"] for doc in invitations.documents) == [
            "market", "organization"]


class TestTheEmail:
    def test_it_says_who_invited_them_to_which_organization_as_what_and_until_when(
        self, organization, mail,
    ):
        invite(OWNER, NO_ACCOUNT, place="admin")

        [message] = mail.messages
        assert message.kind == "invitation"
        assert message.email == NO_ACCOUNT
        assert message.subject == f"{OWNER.email} invited you to Ember Markets"
        for line in (
            f"{OWNER.email} invited you to join the organization Ember Markets as an admin on "
            "Conventioner.",
            "To accept or decline, sign in with this email address: "
            "http://127.0.0.1:5173/invitations\n",
            "No account yet? Create one with this email address first, and the invitation will "
            "be waiting.",
            "It ends on 8 December 2026 at 09:30 UTC.",
        ):
            assert line in message.text

    def test_it_names_a_member(self, organization, mail):
        invite(OWNER, NO_ACCOUNT, place="member")

        assert "the organization Ember Markets as a member on Conventioner." in (
            mail.messages[0].text)

    def test_its_html_escapes_the_organizations_name(self, monkeypatch, people, clock, mail):
        organization_with(monkeypatch, name="<b>Ember</b> & Co")

        invite(OWNER, NO_ACCOUNT)

        [message] = mail.messages
        assert "<b>" not in message.html
        assert "the organization &lt;b&gt;Ember&lt;/b&gt; &amp; Co as a member" in message.html
        assert "<b>Ember</b> & Co" in message.text

    def test_a_failed_send_keeps_the_invitation_and_says_so(
        self, organization, invitations, mail, history,
    ):
        mail.fails = True

        response = invite(OWNER, NO_ACCOUNT)

        assert response.status_code == 200
        assert response.get_json()["emailed"] is False
        assert len(invitations.documents) == 1
        assert len(entries(history)) == 1


class TestTheList:
    def listed(self, person, org_id=ORG_ID):
        return signed_in_as(person).get(f"/organizations/{org_id}/invitations")

    @pytest.mark.parametrize("reader", [OWNER, ADMIN])
    def test_its_owner_and_admins_read_both_places_newest_first(
        self, organization, clock, reader,
    ):
        invite(ADMIN, "first@example.com", place="member")
        clock.now = SENT_AT + timedelta(hours=1)
        invite(OWNER, "second@example.com", place="admin")

        response = self.listed(reader)

        assert response.status_code == 200
        assert [(row["email"], row["role"]) for row in response.get_json()["invitations"]] == [
            ("second@example.com", "admin"), ("first@example.com", "member")]

    @pytest.mark.parametrize("reader", [MEMBER, ACCOUNT])
    def test_anyone_else_is_refused(self, organization, reader):
        response = self.listed(reader)

        assert response.status_code == 403
        assert response.get_json() == {
            "error": "Only the organization's owner and its admins see its invitations."}

    def test_an_invitation_past_its_end_is_not_listed(self, organization, clock, invitations):
        invite(OWNER, NO_ACCOUNT)
        clock.now = ENDS_AT

        assert self.listed(OWNER).get_json() == {"invitations": []}
        assert len(invitations.documents) == 1, "the TTL removes it, a minute late at most"

    @pytest.mark.parametrize("kind, target", [("organization", "org-2"), ("market", ORG_ID)])
    def test_another_targets_invitations_are_not_listed(
        self, organization, invitations, kind, target,
    ):
        invite(OWNER, NO_ACCOUNT)
        invitations.documents[0].update(target_kind=kind, target_id=target)

        assert self.listed(OWNER).get_json() == {"invitations": []}

    def test_an_organization_that_does_not_exist(self, organization):
        assert self.listed(OWNER, org_id="org-missing").status_code == 404


class TestWithdrawing:
    def withdraw(self, person, invitation_id):
        return signed_in_as(person).delete(f"/organizations/{ORG_ID}/invitations/{invitation_id}")

    @pytest.mark.parametrize("inviter, withdrawer, place, action", [
        (OWNER, OWNER, "admin", History.MANAGE_ORGANIZATION_ADMINS),
        (OWNER, ADMIN, "member", History.MANAGE_ORGANIZATION_MEMBERS),
        (ADMIN, OWNER, "member", History.MANAGE_ORGANIZATION_MEMBERS),
    ])
    def test_withdrawing_ends_the_invitation_and_records_it(
        self, organization, invitations, history, inviter, withdrawer, place, action,
    ):
        invitation = invite(inviter, NO_ACCOUNT, place=place).get_json()["invitation"]

        response = self.withdraw(withdrawer, invitation["id"])

        assert response.status_code == 200
        assert response.get_json() == {"message": "Invitation withdrawn"}
        assert invitations.documents == []
        withdrawn = entries(history)[-1]
        assert (withdrawn["actor"], withdrawn["action"], withdrawn["kind"],
                withdrawn["subject"], withdrawn["detail"]) == (
            withdrawer.email, action, History.INVITATION_WITHDRAWN,
            {"email": NO_ACCOUNT}, {"role": place})

    def test_an_invitation_already_ended_says_so_and_records_nothing(
        self, organization, invitations, history,
    ):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        assert self.withdraw(OWNER, invitation["id"]).status_code == 200

        response = self.withdraw(OWNER, invitation["id"])

        assert response.status_code == 404
        assert response.get_json() == {"error": "That invitation has already ended."}
        assert [entry["kind"] for entry in entries(history)] == [
            History.INVITED, History.INVITATION_WITHDRAWN]

    def test_an_invitation_past_its_end_has_already_ended(self, organization, invitations, clock):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        clock.now = ENDS_AT

        assert self.withdraw(OWNER, invitation["id"]).status_code == 404

    def test_an_admin_may_not_withdraw_an_invitation_to_be_an_admin(
        self, organization, invitations, history,
    ):
        invitation = invite(OWNER, NO_ACCOUNT, place="admin").get_json()["invitation"]

        response = self.withdraw(ADMIN, invitation["id"])

        assert response.status_code == 403
        assert response.get_json() == {"error": "Only organization owner can add admins"}
        assert len(invitations.documents) == 1
        assert len(entries(history)) == 1

    @pytest.mark.parametrize("person", [MEMBER, ACCOUNT])
    def test_anyone_else_is_refused_whether_or_not_it_waits(
        self, organization, invitations, person,
    ):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]

        waiting = self.withdraw(person, invitation["id"])
        none = self.withdraw(person, "no-such-invitation")

        assert (waiting.status_code, waiting.get_json()) == (none.status_code, none.get_json())
        assert waiting.status_code == 403
        assert len(invitations.documents) == 1

    def test_a_re_invitation_to_another_place_meanwhile_is_not_withdrawn_unseen(
        self, organization, invitations, history, monkeypatch,
    ):
        """The withdrawal holds the place it asked about: an invitation made an admin one
        between its read and its delete is left, and the admin is told it changed."""
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        read = Invitations.waiting

        def read_then_reinvited(*args, **kwargs):
            found = read(*args, **kwargs)
            invitations.documents[0]["role"] = "admin"
            return found
        monkeypatch.setattr(Invitations, "waiting", read_then_reinvited)

        response = self.withdraw(ADMIN, invitation["id"])

        assert response.status_code == 409
        assert response.get_json() == {"error": Invitations.CHANGED_MEANWHILE}
        assert len(invitations.documents) == 1
        assert [entry["kind"] for entry in entries(history)] == [History.INVITED]

    def test_a_markets_invitation_is_not_found_here(self, organization, invitations):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        invitations.documents[0]["target_kind"] = "market"

        assert self.withdraw(OWNER, invitation["id"]).status_code == 404
        assert len(invitations.documents) == 1


class TestAnOrganizationDeletedMeanwhile:
    @pytest.mark.parametrize("gone", ["deleted", "its trail written"])
    def test_an_invitation_landing_as_its_organization_is_deleted_is_taken_back(
        self, organization, invitations, history, mail, monkeypatch, gone,
    ):
        """The invite read the organization live, and the deletion swept its invitations before
        the write: the write is taken back, nothing is recorded or sent, and it answers 404."""
        upsert = invitations.find_one_and_update

        def deleted_meanwhile(*args, **kwargs):
            if gone == "deleted":
                organization.docs.clear()
            else:
                organization.docs[0]["deleting"] = {
                    "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}
                monkeypatch.setattr(OrgsApi.DeletionTrail, "is_recorded", lambda _id: True)
            return upsert(*args, **kwargs)
        monkeypatch.setattr(invitations, "find_one_and_update", deleted_meanwhile)

        response = invite(OWNER, NO_ACCOUNT)

        assert response.status_code == 404
        assert response.get_json() == {"error": "Organization not found"}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []

    def test_one_landing_while_a_deletion_may_still_be_refused_is_kept(
        self, organization, invitations, monkeypatch,
    ):
        """A tombstone with no trail yet: that deletion sweeps after this write, or is refused and
        the organization lives on with its invitation."""
        upsert = invitations.find_one_and_update

        def deleting_meanwhile(*args, **kwargs):
            organization.docs[0]["deleting"] = {
                "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}
            return upsert(*args, **kwargs)
        monkeypatch.setattr(invitations, "find_one_and_update", deleting_meanwhile)
        monkeypatch.setattr(OrgsApi.DeletionTrail, "is_recorded", lambda _id: False)

        assert invite(OWNER, NO_ACCOUNT).status_code == 200
        assert len(invitations.documents) == 1
