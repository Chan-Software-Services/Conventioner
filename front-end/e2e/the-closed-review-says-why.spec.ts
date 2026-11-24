import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { marketSetupPath } from './helpers/marketScreens';
import { seedAssignedMarket } from './helpers/seedAssignedMarket';
import { mongoEval } from './helpers/mongo';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import type { Page } from '@playwright/test';

/**
 * Wherever the review is closed, the automatic rejections say why and what to do instead (T207), in
 * the server's words: Back to review while tables are allocated, a seat on Assignments once results
 * are published or a Google Form market that went live before it could publish them. The
 * Applications tab no longer says it over its views (T466, release walk F7): the review's controls
 * are simply gone there, and its toolbar stands where it stands in every stage.
 */

const ALLOCATING =
  'The automatic rejections are closed while tables are allocated. To change a rule, choose Back to review under More… on the phase rail; tables are then allocated again.';
const PUBLISHED =
  'The automatic rejections closed when results were published. To change who has a table, place or free a seat on Assignments.';
const WENT_LIVE =
  'The automatic rejections closed when the market went live. To change who has a table, place or free a seat on Assignments.';

/** The tab says no review-closed line over either view, and offers no reviewers. */
async function saysNoClosedLine(page: Page, marketId: string) {
  await page.goto(marketSetupPath(marketId, 'applications'));
  await expect(page.getByTestId('applications-all-list')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('applications-toolbar')).toBeVisible();
  await expect(page.getByTestId('market-setup-applications-condition')).toHaveCount(0);
  await expect(page.getByTestId('reviewers')).toHaveCount(0);
  await page.getByTestId('applications-view-one').click();
  await expect(page.getByTestId('app-monitor-panel')).toBeVisible();
  await expect(page.getByTestId('market-setup-applications-condition')).toHaveCount(0);
  await expect(page.getByTestId('reviewers')).toHaveCount(0);
}

/** The automatic rejections' own line, in their subject. */
async function rulesLine(page: Page, marketId: string) {
  await page.goto(marketSetupPath(marketId, 'form'));
  await page.getByTestId('form-step-review').click();
  return page.getByTestId('rejection-rules-locked');
}

test('in Assignment, the tab says no closed line and the automatic rejections say why', async ({
  authenticatedPage: page,
  request,
}) => {
  const seed = await seedAssignedMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    intakeMode: 'form',
  });

  await saysNoClosedLine(page, seed.marketId);
  await expect(await rulesLine(page, seed.marketId)).toHaveText(ALLOCATING);
});

test('once results are published, the tab says no closed line and the rules say to place a seat', async ({
  authenticatedPage: page,
  request,
}) => {
  const seed = await seedAssignedMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    intakeMode: 'form',
  });
  const published = await request.post(`${BACKEND_URL}/markets/${seed.marketId}/publish-results`);
  expect(published.ok(), await published.text()).toBe(true);

  await saysNoClosedLine(page, seed.marketId);
  await expect(await rulesLine(page, seed.marketId)).toHaveText(PUBLISHED);
});

test('a Google Form market that went live before it could publish: the tab says no closed line and the rules say it closed then', async ({
  authenticatedPage: page,
  request,
}) => {
  const seed = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  // Going live waits for results now (ADR 0022), so this market went before that rule reached it.
  // No route reaches that state any more, so it is written: the flag unset, and the revision
  // Publish results stood on with it, since neither was ever written (T316).
  mongoEval(
    `db.markets.updateOne({id: ${JSON.stringify(seed.marketId)}}, {$unset: {resultsPublished: '', 'assignmentObject.publishedRevision': ''}})`,
  );

  await saysNoClosedLine(page, seed.marketId);
  await expect(await rulesLine(page, seed.marketId)).toHaveText(WENT_LIVE);
});
