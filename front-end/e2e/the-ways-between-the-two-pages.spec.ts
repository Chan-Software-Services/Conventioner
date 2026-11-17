import type { Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER, VendorPage } from './fixtures';
import { marketPagePath, vendorPagePath } from './helpers/marketScreens';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';
import { signInOnThePage } from './helpers/vendorSignIn';
import { MarketPage } from './pages/MarketPage';
import { PublicMapPage } from './pages/PublicMapPage';

/**
 * The ways between a market's two pages (T469, K1): the vendor page at `/<market>/vendor` lists the
 * market's dates under its name, signed out or in, and while the public map is open links "See the
 * market map" to the market page at `/<market>`; the market page's app bar carries "Vendor
 * sign-in", or "Your vendor page" for a vendor signed in in this tab, back to the vendor page.
 */

let mapped: SeededMarketDayMap;
let unmapped: SeededMarketDayMap;

/** A calendar day in the product's one long format: "Saturday, August 1, 2099". */
const inWords = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

test.beforeAll(async ({ request }) => {
  mapped = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  unmapped = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
});

/**
 * Its vendor page, signed out or signed in as its `vendor`th vendor, waiting for what it shows. The
 * sign-in limits count per address, so each test signs in as a vendor of its own.
 */
async function openTheVendorPage(
  page: Page,
  market: SeededMarketDayMap,
  signedIn: boolean,
  vendor: number,
): Promise<VendorPage> {
  const vendorPage = new VendorPage(page);
  await vendorPage.goto(market.slug);
  await expect(vendorPage.marketName).toHaveText(market.marketName);
  if (signedIn) await signInOnThePage(vendorPage, market.marketId, market.vendors[vendor].email);
  return vendorPage;
}

for (const signedIn of [false, true]) {
  test.describe(signedIn ? 'signed in as a vendor' : 'signed out', () => {
    test("the vendor page lists the market's dates, and links its open map, which opens at the market's address", async ({
      page,
    }) => {
      const vendorPage = await openTheVendorPage(page, mapped, signedIn, 0);
      await expect(page.getByRole('list', { name: 'Market dates' })).toBeVisible();
      await expect(vendorPage.dates.getByRole('listitem')).toHaveText([
        inWords(mapped.today),
        inWords(mapped.tomorrow),
      ]);
      await expect(vendorPage.mapLink).toHaveText('See the market map');
      await expect(vendorPage.mapLink).toHaveAttribute('href', marketPagePath(mapped.slug));

      await vendorPage.mapLink.click();
      await expect(page).toHaveURL(new RegExp(`${marketPagePath(mapped.slug)}$`));
      await expect(new PublicMapPage(page).heading).toHaveText(mapped.marketName);
    });

    test('the vendor page of a market whose map is off lists its dates, with no map link', async ({
      page,
    }) => {
      const vendorPage = await openTheVendorPage(page, unmapped, signedIn, 1);
      await expect(vendorPage.dates.getByRole('listitem')).toHaveText([
        inWords(unmapped.today),
        inWords(unmapped.tomorrow),
      ]);
      await expect(vendorPage.mapLink).toHaveCount(0);
    });

    test("the market page's app bar leads back to the vendor page", async ({ page }) => {
      if (signedIn) await openTheVendorPage(page, unmapped, true, 2);
      const market = new MarketPage(page);
      await market.goto(unmapped.slug);
      await expect(market.noticeLine).toHaveText("The map isn't published yet.");
      const barLink = page.getByTestId('app-bar').getByRole('link');
      await expect(barLink).toHaveText(signedIn ? 'Your vendor page' : 'Vendor sign-in');
      await expect(barLink).toHaveAttribute('href', vendorPagePath(unmapped.slug));

      await barLink.click();
      await expect(page).toHaveURL(new RegExp(`${vendorPagePath(unmapped.slug)}$`));
      const vendorPage = new VendorPage(page);
      await expect(vendorPage.marketName).toHaveText(unmapped.marketName);
      await expect(signedIn ? vendorPage.signedInAs : vendorPage.emailInput).toBeVisible();
    });

    test("the map's app bar leads to the vendor page too", async ({ page }) => {
      if (signedIn) await openTheVendorPage(page, mapped, true, 3);
      await new MarketPage(page).goto(mapped.slug);
      await expect(new PublicMapPage(page).heading).toHaveText(mapped.marketName);
      const barLink = page.getByTestId('app-bar').getByRole('link');
      await expect(barLink).toHaveText(signedIn ? 'Your vendor page' : 'Vendor sign-in');

      await barLink.click();
      await expect(page).toHaveURL(new RegExp(`${vendorPagePath(mapped.slug)}$`));
      await expect(new VendorPage(page).marketName).toHaveText(mapped.marketName);
    });
  });
}
