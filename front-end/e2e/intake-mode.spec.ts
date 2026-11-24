import { test, expect, TEST_USER, BACKEND_URL, VendorPage } from './fixtures';
import {
  createApplicantLoginChallenge,
  seedApplicantMarket,
  type ApplicantMarketSeed,
} from './helpers/seedApplicantMarket';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { marketPagePath, vendorPagePath } from './helpers/marketScreens';
import type { Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e-screenshots/intake-mode';
const UNKNOWN_SLUG = 'no-such-market-at-all';
const SIGNED_IN_VENDOR = 'signed-in-vendor@example.com';

async function finalPath(page: Page, slug: string, suffix: string): Promise<string> {
  await page.goto(`/${slug}${suffix}`);
  await page.waitForLoadState('networkidle');
  return new URL(page.url()).pathname.split(slug).join('<slug>');
}

/**
 * The market's own address (its market page) and its vendor page (T469). That each reads as an
 * unknown market's, to a stranger and to the signed-in organizer, is `the-market-page.spec.ts`'s
 * ("a draft and a Google Form market before its results read as a slug naming nothing, at both
 * addresses"), which a CSV draft reads as too, since the server refuses a draft before it reads
 * the intake mode.
 *
 * Nothing under them is a page, the old `/applicant-login` and `/applicant/dashboard` among them
 * (ADR 0022): those addresses ask no server, and land on the router's "Page not found" whatever
 * the slug and whoever is signed in, which `theMarketsTwoAddresses.test.ts` proves on the app's
 * router; `every-market-page-has-an-address.spec.ts` renders that page at a removed market page.
 */
const PAGE_SUFFIXES = ['', '/vendor'];

test.describe('Intake mode - a CSV market has no public applicant surface', () => {
  let csvMarket: ApplicantMarketSeed;

  test.beforeAll(async ({ request }) => {
    csvMarket = await seedApplicantMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
      { intakeMode: 'csv' },
    );
  });

  for (const suffix of PAGE_SUFFIXES) {
    test(`/<slug>${suffix} lands a stranger where an unknown market lands them`, async ({
      page,
    }) => {
      const gated = await finalPath(page, csvMarket.marketSlug, suffix);
      const absent = await finalPath(page, UNKNOWN_SLUG, suffix);

      expect(gated).toBe(absent);
    });
  }

  test('its vendor page says the page does not exist, rather than naming it or taking an address', async ({
    page,
  }) => {
    // A sign-in page once drew its form and answered "sent" for a code it never sends (E32/F03/S01).
    for (const slug of [csvMarket.marketSlug, UNKNOWN_SLUG]) {
      await page.goto(vendorPagePath(slug));
      await expect(page.getByTestId('vendor-page-not-found')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('vendor-page-market-name')).toHaveCount(0);
      await expect(page.getByTestId('vendor-sign-in-email-input')).toHaveCount(0);
    }

    await page.goto(vendorPagePath(csvMarket.marketSlug));
    await expect(page.getByTestId('vendor-page-not-found')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-csv-market-home.png`, fullPage: true });
  });

  test('its market page says the page does not exist, rather than naming it or calling for applications', async ({
    page,
  }) => {
    for (const slug of [csvMarket.marketSlug, UNKNOWN_SLUG]) {
      await page.goto(marketPagePath(slug));
      await expect(page.getByTestId('market-page-not-found')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('market-page-name')).toHaveCount(0);
      await expect(page.getByTestId('market-page-call')).toHaveCount(0);
      await expect(page.getByTestId('market-page-notice')).toHaveCount(0);
    }
  });

  test('its vendors still reach their page, where they check in, once it runs', async ({
    page,
    request,
  }) => {
    // Intake mode gates applying, never checking in, which is on the vendor page now (ADR 0022).
    // This used to open the public check-in page of the market above, which takes applications
    // and runs no check-in - and passed only because the page drew its form for any address at
    // all (bug 9). A market seeded with no intake mode is CSV, and this one runs.
    const running = await seedPublishedMarketWithAssignments(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    await page.goto(vendorPagePath(running.marketSlug));

    await expect(page.getByTestId('vendor-page-market-name')).toHaveText(running.marketName, {
      timeout: 10000,
    });
    await expect(page.getByTestId('vendor-sign-in-email-input')).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-csv-market-checkin.png`, fullPage: true });
  });
});

test.describe('Intake mode - a form market keeps its applicant surface', () => {
  let formMarket: ApplicantMarketSeed;

  test.beforeAll(async ({ request }) => {
    formMarket = await seedApplicantMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
  });

  test('its vendor page names the market and asks for an email address', async ({ page }) => {
    await page.goto(vendorPagePath(formMarket.marketSlug));

    await expect(page.getByTestId('vendor-page-market-name')).toHaveText(formMarket.marketName, {
      timeout: 10000,
    });
    await expect(page.getByTestId('vendor-sign-in-email-input')).toBeVisible();
    await expect(page.getByTestId('vendor-page-not-found')).toHaveCount(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-form-market-home.png`, fullPage: true });
  });
});

test.describe('Intake mode - a market that stops serving applicants', () => {
  test('reads to a vendor already signed in as it reads to a stranger', async ({
    page,
    request,
  }) => {
    const market = await seedApplicantMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    const login = new VendorPage(page);
    await page.goto(vendorPagePath(market.marketSlug));
    await login.requestCode(SIGNED_IN_VENDOR);
    createApplicantLoginChallenge(market.marketId, SIGNED_IN_VENDOR, '531642');
    await login.enterCode('531642');
    await expect(login.signedInAs).toBeVisible();

    // Nobody has applied, so the organizer may take the market back to draft, where it serves no
    // applicant. The vendor's sign-in still holds; their page must not blame their connection
    // for a market that is no longer there.
    const back = await request.post(`${BACKEND_URL}/markets/${market.marketId}/transition`, {
      headers: { 'Content-Type': 'application/json' },
      data: { toPhase: 'draft' },
    });
    expect(back.ok(), await back.text()).toBeTruthy();

    await page.goto(vendorPagePath(market.marketSlug));
    await expect(page.getByTestId('page-not-found')).toBeVisible();
    await expect(page.getByText('Check your connection')).toHaveCount(0);
  });
});
