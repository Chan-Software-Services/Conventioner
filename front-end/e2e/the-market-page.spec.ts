import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, LoginPage, TEST_USER, VendorPage } from './fixtures';
import { marketPagePath, vendorPagePath } from './helpers/marketScreens';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import {
  planSetupObject,
  seedApplicantMarket,
  type ApplicantMarketSeed,
} from './helpers/seedApplicantMarket';
import { seedApprovedVendor } from './helpers/seedApplication';
import { seedAssignedMarket } from './helpers/seedAssignedMarket';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';
import { letVendorsCheckThemselvesIn } from './helpers/selfCheckIn';
import { MarketPage } from './pages/MarketPage';
import { PublicMapPage } from './pages/PublicMapPage';

/**
 * A market's own address is its public page (T469): `/<market>` shows anyone, signed out or signed
 * in, the application call while the market takes applications, the public map once it is open,
 * and a notice of where the market stands in between and after, each with a way to the vendor's
 * side at `/<market>/vendor`. A market with no vendor page reads at both addresses exactly as a
 * slug naming nothing. The map's old address and a door poster printed for the old vendor page
 * still land where they meant to.
 */
const DATE = '2099-08-01';
const DATE_IN_WORDS = 'Saturday, August 1, 2099';
const UNKNOWN_SLUG = 'no-such-market-at-all';

async function post(request: APIRequestContext, path: string, data: object = {}) {
  const res = await request.post(`${BACKEND_URL}${path}`, { data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
}

/** A market taking applications on its page, with one approved vendor, so it can be assigned. */
async function formMarket(request: APIRequestContext, vendor: string) {
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { setupObject: planSetupObject([DATE]) },
  );
  seedApprovedVendor(market.marketId, vendor, {
    dates: [DATE],
    tiers: ['Gold'],
    sections: ['Main Hall', 'Garden'],
    fullName: 'Riley Fixture',
    extra: { business_name: 'Fixture Prints', product_type: 'Prints' },
  });
  return market;
}

let calling: ApplicantMarketSeed;
let stopped: ApplicantMarketSeed;
let assigning: ApplicantMarketSeed;
let published: ApplicantMarketSeed;
let mapped: SeededMarketDayMap;
let ended: SeededMarketDayMap;
let draft: ApplicantMarketSeed;
let googleForm: { slug: string };

test.beforeAll(async ({ request }) => {
  const at = Date.now();
  calling = await formMarket(request, `market-page-call-${at}@example.com`);

  stopped = await formMarket(request, `market-page-stopped-${at}@example.com`);
  await post(request, `/markets/${stopped.marketId}/applications-stopped`, { stopped: true });

  assigning = await formMarket(request, `market-page-assigning-${at}@example.com`);
  await post(request, `/markets/${assigning.marketId}/transition`, { toPhase: 'assignment' });

  published = await formMarket(request, `market-page-published-${at}@example.com`);
  await post(request, `/markets/${published.marketId}/transition`, { toPhase: 'assignment' });
  await post(request, `/markets/${published.marketId}/assignment`);
  await post(request, `/markets/${published.marketId}/publish-results`);

  mapped = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  // Its vendors check themselves in, so a door poster's code is held for the sign-in (T496).
  await letVendorsCheckThemselvesIn(request, mapped.marketId);

  // It ran: on its market days, a vendor checked in, then archived.
  ended = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  await post(request, `/markets/${ended.marketId}/transition`, { toPhase: 'archived' });

  draft = await seedApplicantMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    draft: true,
  });
  googleForm = await seedAssignedMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
});

async function signInAsTheOrganizer(page: Page) {
  const login = new LoginPage(page);
  await login.goto();
  await login.fillEmail(TEST_USER.email);
  await login.fillPassword(TEST_USER.password);
  await login.clickSubmit();
  await login.waitForMarkets();
}

for (const who of ['signed out', 'signed in as the organizer'] as const) {
  test.describe(who, () => {
    test.beforeEach(async ({ page }) => {
      if (who !== 'signed out') await signInAsTheOrganizer(page);
    });

    test('a market taking applications shows its call, and Apply opens the vendor sign-in', async ({
      page,
    }) => {
      const market = new MarketPage(page);
      await market.goto(calling.marketSlug);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(calling.marketName);
      await expect(market.dates.getByRole('listitem')).toHaveText([DATE_IN_WORDS]);
      await expect(page.getByRole('list', { name: 'Market dates' })).toBeVisible();
      await expect(market.call).toContainText('Applications are open.');
      await expect(market.call).toContainText('Already applied? Sign in');
      await expect(market.signInLink).toHaveAttribute('href', vendorPagePath(calling.marketSlug));

      await market.applyLink.click();
      await expect(page).toHaveURL(new RegExp(`${vendorPagePath(calling.marketSlug)}$`));
      const vendorPage = new VendorPage(page);
      await expect(vendorPage.marketName).toHaveText(calling.marketName);
      await expect(vendorPage.emailInput).toBeVisible();
    });

    for (const [stage, seed, line] of [
      ['a market that stopped taking applications', () => stopped, 'Applications are closed.'],
      ['a market in Assignment', () => assigning, 'Applications are closed.'],
      [
        'a market whose results are out, its map off',
        () => published,
        "The map isn't published yet.",
      ],
    ] as const) {
      test(`${stage} says so, with its dates and a way to the vendor page`, async ({ page }) => {
        const market = new MarketPage(page);
        await market.goto(seed().marketSlug);
        await expect(market.name).toHaveText(seed().marketName);
        await expect(market.dates.getByRole('listitem')).toHaveText([DATE_IN_WORDS]);
        await expect(market.call).toHaveCount(0);
        await expect(market.noticeLine).toHaveText(line);
        await expect(market.vendorLink).toHaveText('Vendor sign-in');

        await market.vendorLink.click();
        await expect(page).toHaveURL(new RegExp(`${vendorPagePath(seed().marketSlug)}$`));
        await expect(new VendorPage(page).marketName).toHaveText(seed().marketName);
      });
    }

    test('an archived market that ran says it has ended', async ({ page }) => {
      const market = new MarketPage(page);
      await market.goto(ended.slug);
      await expect(market.name).toHaveText(ended.marketName);
      await expect(market.dates.getByRole('listitem')).toHaveCount(2);
      await expect(market.noticeLine).toHaveText('This market has ended.');
      await expect(market.vendorLink).toHaveAttribute('href', vendorPagePath(ended.slug));
    });

    test('a market whose map is open shows the map at its own address', async ({ page }) => {
      const map = new PublicMapPage(page);
      await new MarketPage(page).goto(mapped.slug);
      await expect(page).toHaveURL(new RegExp(`${marketPagePath(mapped.slug)}$`));
      await expect(map.heading).toHaveText(mapped.marketName);
      await expect(page.getByTestId('market-page')).toHaveCount(0);
    });

    test("the map's old address lands on the market page, the table picked", async ({ page }) => {
      const map = new PublicMapPage(page);
      await page.goto(`${marketPagePath(mapped.slug)}/map?table=north-table-1`);
      await expect(map.card.getByRole('heading', { level: 2 })).toHaveText('Table Aisle A 1');
      await expect(page).toHaveURL(
        new RegExp(`${marketPagePath(mapped.slug)}\\?(.*&)?table=north-table-1(&|$)`),
      );
    });

    test('a door poster printed for the old vendor page lands on the vendor page, holding the code', async ({
      page,
    }) => {
      await page.goto(`${marketPagePath(mapped.slug)}?door=FIXTURE-DOOR`);
      const vendorPage = new VendorPage(page);
      await expect(vendorPage.doorCodeHeld).toHaveText(
        "Sign in, and you'll be checked in for today.",
      );
      // The vendor page takes the code off the address, as from the poster's own address.
      await expect(page).toHaveURL(new RegExp(`${vendorPagePath(mapped.slug)}$`));
    });

    test('a draft and a Google Form market before its results read as a slug naming nothing, at both addresses', async ({
      page,
    }) => {
      const market = new MarketPage(page);
      const vendorPage = new VendorPage(page);
      const unknownMarketPage = await market.renderedText(UNKNOWN_SLUG);
      const unknownVendorPage = await vendorPage.renderedText(UNKNOWN_SLUG);
      expect(unknownMarketPage).toContain('Page not found');
      expect(unknownVendorPage).toBe(unknownMarketPage);
      for (const slug of [draft.marketSlug, googleForm.slug]) {
        expect(await market.renderedText(slug), `${slug}'s market page`).toBe(unknownMarketPage);
        expect(await vendorPage.renderedText(slug), `${slug}'s vendor page`).toBe(
          unknownVendorPage,
        );
      }
    });
  });
}

test('a read that does not answer says the page could not be loaded, and Try again reads it', async ({
  page,
}) => {
  let refused = 0;
  await page.route(`**/public/markets/${calling.marketSlug}/vendor-page`, async (route) => {
    if (refused++ === 0) await route.abort('failed');
    else await route.continue();
  });
  const market = new MarketPage(page);
  await market.goto(calling.marketSlug);
  await expect(market.readFailed).toContainText(
    'This page could not be loaded. Check your connection and try again.',
  );
  await expect(page.getByTestId('page-not-found')).toHaveCount(0);

  await market.retryButton.click();
  await expect(market.call).toBeVisible();
  await expect(market.name).toHaveText(calling.marketName);
});

for (const size of PHONE_AND_DESK) {
  test.describe(size.name, () => {
    test.use(size.use);
    const { expectFits } = inTheWindow(size);

    test('the call and a notice keep the window, and pass axe', async ({
      page,
      expectAccessible,
    }) => {
      const market = new MarketPage(page);
      await market.goto(calling.marketSlug);
      await expect(market.applyLink).toBeVisible();
      await expectFits(page, 'The application call');
      await expectAccessible('the application call');

      await market.goto(published.marketSlug);
      await expect(market.noticeLine).toBeVisible();
      await expectFits(page, 'A notice');
      await expectAccessible('a notice');
    });
  });
}
