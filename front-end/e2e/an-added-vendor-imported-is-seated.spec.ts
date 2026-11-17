import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { ApplicationsAllPage } from './pages/ApplicationsAllPage';
import { CsvImportPage } from './pages/CsvImportPage';
import { marketScreenPath } from './helpers/marketScreens';
import { seedAssignedMarket } from './helpers/seedAssignedMarket';
import { ensureTestOrg, SEED_MARKET_DATE } from './helpers/seeds';

/**
 * An added vendor whom a re-import brings in stays approved and is seated by the run (T277 P7).
 *
 * A vendor added by hand in Assignment holds only a name. After Back to review, the Google Form
 * market's file came in again with their row: the import sent their approval back to review, and
 * once approved again the table allocation still left them out, since it read only vendors nobody
 * added. Where an application came from is now its own: the import makes them an imported
 * applicant, keeps their approval, and the allocation seats them like anyone.
 */
const VENDOR = 'walk.in@example.com';
const HEADERS = [
  'Timestamp',
  'Email Address',
  'Full Legal Name',
  'Business name',
  'Which days can you attend?',
  'Full or half table?',
  'Which tiers will you accept?',
];
const MAPPING: Record<string, string> = {
  'Full Legal Name': 'essential_full_name',
  'Business name': 'business_name',
  'Which days can you attend?': 'essential_available_dates',
  'Full or half table?': 'essential_table_choice',
  'Which tiers will you accept?': 'essential_tier_preference',
};
const FILE = [
  HEADERS.join(','),
  `2099/01/02 9:14:03,${VENDOR},Walk-in Wares,Kiln & Co,${SEED_MARKET_DATE},full,Gold`,
].join('\n');

test.beforeEach(async ({ request }) => {
  await ensureTestOrg(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
});

test('an added vendor imported after Back to review stays approved and is given a table', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId } = await seedAssignedMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );

  // Added by hand while assigning: approved, and seated by hand only.
  await page.goto(marketScreenPath(marketId, 'vendors'));
  await page.getByTestId('vendors-add-button').click();
  const dialog = page.getByTestId('add-vendor-window');
  await dialog.getByTestId('add-vendor-name-input').fill('Walk-in Wares');
  await dialog.getByTestId('add-vendor-email-input').fill(VENDOR);
  await dialog.getByTestId('add-vendor-submit-button').click();
  await expect(dialog).toBeHidden();

  // Back to review, and the file imported again, their row in it.
  await page.goto(marketScreenPath(marketId, 'assignments'));
  await expect(page.getByTestId('phase-rail-current')).toHaveText(/Assignment/, {
    timeout: 15000,
  });
  await page.getByTestId('phase-rail-menu-button').click();
  await page.getByTestId('phase-transition-applications').click();
  await page.getByTestId('back-to-review-confirm-submit-button').click();
  await expect(page).toHaveURL(/\/applications$/, { timeout: 10000 });

  const importPage = new CsvImportPage(page);
  await importPage.open({ id: marketId });
  await importPage.chooseFile(FILE);
  await importPage.mapColumns(HEADERS, MAPPING);
  await expect(importPage.allMapped).toBeVisible();
  await importPage.clickPreview();
  // Their approval is kept, and said so before anything is written.
  await expect(importPage.previewMerge).toContainText(
    'The 1 updated application already decided keeps its verdict.',
  );
  await expect(importPage.returningNote).toBeHidden();
  await importPage.clickConfirm();
  await expect(importPage.resultSummary).toBeVisible();

  // Still approved, with the answers the file brought.
  const all = new ApplicationsAllPage(page);
  await page.goto(marketScreenPath(marketId, 'applications'));
  await expect(all.statusOf(VENDOR)).toHaveText('Approved', { timeout: 15000 });

  // Begin assignment, and allocate tables: they hold one, placed by the run.
  await page.getByTestId('phase-transition-assignment').click();
  await expect(page).toHaveURL(/\/assignments$/, { timeout: 15000 });
  await page.goto(marketScreenPath(marketId, 'settings'));
  await page.getByTestId('market-setup-assign-button').click();
  await expect(page).toHaveURL(new RegExp(`/markets/${marketId}/assignments$`), {
    timeout: 15000,
  });
  const seat = page.locator('[data-testid="tables-table-row"]').filter({ hasText: VENDOR });
  await expect(seat).toHaveCount(1, { timeout: 15000 });
  await expect(seat.getByTestId('tables-seat-not-approved')).toHaveCount(0);
});
