"""The invitee's side of the invitations (T538, ADR 0047): what waits for the signed-in address,
and its answer.

An invitation is the signed-in account's only when it was sent to the account's address, in its one
spelling (``normalized_email``); any other id answers that it has ended (``InvitationEnded``), as
one past its end, withdrawn, or whose target is gone does. Accepting hands each kind to the module
that writes its target: a market's role to ``api.markets``, a place in an organization to
``organization_people``.
"""
from typing import Any, Dict, List

import api.markets as MarketsApi
import api.organizations as OrgsApi
import api.users as UsersApi
import invitations as Invitations
import organization_people as OrganizationPeople
from utils.email_address import normalized_email


def waiting(requesting_user: str) -> List[Dict[str, Any]]:
    """Every invitation waiting for the signed-in address, newest first, as its invitee reads it.

    The targets' names come from one read of the live markets among them and one of the live
    organizations; an invitation whose target is gone or being deleted is left out.
    """
    found = Invitations.waiting_for_address(normalized_email(requesting_user))

    def targets(kind: str) -> List[str]:
        return [invitation["target_id"] for invitation in found
                if invitation["target_kind"] == kind]
    names = {
        Invitations.MARKET: MarketsApi.live_market_names(targets(Invitations.MARKET)),
        Invitations.ORGANIZATION: OrgsApi.live_organization_names(
            targets(Invitations.ORGANIZATION)),
    }
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
    invitee = UsersApi.get_user(requesting_user)
    if invitation["target_kind"] == Invitations.MARKET:
        return MarketsApi.give_role_by_invitation(invitation, invitee)
    if invitation["target_kind"] == Invitations.ORGANIZATION:
        return OrganizationPeople.place_by_invitation(invitation, invitee)
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
    if invitation["target_kind"] == Invitations.ORGANIZATION:
        OrgsApi.decline_organization_invitation(invitation, address)
        return
    raise Invitations.InvitationEnded()
