import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { widths } from './helpers/phoneWindow';
import { transitionMarket } from './helpers/seedPhaseMarket';
import { marketSetupPath } from './helpers/marketScreens';
import { mongoEval } from './helpers/mongo';
import {
  APPLICATION_FIELDS,
  planSetupObject,
  seedApplicantMarket,
} from './helpers/seedApplicantMarket';
import { seedApprovedVendor } from './helpers/seedApplication';

/**
 * The review's tools hold still (T466, release walk F7).
 *
 * The Applications page's toolbar, the view switch and the list's Refresh and Export, scrolled away
 * with the 184 applications an organizer reads down. From 1024px it is pinned under the market's
 * frame from the start, so it never moves as the page scrolls, on All and on One by one alike, and
 * a failed refresh's line, which makes it taller, moves nothing either; on a phone it scrolls with
 * the page, as the frame's rail does. On All the search and the filters stand on one line pinned
 * flush under the toolbar, so neither ever moves; on a phone the statuses wrap inside the window.
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

/**
 * In px from the window's top, unrounded, so a fraction of a pixel shows: the frame's bottom, the
 * pinned block's top and bottom, the All view's filters line's top (`null` on One by one), and the
 * scroll.
 */
function parts(page: Page) {
  return page.evaluate(() => {
    const edge = (testid: string, side: 'top' | 'bottom') => {
      const box = document.querySelector(`[data-testid="${testid}"]`)?.getBoundingClientRect();
      return box ? box[side] : null;
    };
    return {
      frame: edge('market-frame', 'bottom')!,
      tools: edge('applications-tools', 'top')!,
      toolsEnd: edge('applications-tools', 'bottom')!,
      filters: edge('applications-all-list-tools', 'top'),
      scrolled: Math.round(window.scrollY),
    };
  });
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), `${y}px`).toBe(y);
}

/** Two edges less than half a hundredth of a pixel apart stand at the same place. */
const AT = 2;

/**
 * At every scroll the block's top is the frame's bottom, and on All the filters line's top is the
 * block's bottom, each where it stood at rest: pinned from the start, flush, never moving, not by a
 * fraction of a pixel.
 */
async function expectHeldStill(page: Page, at: string, withFilters: boolean) {
  await scrollTo(page, 0);
  const rest = await parts(page);
  for (const y of SCROLLS) {
    await scrollTo(page, y);
    const now = await parts(page);
    expect(now.tools, `${at}, ${y}px: the tools stand under the frame`).toBeCloseTo(now.frame, AT);
    expect(now.tools, `${at}, ${y}px: the tools stand where they did at rest`).toBeCloseTo(
      rest.tools,
      AT,
    );
    if (withFilters) {
      expect(now.filters!, `${at}, ${y}px: the filters stand flush under the toolbar`).toBeCloseTo(
        now.toolsEnd,
        AT,
      );
      expect(now.filters!, `${at}, ${y}px: the filters stand where they did at rest`).toBeCloseTo(
        rest.filters!,
        AT,
      );
    }
  }
  await scrollTo(page, 0);
}

const VIEWS = [
  { view: 'All', query: '', shown: 'applications-all-row', withFilters: true },
  { view: 'One by one', query: '?view=one', shown: 'app-monitor-card', withFilters: false },
] as const;

for (const { view, query, shown, withFilters } of VIEWS) {
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
      await expectHeldStill(page, at, withFilters);

      // A refresh that cannot reach the server says so under Refresh, which makes the block taller.
      await page.route(THE_LIST, (route) =>
        route.request().method() === 'GET' ? route.abort() : route.continue(),
      );
      await page.getByTestId('applications-refresh').click();
      await expect(page.getByTestId('applications-refresh-error')).toBeVisible();
      await expectHeldStill(page, `${at}, a refresh failed`, withFilters);
      await page.unroute(THE_LIST);
    }
  });
}

/**
 * In the assignment, before results go out, Publish results and its hint share the toolbar's start,
 * so at 1100 a failed refresh's line moves the end under it and the block grows a line: the filters
 * follow its measured height, flush under it at every scroll.
 */
test("All: the filters stay flush under a toolbar a failed refresh's line has grown", async ({
  authenticatedPage: page,
  request,
}) => {
  const marketId = await aLongReview(request);
  mongoEval(
    `db.applications.updateMany(${JSON.stringify({ market_id: marketId })}, { $set: { status: 'reviewer_approved' } })`,
  );
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, marketId, 'assignment');
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(marketSetupPath(marketId, 'applications'));
  await expect(page.getByTestId('applications-all-row').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('applications-publish-hint')).toBeVisible();
  const height = () =>
    page.getByTestId('applications-tools').evaluate((block) => (block as HTMLElement).offsetHeight);
  const oneLine = await height();

  await page.route(THE_LIST, (route) =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  await page.getByTestId('applications-refresh').click();
  await expect(page.getByTestId('applications-refresh-error')).toBeVisible();
  await expect.poll(height, 'the failed line grows the toolbar').toBeGreaterThan(oneLine + 20);
  await expectHeldStill(page, 'All at 1100 in the assignment, the toolbar grown', true);
  await page.unroute(THE_LIST);
});

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
      expect(now.tools, `${view}, ${y}px: the tools went with the page`).toBeCloseTo(
        rest.tools - y,
        AT,
      );
    }
  }
});

test("on a phone the statuses wrap, and nothing on All's two lines passes the window's edge", async ({
  authenticatedPage: page,
  request,
}) => {
  const marketId = await aLongReview(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(marketSetupPath(marketId, 'applications'));
  await expect(page.getByTestId('applications-all-row').first()).toBeVisible({ timeout: 15000 });

  const statuses = page.getByTestId('applications-all-filter').getByRole('button');
  await expect(statuses).toHaveCount(5);
  const tops = await statuses.evaluateAll((buttons) =>
    buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size, 'the statuses wrap onto more than one line').toBeGreaterThan(1);

  expect(await widths(page), "the page keeps the window's width").toEqual({
    layout: 390,
    sideways: 0,
    zoom: 1,
  });
  for (const line of ['applications-toolbar', 'applications-all-list-tools']) {
    const past = await page
      .getByTestId(line)
      .evaluate((row) =>
        [row, ...row.querySelectorAll('*')]
          .map((element) => element.getBoundingClientRect())
          .filter((box) => box.width && (box.left < 0 || box.right > window.innerWidth)),
      );
    expect(past, `nothing in ${line} passes the window's edge`).toEqual([]);
  }
});

/**
 * Publish results' confirmation opens from inside the pinned toolbar, whose sticky block is a
 * stacking context from 1024px: the dialog stands over the app bar and the market's frame, its scrim
 * covering both, and its title is on top on a short window.
 */
test("Publish results' confirmation stands over the app bar and the market's frame", async ({
  authenticatedPage: page,
  request,
}) => {
  const DATE = '2099-08-01';
  const { marketId } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { setupObject: planSetupObject([DATE]) },
  );
  seedApprovedVendor(marketId, 'held-still-seated@vendor.test', {
    dates: [DATE],
    tiers: ['Gold'],
    sections: ['Main Hall', 'Garden'],
  });
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, marketId, 'assignment');
  const ran = await request.post(`${BACKEND_URL}/markets/${marketId}/assignment`);
  expect(ran.ok(), await ran.text()).toBeTruthy();

  for (const [width, height] of [
    [1440, 900],
    [1100, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(marketSetupPath(marketId, 'applications'));
    await page.getByTestId('applications-publish-button').click();
    await expect(page.getByTestId('publish-results-window')).toBeVisible();
    // What is painted on top at a part's centre. The page behind an open dialog is held `inert`,
    // which hit-testing passes through, so the marks are lifted for the probe and put back.
    const onTop = (part: Locator) =>
      part.evaluate((element) => {
        const held = [...document.querySelectorAll('[inert]')];
        held.forEach((behind) => behind.removeAttribute('inert'));
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        held.forEach((behind) => behind.setAttribute('inert', ''));
        return (
          hit
            ?.closest(
              '[data-testid="publish-results-background"], [data-testid="publish-results-window"]',
            )
            ?.getAttribute('data-testid') ?? 'the page'
        );
      });
    for (const behind of ['app-bar-logo', 'market-bar-title', 'phase-rail']) {
      expect(
        await onTop(page.getByTestId(behind)),
        `${width}x${height}: the dialog covers ${behind}`,
      ).not.toBe('the page');
    }
    const dialog = page.getByTestId('publish-results-window');
    expect(
      await onTop(dialog.getByRole('heading', { name: 'Publish results' })),
      `${width}x${height}: nothing covers the dialog's title`,
    ).toBe('publish-results-window');
    await page.getByTestId('publish-results-close-button').click();
    await expect(page.getByTestId('publish-results-window')).toHaveCount(0);
  }
});
