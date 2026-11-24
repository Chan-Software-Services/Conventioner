import type { Page, Request, Response } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { marketSetupPath } from './helpers/marketScreens';

/**
 * One edit to the plan is one save (E26/F04/S01, bug 25).
 *
 * After any edit the page used to send `PUT /plan` about every 625 ms until the organizer left
 * it: each save re-read the market, the re-read replaced the plan's working copy, and the cards,
 * which deep-watch that copy, reported the replacement as a new edit. Besides the traffic, the
 * looping tab re-sent its own copy every cycle and overwrote whatever another editor saved.
 *
 * The quiet after the save runs on `page.clock`, not in real time: the pause before a save and
 * the two seconds "Plan saved" shows are the page's own timers, so the fake clock runs them at once.
 */

function countPlanSaves(page: Page): { count: () => number } {
  let saves = 0;
  page.on('request', (req: Request) => {
    if (req.method() === 'PUT' && /\/markets\/[^/]+\/plan$/.test(req.url())) saves += 1;
  });
  return { count: () => saves };
}

/** Five seconds is eight debounce cycles of the old loop; one save must stay one save. */
const QUIET = 5_000;

/** The market's own read, which follows every save of the plan. */
function theReRead(page: Page, marketId: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/markets/${marketId}`),
  );
}

/**
 * Runs the quiet on the page's clock, stopped, so the page's own timers alone move it: the pause
 * before a save, and the two seconds "Plan saved" shows. The old loop's save was the edit the
 * re-read reported, so the quiet starts once that read has answered. A save the page meant to
 * make in the quiet goes as it runs, and with the clock stopped its line then holds, "Saving…"
 * and then "Plan saved", never clearing; with none, the line has cleared.
 */
async function runTheQuiet(page: Page, reRead: Promise<Response>): Promise<void> {
  await (await reRead).finished();
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.clock.runFor(QUIET);
}

/** Market Setup's save line says nothing: no save is out, and none landed in the quiet. */
async function expectNoSaveInTheQuiet(page: Page): Promise<void> {
  await expect(page.getByTestId(/^market-setup-plan-sav(ing|ed)$/)).toHaveCount(0);
}

test.describe('The plan saves once per edit', () => {
  test('on Market Setup, one edit sends one save', async ({ authenticatedPage: page, request }) => {
    const { marketId } = await seedDraftMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    await page.clock.install();
    await page.goto(marketSetupPath(marketId));
    await page.getByTestId('setup-location-add-button').click();
    const saves = countPlanSaves(page);
    const reRead = theReRead(page, marketId);

    await page.getByTestId('setup-location-name-input-0').fill('Pier Hall');
    await expect.poll(saves.count).toBe(1);

    // Said under the plan's cards, in their gutter: it sat in the card's corner, touching both
    // edges (E26 re-walk).
    const saved = await page.getByTestId('market-setup-plan-saved').boundingBox();
    const plan = await page.getByTestId('plan-card-form').boundingBox();
    const card = await page.getByTestId('market-frame-card').boundingBox();
    expect(Math.abs(saved!.x + saved!.width - (plan!.x + plan!.width))).toBeLessThanOrEqual(1);
    expect(card!.y + card!.height - (saved!.y + saved!.height)).toBeGreaterThanOrEqual(16);

    await runTheQuiet(page, reRead);
    await expectNoSaveInTheQuiet(page);
    expect(saves.count()).toBe(1);
  });

  test('on the Settings page, one option edit sends one save', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { marketId } = await seedDraftMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    await page.clock.install();
    await page.goto(marketSetupPath(marketId, 'settings'));
    const proportion = page.getByTestId('setup-options-max-proportion-input');
    await expect(proportion).toBeVisible();
    const saves = countPlanSaves(page);
    const reRead = theReRead(page, marketId);

    await proportion.fill('40');
    await expect.poll(saves.count).toBe(1);
    await runTheQuiet(page, reRead);
    // Settings shows the save line only for a save that did not land, so the line is read on the
    // plan's tab, the same page at another address, with the clock still stopped.
    await page.getByTestId('market-bar-tab-setup').click();
    await expect(page.getByTestId('setup-location-add-button')).toBeVisible();
    await expectNoSaveInTheQuiet(page);
    expect(saves.count()).toBe(1);
  });

  test("a second editor's change survives while the first tab stays open", async ({
    authenticatedPage: first,
    request,
  }) => {
    const { marketId } = await seedDraftMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    await first.clock.install();
    await first.goto(marketSetupPath(marketId));
    await first.getByTestId('setup-location-add-button').click();
    const reRead = theReRead(first, marketId);
    await first.getByTestId('setup-location-name-input-0').fill('Pier Hall');
    await expect(first.getByTestId('market-setup-plan-saved')).toBeVisible();

    // The same organizer in a second tab, as two people sharing a market would be.
    const second = await first.context().newPage();
    await second.goto(marketSetupPath(marketId));
    await expect(second.getByTestId('setup-location-name-input-0')).toHaveValue('Pier Hall');
    await second.getByTestId('setup-location-add-button').click();
    await second.getByTestId('setup-location-name-input-1').fill('Annex');
    await expect(second.getByTestId('market-setup-plan-saved')).toBeVisible();
    await second.close();

    await runTheQuiet(first, reRead);
    await expectNoSaveInTheQuiet(first);
    const res = await request.get(`${BACKEND_URL}/markets/${marketId}`);
    const { market } = (await res.json()) as {
      market: { setupObject: { locations: { name: string }[] } };
    };
    expect(market.setupObject.locations.map((l) => l.name)).toEqual(['Pier Hall', 'Annex']);
  });
});
