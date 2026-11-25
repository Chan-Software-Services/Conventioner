/**
 * Invitations (T538, ADR 0047), and their words: the ones waiting for the signed-in person's
 * address, which the Invitations page reads, accepts and declines and the Markets list counts, and
 * the ones a market's organizers send, read and withdraw in Manage market. One module, so a screen's
 * tests mock one import.
 */
import type { Invitation, SentInvitation } from '@/assets/types/datatypes';
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
 * The moment an invitation ends, in the reader's own timezone: "8 December, 16:44". It is never a
 * day gone by while the invitation waits, and covers no more than it gives; the email names the
 * same moment in UTC.
 */
export function endsOn(invitation: Pick<Invitation, 'endsAt'>): string {
  const at = new Date(invitation.endsAt);
  if (Number.isNaN(at.getTime())) return '';
  const time = [at.getHours(), at.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${at.getDate()} ${MONTH_NAMES[at.getMonth()]}, ${time}`;
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

/** What sending an invitation answers: the invitation, and whether its email went. */
export interface Sent {
  invitation: SentInvitation;
  emailed: boolean;
}

/**
 * Invite `email` to `role` on the market whose `id` is `marketId`. The answer is the same for every
 * address: nobody is given a role until someone signed in with it accepts.
 */
export async function inviteToMarket(marketId: string, email: string, role: string): Promise<Sent> {
  const response = await api.post(`/markets/${encodeURIComponent(marketId)}/invitations`, {
    email,
    role,
  });
  return response.data as Sent;
}

/** The invitations waiting on a market, newest first. */
export async function fetchMarketInvitations(marketId: string): Promise<SentInvitation[]> {
  const response = await api.get(`/markets/${encodeURIComponent(marketId)}/invitations`);
  return (response.data.invitations ?? []) as SentInvitation[];
}

export async function withdrawMarketInvitation(marketId: string, id: string): Promise<void> {
  await api.delete(
    `/markets/${encodeURIComponent(marketId)}/invitations/${encodeURIComponent(id)}`,
  );
}

/** Said under an invite row once the invitation went: "Invitation sent to ana@ember.test." */
export function sentLine(address: string): string {
  return `Invitation sent to ${address}.`;
}

/** Said in the sent line's place when the invitation was made but its email could not be sent. */
export function notEmailedLine(address: string): string {
  return `${address} is invited, but the email could not be sent. Invite them again to send it.`;
}

/**
 * An invitation's line under "Invited": "Invited as Editor, until 8 December, 16:44", a market's
 * role named as "Users with access" names it, an organization's place in lower case.
 */
export function invitedAs(
  kind: Invitation['kind'],
  invitation: Pick<SentInvitation, 'role' | 'endsAt'>,
): string {
  const role =
    kind === 'market'
      ? invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1)
      : invitation.role;
  const until = endsOn(invitation);
  return until ? `Invited as ${role}, until ${until}` : `Invited as ${role}`;
}
