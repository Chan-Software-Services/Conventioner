import type { Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, VendorPage } from './fixtures';
import {
  createApplicantLoginChallenge,
  planSetupObject,
  seedApplicantMarket,
} from './helpers/seedApplicantMarket';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { grantMarketRole } from './helpers/grantMarketRole';
import { withUser } from './helpers/withUser';
import { ApplicationsAllPage } from './pages/ApplicationsAllPage';
import { ManageMarketPage } from './pages/ManageMarketPage';

/**
 * A card in nobody's share waits to be dealt, and says so (ADR 0037, ADR 0020).
 *
 * Ana alone is chosen to review; the owner then takes her role away in Manage market, which leaves
 * her chosen, as the dealing rule keeps a reviewer until an Admin takes them off, but able to
 * review nothing. A vendor applies on the market's vendor page, and the deal, finding nobody able, leaves
 * the application in nobody's share, waiting for the next deal. The All view's row and its drawer
 * read "Reviewer: not dealt yet", and the drawer warns of nobody it would be decided for. Before
 * the server served the review state, the row named no reviewer at all.
 */
const PASSWORD = 'e2epassword123';
const ANA = 'e2e-reviewers-ana@example.com';
const DATE = '2099-08-01';
const CODE = '246810';

async function takeTheRoleAway(page: Page, marketName: string, email: string): Promise<void> {
  await page.goto(`/markets?q=${encodeURIComponent(marketName)}`);
  await page.getByTestId('market-card-manage-button').click();
  const manage = new ManageMarketPage(page);
  await manage.waitForOverlay();
  await manage.removeUser(email);
  await expect(page.getByTestId('manage-market-person').filter({ hasText: email })).toHaveCount(0);
}

test('an application in nobody’s share reads "not dealt yet", warning of no one', async ({
  page,
  request,
  browser,
}) => {
  ensureVerifiedUser(ANA, PASSWORD);
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { setupObject: planSetupObject([DATE]) },
  );
  const api = `${BACKEND_URL}/markets/${market.marketId}`;
  await grantMarketRole(request, market.marketId, { email: ANA, password: PASSWORD }, 'viewer');
  const chosen = await request.put(`${api}/reviewers`, { data: { reviewers: [ANA] } });
  expect(chosen.ok(), await chosen.text()).toBeTruthy();

  await withUser(browser, TEST_USER.email, TEST_USER.password, (organizer) =>
    takeTheRoleAway(organizer, market.marketName, ANA),
  );

  // A vendor applies on the market's vendor page, with an address of this run's own.
  const vendor = `stranded-${Date.now()}@moss.test`;
  const login = new VendorPage(page);
  await login.goto(market.marketSlug);
  await login.requestCode(vendor);
  await expect(login.codeInput).toBeVisible();
  createApplicantLoginChallenge(market.marketId, vendor, CODE);
  await login.enterCode(CODE);
  await login.applyButton.click();
  await expect(login.form).toBeVisible({ timeout: 30000 });
  await login.fullNameInput.fill('Wren Waiting');
  await login.tierCheckbox(DATE, 'Gold').check();
  await login.maxDatesInput.fill('1');
  await login.tableChoiceRadio('full').check();
  await login.fillField('business_name', 'Waiting Prints');
  await login.fillField('product_type', 'Linocut prints');
  await login.submit();
  await expect(login.form).toHaveCount(0, { timeout: 10000 });

  await withUser(browser, TEST_USER.email, TEST_USER.password, async (organizer) => {
    const all = new ApplicationsAllPage(organizer);
    await all.goto(market.marketId, 'anyone');

    await expect(all.reviewerOf(vendor)).toHaveText('Reviewer: not dealt yet');

    await all.open(vendor);
    await expect(all.drawerReviewer).toHaveText('Reviewer: not dealt yet');
    await expect(all.drawerDealtWarning).toHaveCount(0);
  });
});
