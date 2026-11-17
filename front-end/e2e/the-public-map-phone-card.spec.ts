import type { Locator, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The public map's card on a phone (T465 ticket 08, Daniel's Q1, option (c)), opened signed out on
 * the seam's seeded market: North Wing's Aisle A 1 held by Ember Ceramics (a website and an
 * Instagram), Aisle A 3 shared today by Loom House and Paper Moth Press, Aisle A 4 free.
 *
 * Under 1000px the card of the table picked lies over the vendor panel's top, the panel's full
 * width, so the whole hall stays in view with the table outlined; the list stays under it and
 * shows below it, and comes back whole when the card is closed. A card taller than the panel
 * scrolls in its own box. At 640px and under every control it holds, and the selects, the zoom and
 * the vendor rows, are 44px tall at least. On a phone's browser, whose bars make `100vh` taller
 * than the window it shows, the page and the shell take `100dvh` while the page fills the window.
 * At a desk the card is the speech bubble, never in the panel.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

const [PHONE, DESK] = PHONE_AND_DESK;

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const bottom = (box: Box) => box.y + box.height;

/** Whether the element drawn at a point is inside the locator's element. */
const drawnAt = (locator: Locator, x: number, y: number) =>
  locator.evaluate(
    (el, [px, py]) => {
      const hit = document.elementFromPoint(px!, py!);
      return !!hit && el.contains(hit);
    },
    [x, y],
  );

/** The card lies over the panel's top, the panel's full width, no taller than the panel, and the
 *  hall above it stands wholly in the window, uncovered. */
async function expectAtThePanelsTop(page: Page, map: PublicMapPage) {
  const panel = await boxOf(map.vendorsPanel);
  const scroller = await boxOf(map.cardScroller);
  expect(scroller.x, "the card starts at the panel's start").toBeCloseTo(panel.x, 0);
  expect(scroller.width, "the card is the panel's width").toBeCloseTo(panel.width, 0);
  expect(scroller.y, "the card starts at the panel's top").toBeCloseTo(panel.y, 0);
  expect(bottom(scroller), 'the card ends inside the panel').toBeLessThanOrEqual(
    bottom(panel) + 0.5,
  );
  await expect(map.bubble).toHaveCount(0);

  const hall = await boxOf(map.hall);
  const { width, height } = page.viewportSize()!;
  expect(hall.x).toBeGreaterThanOrEqual(0);
  expect(hall.y).toBeGreaterThanOrEqual(0);
  expect(hall.x + hall.width).toBeLessThanOrEqual(width);
  expect(bottom(hall), 'the hall ends in the window').toBeLessThanOrEqual(height);
  expect(scroller.y, 'the card covers none of the hall').toBeGreaterThanOrEqual(bottom(hall));
  for (const [x, y] of [
    [hall.x + 4, hall.y + 4],
    [hall.x + hall.width - 4, hall.y + 4],
    [hall.x + hall.width / 2, hall.y + hall.height / 2],
    [hall.x + 4, bottom(hall) - 4],
    [hall.x + hall.width - 4, bottom(hall) - 4],
  ] as const)
    expect(await drawnAt(map.hall, x, y), `the hall is drawn at ${x}, ${y}`).toBe(true);
}

/** The declared `min-height` that wins on the element a selector names, as the cascade gives it
 *  (`100vh` and `100dvh` compute to the same pixels in a window with no browser bars). */
async function winningMinHeight(page: Page, selector: string): Promise<string | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { matchedCSSRules = [] } = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    // The rules come in the cascade's order, the last one winning.
    const declared = matchedCSSRules.flatMap((match) =>
      match.rule.style.cssProperties
        .filter((p) => p.name === 'min-height' && !p.disabled && p.parsedOk !== false)
        .map((p) => p.value),
    );
    return declared.at(-1);
  } finally {
    await cdp.detach();
  }
}

test.describe(`the card at the vendor panel's top ${PHONE.name}`, () => {
  test.use(PHONE.use);
  const { press } = inTheWindow(PHONE);

  test("a tap opens the card over the panel's top, and Close brings the list back whole", async ({
    page,
    expectAccessible,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await expect(map.vendors.first()).toBeVisible();
    const rows = await map.vendors.count();
    const firstRow = await boxOf(map.vendors.first());

    await press(map.table('Aisle A 1'));
    await expect(map.cardCode).toHaveText('Aisle A 1');
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await expect(map.cardScroller.getByTestId('public-map-card')).toHaveCount(1);
    await expectAtThePanelsTop(page, map);
    // The list stays under it, unmoved.
    await expect(map.vendors).toHaveCount(rows);
    expect((await boxOf(map.vendors.first())).y).toBeCloseTo(firstRow.y, 0);
    await expectAccessible('the public map, the phone card open');

    await press(map.cardClose);
    await expect(map.card).toHaveCount(0);
    await expect(map.cardScroller).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]table=/);
    // Nothing lies over the list now: its first row and the search are drawn where they stand.
    const first = await boxOf(map.vendors.first());
    expect(await drawnAt(map.vendors.first(), first.x + 8, first.y + first.height / 2)).toBe(true);
    const field = await boxOf(map.searchInput);
    expect(await drawnAt(map.searchInput, field.x + 8, field.y + field.height / 2)).toBe(true);
  });

  test('the list shows below a short card, and a row there opens its vendor', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await press(map.table('Aisle A 4'));
    await expect(map.cardCode).toHaveText('Aisle A 4');
    await expectAtThePanelsTop(page, map);

    // The first row whose middle stands below the card, drawn there and pressable.
    const cardEnd = bottom(await boxOf(map.cardScroller));
    const panelEnd = bottom(await boxOf(map.vendorsPanel));
    let below: Locator | null = null;
    for (const row of await map.vendors.all()) {
      const box = await boxOf(row);
      const middle = box.y + box.height / 2;
      if (middle > cardEnd + 2 && middle < panelEnd - 2) {
        below = row;
        expect(await drawnAt(row, box.x + 8, middle), 'the row below the card is drawn').toBe(true);
        break;
      }
    }
    expect(below, 'a row shows below the card').not.toBeNull();
    const code = (await below!.getByTestId('public-map-vendor-code').innerText()).trim();
    expect(code).not.toBe('Aisle A 4');
    await press(below!);
    await expect(map.cardCode).toHaveText(code);
    await expectAtThePanelsTop(page, map);
  });

  test('Escape shuts the card', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug, { table: 'north-table-1' });
    await expect(map.cardScroller).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(map.card).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]table=/);
  });

  test("the card's Close and links, the selects, the zoom and the rows are 44px tall", async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug, { table: 'north-table-1' });
    await expect(map.cardWebsites).toHaveCount(1);
    const targets: [string, Locator][] = [
      ['Close', map.cardClose],
      ['the website', map.cardWebsites.first()],
      ['the Instagram', map.cardInstagrams.first()],
      ['the day select', map.daySelect],
      ['the hall select', map.locationSelect],
      ['Zoom out', page.getByTestId('day-map-zoom-out')],
      ['Zoom in', map.zoomIn],
      ['Fit', page.getByTestId('day-map-fit')],
    ];
    for (const [what, target] of targets)
      expect((await boxOf(target)).height, `${what} is 44px tall`).toBeGreaterThanOrEqual(44);
    for (const row of await map.vendors.all())
      expect((await boxOf(row)).height, 'a vendor row is 44px tall').toBeGreaterThanOrEqual(44);
  });

  test("the page and the shell take the window's dynamic height while the page fills it", async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await expect(page.locator('html')).toHaveClass(/\bfills-the-window\b/);
    expect(await winningMinHeight(page, 'body')).toBe('100dvh');
    expect(await winningMinHeight(page, '.app-container')).toBe('100dvh');

    // Without the class, as on every other page, both keep `100vh`.
    await page.evaluate(() => document.documentElement.classList.remove('fills-the-window'));
    expect(await winningMinHeight(page, 'body')).toBe('100vh');
    expect(await winningMinHeight(page, '.app-container')).toBe('100vh');
  });
});

/** A small phone, 375 by 667, whose panel is shorter than a shared table's whole card. */
const SMALL_PHONE = { ...PHONE.use, viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 };

test.describe("the card at the vendor panel's top on a small phone", () => {
  test.use(SMALL_PHONE);

  test("a card taller than the panel scrolls in its own box, inside the panel's height", async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    // Both halves of the shared table, the tallest card the seed has.
    await map.goto(seeded.slug, { table: 'north-table-3', half: 'middle' });
    await expect(map.cardHalves).toHaveCount(2);
    await expectAtThePanelsTop(page, map);
    const scroller = map.cardScroller;
    const lastLink = map.cardWebsites.last();
    expect(
      bottom(await boxOf(lastLink)),
      "the card's last link starts cut off at the box's foot",
    ).toBeGreaterThan(bottom(await boxOf(scroller)));
    // It is reached by scrolling the card's own box, the hall and the page unmoved.
    const hallBefore = await boxOf(map.hall);
    await lastLink.scrollIntoViewIfNeeded();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const link = await boxOf(lastLink);
    expect(bottom(link)).toBeLessThanOrEqual(bottom(await boxOf(scroller)) + 0.5);
    expect(await boxOf(map.hall)).toEqual(hallBefore);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      ),
    ).toBe(0);
  });
});

test.describe(`the card ${DESK.name}`, () => {
  test.use(DESK.use);

  test('is the speech bubble in the hall, never in the panel', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await map.table('Aisle A 1').click();
    await expect(map.bubble.getByTestId('public-map-card')).toHaveCount(1);
    await expect(map.card).toHaveCount(1);
    await expect(map.cardScroller).toHaveCount(0);
    await expect(map.vendorsPanel.getByTestId('public-map-card')).toHaveCount(0);
  });
});
