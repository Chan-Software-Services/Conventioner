import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { marketScreenPath, marketSetupPath } from './helpers/marketScreens';
import { seedApplicantMarket } from './helpers/seedApplicantMarket';
import { seedPhaseMarket } from './helpers/seedPhaseMarket';

/**
 * A market's frame is the same on every page of it, and the rail's addresses and next step are one
 * row at 1440 (bugs 11 and 12, and items 12 and 13 of bug 43; E26/F10/S01; settles claims-and-room
 * 07): beside the spine while the market had one address, and on the rail's designed second row now
 * that it has two, the market page and the vendor page, each whole (E30/F01/S03, T469).
 *
 * Each screen placed the frame itself, so it sat at x 16 on most pages, x 0 on Start from your
 * Google Form and the floorplan wizard, and x 32 on the import - and the last two had no card and
 * no rail at all. The application page's address pushed "Close Applications" onto a row of its
 * own. And until the market arrived, every screen showed an empty black bar.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not rendered');
  return b;
}

const middle = (b: { y: number; height: number }) => b.y + b.height / 2;

/** The bar's box once its market has arrived, so each page is compared in the same state. */
async function frameOn(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('market-bar-title')).toBeVisible();
  return box(page.getByTestId('market-bar'));
}

test("the rail holds the market's two addresses, whole, and the next step on one row at 1440", async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId, marketSlug } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  await page.goto(marketSetupPath(marketId, 'applications'));

  const spine = await box(page.getByTestId('phase-rail-spine'));
  const market = page.getByTestId('phase-rail-market-page');
  const vendor = page.getByTestId('phase-rail-vendor-page');
  const next = page.getByTestId('phase-transition-assignment');
  // Under the spine, on the row the two addresses ask for, never squeezed beside it.
  const row = middle(await box(market));
  expect((await box(market)).y).toBeGreaterThan(spine.y + spine.height);
  expect(Math.abs(middle(await box(vendor)) - row)).toBeLessThan(4);
  expect(Math.abs(middle(await box(next)) - row)).toBeLessThan(4);

  // Each whole: the address it shows, the link, its hover text, and what Copy copies.
  for (const [chip, end] of [
    [market, `/${marketSlug}`],
    [vendor, `/${marketSlug}/vendor`],
  ] as const) {
    const link = chip.getByRole('link');
    await expect(link).toHaveText(new RegExp(`${end}$`));
    expect(
      await link.evaluate((a) => a.scrollWidth > a.clientWidth || a.scrollHeight > a.clientHeight),
      `${end} is cut`,
    ).toBe(false);
    await expect(link).toHaveAttribute('href', new RegExp(`${end}$`));
    await expect(link).toHaveAttribute('title', new RegExp(`${end}$`));
    await expect(chip.getByRole('button', { name: 'Copy' })).toBeVisible();
  }
});

test('where the rail cannot hold one row, the address and the next step share the second', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  // A window too narrow for the spine, the address and the next step on one row, yet wide enough
  // for the spine to keep a line of its own.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(marketSetupPath(marketId, 'applications'));

  const spine = await box(page.getByTestId('phase-rail-spine'));
  const chip = await box(page.getByTestId('phase-rail-vendor-page'));
  const next = await box(page.getByTestId('phase-transition-assignment'));
  // Never a lone button on a row of its own beside an empty band: the second row is designed.
  expect(chip.y).toBeGreaterThan(spine.y + spine.height);
  expect(Math.abs(middle(next) - middle(chip))).toBeLessThan(4);
});

test('every page of a market puts its frame in the same place, flows included', async ({
  authenticatedPage: page,
  request,
}) => {
  const draft = await seedPhaseMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const open = await seedApplicantMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);

  const plan = await frameOn(page, marketSetupPath(draft.marketId, 'setup'));
  // A page that scrolls and one that does not must not differ by the scrollbar's width. Headless
  // Chromium hides scrollbars, so this is pinned as the rule that prevents it.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
  ).toBe('stable');

  for (const path of [
    marketSetupPath(draft.marketId, 'form'),
    marketSetupPath(draft.marketId, 'start-from-csv'),
    marketScreenPath(draft.marketId, 'layout'),
    marketSetupPath(open.marketId, 'applications'),
    marketScreenPath(open.marketId, 'import'),
  ]) {
    expect(await frameOn(page, path), path).toEqual(plan);
    // The flows stand in the frame too, rail and all.
    await expect(page.getByTestId('phase-rail'), path).toBeVisible();
  }
});

/** Each Market Setup page's first thing, as wide as the page's content allows where it is wide. */
const SETUP_CONTENT = [
  { tab: 'setup', testid: 'plan-card-dates', wide: true },
  { tab: 'form', testid: 'form-steps', wide: true },
  { tab: 'applications', testid: 'market-setup-applications-condition', wide: false },
  { tab: 'settings', testid: 'assignment-card-priority', wide: false },
] as const;

for (const width of [1440, 1100]) {
  test(`every Market Setup page keeps the frame's 24px gutter at ${width}`, async ({
    authenticatedPage: page,
    request,
  }) => {
    // Each tab padded itself 40px while the rail, Assignments, Vendors and the frame's own note sit
    // 24px in, so a Viewer's note and the page under it started 16px apart (T15, ticket 03).
    await page.setViewportSize({ width, height: 900 });
    const draft = await seedPhaseMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
    const open = await seedApplicantMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );

    for (const { tab, testid, wide } of SETUP_CONTENT) {
      const marketId = tab === 'applications' ? open.marketId : draft.marketId;
      await frameOn(page, marketSetupPath(marketId, tab));
      const card = await box(page.getByTestId('market-frame-card'));
      const content = await box(page.getByTestId(testid));
      expect.soft(content.x - card.x, tab).toBeCloseTo(24, 0);
      if (wide)
        expect.soft(card.x + card.width - (content.x + content.width), tab).toBeCloseTo(24, 0);
    }

    // The plan's save line ends under its cards' right edge, in the same gutter.
    await page.goto(marketSetupPath(draft.marketId, 'setup'));
    await page.getByTestId('setup-location-add-button').click();
    await page.getByTestId('setup-location-name-input-0').fill('Pier Hall');
    const saved = await box(page.getByTestId('market-setup-plan-saved'));
    const card = await box(page.getByTestId('market-frame-card'));
    expect(card.x + card.width - (saved.x + saved.width)).toBeCloseTo(24, 0);
  });
}

test('a market on its way shows the frame it will fill, and one that is missing no bar at all', async ({
  authenticatedPage: page,
  request,
}) => {
  const draft = await seedPhaseMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/markets/${draft.marketId}`, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(marketScreenPath(draft.marketId, 'vendors'));
  await expect(page.getByTestId('market-arrival-loading')).toBeVisible();
  // Where the name will be, something that reads as on its way rather than an empty black band.
  await expect(page.getByTestId('market-bar-loading')).toBeVisible();
  release();
  await expect(page.getByTestId('market-bar-title')).toHaveText(draft.marketName);
  await expect(page.getByTestId('market-bar-loading')).toHaveCount(0);

  await page.goto(marketScreenPath('no-such-market', 'vendors'));
  await expect(page.getByTestId('market-arrival-missing')).toBeVisible();
  await expect(page.getByTestId('market-bar')).toHaveCount(0);
});
