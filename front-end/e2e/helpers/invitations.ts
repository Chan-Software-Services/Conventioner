import { expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { BACKEND_URL } from '../fixtures';
import { loginViaApi } from './seeds';

/**
 * Invitations through the API (T538, ADR 0047): a role on a market and a place in an organization
 * are offered to an address, and given only once someone signed in with it accepts.
 *
 * `inviteToMarket` and `inviteToOrganization` invite as whoever `request`'s session is, as Manage
 * market and Manage organization do. `acceptInvitation` accepts as the invitee on a request
 * context of its own, signed in for the call and disposed after it, never on the inviter's: a sign-in
 * ends the sign-in that context held.
 */

export type MarketInvitationRole = 'admin' | 'editor' | 'viewer';
export type OrganizationPlace = 'admin' | 'member';

/** An invitation as its inviter reads it, `POST`'s answer. */
export interface SentInvitation {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  sentAt: string;
  endsAt: string;
}

async function sent(response: Awaited<ReturnType<APIRequestContext['post']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { invitation: SentInvitation; emailed: boolean };
  return body.invitation;
}

/** Invite `email` to `role` on the market whose `id` (its uuid) is `marketId`. */
export async function inviteToMarket(
  request: APIRequestContext,
  marketId: string,
  email: string,
  role: MarketInvitationRole,
): Promise<SentInvitation> {
  return sent(
    await request.post(`${BACKEND_URL}/markets/${marketId}/invitations`, {
      data: { email, role },
    }),
  );
}

/** Invite `email` to `place` in the organization `orgId`. */
export async function inviteToOrganization(
  request: APIRequestContext,
  orgId: string,
  email: string,
  place: OrganizationPlace,
): Promise<SentInvitation> {
  return sent(
    await request.post(`${BACKEND_URL}/organizations/${orgId}/invitations`, {
      data: { email, place },
    }),
  );
}

/** An invitation as its invitee reads it, `GET /invitations`'s rows. */
export interface WaitingInvitation {
  id: string;
  kind: 'market' | 'organization';
  targetId: string;
  targetName: string;
  role: string;
}

type Person = { email: string; password: string };

/** `body` with `person` signed in on a request context of their own, disposed after it. */
async function asThem<T>(person: Person, body: (invitee: APIRequestContext) => Promise<T>) {
  const invitee = await apiRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    await loginViaApi(invitee, BACKEND_URL, person.email, person.password);
    return await body(invitee);
  } finally {
    await invitee.dispose();
  }
}

async function waiting(invitee: APIRequestContext): Promise<WaitingInvitation[]> {
  const listed = await invitee.get(`${BACKEND_URL}/invitations`);
  expect(listed.ok(), await listed.text()).toBe(true);
  return ((await listed.json()) as { invitations: WaitingInvitation[] }).invitations;
}

/** The invitations waiting for `person`, as their Invitations page reads them. */
export async function invitationsWaitingFor(person: Person): Promise<WaitingInvitation[]> {
  return asThem(person, waiting);
}

/**
 * Sign `person` in on a request context of their own, find their invitation to `targetId` (a
 * market's `id` or an organization's) among those waiting for them, and accept it.
 */
export async function acceptInvitation(person: Person, targetId: string): Promise<void> {
  await asThem(person, async (invitee) => {
    const invitation = (await waiting(invitee)).find((one) => one.targetId === targetId);
    expect(invitation, `${person.email} has an invitation to ${targetId} waiting`).toBeDefined();
    const accepted = await invitee.post(`${BACKEND_URL}/invitations/${invitation!.id}/accept`);
    expect(accepted.ok(), await accepted.text()).toBe(true);
  });
}
