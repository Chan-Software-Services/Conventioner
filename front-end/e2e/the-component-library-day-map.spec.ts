import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import { eachWindow, expectLaidOut, openEntry } from './helpers/componentLibrary';
import { inTheWindow } from './helpers/phoneWindow';

/**
 * The component library's `day-map` entry (T422): `DayMap` on the fixture's market day, Upper
 * Hall and Lower Hall with their seats dealt from seed 422, at a desk and on a phone. Each table is
 * drawn filled, outlined or free, a shared table is two halves each pressed on its own, a press is
 * read out, the location switch opens Lower Hall with its turned stage, a search's mark outlines
 * one half, and the map zooms by its buttons and, at a desk, by Ctrl and the wheel. Filling a box
 * of its own, as the public map's hall draws it (T465), the map takes the box whole, and the
 * caller's legend and the zoom stand over its bottom corners, or in a row under it in a narrow box.
 */

const readOutsOf = (panel: Locator): Locator => panel.getByTestId('read-out');

/** The fill a table's top, or a half's shape, is painted. */
const fillOf = (shape: Locator) => shape.evaluate((element) => getComputedStyle(element).fill);

const viewWidth = (map: Locator) =>
  map.evaluate((svg) => Number(svg.getAttribute('viewBox')!.split(' ')[2]));

/** Gold row 3: shared, its left half here (Nettle Knits) and its right expected (Kelp Candles). */
const GOLD_3 = 'Gold row 3, Standard 6 ft';

eachWindow('the day map entry', (size) => {
  test.beforeEach(async ({ page }) => {
    await openEntry(page, 'day-map');
  });

  test('names what it serves, ends with its choices, and is laid out', async ({
    page,
    expectAccessible,
  }) => {
    await expect(page.getByTestId('library-serves')).toContainText('The public map page');
    await expect(page.getByTestId('choices-for-you').getByRole('listitem')).toHaveCount(8);
    const door = page.getByTestId('library-day-map-door');
    await expect(readOutsOf(door).nth(2)).toHaveText(
      'Dealt: 63 tables, 45 seats filled, 18 outlined, 8 tables free, 13 shared, 5 of them with a half free',
    );
    await expectLaidOut(page, size, 'the day map entry');
    await expectAccessible('the day map entry');
  });

  test('draws each tone, a shared table as two halves, and reads out a press', async ({ page }) => {
    const { press } = inTheWindow(size);
    const door = page.getByTestId('library-day-map-door');
    const map = door.getByTestId('layout-map');
    await expect(map).toHaveAccessibleName('Upper Hall layout, 49 tables');
    await expect(door.getByTestId('day-map-legend-item')).toHaveText([
      'Here',
      'Expected',
      'No vendor',
    ]);

    // Filled in Silver aisle's tint, outlined white, free on the floor with a dashed edge.
    const here = map.getByRole('button', { name: 'Silver aisle 5, Standard 6 ft, Oakmoss Soaps' });
    expect(await fillOf(here.getByTestId('layout-table-top'))).toBe('rgb(220, 233, 238)');
    const free = map.getByRole('button', { name: 'Gold row 6, Standard 6 ft, no vendor' });
    expect(await fillOf(free.getByTestId('layout-table-top'))).toBe('rgb(244, 242, 238)');
    await expect(free.getByTestId('layout-table-top')).toHaveAttribute('stroke-dasharray', '4 3');

    const left = map.getByRole('button', { name: `${GOLD_3}, left half, Nettle Knits` });
    const right = map.getByRole('button', { name: `${GOLD_3}, right half, Kelp Candles` });
    expect(await fillOf(right.locator('path').first())).toBe('rgb(255, 255, 255)');
    await expect(map.locator('[data-table-id="sec-gold-3"] [data-label-of="left"]')).toHaveText(
      size.phone ? [] : ['3L'],
    );

    await press(right);
    await expect(readOutsOf(door).nth(1)).toHaveText(
      `Pressed: ${GOLD_3}, right half, Kelp Candles`,
    );
    await expect(door.getByTestId('layout-map-read')).toHaveCount(1);
    await press(left);
    await expect(readOutsOf(door).nth(1)).toHaveText(`Pressed: ${GOLD_3}, left half, Nettle Knits`);
    // Gold row 1's left half is free: drawn, and no button.
    const goldOne = map.locator('[data-table-id="sec-gold-1"]');
    await expect(goldOne.getByRole('button')).toHaveCount(1);
    await expect(goldOne.locator('[data-half]')).toHaveCount(2);
  });

  test('the keys reach each half, left before right, and press it', async ({ page }) => {
    test.skip(size.phone, 'a desk has the keys');
    const door = page.getByTestId('library-day-map-door');
    const map = door.getByTestId('layout-map');
    await map.getByRole('button', { name: `${GOLD_3}, left half, Nettle Knits` }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(
      map.getByRole('button', { name: `${GOLD_3}, right half, Kelp Candles` }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(readOutsOf(door).nth(1)).toHaveText(
      `Pressed: ${GOLD_3}, right half, Kelp Candles`,
    );

    // The map is one Tab stop: from a half, Tab and Shift+Tab leave it, never stopping on a shared
    // table around its halves or on a free half, neither a button (T422 ticket 11's focus sweep).
    const inTheMap = () =>
      page.evaluate(
        () => !!document.activeElement?.closest('[data-testid="library-day-map-door"] svg'),
      );
    await page.keyboard.press('Shift+Tab');
    expect(await inTheMap(), 'Shift+Tab from a half left the map').toBe(false);
    await map.getByRole('button', { name: `${GOLD_3}, left half, Nettle Knits` }).focus();
    await page.keyboard.press('Tab');
    expect(await inTheMap(), 'Tab from a half left the map').toBe(false);
  });

  test('switches to Lower Hall, its stage turned', async ({ page }) => {
    const { press } = inTheWindow(size);
    const door = page.getByTestId('library-day-map-door');
    const switches = door.getByTestId('day-map-locations');
    await expect(switches.getByRole('button', { name: 'Upper Hall' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await press(switches.getByRole('button', { name: 'Lower Hall' }));
    await expect(readOutsOf(door).first()).toHaveText('Location: Lower Hall');
    await expect(door.getByTestId('layout-map')).toHaveAccessibleName(
      'Lower Hall layout, 14 tables',
    );
    await expect(door.getByTestId('layout-map-zone')).toHaveAttribute(
      'transform',
      'rotate(30 10000 9500)',
    );
    await press(door.getByRole('button', { name: 'Food lane 2, Standard 6 ft, no vendor' }));
    await expect(readOutsOf(door).nth(1)).toHaveText(
      'Pressed: Food lane 2, Standard 6 ft, no vendor',
    );
  });

  test("a search's mark outlines the one half it found", async ({ page }) => {
    const marked = page.getByTestId('library-day-map-marked');
    const marks = marked.getByTestId('layout-map-read');
    await expect(marks).toHaveCount(1);
    await expect(marks.locator('path')).toHaveCount(1);
    await expect(readOutsOf(marked)).toHaveText(`Marked: ${GOLD_3}, right half, Kelp Candles`);
  });

  test('zooms by its buttons, and back to the whole', async ({ page }) => {
    const { press } = inTheWindow(size);
    const publicDay = page.getByTestId('library-day-map-public');
    const map = publicDay.getByTestId('layout-map');
    await expect(publicDay.getByTestId('day-map-legend-item')).toHaveText(['Taken', 'Free']);
    const whole = await viewWidth(map);
    // On the map's bottom-right corner where the box is wide, under it where it is a phone's.
    const frame = (await map.boundingBox())!;
    const zoom = (await publicDay.getByTestId('day-map-zoom').boundingBox())!;
    if (size.phone) expect(zoom.y).toBeGreaterThanOrEqual(frame.y + frame.height);
    else {
      expect(zoom.y + zoom.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(zoom.x + zoom.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(zoom.x + zoom.width).toBeGreaterThan(frame.x + frame.width - 40);
    }
    await press(publicDay.getByRole('button', { name: 'Zoom in' }));
    await expect(map).toHaveAttribute('data-zoomed', '');
    expect(await viewWidth(map)).toBeLessThan(whole);
    await press(publicDay.getByRole('button', { name: 'Zoom out' }));
    await expect(map).not.toHaveAttribute('data-zoomed');
    expect(await viewWidth(map)).toBeCloseTo(whole, 0);
    await press(publicDay.getByRole('button', { name: 'Zoom in' }));
    await press(publicDay.getByRole('button', { name: 'Fit' }));
    await expect(map).not.toHaveAttribute('data-zoomed');
  });

  test('at a desk, Ctrl and the wheel zoom, a drag pans, and a plain wheel scrolls the page', async ({
    page,
  }) => {
    test.skip(size.phone, 'a desk has the wheel');
    const publicDay = page.getByTestId('library-day-map-public');
    const map = publicDay.getByTestId('layout-map');
    await map.scrollIntoViewIfNeeded();
    const box = (await map.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const scrolled = () => page.evaluate(() => window.scrollY);

    const before = await scrolled();
    await page.mouse.wheel(0, 200);
    await expect.poll(scrolled).toBeGreaterThan(before);
    await expect(map).not.toHaveAttribute('data-zoomed');

    await map.scrollIntoViewIfNeeded();
    const at = (await map.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    const still = await scrolled();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(map).toHaveAttribute('data-zoomed', '');
    expect(await scrolled()).toBe(still);

    const x = () => map.evaluate((svg) => Number(svg.getAttribute('viewBox')!.split(' ')[0]));
    const from = await x();
    await page.mouse.down();
    await page.mouse.move(at.x + at.width / 2 - 80, at.y + at.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await x()).toBeGreaterThan(from);
    await expect(readOutsOf(publicDay)).toHaveText('Pressed: nothing');
  });

  test("at a phone's width the map fits its box and a half is tapped", async ({ page }) => {
    const { press } = inTheWindow(size);
    const phone = page.getByTestId('library-day-map-phone');
    const box = (await phone.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    const frame = (await phone.getByTestId('layout-map').boundingBox())!;
    expect(frame.width).toBeLessThanOrEqual(box.width);
    // In a box this narrow the zoom stands under the map, covering none of it.
    const zoom = (await phone.getByTestId('day-map-zoom').boundingBox())!;
    expect(zoom.y).toBeGreaterThanOrEqual(frame.y + frame.height);
    await press(phone.getByRole('button', { name: `${GOLD_3}, left half, Nettle Knits` }));
    await expect(readOutsOf(phone)).toHaveText(`Pressed: ${GOLD_3}, left half, Nettle Knits`);
  });

  test('filling its box, the legend and the zoom stand over the corners, or under a narrow map', async ({
    page,
  }) => {
    const { press } = inTheWindow(size);
    for (const testid of ['library-day-map-fills', 'library-day-map-fills-phone']) {
      const panel = page.getByTestId(testid);
      await panel.scrollIntoViewIfNeeded();
      // The caller draws the choice of hall and the legend: the map draws neither.
      await expect(panel.getByTestId('day-map-locations')).toHaveCount(0);
      await expect(panel.getByTestId('day-map-legend')).toHaveCount(0);
      const legend = panel.getByRole('list', { name: 'Legend' });
      await expect(legend.getByRole('listitem')).toHaveText(['Gold row', 'Free table']);

      const box = (await panel.getByTestId('day-map').boundingBox())!;
      const map = (await panel.getByTestId('layout-map').boundingBox())!;
      const key = (await legend.boundingBox())!;
      const zoom = (await panel.getByTestId('day-map-zoom').boundingBox())!;
      const inset = 12;
      if (box.width >= 480) {
        // The map takes the box whole, the legend and the zoom over its bottom corners.
        expect(map.height, testid).toBeCloseTo(box.height, 0);
        expect(map.width, testid).toBeCloseTo(box.width, 0);
        expect(key.x - map.x, testid).toBeCloseTo(inset, 0);
        expect(map.y + map.height - (key.y + key.height), testid).toBeCloseTo(inset, 0);
        expect(map.x + map.width - (zoom.x + zoom.width), testid).toBeCloseTo(inset, 0);
        expect(map.y + map.height - (zoom.y + zoom.height), testid).toBeCloseTo(inset, 0);
        expect(key.x + key.width, testid).toBeLessThan(zoom.x);
      } else {
        // The map takes the box less one row under it, the legend at its start, the zoom at its end.
        expect(map.width, testid).toBeCloseTo(box.width, 0);
        expect(key.y, testid).toBeGreaterThanOrEqual(map.y + map.height);
        expect(zoom.y, testid).toBeGreaterThanOrEqual(map.y + map.height);
        expect(key.x - box.x, testid).toBeCloseTo(inset, 0);
        expect(box.x + box.width - (zoom.x + zoom.width), testid).toBeCloseTo(inset, 0);
        expect(zoom.x - (key.x + key.width), testid).toBeGreaterThanOrEqual(8 - 0.5);
        const bottom = Math.max(key.y + key.height, zoom.y + zoom.height);
        expect(box.y + box.height - bottom, testid).toBeGreaterThanOrEqual(inset - 0.5);
      }

      await press(panel.getByRole('button', { name: `${GOLD_3}, left half, Nettle Knits` }));
      await expect(readOutsOf(panel)).toHaveText(`Pressed: ${GOLD_3}, left half, Nettle Knits`);
    }
  });
});
