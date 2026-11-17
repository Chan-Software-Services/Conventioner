import { test, expect, TEST_USER, BACKEND_URL, APP_API } from './fixtures';
import { seedApplicantMarket } from './helpers/seedApplicantMarket';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { transitionMarket } from './helpers/seedPhaseMarket';
import { marketScreenPath } from './helpers/marketScreens';

/**
 * The rail's public addresses read in full and point at the right page (E30/F01/S03).
 *
 * A form market on its market days carried two - the vendor page and the check-in page - and each
 * once shrank the other to "localhost:5…"; archived, it dropped the check-in page, the reverse of
 * what its archive dialog promised stays up. The check-in page is gone (ADR 0022): its vendors
 * check in on the vendor page. The rail carries two again (T469): the market page, for the public,
 * and the vendor page, for its vendors, both of which a market that ran keeps.
 */
test.describe("The rail's addresses", () => {
  test('read whole on a running form market, and the record stays once archived', async ({
    authenticatedPage: page,
    request,
  }) => {
    const seed = await seedPublishedMarketWithAssignments(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
      { intakeMode: 'form', marketDate: '2099-05-03' },
    );
    const marketPage = page.getByTestId('phase-rail-market-page');
    const vendorPage = page.getByTestId('phase-rail-vendor-page');

    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(marketScreenPath(seed.marketId, 'attendance'));
      await expect(page.getByTestId('phase-rail-checkin')).toHaveCount(0);
      for (const chip of [marketPage, vendorPage]) {
        await expect(chip).toBeVisible();
        const link = chip.locator('a');
        // The address breaks at any character and shows one line, so a cut one runs on to a
        // hidden second line rather than past the link's right edge.
        const cut = await link.evaluate(
          (a) => a.scrollWidth > a.clientWidth || a.scrollHeight > a.clientHeight,
        );
        expect(cut, `${await link.textContent()} is cut off at ${width}px`).toBe(false);
      }
    }

    await transitionMarket(request, BACKEND_URL, TEST_USER.email, seed.marketId, 'archived');
    await page.goto(marketScreenPath(seed.marketId, 'assignments'));
    // A market that ran keeps its pages: its vendor page is where its vendors read where they sat
    // (ADR 0022), and its market page says it has ended (T469).
    await expect(marketPage.locator('a')).toHaveAttribute(
      'href',
      new RegExp(`/${seed.marketSlug}$`),
    );
    await expect(vendorPage.locator('a')).toHaveAttribute(
      'href',
      new RegExp(`/${seed.marketSlug}/vendor$`),
    );
  });

  // A short address left the chip's floor empty after Copy, which then stood mid-chip (T260).
  test("Copy stands at the chip's end, however short the address", async ({
    authenticatedPage: page,
  }) => {
    const market = await seedApplicantMarket(
      page.request,
      APP_API,
      TEST_USER.email,
      TEST_USER.password,
      { name: `c${Date.now().toString(36).slice(-5)}` },
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(marketScreenPath(market.marketId, 'applications'));
      for (const testId of ['phase-rail-market-page', 'phase-rail-vendor-page']) {
        const chip = page.getByTestId(testId);
        await expect(chip).toBeVisible();
        const ends = await chip.evaluate((element) => {
          const style = getComputedStyle(element);
          const inner =
            element.getBoundingClientRect().right -
            parseFloat(style.borderRightWidth) -
            parseFloat(style.paddingRight);
          const copy = element.querySelector('button')!.getBoundingClientRect().right;
          return { inner, copy };
        });
        expect(ends.copy, `${testId}'s Copy's right edge at ${width}px`).toBeCloseTo(ends.inner, 0);
      }
    }
  });
});
