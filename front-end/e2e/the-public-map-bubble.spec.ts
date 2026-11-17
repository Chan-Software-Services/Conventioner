import type { Locator, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The public map's speech bubble at a desk (T465 ticket 05), opened signed out on the seam's seeded
 * market: North Wing's Aisle A of four tables in a row near the hall's top, Aisle A 1 held by Ember
 * Ceramics (a website and an Instagram, so a tall card) and Aisle A 4 free (a short one).
 *
 * A press on a table opens the card as a bubble from it, its tail on the table, always inside the
 * hall: up and to the right by default, under the table when the room over it is too short, to the
 * left near the hall's right edge. It follows the table as the map zooms and pans, hides while the
 * table is out of view, and Close and Escape shut it, giving the focus back to the table. A vendor
 * opened from the list whose table is out of view shows the whole hall first. The rules themselves
 * are proved in `bubblePlacement.test.ts`; this proves the wiring in a real browser.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const centreX = (box: Box) => box.x + box.width / 2;

/** The bubble's tail's point across the screen: the bubble's left and its `--tail-x`. */
async function tailX(map: PublicMapPage): Promise<number> {
  const box = await boxOf(map.bubble);
  const offset = await map.bubble.evaluate((el) =>
    parseFloat(getComputedStyle(el).getPropertyValue('--tail-x')),
  );
  // The bubble's box is its border box; `left` and `--tail-x` count from it.
  return box.x + offset;
}

/** The bubble stands wholly inside the hall, 8px clear of every edge. */
async function expectInsideTheHall(map: PublicMapPage) {
  const hall = await boxOf(map.hall);
  const bubble = await boxOf(map.bubble);
  expect(bubble.x, "the bubble is clear of the hall's left edge").toBeGreaterThanOrEqual(
    hall.x + 8 - 0.5,
  );
  expect(bubble.y, "the bubble is clear of the hall's top").toBeGreaterThanOrEqual(
    hall.y + 8 - 0.5,
  );
  expect(
    bubble.x + bubble.width,
    "the bubble is clear of the hall's right edge",
  ).toBeLessThanOrEqual(hall.x + hall.width - 8 + 0.5);
  expect(bubble.y + bubble.height, "the bubble is clear of the hall's bottom").toBeLessThanOrEqual(
    hall.y + hall.height - 8 + 0.5,
  );
}

/** The bubble's tail points at the table's centre across, and the bubble opened `vert` of it. */
async function expectSpeaksFor(map: PublicMapPage, table: Locator, vert: 'up' | 'down') {
  await expect(map.bubble).toBeVisible();
  await expect(map.bubble).toHaveAttribute('data-vert', vert);
  const at = await boxOf(table);
  const bubble = await boxOf(map.bubble);
  expect(Math.abs((await tailX(map)) - centreX(at)), 'the tail is on the table').toBeLessThan(1.5);
  if (vert === 'up') expect(bubble.y + bubble.height).toBeLessThanOrEqual(at.y);
  else expect(bubble.y).toBeGreaterThanOrEqual(at.y + at.height);
}

/** Drag the map by the mouse from a point of the floor, by `dx` and `dy` pixels. */
async function drag(page: Page, map: PublicMapPage, dx: number, dy: number) {
  const hall = await boxOf(map.hall);
  // The hall's bottom middle is floor in the seeded North Wing, at any zoom the tests use.
  const from = { x: hall.x + hall.width / 2, y: hall.y + hall.height - 120 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

/** Whether two boxes overlap at all. */
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * A second row in North Wing, 2 m under Aisle A, each table held today by a fixture vendor, so a
 * bubble opening down from Aisle A covers a table that takes the focus: North Wing's answer as the
 * server sent it, the seed unchanged for this one test.
 */
async function addARowUnderAisleA(page: Page): Promise<void> {
  await page.route(
    (url) => new URL(url.href).pathname.endsWith(`/public/markets/${seeded.slug}/map`),
    async (route) => {
      const response = await route.fetch();
      const answer = await response.json();
      const north = answer.locations.find(
        (location: { id: string }) => location.id === seeded.north.id,
      );
      const aisle = north.layout.tables.slice(0, 4);
      aisle.forEach((model: { xMm: number; yMm: number }, i: number) => {
        const tableId = `second-row-table-${i + 1}`;
        north.layout.tables.push({ ...model, id: tableId, number: 5 + i, yMm: model.yMm + 2000 });
        answer.seats.push({
          date: seeded.today,
          tableId,
          half: 'whole',
          name: `Rowfixture Stall ${i + 1}`,
          website: null,
          instagram: null,
        });
      });
      await route.fulfill({ response, json: answer });
    },
  );
}

test.describe('the bubble at a desk', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a press opens it up and to the right of the table, its tail on it, inside the hall', async ({
    page,
    expectAccessible,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await expect(map.bubble).toHaveCount(0);

    const free = map.table('Aisle A 4');
    await free.click();
    await expect(map.bubble).toHaveAttribute('data-side', 'right');
    await expectSpeaksFor(map, free, 'up');
    await expectInsideTheHall(map);
    // One card, in the bubble, its code in its section's pill and the hall named beside it.
    await expect(map.card).toHaveCount(1);
    await expect(map.bubble.getByTestId('public-map-card')).toBeVisible();
    await expect(map.cardCode).toHaveText('Aisle A 4');
    await expect(map.card).toContainText(seeded.north.name);
    await expect(map.card.getByRole('heading', { level: 2 })).toHaveText('Table Aisle A 4');
    await expect(map.card).toHaveAccessibleName('Table Aisle A 4');
    await expectAccessible('the public map, the bubble open');
  });

  test('it opens under a table whose room over it is too short for it', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const ember = map.table('Aisle A 1');
    await ember.click();
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    const hall = await boxOf(map.hall);
    const at = await boxOf(ember);
    const bubble = await boxOf(map.bubble);
    expect(
      at.y - hall.y - 8 - 12,
      'the precondition: the room over Aisle A 1 is shorter than its bubble',
    ).toBeLessThan(bubble.height);
    await expectSpeaksFor(map, ember, 'down');
    await expect(map.bubble).toHaveAttribute('data-side', 'right');
    await expectInsideTheHall(map);
    // The links are pills, their kind said to a reader alone.
    await expect(map.cardWebsites).toHaveAccessibleName('ember-ceramics.test');
    await expect(map.card.getByText('Website', { exact: true })).toHaveClass(/visually-hidden/);
  });

  test('it follows its table as the map zooms, hides while the table is panned away, and comes back', async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const free = map.table('Aisle A 4');
    await free.click();
    await expectSpeaksFor(map, free, 'up');
    const before = await boxOf(free);

    await map.zoomIn.click();
    await expect.poll(async () => (await boxOf(free)).width).toBeGreaterThan(before.width * 1.4);
    await expect
      .poll(async () => Math.abs((await tailX(map)) - centreX(await boxOf(free))))
      .toBeLessThan(1.5);
    await expectInsideTheHall(map);

    // Zoomed further, drag the table off the hall's left edge: the bubble hides with it. (The map
    // keeps its view inside the whole hall, so a table goes out of view only zoomed in this far.)
    await map.zoomIn.click();
    await map.zoomIn.click();
    const hall = await boxOf(map.hall);
    await drag(page, map, hall.x - 200 - centreX(await boxOf(free)), 0);
    const away = await boxOf(free);
    expect(away.x + away.width, 'the precondition: Aisle A 4 is out of the hall').toBeLessThan(
      hall.x,
    );
    await expect(map.bubble).toBeHidden();
    await expect(map.bubble).toHaveCount(1);

    await page.getByTestId('day-map-fit').click();
    await expectSpeaksFor(map, free, 'up');
  });

  test('the focus reaching a table it covers closes it, the focus staying on that table', async ({
    page,
  }) => {
    await addARowUnderAisleA(page);
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const ember = map.table('Aisle A 1');
    await ember.click();
    await expect(map.bubble).toHaveAttribute('data-vert', 'down');
    const under = map.table('Aisle A 5');
    expect(
      overlap(await boxOf(map.bubble), await boxOf(under)),
      'the precondition: Aisle A 5 lies under the bubble',
    ).toBe(true);
    const beside = map.table('Aisle A 2');
    expect(
      overlap(await boxOf(map.bubble), await boxOf(beside)),
      'the precondition: Aisle A 2 is clear of the bubble',
    ).toBe(false);

    // A neighbour clear of it keeps it open; one under it closes it, and keeps the focus.
    await ember.focus();
    await page.keyboard.press('ArrowRight');
    await expect(beside).toBeFocused();
    await page.waitForTimeout(100);
    await expect(map.bubble).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(ember).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(under).toBeFocused();
    await expect(map.card).toHaveCount(0);
    await expect(page).not.toHaveURL(/table=/);
    await expect(under).toBeFocused();
  });

  test('Close shuts it and gives the focus back to its table', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const ember = map.table('Aisle A 1');
    await ember.click();
    await expect(map.cardClose).toHaveAccessibleName('Close');
    await map.cardClose.click();
    await expect(map.card).toHaveCount(0);
    await expect(map.bubble).toHaveCount(0);
    await expect(page).not.toHaveURL(/table=/);
    await expect(ember).toBeFocused();
  });

  test('Escape shuts it from the card or from the map, the focus back on its table', async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const ember = map.table('Aisle A 1');
    await ember.click();
    await map.cardWebsites.focus();
    await page.keyboard.press('Escape');
    await expect(map.card).toHaveCount(0);
    await expect(page).not.toHaveURL(/table=/);
    await expect(ember).toBeFocused();

    // From the table itself, by keyboard: Enter opens it, Escape shuts it, the focus stays.
    await page.keyboard.press('Enter');
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await page.keyboard.press('Escape');
    await expect(map.card).toHaveCount(0);
    await expect(ember).toBeFocused();
  });

  test('Escape in the search closes its open list first, and then the card', async ({ page }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await map.table('Aisle A 1').click();
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await map.searchInput.fill('kiln');
    await expect(map.searchList).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(map.searchList).toBeHidden();
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await page.keyboard.press('Escape');
    await expect(map.card).toHaveCount(0);
    await expect(map.searchInput).toBeFocused();
  });

  test('a vendor from the list whose table is zoomed out of view shows the whole hall first', async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    const whole = (await map.view()).width;
    for (let i = 0; i < 3; i++) await map.zoomIn.click();
    await expect.poll(async () => (await map.view()).width).toBeLessThan(whole / 2.5);
    const hall = await boxOf(map.hall);
    const ember = map.table('Aisle A 1');
    const out = await boxOf(ember);
    expect(
      out.x + out.width < hall.x || out.y + out.height < hall.y,
      'the precondition: Aisle A 1 is zoomed out of the hall',
    ).toBe(true);

    await map.vendors.filter({ hasText: 'Ember Ceramics' }).click();
    await expect.poll(async () => (await map.view()).width).toBeCloseTo(whole, 0);
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await expectSpeaksFor(map, ember, 'down');
    await expectInsideTheHall(map);
  });
});

test.describe('the bubble in a smaller desk window', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("near the hall's right edge it opens to the left, its tail still on the table", async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    // No seeded table stands near the right edge of the whole hall: zoom in and drag Aisle A 4
    // there, its right end 16px in, half way down (zoomed about the middle, the row has left the
    // hall's top).
    for (let i = 0; i < 3; i++) await map.zoomIn.click();
    const free = map.table('Aisle A 4');
    const hall = await boxOf(map.hall);
    const start = await boxOf(free);
    await drag(
      page,
      map,
      hall.x + hall.width - 16 - (start.x + start.width),
      hall.y + hall.height / 2 - (start.y + start.height / 2),
    );
    const at = await boxOf(free);
    expect(
      centreX(at) - 28 + 288,
      "the precondition: a bubble opening right from Aisle A 4 would pass the hall's right edge",
    ).toBeGreaterThan(hall.x + hall.width - 8);
    expect(at.x + at.width, 'the precondition: Aisle A 4 is still in the hall').toBeLessThan(
      hall.x + hall.width,
    );

    await free.click();
    await expect(map.bubble).toHaveAttribute('data-side', 'left');
    await expectSpeaksFor(map, free, (await map.bubble.getAttribute('data-vert')) as 'up' | 'down');
    await expectInsideTheHall(map);
  });
});

// What floats over the hall, the zoom and the legend, is never under the bubble where the hall has
// room, so the only things under it that take the focus are tables: a press on the zoom, and Tab
// from the picked table through Zoom out, Zoom in and Fit, leave it open.
test.describe('the bubble in a short desk window', () => {
  test.use({ viewport: { width: 1100, height: 560 } });

  test('it keeps clear of the zoom, which a press and Tab pass without closing it', async ({
    page,
  }) => {
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    // No seeded table stands over the zoom: zoom in and drag Aisle A 1, whose card is tall, left
    // of the zoom by less than the card's width and two fifths of the way down the hall.
    for (let i = 0; i < 3; i++) await map.zoomIn.click();
    const zoom = page.getByTestId('day-map-zoom');
    const ember = map.table('Aisle A 1');
    const hall = await boxOf(map.hall);
    const pill = await boxOf(zoom);
    const start = await boxOf(ember);
    await drag(
      page,
      map,
      pill.x - 180 - centreX(start),
      hall.y + hall.height * 0.4 - (start.y + start.height / 2),
    );

    await ember.click();
    await expect(map.cardNames).toHaveText(['Ember Ceramics']);
    await expect(map.bubble).toHaveAttribute('data-vert', 'down');
    const at = await boxOf(ember);
    const bubble = await boxOf(map.bubble);
    // Where it opens with nothing to keep clear of: right of the table, under it, held in the hall.
    expect(
      centreX(at) - 28 + bubble.width,
      'the precondition: opening right from Aisle A 1 keeps inside the hall',
    ).toBeLessThanOrEqual(hall.x + hall.width - 8);
    const opened = {
      x: centreX(at) - 28,
      y: Math.min(at.y + at.height + 12, hall.y + hall.height - 8 - bubble.height),
      width: bubble.width,
      height: bubble.height,
    };
    expect(overlap(opened, pill), 'the precondition: opened so, it would cover the zoom').toBe(
      true,
    );
    expect(overlap(bubble, pill), 'the bubble is clear of the zoom').toBe(false);
    expect(
      overlap(bubble, await boxOf(page.getByTestId('public-map-legend'))),
      'the bubble is clear of the legend',
    ).toBe(false);
    await expectSpeaksFor(map, ember, 'down');
    await expectInsideTheHall(map);

    // Tab from the table passes the zoom's three buttons and reaches the card, at its Close.
    await ember.focus();
    for (const stop of ['day-map-zoom-out', 'day-map-zoom-in', 'day-map-fit']) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(stop)).toBeFocused();
    }
    await page.waitForTimeout(100);
    await expect(map.card).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(map.card.getByTestId('public-map-card-close')).toBeFocused();

    // A press on the zoom zooms the map, the bubble following its table.
    await map.zoomIn.click();
    await page.waitForTimeout(100);
    await expect(map.bubble).toBeVisible();
    await expect(map.card).toHaveCount(1);
  });
});
