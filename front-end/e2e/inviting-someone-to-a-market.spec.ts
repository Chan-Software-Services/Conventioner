import { randomInt } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { acceptInvitation, withdrawInvitation, type SentInvitation } from './helpers/invitations';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { loginViaApi } from './helpers/seeds';
import { uniqueMarketName } from './helpers/uniqueName';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { ManageMarketPage } from './pages/ManageMarketPage';

/**
 * Why E2E: the stack together (an invitation sent from Manage market waits on the server until the
 * person signed in with its address accepts, and only then are they on the market), and layout at a
 * phone's width.
 *
 * Manage market adds a person by inviting them (T538, ADR 0047): an address with no account and
 * one with an account are each answered "Invitation sent to <address>.", each listed under
 * "Invited" and neither under "Users with access"; withdrawing asks first and takes the row away;
 * the person with the account accepting puts them under "Users with access" at their role.
 *
 * The addresses are each run's own, in the fixture domains, never the fixture organizer's, so the
 * limit on invitations to one address and the screens' "none waiting" state hold across retries;
 * the teardown withdraws whatever a test left waiting. Fixture data.
 */

const PASSWORD = 'e2epassword123';

/** An address no earlier run used: `<who>-<stamp>@<domain>`. */
const runAddress = (who: string, domain: string) =>
  `e2e-${who}-${Date.now()}${randomInt(1000, 10000)}@${domain}`;

/** The invitations left waiting on the market, withdrawn as its owner. */
async function withdrawWhatWaits(request: APIRequestContext, marketId: string): Promise<void> {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const listed = await request.get(`${BACKEND_URL}/markets/${marketId}/invitations`);
  expect(listed.ok(), await listed.text()).toBe(true);
  const { invitations } = (await listed.json()) as { invitations: SentInvitation[] };
  for (const invitation of invitations) {
    const withdrawn = await withdrawInvitation(request, `markets/${marketId}`, invitation);
    expect([200, 404], await withdrawn.text()).toContain(withdrawn.status());
  }
}

async function openManage(page: Page, marketName: string): Promise<ManageMarketPage> {
  await page.goto(`/markets?q=${encodeURIComponent(marketName)}`);
  await page.getByTestId('market-card-manage-button').click();
  const manage = new ManageMarketPage(page);
  await manage.waitForOverlay();
  return manage;
}

for (const window of [
  { name: 'at a desk', viewport: { width: 1440, height: 900 } },
  { name: 'on a phone', viewport: { width: 390, height: 844 } },
]) {
  test.describe(window.name, () => {
    test.use({ viewport: window.viewport });

    let marketId = '';

    test.afterEach(async ({ request }) => {
      if (marketId) await withdrawWhatWaits(request, marketId);
    });

    test('an invitation answers alike for every address, waits under Invited, and is withdrawn or accepted', async ({
      authenticatedPage: page,
      request,
    }) => {
      const market = await seedDraftMarket(
        request,
        BACKEND_URL,
        TEST_USER.email,
        TEST_USER.password,
        { name: uniqueMarketName('E2E Inviting Market') },
      );
      marketId = market.marketId;
      const withAccount = { email: runAddress('has-account', 'example.com'), password: PASSWORD };
      ensureVerifiedUser(withAccount.email, withAccount.password);
      const noAccount = runAddress('no-account', 'example.test');

      const manage = await openManage(page, market.marketName);

      // The same answer for an address with no account and one with an account.
      await manage.invite(noAccount, 'viewer');
      await expect(manage.addUserSent).toHaveText(`Invitation sent to ${noAccount}.`);
      await expect(manage.addUserError).toHaveCount(0);
      await expect(manage.addUserInput).toHaveValue('');
      await manage.invite(withAccount.email, 'editor');
      await expect(manage.addUserSent).toHaveText(`Invitation sent to ${withAccount.email}.`);
      await expect(manage.addUserError).toHaveCount(0);

      // Both wait under Invited, newest first, and neither has access.
      await expect(manage.person(withAccount.email)).toHaveCount(0);
      await expect(manage.invitedRows).toHaveCount(2);
      await expect(manage.invitedRows.first()).toContainText(withAccount.email);
      await expect(manage.invitation(withAccount.email)).toContainText(/Invited as Editor, until /);
      await expect(manage.invitation(noAccount)).toContainText(/Invited as Viewer, until /);
      await expect(manage.person(noAccount)).toHaveCount(0);
      await expect(manage.addUserSubmit).toHaveText('Send invitation');
      await manage.addUserCancel.click();
      await expect(manage.addUserButton).toHaveText('Invite someone');

      // Withdrawing asks first, opens on Cancel, and Cancel changes nothing.
      const withdraw = manage.withdrawButton(noAccount);
      await withdraw.click();
      await expect(manage.withdrawConfirm).toContainText(
        `Withdraw the invitation to ${noAccount}?`,
      );
      await expect(manage.withdrawConsequence).toHaveText('They can no longer accept it.');
      await expect(manage.withdrawCancelButton).toBeFocused();
      await manage.withdrawCancelButton.click();
      await expect(manage.withdrawConfirm).toHaveCount(0);
      await expect(withdraw).toBeFocused();
      await expect(manage.invitedRows).toHaveCount(2);

      await manage.withdraw(noAccount);
      await expect(manage.invitation(noAccount)).toHaveCount(0);
      await expect(manage.invitedRows).toHaveCount(1);
      await expect(manage.window).toBeVisible();

      // Accepted by them, signed in with that address, they have access at the role invited.
      await acceptInvitation(withAccount, market.marketId);
      await page.getByTestId('manage-market-close-button').click();
      await expect(manage.window).toHaveCount(0);
      await page.getByTestId('market-card-manage-button').click();
      await manage.waitForOverlay();
      await expect(manage.person(withAccount.email)).toHaveCount(1);
      await expect(
        manage.person(withAccount.email).getByTestId('manage-market-role-select'),
      ).toHaveValue('editor');
      await expect(manage.invited).toHaveCount(0);

      // The page does not scroll sideways.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(window.viewport.width);
    });
  });
}
