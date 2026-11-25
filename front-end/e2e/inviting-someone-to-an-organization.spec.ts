import { randomInt } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER, OrganizationsPage } from './fixtures';
import { placeInOrganization } from './helpers/grantMarketRole';
import { acceptInvitation, inviteToOrganization } from './helpers/invitations';
import { loginViaApi } from './helpers/seeds';
import { uniqueMarketName } from './helpers/uniqueName';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { withUser } from './helpers/withUser';

/**
 * Why E2E: the stack together (an invitation sent from Manage organization waits on the server
 * until the person signed in with its address accepts, and only then are they in the
 * organization), who may withdraw which invitation as the server judges it, and layout at a phone's
 * width.
 *
 * Manage organization adds an admin or a member by inviting them (T538, ADR 0047): an address with
 * no account and one with an account are each answered "Invitation sent to <address>.", each listed
 * under "Invited" and none under Admins or Members; a member invited as an admin is refused and
 * pointed at "Make admin"; withdrawing asks first and takes the row away; the person with the
 * account accepting puts them under Admins. An admin sees every invitation, and Withdraw only on
 * the member ones.
 *
 * The addresses are each run's own, in the fixture domains, never the fixture organizer's, so the
 * limit on invitations to one address and the screens' "none waiting" state hold across retries;
 * the teardown withdraws whatever a test left waiting. Fixture data.
 */

const PASSWORD = 'e2einviteorg123';

/** An address no earlier run used: `<who>-<stamp>@<domain>`. */
const runAddress = (who: string, domain: string) =>
  `e2e-org-${who}-${Date.now()}${randomInt(1000, 10000)}@${domain}`;

/** A person with a verified account, made for this run. */
function someoneWithAnAccount(who: string) {
  const person = { email: runAddress(who, 'example.com'), password: PASSWORD };
  ensureVerifiedUser(person.email, person.password);
  return person;
}

/** A new organization of the fixture organizer's. */
async function seedOrganization(request: APIRequestContext): Promise<string> {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const made = await request.post(`${BACKEND_URL}/organizations`, {
    data: { name: uniqueMarketName('E2E Inviting Org') },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return (await made.json()).organization_id as string;
}

/** The invitations left waiting on the organization, withdrawn as its owner. */
async function withdrawWhatWaits(request: APIRequestContext, orgId: string): Promise<void> {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const listed = await request.get(`${BACKEND_URL}/organizations/${orgId}/invitations`);
  expect(listed.ok(), await listed.text()).toBe(true);
  const { invitations } = (await listed.json()) as { invitations: Array<{ id: string }> };
  for (const invitation of invitations) {
    const withdrawn = await request.delete(
      `${BACKEND_URL}/organizations/${orgId}/invitations/${invitation.id}`,
    );
    expect([200, 404], await withdrawn.text()).toContain(withdrawn.status());
  }
}

async function openManage(page: Page, orgId: string): Promise<OrganizationsPage> {
  await page.goto(`/organizations?manage=${orgId}`);
  const orgs = new OrganizationsPage(page);
  await orgs.waitForManageOverlay();
  return orgs;
}

for (const window of [
  { name: 'at a desk', viewport: { width: 1440, height: 900 } },
  { name: 'on a phone', viewport: { width: 390, height: 844 } },
]) {
  test.describe(window.name, () => {
    test.use({ viewport: window.viewport });

    let orgId = '';

    test.afterEach(async ({ request }) => {
      if (orgId) await withdrawWhatWaits(request, orgId);
    });

    test('an invitation answers alike for every address, waits under Invited, and is withdrawn or accepted', async ({
      authenticatedPage: page,
      request,
    }) => {
      orgId = await seedOrganization(request);
      const member = someoneWithAnAccount('member');
      await placeInOrganization(request, orgId, member, 'member');
      const admin = someoneWithAnAccount('admin');
      const newMember = someoneWithAnAccount('new-member');
      const noAccountAdmin = runAddress('no-account-admin', 'example.test');
      const noAccountMember = runAddress('no-account-member', 'example.test');

      const orgs = await openManage(page, orgId);
      await expect(orgs.addAdminButton).toHaveText('Invite admin');
      await expect(orgs.addMemberButton).toHaveText('Invite member');

      // The same answer for an address with no account and one with an account, in each row.
      await orgs.inviteAdmin(noAccountAdmin);
      await expect(orgs.addAdminSent).toHaveText(`Invitation sent to ${noAccountAdmin}.`);
      await expect(orgs.addAdminError).toHaveCount(0);
      await expect(orgs.addAdminInput).toHaveValue('');
      await orgs.inviteAdmin(admin.email);
      await expect(orgs.addAdminSent).toHaveText(`Invitation sent to ${admin.email}.`);
      await expect(orgs.addAdminError).toHaveCount(0);
      await expect(orgs.addAdminSubmit).toHaveText('Send invitation');
      await orgs.inviteMember(noAccountMember);
      await expect(orgs.addMemberSent).toHaveText(`Invitation sent to ${noAccountMember}.`);
      await orgs.inviteMember(newMember.email);
      await expect(orgs.addMemberSent).toHaveText(`Invitation sent to ${newMember.email}.`);
      await expect(orgs.addMemberError).toHaveCount(0);

      // Every one waits under Invited, newest first, and nobody is under Admins or Members.
      await expect(orgs.invitedRows).toHaveCount(4);
      await expect(orgs.invitedRows.first()).toContainText(newMember.email);
      await expect(orgs.invitation(admin.email)).toContainText(/Invited as admin, until /);
      await expect(orgs.invitation(noAccountAdmin)).toContainText(/Invited as admin, until /);
      await expect(orgs.invitation(noAccountMember)).toContainText(/Invited as member, until /);
      await expect(orgs.adminEmails).toHaveCount(0);
      await expect(orgs.memberEmails).toHaveText([member.email]);
      // The owner may withdraw every one.
      await expect(orgs.invitedWithdrawButtons).toHaveCount(4);

      // A member invited as an admin is refused, and pointed at their row's "Make admin".
      await orgs.inviteAdmin(member.email);
      await expect(orgs.addAdminError).toHaveText(
        `${member.email} is already a member of this organization. Make them an admin from their row.`,
      );
      await expect(orgs.addAdminInput).toHaveValue(member.email);
      await expect(orgs.invitedRows).toHaveCount(4);
      await orgs.addAdminCancel.click();
      await orgs.addMemberCancel.click();
      await expect(orgs.addAdminButton).toBeVisible();

      // Withdrawing asks first, opens on Cancel, and Cancel changes nothing.
      const withdraw = orgs.withdrawButton(noAccountMember);
      await withdraw.click();
      await expect(orgs.withdrawConfirm).toContainText(
        `Withdraw the invitation to ${noAccountMember}?`,
      );
      await expect(orgs.withdrawConsequence).toHaveText('They can no longer accept it.');
      await expect(orgs.withdrawCancelButton).toBeFocused();
      await orgs.withdrawCancelButton.click();
      await expect(orgs.withdrawConfirm).toHaveCount(0);
      await expect(withdraw).toBeFocused();
      await expect(orgs.invitedRows).toHaveCount(4);

      await orgs.withdraw(noAccountMember);
      await expect(orgs.invitation(noAccountMember)).toHaveCount(0);
      await expect(orgs.invitedRows).toHaveCount(3);
      await expect(orgs.manageWindow).toBeVisible();

      // Accepted by them, signed in with that address, they are an admin.
      await acceptInvitation(admin, orgId);
      await orgs.manageCloseButton.click();
      await expect(orgs.manageWindow).toHaveCount(0);
      await openManage(page, orgId);
      await expect(orgs.adminEmails).toHaveText([admin.email]);
      await expect(orgs.invitation(admin.email)).toHaveCount(0);
      await expect(orgs.invitedRows).toHaveCount(2);

      // Nothing in the dialog runs past the window.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(window.viewport.width);
    });

    test('an admin reads every invitation, and withdraws only the member ones', async ({
      browser,
      request,
    }) => {
      orgId = await seedOrganization(request);
      const admin = someoneWithAnAccount('reading-admin');
      await placeInOrganization(request, orgId, admin, 'admin');
      const invitedAdmin = runAddress('invited-admin', 'example.test');
      const invitedMember = runAddress('invited-member', 'example.test');
      await inviteToOrganization(request, orgId, invitedAdmin, 'admin');
      await inviteToOrganization(request, orgId, invitedMember, 'member');

      await withUser(
        browser,
        admin.email,
        admin.password,
        async (page) => {
          const orgs = await openManage(page, orgId);
          await expect(orgs.invitedRows).toHaveCount(2);
          await expect(orgs.invitation(invitedAdmin)).toContainText(/Invited as admin, until /);
          await expect(orgs.withdrawButton(invitedAdmin)).toHaveCount(0);
          await expect(orgs.withdrawButton(invitedMember)).toHaveCount(1);
          // An admin invites members, never admins.
          await expect(orgs.addAdminButton).toHaveCount(0);
          await expect(orgs.addMemberButton).toHaveText('Invite member');

          await orgs.withdraw(invitedMember);
          await expect(orgs.invitedRows).toHaveCount(1);
          await expect(orgs.invitation(invitedAdmin)).toBeVisible();
        },
        { viewport: window.viewport },
      );
    });
  });
}
