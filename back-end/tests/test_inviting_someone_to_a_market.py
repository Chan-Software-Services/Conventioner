"""Inviting someone to a market gives one answer for every address (T538, ADR 0047).

An organizer who may give a role on a market invites an address to it: whether or not the address
has an account, the invite answers the same status and body, sends the same email and records the
same entry, whose subject is the address alone. Nobody gains a role by being invited: the
invitation waits in ``invitations`` until someone signed in with that address accepts it. The
organizer lists the market's waiting invitations, and withdraws one.

Pinned through the test client against the real app, over collections that apply the writes.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import (
    FakeMarketsCollection,
    sessions_load_through_get_user,
    skip_without_real_dependencies,
    stored_market,
)

skip_without_real_dependencies()

import app as app_module  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import api.users as UsersApi  # noqa: E402
import history as History  # noqa: E402
import invitations as Invitations  # noqa: E402
import market_deletion as MarketDeletion  # noqa: E402
import market_write as MarketWrite  # noqa: E402
import sign_in_limits  # noqa: E402
import utils.email as Email  # noqa: E402
from datatypes import MarketPhase  # noqa: E402

MARKET_ID = "market-123"
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
ADMIN = SimpleNamespace(id="user-admin", email="admin@example.com")
EDITOR = SimpleNamespace(id="user-editor", email="editor@example.com")
VIEWER = SimpleNamespace(id="user-viewer", email="viewer@example.com")
#: An account holding no role on the market.
ACCOUNT = SimpleNamespace(id="user-account", email="has-an-account@example.com")
#: An address no account has.
NO_ACCOUNT = "no-account@example.com"
PEOPLE = (OWNER, ADMIN, EDITOR, VIEWER, ACCOUNT)
ROLES = {OWNER.id: "owner", ADMIN.id: "admin", EDITOR.id: "editor", VIEWER.id: "viewer"}

EDITORS_ROW_REFUSAL = (
    "Only an Admin or the owner may give or take Editor and Viewer roles on this market.")
ADMINS_ROW_REFUSAL = "Only the market's owner may give or take Admin roles on this market."

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


def market_with(monkeypatch, phase=MarketPhase.APPLICATIONS, **overrides):
    markets = FakeMarketsCollection(stored_market(
        phase=phase, **{"name": "Ember Night Market", "roles": dict(ROLES), **overrides}))
    monkeypatch.setattr(MarketsApi, "markets_collection", markets)
    monkeypatch.setattr(MarketWrite, "markets_collection", markets)
    return markets


@pytest.fixture
def market(monkeypatch, people, clock, mail):
    return market_with(monkeypatch)


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


def invite(person, email, role="editor", market_id=MARKET_ID):
    return signed_in_as(person).post(
        f"/markets/{market_id}/invitations", json={"email": email, "role": role})


def entries(history):
    return [doc for doc in history.documents if doc.get(History.MARKET_ID_FIELD) == MARKET_ID]


def stored(invitations):
    return [{key: value for key, value in doc.items() if key != "_id"}
            for doc in invitations.documents]


def without_ids(entry):
    return {key: value for key, value in entry.items() if key not in ("_id", "id", "at")}


class TestOneAnswerForEveryAddress:
    def test_an_invitation_answers_alike_for_every_address(
        self, market, invitations, history, mail,
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
            {"market_id": MARKET_ID, "actor": OWNER.email, "action": "manage-editors-and-viewers",
             "kind": History.INVITED, "vendors": [], "subject": None,
             "detail": {"role": "editor"}}] * 2
        assert [entry["subject"] for entry in entries(history)] == [
            {"email": ACCOUNT.email}, {"email": NO_ACCOUNT}]
        assert [message.email for message in mail.messages] == [ACCOUNT.email, NO_ACCOUNT]
        assert mail.messages[0].subject == mail.messages[1].subject
        assert mail.messages[0].text == mail.messages[1].text
        assert mail.messages[0].html == mail.messages[1].html

    def test_nobody_gains_a_role_by_being_invited(self, market, invitations):
        for address in (ACCOUNT.email, NO_ACCOUNT):
            assert invite(OWNER, address).status_code == 200

        assert market.doc["roles"] == ROLES
        assert len(invitations.documents) == 2

    @pytest.mark.parametrize("person", [ACCOUNT.email, NO_ACCOUNT])
    def test_no_route_adds_someone_to_a_market_directly(
        self, market, invitations, history, mail, person,
    ):
        response = signed_in_as(OWNER).post(
            f"/markets/{MARKET_ID}/roles", json={"user_email": person, "role": "editor"})

        assert response.status_code == 404
        assert market.doc["roles"] == ROLES
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []

    def test_the_answer_serves_the_invitation(self, market, invitations):
        response = invite(OWNER, "  Someone@Example.com ", role="Viewer")

        [doc] = stored(invitations)
        assert response.get_json() == {
            "invitation": {
                "id": doc["id"], "email": "someone@example.com", "role": "viewer",
                "invitedBy": OWNER.email, "sentAt": SENT_AT.isoformat(),
                "endsAt": ENDS_AT.isoformat(),
            },
            "emailed": True,
        }
        assert doc == {
            "id": doc["id"], "target_kind": "market", "target_id": MARKET_ID,
            "email": "someone@example.com", "role": "viewer", "invited_by": OWNER.id,
            "invited_by_email": OWNER.email, "sent_at": SENT_AT, "expires_at": ENDS_AT,
            "counted_at": SENT_AT,
        }

    def test_an_address_already_on_the_market_is_refused_pointing_at_their_row(
        self, market, invitations, history, mail,
    ):
        response = invite(OWNER, EDITOR.email, role="viewer")

        assert response.status_code == 400
        assert response.get_json() == {"error": (
            f"{EDITOR.email} already has a role on this market. "
            "Change it in their row under Users with access.")}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []


class TestWhoMayInvite:
    @pytest.mark.parametrize("inviter, role", [
        (OWNER, "admin"), (OWNER, "editor"), (OWNER, "viewer"),
        (ADMIN, "editor"), (ADMIN, "viewer"),
    ])
    def test_whoever_may_give_the_role_invites(self, market, invitations, inviter, role):
        assert invite(inviter, NO_ACCOUNT, role=role).status_code == 200
        assert [doc["role"] for doc in invitations.documents] == [role]

    def test_the_admin_row_is_asked_of_an_admin_invitation(self, market, invitations, history):
        invite(OWNER, NO_ACCOUNT, role="admin")

        assert [entry["action"] for entry in entries(history)] == ["manage-admins"]

    @pytest.mark.parametrize("inviter, role, refusal", [
        (ADMIN, "admin", ADMINS_ROW_REFUSAL),
        (EDITOR, "editor",
         EDITORS_ROW_REFUSAL),
        (VIEWER, "viewer",
         EDITORS_ROW_REFUSAL),
        (ACCOUNT, "viewer",
         EDITORS_ROW_REFUSAL),
    ])
    def test_whoever_may_not_give_the_role_is_refused_before_anything_is_written(
        self, market, invitations, history, mail, sign_in_attempts, inviter, role, refusal,
    ):
        response = invite(inviter, NO_ACCOUNT, role=role)

        assert response.status_code == 403
        assert response.get_json() == {"error": refusal}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []
        assert sign_in_attempts.docs == {}

    def test_an_archived_market_still_invites(self, monkeypatch, people, clock, mail, invitations):
        market_with(monkeypatch, phase=MarketPhase.ARCHIVED)

        assert invite(OWNER, NO_ACCOUNT).status_code == 200
        assert len(invitations.documents) == 1


class TestWhatIsRefusedFirst:
    @pytest.mark.parametrize("body", [
        {"role": "editor"}, {"email": NO_ACCOUNT}, {"email": 7, "role": "editor"},
        {"email": NO_ACCOUNT, "role": ["editor"]}, {"email": "", "role": "editor"},
    ])
    def test_an_address_and_a_role_are_required(self, market, invitations, body):
        response = signed_in_as(OWNER).post(f"/markets/{MARKET_ID}/invitations", json=body)

        assert response.status_code == 400
        assert response.get_json() == {"error": "email and role required"}
        assert invitations.documents == []

    @pytest.mark.parametrize("typed", ["someone", "someone@example", "@", "someone@"])
    def test_what_is_not_an_address_is_refused(self, market, invitations, typed):
        response = invite(OWNER, typed)

        assert response.status_code == 400
        assert response.get_json() == {
            "error": "Type an email address, such as name@example.com."}
        assert invitations.documents == []

    def test_a_role_that_does_not_exist(self, market, invitations):
        response = invite(OWNER, NO_ACCOUNT, role="Wizard")

        assert response.status_code == 400
        assert response.get_json() == {"error": "Invalid role: Wizard"}

    def test_the_owner_role_is_never_given_by_invitation(self, market, invitations):
        response = invite(OWNER, NO_ACCOUNT, role="owner")

        assert response.status_code == 400
        assert response.get_json() == {
            "error": "A market's Owner changes only when ownership is transferred."}
        assert invitations.documents == []

    def test_a_market_that_does_not_exist(self, market, invitations):
        response = invite(OWNER, NO_ACCOUNT, market_id="market-missing")

        assert response.status_code == 404
        assert response.get_json() == {"error": "Market not found"}

    def test_a_market_being_deleted_reads_as_absent(self, monkeypatch, people, clock, mail,
                                                     invitations):
        market_with(monkeypatch, deleting={"at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"})

        assert invite(OWNER, NO_ACCOUNT).status_code == 404
        assert invitations.documents == []


class TestInvitingAgain:
    def test_inviting_an_address_again_replaces_its_invitation(
        self, market, invitations, history, mail, clock,
    ):
        first = invite(OWNER, NO_ACCOUNT, role="viewer").get_json()["invitation"]
        clock.now = SENT_AT + timedelta(days=3)

        again = invite(ADMIN, NO_ACCOUNT.upper(), role="editor").get_json()["invitation"]

        [doc] = stored(invitations)
        assert again["id"] == first["id"] == doc["id"]
        assert again == {
            "id": first["id"], "email": NO_ACCOUNT, "role": "editor", "invitedBy": ADMIN.email,
            "sentAt": clock.now.isoformat(), "endsAt": (clock.now + timedelta(days=14)).isoformat(),
        }
        assert doc["invited_by"] == ADMIN.id
        assert doc["counted_at"] == clock.now
        assert len(mail.messages) == 2
        assert [entry["detail"] for entry in entries(history)] == [
            {"role": "viewer"}, {"role": "editor"}]

    def test_two_invitations_racing_leave_one(self, market, invitations, monkeypatch):
        """The unique index refuses the second of two upserts that both matched nothing; it is
        sent once more, and then finds the first's invitation and replaces it."""
        invite(OWNER, NO_ACCOUNT)
        [first] = invitations.documents
        upsert = invitations.find_one_and_update
        raced = []

        def racing(query, update, **kwargs):
            if not raced:
                raced.append(query)
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError("E11000 duplicate key error")
            return upsert(query, update, **kwargs)
        monkeypatch.setattr(invitations, "find_one_and_update", racing)

        response = invite(ADMIN, NO_ACCOUNT, role="viewer")

        assert response.status_code == 200
        assert raced
        assert [doc["id"] for doc in invitations.documents] == [first["id"]]
        assert invitations.documents[0]["role"] == "viewer"


class TestTheEmail:
    def test_it_says_who_invited_them_to_what_as_what_and_until_when(self, market, mail):
        invite(OWNER, NO_ACCOUNT)

        [message] = mail.messages
        assert message.kind == "invitation"
        assert message.email == NO_ACCOUNT
        assert message.subject == f"{OWNER.email} invited you to Ember Night Market"
        for line in (
            f"{OWNER.email} invited you to join Ember Night Market as an Editor on Conventioner.",
            "To accept or decline, sign in with this email address: "
            "http://127.0.0.1:5173/invitations\n",
            "No account yet? Create one with this email address first, and the invitation will "
            "be waiting.",
            "It ends on 8 December 2026 at 09:30 UTC.",
            "If you weren't expecting it, you can ignore this email: nothing happens unless you "
            "accept.",
        ):
            assert line in message.text
        assert 'href="http://127.0.0.1:5173/invitations"' in message.html

    @pytest.mark.parametrize("role, words", [
        ("admin", "as an Admin"), ("editor", "as an Editor"), ("viewer", "as a Viewer")])
    def test_it_names_the_role(self, market, mail, role, words):
        invite(OWNER, NO_ACCOUNT, role=role)

        assert f"Ember Night Market {words} on Conventioner." in mail.messages[0].text

    def test_its_html_escapes_every_name_and_address(self, monkeypatch, people, clock, mail):
        market_with(monkeypatch, name="<b>Ember</b> & Co")

        invite(OWNER, NO_ACCOUNT)

        [message] = mail.messages
        assert "<b>" not in message.html
        assert "&lt;b&gt;Ember&lt;/b&gt; &amp; Co" in message.html
        assert "<b>Ember</b> & Co" in message.text

    def test_a_name_on_two_lines_reads_on_one_in_the_subject(self, monkeypatch, people, clock,
                                                              mail):
        market_with(monkeypatch, name="Ember\r\nBcc: someone")

        invite(OWNER, NO_ACCOUNT)

        assert mail.messages[0].subject == f"{OWNER.email} invited you to Ember Bcc: someone"

    def test_a_failed_send_keeps_the_invitation_and_says_so(self, market, invitations, mail,
                                                            history):
        mail.fails = True

        response = invite(OWNER, NO_ACCOUNT)

        assert response.status_code == 200
        assert response.get_json()["emailed"] is False
        assert len(invitations.documents) == 1
        assert len(entries(history)) == 1


class TestTheLimits:
    def test_an_inviter_past_their_limit_is_refused_alike_for_every_address(
        self, market, invitations, history, mail, monkeypatch,
    ):
        monkeypatch.setattr(sign_in_limits, "INVITATION_PER_INVITER", sign_in_limits.SignInLimit(
            "invitation:inviter", attempts=2, window=timedelta(minutes=15)))
        for address in ("one@example.com", "two@example.com"):
            assert invite(OWNER, address).status_code == 200

        refusals = [invite(OWNER, address) for address in (ACCOUNT.email, NO_ACCOUNT, EDITOR.email)]

        assert {response.status_code for response in refusals} == {429}
        assert {response.headers["Retry-After"] for response in refusals} == {"900"}
        assert {response.get_json()["error"] for response in refusals} == {
            "You have sent many invitations. Try again in 15 minutes."}
        assert len(invitations.documents) == 2
        assert len(entries(history)) == 2
        assert len(mail.messages) == 2

    def test_an_address_invited_too_often_is_refused(self, market, invitations, mail):
        for inviter in (OWNER, ADMIN, OWNER, ADMIN, OWNER):
            assert invite(inviter, NO_ACCOUNT).status_code == 200

        response = invite(ADMIN, NO_ACCOUNT)

        assert response.status_code == 429
        assert len(mail.messages) == 5

    def test_both_limits_are_listed_with_the_others(self):
        assert sign_in_limits.INVITATION_PER_INVITER in sign_in_limits.LIMITS
        assert sign_in_limits.INVITATION_PER_ADDRESS in sign_in_limits.LIMITS
        assert sign_in_limits.INVITATION_PER_INVITER.attempts == 100
        assert sign_in_limits.INVITATION_PER_ADDRESS.attempts == 5

    def test_an_invitation_counts_by_inviter_and_by_address_when_it_was_sent(
        self, market, sign_in_attempts,
    ):
        invite(OWNER, NO_ACCOUNT)

        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [1, 1]
        for limit, subject in ((sign_in_limits.INVITATION_PER_INVITER, OWNER.id),
                               (sign_in_limits.INVITATION_PER_ADDRESS, NO_ACCOUNT)):
            key, _ends = sign_in_limits._window(limit, subject, SENT_AT)
            assert sign_in_attempts.docs[key]["count"] == 1


class TestTheList:
    def test_it_lists_the_waiting_invitations_newest_first(self, market, clock):
        invite(OWNER, "first@example.com")
        clock.now = SENT_AT + timedelta(hours=1)
        invite(OWNER, "second@example.com", role="admin")

        response = signed_in_as(ADMIN).get(f"/markets/{MARKET_ID}/invitations")

        assert response.status_code == 200
        assert [(row["email"], row["role"]) for row in response.get_json()["invitations"]] == [
            ("second@example.com", "admin"), ("first@example.com", "editor")]

    def test_an_invitation_past_its_end_is_not_listed(self, market, clock, invitations):
        invite(OWNER, NO_ACCOUNT)
        clock.now = ENDS_AT

        response = signed_in_as(OWNER).get(f"/markets/{MARKET_ID}/invitations")

        assert response.get_json() == {"invitations": []}
        assert len(invitations.documents) == 1, "the TTL removes it, a minute late at most"

    def test_another_markets_invitations_are_not_listed(self, market, invitations):
        invite(OWNER, NO_ACCOUNT)
        invitations.documents[0]["target_id"] = "another-market"

        response = signed_in_as(OWNER).get(f"/markets/{MARKET_ID}/invitations")

        assert response.get_json() == {"invitations": []}

    @pytest.mark.parametrize("reader", [EDITOR, VIEWER, ACCOUNT])
    def test_whoever_may_give_no_role_is_refused(self, market, reader):
        response = signed_in_as(reader).get(f"/markets/{MARKET_ID}/invitations")

        assert response.status_code == 403
        assert response.get_json() == {"error": EDITORS_ROW_REFUSAL}

    def test_a_market_that_does_not_exist(self, market):
        response = signed_in_as(OWNER).get("/markets/market-missing/invitations")

        assert response.status_code == 404


class TestWithdrawing:
    def withdraw(self, person, invitation):
        """Withdraw the invitation as it was served, naming the send it was read at."""
        return signed_in_as(person).delete(
            f"/markets/{MARKET_ID}/invitations/{invitation['id']}",
            query_string={"sentAt": invitation["sentAt"]})

    def test_withdrawing_ends_the_invitation_and_records_it(self, market, invitations, history):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]

        response = self.withdraw(ADMIN, invitation)

        assert response.status_code == 200
        assert response.get_json() == {"message": "Invitation withdrawn"}
        assert invitations.documents == []
        withdrawn = entries(history)[-1]
        assert (withdrawn["actor"], withdrawn["action"], withdrawn["kind"],
                withdrawn["subject"], withdrawn["detail"]) == (
            ADMIN.email, "manage-editors-and-viewers", History.INVITATION_WITHDRAWN,
            {"email": NO_ACCOUNT}, {"role": "editor"})

    def test_an_invitation_already_ended_says_so_and_records_nothing(
        self, market, invitations, history,
    ):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        assert self.withdraw(OWNER, invitation).status_code == 200

        response = self.withdraw(OWNER, invitation)

        assert response.status_code == 404
        assert response.get_json() == {"error": "That invitation has already ended."}
        assert [entry["kind"] for entry in entries(history)] == [
            History.INVITED, History.INVITATION_WITHDRAWN]

    def test_an_invitation_past_its_end_has_already_ended(self, market, invitations, clock):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        clock.now = ENDS_AT

        assert self.withdraw(OWNER, invitation).status_code == 404

    def test_an_admin_may_not_withdraw_an_admin_invitation(self, market, invitations, history):
        invitation = invite(OWNER, NO_ACCOUNT, role="admin").get_json()["invitation"]

        response = self.withdraw(ADMIN, invitation)

        assert response.status_code == 403
        assert response.get_json() == {
            "error": ADMINS_ROW_REFUSAL}
        assert len(invitations.documents) == 1
        assert len(entries(history)) == 1

    @pytest.mark.parametrize("person", [EDITOR, ACCOUNT])
    def test_whoever_may_give_no_role_is_refused_whether_or_not_it_waits(
        self, market, invitations, person,
    ):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]

        waiting = self.withdraw(person, invitation)
        none = self.withdraw(person, {**invitation, "id": "no-such-invitation"})

        assert (waiting.status_code, waiting.get_json()) == (none.status_code, none.get_json())
        assert waiting.status_code == 403
        assert len(invitations.documents) == 1

    @pytest.mark.parametrize("role", ["editor", "admin"])
    def test_one_sent_again_since_it_was_read_is_left_and_says_why(
        self, market, invitations, history, clock, role,
    ):
        """A re-send keeps the id, so the withdrawal names the send it was confirmed for: one sent
        since, to any role, is not that one. An Admin hears this of one now sent as an Admin
        too, which they may not withdraw."""
        confirmed = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        clock.now = SENT_AT + timedelta(hours=1)
        again = invite(OWNER, NO_ACCOUNT, role=role).get_json()["invitation"]
        assert again["id"] == confirmed["id"]

        response = self.withdraw(ADMIN, confirmed)

        assert response.status_code == 409
        assert response.get_json() == {"error": Invitations.CHANGED_MEANWHILE}
        assert [doc["role"] for doc in invitations.documents] == [role]
        assert [entry["kind"] for entry in entries(history)] == [History.INVITED] * 2
        assert self.withdraw(OWNER, again).status_code == 200

    @pytest.mark.parametrize("query", [{}, {"sentAt": ""}, {"sentAt": "yesterday"}])
    def test_a_withdrawal_naming_no_send_it_stands_at_is_refused_the_same_way(
        self, market, invitations, history, query,
    ):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]

        response = signed_in_as(OWNER).delete(
            f"/markets/{MARKET_ID}/invitations/{invitation['id']}", query_string=query)

        assert response.status_code == 409
        assert response.get_json() == {"error": Invitations.CHANGED_MEANWHILE}
        assert len(invitations.documents) == 1
        assert [entry["kind"] for entry in entries(history)] == [History.INVITED]

    @pytest.mark.parametrize("role", ["editor", "admin"])
    def test_one_sent_again_between_the_read_and_the_delete_is_left(
        self, market, invitations, history, monkeypatch, role,
    ):
        """The delete holds the send it read, and the role it asked the row of."""
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        read = Invitations.waiting

        def read_then_sent_again(*args, **kwargs):
            found = read(*args, **kwargs)
            Invitations.invite(
                Invitations.MARKET, MARKET_ID, NO_ACCOUNT, role, OWNER.id, OWNER.email,
                SENT_AT + timedelta(hours=1))
            return found
        monkeypatch.setattr(Invitations, "waiting", read_then_sent_again)

        response = self.withdraw(ADMIN, invitation)

        assert response.status_code == 409
        assert response.get_json() == {"error": Invitations.CHANGED_MEANWHILE}
        assert [doc["role"] for doc in invitations.documents] == [role]
        assert [entry["kind"] for entry in entries(history)] == [History.INVITED]

    def test_another_markets_invitation_is_not_found_here(self, market, invitations):
        invitation = invite(OWNER, NO_ACCOUNT).get_json()["invitation"]
        invitations.documents[0]["target_id"] = "another-market"

        assert self.withdraw(OWNER, invitation).status_code == 404
        assert len(invitations.documents) == 1


class TestDeletingTheMarket:
    def test_its_invitations_go_with_it(self, market, invitations):
        invite(OWNER, NO_ACCOUNT)
        invite(OWNER, "kept@example.com")
        invitations.documents[1]["target_id"] = "another-market"

        MarketDeletion.delete_records(MARKET_ID)

        assert [doc["email"] for doc in invitations.documents] == ["kept@example.com"]

    def test_an_invitation_landing_as_its_market_is_deleted_is_taken_back(
        self, market, invitations, history, mail, monkeypatch,
    ):
        """The invite read its market live, and the deletion swept before its write: the write is
        taken back, nothing is recorded or sent, and it answers as the market's loader would."""
        monkeypatch.setattr(MarketDeletion, "deletion_decided", lambda *_args: True)

        response = invite(OWNER, NO_ACCOUNT)

        assert response.status_code == 404
        assert response.get_json() == {"error": "Market not found"}
        assert invitations.documents == []
        assert entries(history) == []
        assert mail.messages == []

    def test_an_organizations_invitation_under_the_same_id_is_not_a_markets(self, invitations):
        invitations.documents.append({"id": "i-1", "target_kind": "organization",
                                      "target_id": MARKET_ID, "email": NO_ACCOUNT})

        MarketDeletion.delete_records(MARKET_ID)

        assert len(invitations.documents) == 1


class IndexesThatFail:
    """An invitations collection whose index builds the server refuses, quoting an address as a
    driver's message can; ``refusing`` names the index refused, or every one when None."""

    def __init__(self, refusing=None):
        self.refusing = refusing
        self.built = []

    def index_information(self):
        return {}

    def create_index(self, keys, **options):
        if self.refusing is None or options.get("name") == self.refusing:
            from pymongo.errors import OperationFailure
            raise OperationFailure(f"cannot build: {NO_ACCOUNT}", code=85)
        self.built.append(options["name"])
        return options["name"]

    def aggregate(self, _pipeline):
        return iter([])

    name = Invitations.INVITATIONS_COLLECTION


class TestTheIndexes:
    def test_the_boot_builds_each_index_by_name(self, monkeypatch):
        collection = IndexesThatFail(refusing="none of them")
        monkeypatch.setattr(Invitations, "invitations_collection", collection)

        Invitations.ensure_invitation_indexes()

        assert collection.built == [
            Invitations.UNIQUE_INDEX, Invitations.EMAIL_INDEX, Invitations.EXPIRY_INDEX]

    def test_a_unique_index_that_cannot_be_built_refuses_the_boot(self, monkeypatch, caplog):
        from unique_indexes import UniqueIndexError
        monkeypatch.setattr(Invitations, "invitations_collection", IndexesThatFail())

        with caplog.at_level("CRITICAL"), pytest.raises(UniqueIndexError) as refusal:
            app_module.verify_invitation_indexes()

        assert Invitations.UNIQUE_INDEX in str(refusal.value)
        assert NO_ACCOUNT not in str(refusal.value)
        assert any(record.getMessage().startswith("Refusing to start: ")
                   for record in caplog.records)

    @pytest.mark.parametrize("index", [Invitations.EMAIL_INDEX, Invitations.EXPIRY_INDEX])
    def test_an_index_that_cannot_be_built_refuses_the_boot_without_the_drivers_words(
        self, monkeypatch, caplog, index,
    ):
        monkeypatch.setattr(Invitations, "invitations_collection", IndexesThatFail(index))

        with caplog.at_level("CRITICAL"), \
                pytest.raises(Invitations.InvitationIndexError) as refusal:
            app_module.verify_invitation_indexes()

        assert "OperationFailure, code 85" in str(refusal.value)
        assert NO_ACCOUNT not in str(refusal.value)
        assert refusal.value.__cause__ is None
        assert NO_ACCOUNT not in caplog.text
