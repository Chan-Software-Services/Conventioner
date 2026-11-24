/**
 * The invitations waiting for the signed-in person's address (T538, ADR 0047), and their words:
 * the Invitations page reads, accepts and declines them here, and the Markets list says how many
 * wait. One module, so a screen's tests mock one import.
 */
import type { Invitation } from '@/assets/types/datatypes';
import { api } from '@/utils/api';
import { marketPath } from '@/utils/market';
import { MONTH_NAMES } from '@/utils/calendarMonth';

/** What accepting gave, as `POST /invitations/<id>/accept` answers it. */
export interface Accepted {
  kind: Invitation['kind'];
  targetId: string;
  targetName: string;
  role: string;
}

/** Every invitation waiting for the signed-in address, newest first. */
export async function fetchInvitations(): Promise<Invitation[]> {
  const response = await api.get('/invitations');
  return (response.data.invitations ?? []) as Invitation[];
}

export async function acceptInvitation(id: string): Promise<Accepted> {
  const response = await api.post(`/invitations/${encodeURIComponent(id)}/accept`);
  return response.data.accepted as Accepted;
}

export async function declineInvitation(id: string): Promise<void> {
  await api.post(`/invitations/${encodeURIComponent(id)}/decline`);
}

/** The `code` of the server's 404 for an invitation that can no longer be answered. */
export const INVITATION_ENDED_CODE = 'invitation_ended';

/**
 * A role or a place with its article, as an invitation offers it: a market's role named as the
 * market's screens name it ("an Editor", "a Viewer"), an organization's place in lower case ("an
 * admin", "a member"), as Organizations says it.
 */
export function asA(kind: Invitation['kind'], role: string): string {
  const name = kind === 'market' ? role.charAt(0).toUpperCase() + role.slice(1) : role;
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** "ana@ember.test invited you to Riverside Market as an Editor.", or "... to the organization
 * Ember Makers as an admin." */
export function invitationSentence(invitation: Invitation): string {
  const to =
    invitation.kind === 'market'
      ? invitation.targetName
      : `the organization ${invitation.targetName}`;
  return `${invitation.invitedBy} invited you to ${to} as ${asA(invitation.kind, invitation.role)}.`;
}

/**
 * The last whole day an invitation waits, in the reader's own timezone: "8 December" for one that
 * ends during the 9th, or at its first moment. It names no day the invitation does not cover; the
 * email names the moment it ends, in UTC.
 */
export function endsOn(invitation: Pick<Invitation, 'endsAt'>): string {
  const at = new Date(invitation.endsAt);
  if (Number.isNaN(at.getTime())) return '';
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1);
  return `${day.getDate()} ${MONTH_NAMES[day.getMonth()]}`;
}

/** "You are now an Editor on Riverside Market.", or "You are now a member of Ember Makers." */
export function acceptedSentence(accepted: Accepted): string {
  const on = accepted.kind === 'market' ? 'on' : 'of';
  return `You are now ${asA(accepted.kind, accepted.role)} ${on} ${accepted.targetName}.`;
}

/** Where an accepted invitation leads, and its words: the market, as the Markets list opens it, or
 * Organizations. */
export function acceptedLink(accepted: Accepted): { to: string; words: string } {
  return accepted.kind === 'market'
    ? { to: marketPath(accepted.targetId), words: `Open ${accepted.targetName}` }
    : { to: '/organizations', words: 'Open Organizations' };
}

export function declinedSentence(invitation: Pick<Invitation, 'targetName'>): string {
  return `You declined the invitation to ${invitation.targetName}.`;
}

/** The Markets list's line, when any wait: "You have an invitation waiting.", "You have 3
 * invitations waiting." */
export function waitingLine(count: number): string {
  return count === 1 ? 'You have an invitation waiting.' : `You have ${count} invitations waiting.`;
}
