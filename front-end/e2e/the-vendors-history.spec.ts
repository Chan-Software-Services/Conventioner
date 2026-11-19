import type { APIRequestContext } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { VendorsPage } from './pages/VendorsPage';
import { completePlan } from './helpers/seeds';
import { savePlan } from './helpers/savePlan';
import { approvedVendorApplication, insertApplications } from './helpers/seedApplication';
import { seedPhaseMarket, transitionMarket } from './helpers/seedPhaseMarket';
import { marketScreenPath } from './helpers/marketScreens';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { withUser } from './helpers/withUser';
import { ManageMarketPage } from './pages/ManageMarketPage';
import { putVerdict } from './helpers/putVerdict';

/**
 * A vendor's own history, in their drawer's History tab (E40/F01/S04).
 *
 * It was the placement trail alone; it is now everything the market's history holds about that
 * vendor, newest first, in the words of Manage market's History section. Two vendors are given a
 * verdict, a note and a table each through the API the screens call, on a fixture market, and each
 * drawer reads its own vendor's entries and never the other's. A verdict given to a selection of
 * three reads in one vendor's drawer as their own line, naming none of the other two, which the
 * server's answer to the drawer holds nothing of either, and whole in Manage market's History, which
 * opens to each vendor's verdict by their address. Raised above a
 * Viewer, the history's row takes the tab from their drawer and the changes from their Permissions
 * dialog.
 */
const VENDOR = { email: 'e2e-drawer-history-vera@example.com', name: 'Vera Vendor' };
const OTHER = { email: 'e2e-drawer-history-otto@example.com', name: 'Otto Other' };
const THIRD = { email: 'e2e-drawer-history-tess@example.com', name: 'Tess Third' };
const PAGE = 25;
const VIEWER = { email: 'e2e-drawer-history-viewer@example.com', password: 'e2epassword123' };

async function ok(response: Awaited<ReturnType<APIRequestContext['put']>>) {
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function seedTwoVendors(
  request: APIRequestContext,
): Promise<{ marketId: string; marketName: string }> {
  const seed = await seedPhaseMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const plan = completePlan();
  const date = plan.marketDates[0].date;
  await savePlan(request, BACKEND_URL, TEST_USER.email, seed.marketId, plan);
  const applications = [VENDOR, OTHER].map((vendor) => ({
    ...approvedVendorApplication(seed.marketId, vendor.email, {
      dates: [date],
      tiers: ['Gold'],
      fullName: vendor.name,
    }),
    // As an import leaves it, so the verdict is the organizer's to give.
    status: 'open',
  }));
  insertApplications(applications);
  const market = `${BACKEND_URL}/markets/${seed.marketId}`;

  await transitionMarket(request, BACKEND_URL, TEST_USER.email, seed.marketId, 'applications');
  for (const application of applications) {
    await ok(
      await putVerdict(request, BACKEND_URL, seed.marketId, application.id, {
        status: 'reviewer_approved',
      }),
    );
  }
  for (const vendor of [VENDOR, OTHER]) {
    await ok(
      await request.put(`${market}/vendor-notes/${encodeURIComponent(vendor.email)}`, {
        data: { note: `A note on ${vendor.name}` },
      }),
    );
  }

  await transitionMarket(request, BACKEND_URL, TEST_USER.email, seed.marketId, 'assignment');
  // Vera is given a table and then moved to another; Otto takes the one she left.
  for (const [vendor, table] of [
    [VENDOR, 'Hall A 1'],
    [VENDOR, 'Hall A 3'],
    [OTHER, 'Hall A 1'],
  ] as const) {
    await ok(
      await request.put(`${market}/placements`, {
        data: { email: vendor.email, date, table_code: table, table_choice: 'Full Table' },
      }),
    );
  }
  return { marketId: seed.marketId, marketName: seed.marketName };
}

function drawerPath(marketId: string, email: string): string {
  return `${marketScreenPath(marketId, 'vendors')}?vendor=${encodeURIComponent(email)}&vendorTab=history`;
}

test("a vendor's History tab reads their verdict, note and tables, newest first, and nobody else's", async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId } = await seedTwoVendors(request);
  const vendors = new VendorsPage(page);
  const me = TEST_USER.email;
  // In their own drawer a vendor reads by name alone: its head already shows the address.
  const vera = VENDOR.name;
  const otto = OTHER.name;

  await page.goto(drawerPath(marketId, VENDOR.email));
  await expect(vendors.detailHistorySentences).toHaveText([
    `${me} moved ${vera} from Hall A 1 to Hall A 3 (Full Table) on May 1, 2099`,
    `${me} assigned ${vera} at Hall A 1 (Full Table) on May 1, 2099`,
    `${me} changed the note on ${vera}`,
    `${me} set ${vera} to Approved`,
  ]);
  // No filters in the drawer: it is already one vendor's.
  await expect(vendors.detailPanel.getByTestId('market-history-vendor')).toHaveCount(0);

  await page.goto(drawerPath(marketId, OTHER.email));
  await expect(vendors.detailHistorySentences).toHaveText([
    `${me} assigned ${otto} at Hall A 1 (Full Table) on May 1, 2099`,
    `${me} changed the note on ${otto}`,
    `${me} set ${otto} to Approved`,
  ]);
  await expect(vendors.detailPanel).not.toContainText(VENDOR.email);
});

test("a verdict on a selection reads in a vendor's History tab as their own line, naming nobody else", async ({
  authenticatedPage: page,
  request,
}) => {
  const seed = await seedPhaseMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const plan = completePlan();
  await savePlan(request, BACKEND_URL, TEST_USER.email, seed.marketId, plan);
  const vendors = [VENDOR, OTHER, THIRD];
  const applications = vendors.map((vendor) => ({
    ...approvedVendorApplication(seed.marketId, vendor.email, {
      dates: [plan.marketDates[0].date],
      tiers: ['Gold'],
      fullName: vendor.name,
    }),
    status: 'open',
  }));
  insertApplications(applications);
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, seed.marketId, 'applications');
  // Approved all at once, as ticking the three and Approve does.
  await ok(
    await request.post(`${BACKEND_URL}/markets/${seed.marketId}/applications/verdicts`, {
      data: {
        status: 'reviewer_approved',
        applications: applications.map((application) => ({
          id: application.id,
          seen: { status: 'open', verdictAt: null, updatedAt: application.updated_at },
        })),
      },
    }),
  );
  const me = TEST_USER.email;

  const drawer = new VendorsPage(page);
  // The drawer asks for the vendor's own part, matched by what it asks so no other read is taken.
  const own = `/history?own=${encodeURIComponent(VENDOR.email)}`;
  const answered = page.waitForResponse((response) => response.url().includes(own));
  await page.goto(drawerPath(seed.marketId, VENDOR.email));
  // The server sends no more than the drawer shows: the selection holds Vera's application alone,
  // and the names only of the vendors its entries still hold.
  const sent = await (await answered).text();
  expect(sent).toContain(VENDOR.email);
  for (const other of [OTHER, THIRD]) {
    expect(sent).not.toContain(other.name);
    expect(sent).not.toContain(other.email);
  }
  for (const application of applications.slice(1)) {
    expect(sent).not.toContain(application.id);
  }
  await expect(drawer.detailHistorySentences).toHaveText([
    `${me} set the application and 2 others to Approved`,
  ]);
  const entry = page.getByTestId('vendor-drawer-panel-history').getByTestId('market-history-entry');
  await entry.getByTestId('market-history-toggle').click();
  // Before and after is their own verdict alone, as a verdict on their one application opens to.
  await expect(entry.getByTestId('market-history-changes')).toContainText(
    /Status\s*Open\s*Approved/,
  );
  const history = page.getByTestId('vendor-drawer-panel-history');
  for (const other of [OTHER, THIRD]) {
    await expect(history).not.toContainText(other.name);
    await expect(history).not.toContainText(other.email);
  }
  for (const application of applications.slice(1)) {
    await expect(history).not.toContainText(application.id);
  }

  // The market's own History still names the whole selection.
  await page.goto(`/markets?q=${encodeURIComponent(seed.marketName)}`);
  await page.getByTestId('market-card-manage-button').click();
  const manage = new ManageMarketPage(page);
  await manage.waitForOverlay();
  await manage.openHistory();
  await expect(manage.historySentences.first()).toHaveText(
    `${me} set 3 applications to Approved: ${vendors.map((vendor) => `${vendor.name} ${vendor.email}`).join(', ')}`,
  );
  // It opens to each vendor's verdict by their address, never an application's id.
  const changes = await manage.openHistoryEntry(0);
  const rows = changes.locator('tbody tr');
  await expect(rows).toHaveCount(vendors.length);
  for (const [index, vendor] of vendors.entries()) {
    await expect(rows.nth(index).locator('th, td')).toHaveText([vendor.email, 'Open', 'Approved']);
  }
});

test("a vendor's long History scrolls with the drawer's body and fetches at its end, with no box of its own", async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId } = await seedTwoVendors(request);
  // Past one page, on top of the verdict, the note and the tables.
  for (let n = 1; n <= PAGE; n++) {
    await ok(
      await request.put(
        `${BACKEND_URL}/markets/${marketId}/vendor-notes/${encodeURIComponent(VENDOR.email)}`,
        { data: { note: `Note ${n} on ${VENDOR.name}` } },
      ),
    );
  }
  const vendors = new VendorsPage(page);
  await page.goto(drawerPath(marketId, VENDOR.email));
  await expect(vendors.detailHistorySentences).toHaveCount(PAGE);
  await expect(vendors.detailPanel).not.toContainText('Load more');

  // The list has no scroller of its own: it stands in the flow of the drawer's body, which scrolls.
  const list = page.getByTestId('market-history-box');
  await expect(list.evaluate((box) => getComputedStyle(box).overflowY)).resolves.toBe('visible');
  await expect(list.evaluate((box) => box.scrollHeight === box.clientHeight)).resolves.toBe(true);
  await expect(vendors.detailPanel.getByTestId('market-history-box-shade-bottom')).toHaveCount(0);
  await expect(page.getByTestId('vendors-detail-content-shade-bottom')).toBeVisible();

  const first = await vendors.detailHistorySentences.allInnerTexts();
  await vendors.scrollDetailToEnd();

  await expect(vendors.detailHistorySentences).toHaveCount(PAGE + 4);
  const all = await vendors.detailHistorySentences.allInnerTexts();
  expect(all.slice(0, PAGE)).toEqual(first);
  expect(all.at(-1)).toContain('to Approved');
});

test("a Viewer the history's row is raised above has no History tab and no Permissions changes", async ({
  browser,
  request,
}) => {
  ensureVerifiedUser(VIEWER.email, VIEWER.password);
  const { marketId, marketName } = await seedTwoVendors(request);
  const market = `${BACKEND_URL}/markets/${marketId}`;
  await ok(
    await request.post(`${market}/roles`, { data: { user_email: VIEWER.email, role: 'viewer' } }),
  );
  // As the owner raises it from the Permissions dialog.
  await ok(await request.put(`${market}/permissions/read-history`, { data: { role: 'editor' } }));

  await withUser(browser, VIEWER.email, VIEWER.password, async (page) => {
    // A link to the History tab opens on the Application tab rather than on a refusal.
    await page.goto(drawerPath(marketId, VENDOR.email));
    const tabs = page.getByRole('tablist', { name: 'Vendor details', exact: true });
    await expect(tabs.getByRole('tab')).toHaveText(['Application', 'Assignments', 'Payment']);
    await expect(tabs.getByRole('tab', { name: 'Application' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('vendor-drawer-panel-application')).toBeVisible();
    await expect(page.getByTestId('market-history')).toHaveCount(0);

    await page.goto(`/markets?q=${encodeURIComponent(marketName)}`);
    await page.getByTestId('market-card-manage-button').click();
    const manage = new ManageMarketPage(page);
    await manage.waitForOverlay();
    await expect(manage.history).toHaveCount(0);
    await manage.showPermissions();
    await expect(manage.permissionRole('read-history')).toHaveText('Editor and above');
    await expect(manage.permissionsWindow).not.toContainText('Changes');
    await expect(manage.permissionChanges).toHaveCount(0);
    await expect(
      manage.permissionsWindow
        .getByTestId('manage-market-permission-row-read-history')
        .getByTestId('manage-market-permission-source'),
    ).toHaveText('Changed on this market');
  });
});
