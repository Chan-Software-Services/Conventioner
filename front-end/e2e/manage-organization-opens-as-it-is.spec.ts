/**
 * Manage organization opens when it was asked for, and shows the organization as it is.
 *
 * It opened on the organizations list's copy and read the organization again only after a write of
 * its own. Closing it reads the list again, so one reopened before that read answered listed the
 * admins as they were before, and kept them for that opening.
 *
 * Its address, `?manage=<id>`, was dropped when the list read failed, as if it named none of the
 * reader's organizations, so Try again listed them and opened nothing.
 *
 * Why E2E: the stack together, an invitation accepted on the server while the page holds its list's
 * copy, with the page's reads of it held or failed in the browser.
 */
import type { Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, APP_API, OrganizationsPage } from './fixtures';
import { loginViaApi } from './helpers/seeds';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { acceptInvitation } from './helpers/invitations';
import { uniqueMarketName } from './helpers/uniqueName';

const INVITED = { email: 'e2e-opens-as-it-is@example.com', password: 'e2eopensasitis123' };

test.beforeAll(() => {
  ensureVerifiedUser(INVITED.email, INVITED.password);
});

/** Holds every read of the organizations list the page asks from now on, until released. */
async function holdTheListsReads(page: Page): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${APP_API}/organizations`, async (route) => {
    if (route.request().method() === 'GET') await released;
    await route.continue();
  });
  return release;
}

test('reopened before the read closing started has answered, it lists the admin who has since joined', async ({
  authenticatedPage: page,
  request,
}) => {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const name = uniqueMarketName('Opens As It Is Org');
  const made = await request.post(`${BACKEND_URL}/organizations`, { data: { name } });
  expect(made.ok(), await made.text()).toBe(true);
  const orgId = (await made.json()).organization_id as string;

  const orgs = new OrganizationsPage(page);
  await orgs.goto();
  const manage = (await orgs.findCard(name)).getByTestId('organizations-manage-button');
  await manage.click();
  await orgs.waitForManageOverlay();
  await orgs.inviteAdmin(INVITED.email);
  await expect(orgs.invitation(INVITED.email)).toBeVisible();
  await acceptInvitation(INVITED, orgId);

  const release = await holdTheListsReads(page);
  await orgs.manageCloseButton.click();
  await manage.click();
  await expect(orgs.manageWindow).toBeVisible();

  // Nothing of the copy it was opened on is listed as the admins while the read is out.
  await expect(page.getByTestId('manage-org-admin-list-loading')).toHaveText('Loading admins…');
  await expect(page.getByTestId('manage-org-admin-list-empty')).toHaveCount(0);
  await expect(orgs.addAdminButton).toBeFocused();

  release();
  await expect(orgs.adminEmails).toHaveText([INVITED.email]);
  await expect(orgs.addAdminButton).toBeFocused();
});

test('Try again after the list read failed opens it on the organization its address names', async ({
  authenticatedPage: page,
  request,
}) => {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const name = uniqueMarketName('Opens After Try Again Org');
  const made = await request.post(`${BACKEND_URL}/organizations`, { data: { name } });
  expect(made.ok(), await made.text()).toBe(true);
  const orgId = (await made.json()).organization_id as string;

  let failing = true;
  await page.route(`**${APP_API}/organizations`, async (route) => {
    if (failing && route.request().method() === 'GET') await route.abort('failed');
    else await route.continue();
  });
  const orgs = new OrganizationsPage(page);
  await page.goto(`/organizations?manage=${orgId}`);
  await expect(orgs.readFailed).toBeVisible();
  await expect(orgs.manageWindow).toHaveCount(0);

  failing = false;
  await orgs.retryButton.click();
  await orgs.waitForManageOverlay();
  await expect(orgs.renameInput).toHaveValue(name);

  // Closed, the address no longer asks for it.
  await orgs.manageCloseButton.click();
  await expect(orgs.manageWindow).toHaveCount(0);
  await expect(page).toHaveURL(/\/organizations$/);
});
