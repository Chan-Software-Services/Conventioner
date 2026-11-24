"""The invitee's side of the invitations (T538, ADR 0047): what waits for the signed-in address,
and its answer.

An invitation is the signed-in account's only when it was sent to the account's address, in its one
spelling (``normalized_email``); any other id answers that it has ended (``InvitationEnded``), as
one past its end, withdrawn, or whose target is gone does. Accepting hands each kind to the module
that writes its target: a market's role to ``api.markets``.
"""
from typing import Any, Dict, List

import api.markets as MarketsApi
import api.users as UsersApi
import invitations as Invitations
from utils.email_address import normalized_email


def waiting(requesting_user: str) -> List[Dict[str, Any]]:
    """Every invitation waiting for the signed-in address, newest first, as its invitee reads it.

    The targets' names come from one read of the live markets among them; an invitation whose
    target is gone or being deleted is left out.
    """
    found = Invitations.waiting_for_address(normalized_email(requesting_user))
    names = {Invitations.MARKET: MarketsApi.live_market_names(
        invitation["target_id"] for invitation in found
        if invitation["target_kind"] == Invitations.MARKET)}
    return [
        Invitations.invitee_served(
            invitation, names[invitation["target_kind"]][invitation["target_id"]])
        for invitation in found
        if invitation["target_id"] in names.get(invitation["target_kind"], {})
    ]


def accept(invitation_id: str, requesting_user: str) -> Dict[str, Any]:
    """Accept an invitation waiting for the signed-in address: what they now hold, to show them.

    Raises:
        Invitations.InvitationEnded: it is not theirs, or it can no longer be accepted.
    """
    invitation = Invitations.addressed(invitation_id, normalized_email(requesting_user))
    if invitation["target_kind"] == Invitations.MARKET:
        return MarketsApi.give_role_by_invitation(invitation, UsersApi.get_user(requesting_user))
    raise Invitations.InvitationEnded()


def decline(invitation_id: str, requesting_user: str) -> None:
    """Decline an invitation waiting for the signed-in address: it ends, and gives nothing.

    Raises:
        Invitations.InvitationEnded: it is not theirs, or it has already ended.
    """
    address = normalized_email(requesting_user)
    invitation = Invitations.addressed(invitation_id, address)
    if invitation["target_kind"] == Invitations.MARKET:
        MarketsApi.decline_market_invitation(invitation, address)
        return
    raise Invitations.InvitationEnded()
