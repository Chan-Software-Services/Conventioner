import type { Page } from '@playwright/test';
import { test, expect, OrganizationsPage } from './fixtures';
import { uniqueMarketName } from './helpers/uniqueName';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { withUser } from './helpers/withUser';

/**
 * An organization's name is unique among the organizations its creator or owner belongs to,
 * ignoring case and outer spaces (T352): the New organization dialog and Manage organization's
 * rename row each say so in the server's words, and nobody else's organizations are compared, so
 * another organizer makes one of the same name.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const OTHER_ORGANIZER = {
  email: 'e2e-org-names-other@example.com',
  password: 'e2epassword123',
};

test.beforeAll(() => {
  ensureVerifiedUser(OTHER_ORGANIZER.email, OTHER_ORGANIZER.password);
});

function refusal(name: string): string {
  return `You already belong to an organization named "${name}".`;
}

async function create(page: Page, name: string): Promise<OrganizationsPage> {
  const orgs = new OrganizationsPage(page);
  await orgs.goto();
  await orgs.waitForLoaded();
  await orgs.createOrg(name);
  return orgs;
}

test('a second organization of one of your names is refused, in any capitals', async ({
  authenticatedPage: page,
}) => {
  const name = uniqueMarketName('Names Org');
  const orgs = await create(page, name);
  await orgs.findCard(name);

  await orgs.createOrg(`  ${name.toUpperCase()} `);

  await expect(orgs.createError).toHaveText(refusal(name));
  await expect(orgs.createNameInput).toBeVisible();
  await orgs.page.getByTestId('organizations-create-close-button').click();
  const card = await orgs.findCard(name);
  await expect(card).toHaveCount(1);
});

test('renaming onto another of your names is refused, and onto its own in other capitals is not', async ({
  authenticatedPage: page,
}) => {
  const taken = uniqueMarketName('Names Taken');
  const renamed = uniqueMarketName('Names Renamed');
  const orgs = await create(page, taken);
  await orgs.findCard(taken);
  await orgs.createOrg(renamed);
  await (await orgs.findCard(renamed)).getByTestId('organizations-manage-button').click();
  await orgs.waitForManageOverlay();

  await orgs.renameOrg(taken.toLowerCase());
  await expect(orgs.renameError).toHaveText(refusal(taken));

  await orgs.renameOrg(renamed.toUpperCase());
  await expect(orgs.renameError).toBeHidden();
  await expect(orgs.manageWindow.getByText(renamed.toUpperCase(), { exact: true })).toBeVisible();
});

test("another organizer's organization of your name is never compared", async ({
  authenticatedPage: page,
  browser,
}) => {
  const name = uniqueMarketName('Names Shared');
  await (await create(page, name)).findCard(name);

  await withUser(browser, OTHER_ORGANIZER.email, OTHER_ORGANIZER.password, async (theirs) => {
    const orgs = await create(theirs, name);
    const card = await orgs.findCard(name);
    await expect(card).toHaveCount(1);
  });
});
