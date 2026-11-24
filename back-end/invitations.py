"""Single owner of the ``invitations`` collection: offers, each sent to an address, of a role on one
market or a place in one organization (T538, ADR 0047).

**A person joins only by accepting.** Adding someone to a market or an organization is an
invitation: the organizer types an address and a role, and every address gets the same answer, the
same email and the same history entry, whether or not it has an account. The invitation gives
nothing: no read of a market's roles, its people with access or a permission check reads this
collection, so nobody gains a role or a place by being invited.

**One invitation per address and target.** A document is written by one upsert on its target and
address, under the unique ``invitation_target_email_unique`` index, so inviting an address again
replaces its role, its inviter and its times and keeps its ``id``, and two invitations at once
leave one document. The two upserts that both matched nothing race on the index, and the one
refused is sent once more, finding the other's document.

**It waits 14 days.** ``expires_at`` is 14 days after it was sent, and a TTL index removes it then;
the TTL monitor runs about once a minute, so every read also asks for ``expires_at`` after now.
An invitation also ends on a decline, a withdrawal, or once its inviter can no longer give it, and
with its market or its organization (``market_deletion``).

**What a request sends counts.** Each invitation sends an email, so it is counted against two
limits of ``sign_in_limits`` before the account is looked up, by the inviter and by the address,
and refused alike for every address. ``counted_at`` keeps the instant it was counted at, for the
take-back an accepted invitation makes.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

import sign_in_limits
from client_errors import NotFoundError
from db_config import get_database
from unique_indexes import ensure_unique_index

INVITATIONS_COLLECTION = "invitations"

#: What an invitation is to: a role on a market, or a place in an organization.
MARKET = "market"
ORGANIZATION = "organization"

#: How long an invitation waits, from when it was last sent.
LIFETIME = timedelta(days=14)

#: The fields one invitation is kept by: one per target and address.
TARGET_FIELDS = ("target_kind", "target_id", "email")

#: The indexes the boot builds (``ensure_invitation_indexes``), by name.
UNIQUE_INDEX = "invitation_target_email_unique"
EMAIL_INDEX = "invitation_email"
EXPIRY_INDEX = "invitation_ttl"

#: Said of an invitation withdrawn that nobody can accept any more: it was withdrawn, declined,
#: accepted or ran out first. Manage market and Manage organization read it as done.
ALREADY_ENDED = "That invitation has already ended."

#: Said of an invitation withdrawn that was sent again to another role between its read and its
#: delete: the withdrawal asked the row of the role it read, so it leaves the new one.
CHANGED_MEANWHILE = (
    "That invitation was sent again meanwhile. Read the invitations again, and withdraw it if you "
    "still mean to.")

#: Said to an invitee of any invitation they cannot answer: another address's, an id that never
#: was, one past its 14 days, withdrawn, declined or accepted, one whose target is gone, and one
#: whose inviter can no longer give it. One sentence for all, so an id tells nothing of another's.
INVITATION_ENDED = (
    "This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no longer "
    "give it. Ask them to invite you again.")

#: Said of an invitation refused by either limit, with ``{wait}`` for how long to wait.
TOO_MANY = "You have sent many invitations. Try again in {wait}."

db = get_database()
invitations_collection = db[INVITATIONS_COLLECTION]


class InvitationIndexError(RuntimeError):
    """The invitations cannot be indexed, so the process refuses to boot."""


class TooManyInvitations(Exception):
    """An invitation a limit refused; ``retry_after`` is the seconds until it may be sent."""

    def __init__(self, retry_after: int):
        super().__init__(retry_after)
        self.retry_after = retry_after


class InvitationEnded(NotFoundError):
    """An invitation the signed-in person cannot answer (``INVITATION_ENDED``): a 404, coded
    ``invitation_ended``, which the Invitations page tells apart from the other refusals."""

    def __init__(self):
        super().__init__(INVITATION_ENDED)

    def body(self) -> Dict[str, Any]:
        return {"error": INVITATION_ENDED, "code": "invitation_ended"}


def now() -> datetime:
    """The current time, in UTC; a function so a test can move the clock."""
    return datetime.now(timezone.utc)


def ensure_invitation_indexes() -> None:
    """Build the unique index one invitation per address and target rests on, the index an
    invitee's list reads by, and the TTL index that removes an invitation once it has ended.

    Raises ``UniqueIndexError`` when the unique index cannot be built, naming the targets holding
    two invitations for one address but never the address, and ``InvitationIndexError`` when the
    others cannot; ``app.py``'s boot refuses to start on either.
    """
    ensure_unique_index(
        invitations_collection, TARGET_FIELDS, UNIQUE_INDEX,
        shown=("target_kind", "target_id"), one="one address's invitation to one target",
    )
    try:
        invitations_collection.create_index([("email", 1)], name=EMAIL_INDEX)
        invitations_collection.create_index(
            [("expires_at", 1)], expireAfterSeconds=0, name=EXPIRY_INDEX)
    except PyMongoError as exc:
        # The driver's message is not repeated, nor kept as the cause, as the other boot checks do.
        raise InvitationIndexError(
            f"Could not build the indexes on {INVITATIONS_COLLECTION} ({type(exc).__name__}, code "
            f"{getattr(exc, 'code', None)}): without them an ended invitation is never removed "
            f"and an invitee's list scans every invitation."
        ) from None


def count(inviter_id: str, email: str, at: datetime) -> None:
    """Count one invitation against both limits, by the inviter and by the address, at ``at``.

    Raises ``TooManyInvitations`` when either refuses, with the longer wait. Both are counted
    either way, as ``count_attempt`` counts a refused try, and before the account is looked up, so
    the refusal is the same for every address.
    """
    waits = [
        sign_in_limits.count_attempt(sign_in_limits.INVITATION_PER_INVITER, inviter_id, at),
        sign_in_limits.count_attempt(sign_in_limits.INVITATION_PER_ADDRESS, email, at),
    ]
    refused = [wait for wait in waits if wait is not None]
    if refused:
        raise TooManyInvitations(max(refused))


def invite(
    target_kind: str, target_id: str, email: str, role: str, inviter_id: str,
    inviter_email: str, at: datetime,
) -> Dict[str, Any]:
    """Write the invitation of ``email`` to the target, sent at ``at``, and answer it as stored.

    One upsert on the target and the address: an invitation already there is replaced, keeping
    its ``id``. Of two upserts that both matched nothing, the unique index refuses one, which is
    sent once more and finds the other's document; a second refusal is not a race, and is raised.
    """
    query = {"target_kind": target_kind, "target_id": target_id, "email": email}
    update = {
        "$set": {
            "role": role,
            "invited_by": inviter_id,
            "invited_by_email": inviter_email,
            "sent_at": at,
            "expires_at": at + LIFETIME,
            "counted_at": at,
        },
        "$setOnInsert": {"id": str(uuid.uuid4())},
    }
    try:
        return _upsert(query, update)
    except DuplicateKeyError:
        return _upsert(query, update)


def _upsert(query: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
    return invitations_collection.find_one_and_update(
        query, update, projection={"_id": 0}, upsert=True, return_document=ReturnDocument.AFTER)


def _waiting(query: Dict[str, Any]) -> Dict[str, Any]:
    """``query``, narrowed to invitations still waiting: the TTL monitor runs a minute late."""
    return {**query, "expires_at": {"$gt": now()}}


def waiting_for(target_kind: str, target_id: str) -> List[Dict[str, Any]]:
    """Every invitation waiting on the target, newest sent first."""
    return list(invitations_collection.find(
        _waiting({"target_kind": target_kind, "target_id": target_id}), {"_id": 0},
    ).sort([("sent_at", -1), ("id", -1)]))


def waiting(target_kind: str, target_id: str, invitation_id: str) -> Optional[Dict[str, Any]]:
    """The invitation with this id waiting on the target, or None."""
    return invitations_collection.find_one(_waiting(
        {"id": invitation_id, "target_kind": target_kind, "target_id": target_id}), {"_id": 0})


def waiting_for_address(email: str) -> List[Dict[str, Any]]:
    """Every invitation waiting for ``email``, a normalized address, newest sent first."""
    return list(invitations_collection.find(_waiting({"email": email}), {"_id": 0}).sort(
        [("sent_at", -1), ("id", -1)]))


def addressed(invitation_id: str, email: str) -> Dict[str, Any]:
    """The invitation with this id waiting for ``email``, a normalized address.

    Raises ``InvitationEnded`` for any other: the id held only by an invitation to another address
    reads as one that ended, so a forwarded email lets nobody else answer it.
    """
    invitation = invitations_collection.find_one(
        _waiting({"id": invitation_id, "email": email}), {"_id": 0})
    if invitation is None:
        raise InvitationEnded()
    return invitation


def end(invitation: Dict[str, Any]) -> bool:
    """Delete the invitation, by its id and address: accepted, declined, or one that can no longer
    be accepted. Whether it was there to delete."""
    return invitations_collection.delete_one(
        {"id": invitation["id"], "email": invitation["email"]}).deleted_count == 1


def take_back(invitation: Dict[str, Any]) -> None:
    """Take back the two counts an accepted invitation was counted with, at its ``counted_at``,
    so only invitations nobody accepts pile up against the limits."""
    # The driver hands a stored time back without its zone, and the limits' window reads a naive
    # time as the machine's own.
    at = _utc(invitation["counted_at"])
    sign_in_limits.take_back_attempt(
        sign_in_limits.INVITATION_PER_INVITER, invitation["invited_by"], at)
    sign_in_limits.take_back_attempt(sign_in_limits.INVITATION_PER_ADDRESS, invitation["email"], at)


def withdraw(invitation: Dict[str, Any]) -> bool:
    """Delete the invitation as it was read, holding its role; whether it was there to delete.

    Its id and target, and the role the withdrawal asked the row of: one sent again to another
    role meanwhile is left (``CHANGED_MEANWHILE``).
    """
    return invitations_collection.delete_one({
        "id": invitation["id"], "target_kind": invitation["target_kind"],
        "target_id": invitation["target_id"], "role": invitation["role"],
    }).deleted_count == 1


def delete_for_market(market_id: str) -> int:
    """Take a market's invitations with the market. Returns how many went."""
    return invitations_collection.delete_many(
        {"target_kind": MARKET, "target_id": market_id}).deleted_count


def _utc(value: datetime) -> datetime:
    """A stored time in UTC: the driver reads one back without its zone."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _instant(value: datetime) -> str:
    """A stored time as ISO 8601 in UTC."""
    return _utc(value).isoformat()


def ends_at(invitation: Dict[str, Any]) -> datetime:
    """When the invitation ends, in UTC."""
    return _utc(invitation["expires_at"])


def served(invitation: Dict[str, Any]) -> Dict[str, Any]:
    """An invitation as a target's organizer reads it: who it is to, as what, by whom, and when."""
    return {
        "id": invitation["id"],
        "email": invitation["email"],
        "role": invitation["role"],
        "invitedBy": invitation.get("invited_by_email"),
        "sentAt": _instant(invitation["sent_at"]),
        "endsAt": _instant(invitation["expires_at"]),
    }


def invitee_served(invitation: Dict[str, Any], target_name: str) -> Dict[str, Any]:
    """An invitation as the person it was sent to reads it: to what, as what, by whom, and when."""
    return {
        "id": invitation["id"],
        "kind": invitation["target_kind"],
        "targetId": invitation["target_id"],
        "targetName": target_name,
        "role": invitation["role"],
        "invitedBy": invitation.get("invited_by_email"),
        "sentAt": _instant(invitation["sent_at"]),
        "endsAt": _instant(invitation["expires_at"]),
    }
