import type { APIRequestContext } from '@playwright/test';
import {
  acceptInvitation,
  inviteToMarket,
  inviteToOrganization,
  type MarketInvitationRole,
  type OrganizationPlace,
} from './invitations';

/**
 * A role on a market and a place in an organization, given as the app gives them (ADR 0047): an
 * invitation sent through the session `request` holds (the seed's owner, or whoever may give it),
 * then accepted by the person on a request context of their own. No route places a person without
 * their acceptance, so a spec gives every role and place through these.
 *
 * The person must already have an account they sign in to with `password`: `ensureVerifiedUser`
 * makes one. A person who already has a role on the market, or a place in the organization, is the
 * spec's mistake, and the invitation's refusal fails the call with the server's words.
 */
type Person = { email: string; password: string };

/** Give `person` `role` on the market whose `id` (its uuid) is `marketId`. */
export async function grantMarketRole(
  request: APIRequestContext,
  marketId: string,
  person: Person,
  role: MarketInvitationRole,
): Promise<void> {
  await inviteToMarket(request, marketId, person.email, role);
  await acceptInvitation(person, marketId);
}

/** Give `person` `place` in the organization `orgId`. */
export async function placeInOrganization(
  request: APIRequestContext,
  orgId: string,
  person: Person,
  place: OrganizationPlace,
): Promise<void> {
  await inviteToOrganization(request, orgId, person.email, place);
  await acceptInvitation(person, orgId);
}

/**
 * Make `person` an admin of the organization, as its owner, whose session `request` carries.
 *
 * An organization's admins run its markets (T15), so this makes them Admin on every market the
 * organization holds. Idempotent across runs, so the organization is read first: an admin already
 * is left as they are, a member is made an admin by the place change their row's "Make admin"
 * sends, and anyone else is invited and accepts. A step that fails throws with the server's words.
 */
export async function ensureOrganizationAdmin(
  request: APIRequestContext,
  baseURL: string,
  orgId: string,
  person: Person,
): Promise<void> {
  const orgs = await request.get(`${baseURL}/organizations`);
  if (!orgs.ok()) {
    throw new Error(`Organization list failed: ${orgs.status()} ${await orgs.text()}`);
  }
  type Placed = { userId: string; email: string };
  const { organizations = [] } = (await orgs.json()) as {
    organizations?: { id: string; adminPeople?: Placed[]; memberPeople?: Placed[] }[];
  };
  const org = organizations.find((o) => o.id === orgId);
  if (org?.adminPeople?.some((admin) => admin.email === person.email)) return;
  const member = org?.memberPeople?.find((one) => one.email === person.email);
  if (!member) {
    await placeInOrganization(request, orgId, person, 'admin');
    return;
  }
  const changed = await request.put(`${baseURL}/organizations/${orgId}/users/${member.userId}`, {
    data: { place: 'admin' },
  });
  if (!changed.ok()) {
    throw new Error(`Making ${person.email} an organization admin failed: ${await changed.text()}`);
  }
}
