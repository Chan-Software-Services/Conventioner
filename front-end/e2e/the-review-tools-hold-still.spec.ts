import type { Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { marketSetupPath } from './helpers/marketScreens';
import { mongoEval } from './helpers/mongo';
import { APPLICATION_FIELDS, seedApplicantMarket } from './helpers/seedApplicantMarket';

/**
 * The review's tools hold still (T466, release walk F7).
 *
 * The Applications page's toolbar, the view switch and the list's Refresh and Export, scrolled away
 * with the 184 applications an organizer reads down. From 1024px it is pinned under the market's
 * frame from the start, so it never moves as the page scrolls, on All and on One by one alike, and
 * a failed refresh's line, which makes it taller, moves nothing either; on a phone it scrolls with
 * the page, as the frame's rail does.
 */

/**
 * Questions enough that one application's card is well over two windows tall: 36 left One by one's
 * page at 1990x900 a pixel short of scrolling 900px.
 */
const QUESTIONS = Array.from({ length: 60 }, (_, at) => ({
  key: `question_${at + 1}`,
  label: `Question ${at + 1}`,
  type: 'text',
  required: false,
  options: [],
  order: APPLICATION_FIELDS.length + at,
}));
const SCROLLS = [0, 5, 40, 200, 900];
/** The list's own read, not a write under it nor the page of the same address. */
const THE_LIST = /\/markets\/[^/]+\/applications(\?.*)?$/;

/** A market in review holding 50 applications, every question answered, so both views scroll. */
async function aLongReview(request: import('@playwright/test').APIRequestContext) {
  const { marketId } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { fields: [...APPLICATION_FIELDS, ...QUESTIONS] },
  );
  const answers = Object.fromEntries([
    ['business_name', 'Held Still Goods'],
    ['product_type', 'Candles, soap and cards'],
    ...QUESTIONS.map(({ key }) => [key, `An answer to ${key.replace('_', ' ')}`]),
  ]);
  const now = new Date().toISOString();
  const applications = Array.from({ length: 50 }, (_, at) => ({
    id: `held-still-${marketId}-${at}`,
    market_id: marketId,
    applicant_email: `held-still-${at}@vendor.test`,
    form_data: answers,
    status: 'open',
    application_type: 'main',
    submitted_at: now,
    updated_at: now,
  }));
  mongoEval(`db.applications.insertMany(${JSON.stringify(applications)})`);
  return marketId;
}

/** In px from the window's top: the frame's bottom, the pinned block's top, and the scroll. */
function parts(page: Page) {
  return page.evaluate(() => {
    const edge = (testid: string, side: 'top' | 'bottom') =>
      // `|| 0`: a box scrolled up by a fraction rounds to -0, which `toBe` tells from 0.
      Math.round(
        document.querySelector(`[data-testid="${testid}"]`)!.getBoundingClientRect()[side],
      ) || 0;
    return {
      frame: edge('market-frame', 'bottom'),
      tools: edge('applications-tools', 'top'),
      scrolled: Math.round(window.scrollY),
    };
  });
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), `${y}px`).toBe(y);
}

/** At every scroll the block's top is the frame's bottom: pinned from the start, never moving. */
async function expectHeldStill(page: Page, at: string) {
  for (const y of SCROLLS) {
    await scrollTo(page, y);
    const now = await parts(page);
    expect(now.tools, `${at}, ${y}px: the tools stand under the frame`).toBe(now.frame);
  }
  await scrollTo(page, 0);
}

const VIEWS = [
  { view: 'All', query: '', shown: 'applications-all-row' },
  { view: 'One by one', query: '?view=one', shown: 'app-monitor-card' },
] as const;

for (const { view, query, shown } of VIEWS) {
  test(`${view}: the toolbar never moves at a desk, a failed refresh's line shown or not`, async ({
    authenticatedPage: page,
    request,
  }) => {
    test.slow();
    const marketId = await aLongReview(request);
    for (const width of [1100, 1440, 1990]) {
      const at = `${view} at ${width}`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${marketSetupPath(marketId, 'applications')}${query}`);
      await expect(page.getByTestId(shown).first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('applications-refresh')).toBeVisible();
      await expectHeldStill(page, at);

      // A refresh that cannot reach the server says so under Refresh, which makes the block taller.
      await page.route(THE_LIST, (route) =>
        route.request().method() === 'GET' ? route.abort() : route.continue(),
      );
      await page.getByTestId('applications-refresh').click();
      await expect(page.getByTestId('applications-refresh-error')).toBeVisible();
      await expectHeldStill(page, `${at}, a refresh failed`);
      await page.unroute(THE_LIST);
    }
  });
}

test('on a phone the toolbar scrolls with the page, on both views', async ({
  authenticatedPage: page,
  request,
}) => {
  const marketId = await aLongReview(request);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const { view, query, shown } of VIEWS) {
    await page.goto(`${marketSetupPath(marketId, 'applications')}${query}`);
    await expect(page.getByTestId(shown).first()).toBeVisible({ timeout: 15000 });
    const rest = await parts(page);
    for (const y of SCROLLS) {
      await scrollTo(page, y);
      const now = await parts(page);
      expect(now.tools, `${view}, ${y}px: the tools went with the page`).toBe(rest.tools - y);
    }
  }
});
