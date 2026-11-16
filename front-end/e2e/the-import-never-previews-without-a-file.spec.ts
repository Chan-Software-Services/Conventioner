import type { APIRequestContext, Route } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, CsvImportPage } from './fixtures';
import { seedApplicantMarket, planSetupObject } from './helpers/seedApplicantMarket';
import { marketScreenPath } from './helpers/marketScreens';

/**
 * The import never previews without a file (T419, T277 probe 6).
 *
 * On Map columns, Back was offered while the values check was out: it started over and dropped the
 * file, and the check's late answer then opened Preview with no file, whose Import posted an empty
 * `csvContent`. Back now waits for the check, so the preview it opens is the file's.
 */

const HEADERS = [
  'Timestamp',
  'Email Address',
  'Full Legal Name',
  'Business name',
  'Which days can you attend?',
  'How many days do you want?',
  'Which tiers will you accept?',
  'Full or half table?',
  'Rank the sections',
  'What do you sell?',
];

const MAPPING: Record<string, string> = {
  'Full Legal Name': 'essential_full_name',
  'Which days can you attend?': 'essential_available_dates',
  'How many days do you want?': 'essential_max_dates',
  'Which tiers will you accept?': 'essential_tier_preference',
  'Full or half table?': 'essential_table_choice',
  'Rank the sections': 'essential_section_ranking',
  'Business name': 'business_name',
  'What do you sell?': 'product_type',
};

/** Every value names one the market offers, so the check goes straight on to Preview. */
const CSV = [
  HEADERS.join(','),
  '2026/05/02 9:14:03,nadia@ember.test,Nadia Okonkwo,Ember Ceramics,2099-08-01,1,Gold,half,"Garden, Main Hall",Pottery',
  '2026/05/02 11:40:22,theo@thistle.test,Theo Marchetti,Thorn & Thistle,2099-08-01,1,Gold,full,"Main Hall, Garden",Dried flowers',
].join('\n');

/** A Google Form draft with dates, tiers and sections on its plan, ready for its first import. */
async function seedImportableDraft(request: APIRequestContext): Promise<string> {
  const { marketId } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { setupObject: planSetupObject(), intakeMode: 'csv' },
  );
  return marketId;
}

test.describe('The import never previews without a file', () => {
  test('Back waits for the values check, and Import posts the file the preview was read from', async ({
    authenticatedPage: page,
    request,
  }) => {
    const marketId = await seedImportableDraft(request);
    const importPage = new CsvImportPage(page);
    await page.goto(marketScreenPath(marketId, 'import'));
    await expect(importPage.upload).toBeVisible();
    await importPage.chooseFile(CSV);
    await importPage.mapColumns(HEADERS, MAPPING);
    await expect(importPage.allMapped).toBeVisible();

    // The values check is held until the test lets it answer.
    const check = '**/applications/import/preview';
    const held: Route[] = [];
    await page.route(check, (route) => {
      held.push(route);
    });
    await importPage.clickPreview();
    await expect.poll(() => held.length).toBe(1);
    await expect(importPage.map).toBeVisible();
    await expect(importPage.backButton).toBeDisabled();
    // It looks it: the one disabled state, as "Preview import" beside it wears while the check is out.
    await expect(importPage.previewButton).toBeDisabled();
    const look = async (button: typeof importPage.backButton) =>
      await button.evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.backgroundColor, style.color, style.borderColor, style.cursor];
      });
    expect(await look(importPage.backButton)).toEqual(await look(importPage.previewButton));

    await held[0]!.continue();
    await page.unroute(check);
    await expect(importPage.preview).toBeVisible();
    await expect(importPage.filename).toContainText('form-responses.csv');
    await expect(importPage.previewCounts).toContainText('2 of 2 rows');
    await expect(importPage.backButton).toBeEnabled();

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && /\/applications\/import$/.test(req.url()),
    );
    await importPage.clickConfirm();
    expect(((await posted).postDataJSON() as { csvContent: string }).csvContent).toBe(CSV);
    await expect(importPage.resultSummary).toBeVisible();
  });
});
