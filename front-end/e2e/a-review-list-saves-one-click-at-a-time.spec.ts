import type { Page, Request, Route } from '@playwright/test';
import { test, expect, TEST_USER, APP_API } from './fixtures';
import { seedPhaseMarket } from './helpers/seedPhaseMarket';
import { saveApplicationForm } from './helpers/saveApplicationForm';
import { marketSetupPath } from './helpers/marketScreens';

/**
 * A list saved on the market a click at a time writes one click at a time (T420).
 *
 * What a reviewer reads first is saved as each answer is marked. Two quick clicks used to put two
 * writes out at once; when the first did not land, the screen showed a list the server never took.
 * Now a click made while a write is out waits for its answer, and a write that does not land takes
 * the clicks behind it back with it: the list shows what the server holds, beside the reason.
 */

const HIGHLIGHTS_WRITE = /\/markets\/[^/]+\/review-highlights$/;
const OFFLINE = 'You seem to be offline. Check the connection and try again.';

const FORM = {
  fields: [
    { key: 'business_name', label: 'Business name', type: 'text', required: true, order: 0 },
    { key: 'what_you_sell', label: 'What you sell', type: 'text', required: true, order: 1 },
    { key: 'instagram', label: 'Instagram', type: 'text', required: false, order: 2 },
  ],
};

function isHighlightsWrite(req: Request): boolean {
  return req.method() === 'PUT' && HIGHLIGHTS_WRITE.test(req.url());
}

/** How many highlights writes were ever out at once, from the page's side. */
function watchWrites(page: Page): { mostAtOnce: () => number; sent: () => number } {
  let out = 0;
  let most = 0;
  let sent = 0;
  const done = (req: Request) => {
    if (isHighlightsWrite(req)) out -= 1;
  };
  page.on('request', (req) => {
    if (!isHighlightsWrite(req)) return;
    sent += 1;
    out += 1;
    most = Math.max(most, out);
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return { mostAtOnce: () => most, sent: () => sent };
}

async function storedHighlights(page: Page, marketId: string): Promise<string[]> {
  const res = await page.request.get(`${APP_API}/markets/${marketId}`);
  const { market } = (await res.json()) as { market: { reviewHighlights?: string[] } };
  return market.reviewHighlights ?? [];
}

test.describe('A review list saves one click at a time', () => {
  test('a click made while a write is out waits, and a write that fails puts back what the server holds', async ({
    authenticatedPage: page,
  }) => {
    const { marketId } = await seedPhaseMarket(
      page.request,
      APP_API,
      TEST_USER.email,
      TEST_USER.password,
      { intakeMode: 'form' },
    );
    await saveApplicationForm(page.request, APP_API, marketId, FORM);

    // The first write is held on the wire until the test lets it fail; any later one goes through.
    let first: Route | null = null;
    let firstHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => (firstHeld = resolve));
    await page.route(HIGHLIGHTS_WRITE, async (route) => {
      if (route.request().method() !== 'PUT' || first) return route.continue();
      first = route;
      firstHeld();
    });
    const writes = watchWrites(page);

    await page.goto(marketSetupPath(marketId, 'form'));
    await page.getByTestId('form-step-review').click();
    const highlights = page.getByTestId('review-highlights');
    const sell = highlights.getByTestId('review-highlight-what_you_sell');
    const instagram = highlights.getByTestId('review-highlight-instagram');

    await sell.click();
    await held;
    await instagram.click();
    // Both show at once, while one write is out.
    await expect(sell.locator('input')).toBeChecked();
    await expect(instagram.locator('input')).toBeChecked();
    expect(writes.sent()).toBe(1);

    await first!.abort('internetdisconnected');

    // The server never took either click: the list is back as it holds it, with the reason.
    await expect(page.getByTestId('review-highlights-error')).toHaveText(OFFLINE);
    await expect(sell.locator('input')).not.toBeChecked();
    await expect(instagram.locator('input')).not.toBeChecked();
    expect(writes.sent()).toBe(1);
    expect(writes.mostAtOnce()).toBe(1);
    expect(await storedHighlights(page, marketId)).toEqual([]);

    // The next click is sent, and lands.
    await page.unroute(HIGHLIGHTS_WRITE);
    const landed = page.waitForResponse((res) => isHighlightsWrite(res.request()));
    await instagram.click();
    expect((await landed).ok()).toBe(true);
    await expect(page.getByTestId('review-highlights-error')).toHaveCount(0);
    await expect(instagram.locator('input')).toBeChecked();
    await expect(sell.locator('input')).not.toBeChecked();
    expect(await storedHighlights(page, marketId)).toEqual(['instagram']);
  });
});
