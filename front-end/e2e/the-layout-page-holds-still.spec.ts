import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { LayoutPage } from './pages/LayoutPage';
import { seedLayout, type SeedTable } from './helpers/seeds';

/**
 * The layout page's frame holds still (T422, the QC walk of 2026-11-16, items 7, 10, 13 and 14):
 * the map stands at the same place and size whichever tool is on, since each tool's options are a
 * card in the panel; the hint under the map stays on a laptop's screen under the head's bar; the
 * shortcuts stand beside the page where the window has room, else over the map's corner, never
 * over the toolbar or the panel; and a section's colours open in a bubble that leaves the
 * Sections card its height. Every press is the pointer's or the keyboard's own.
 */

const TABLES: SeedTable[] = [
  { section: 'sec-gold', at: [4000, 4000] },
  { section: 'sec-silver', at: [10_000, 11_000] },
];

async function open(page: Page, request: import('@playwright/test').APIRequestContext) {
  const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    metresAcross: 30,
    tables: TABLES,
  });
  const layout = new LayoutPage(page);
  await layout.goto(seeded.marketId, seeded.upper.id);
  await expect(layout.tables).toHaveCount(TABLES.length);
  return layout;
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Whether two boxes share any area. */
const overlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  test.describe(`The layout page at ${size.width} x ${size.height}`, () => {
    test.use({ viewport: size });

    test("the map stands at the same top and height with each tool on, its options in the panel's card", async ({
      authenticatedPage: page,
      request,
    }) => {
      const layout = await open(page, request);
      const at = await box(layout.stage);
      const toolbar = await box(layout.toolbar);
      expect(toolbar.height).toBeLessThan(48);

      for (const [key, name] of [
        ['t', 'Add table'],
        ['w', 'Row of tables'],
        ['a', 'Fill an area'],
        ['z', 'No-table zone'],
        ['v', 'Select'],
      ]) {
        await page.keyboard.press(key);
        await expect(layout.toolbar.getByRole('button', { name, exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        const now = await box(layout.stage);
        expect(now.y, name).toBeCloseTo(at.y, 0);
        expect(now.height, name).toBeCloseTo(at.height, 0);
        // The toolbar stays one line.
        expect((await box(layout.toolbar)).height, name).toBeCloseTo(toolbar.height, 0);
      }

      // Row of tables' card, its Gap refused and its error said: still the map holds still.
      await page.keyboard.press('w');
      await expect(layout.toolCard).toBeVisible();
      await layout.rowRows.fill('2');
      await layout.rowGap.fill('-5');
      await expect(page.getByTestId('layout-row-gap-error')).toBeVisible();
      const said = await box(layout.stage);
      expect(said.y).toBeCloseTo(at.y, 0);
      expect(said.height).toBeCloseTo(at.height, 0);
      // The card stands in the panel, beside the map, never above it.
      expect((await box(layout.toolCard)).x).toBeGreaterThan(at.x + at.width);
      await layout.rowGap.fill('0');
      await layout.rowRows.fill('1');
    });

    test('the head is a bar across the page, and the hint under the map is on the screen', async ({
      authenticatedPage: page,
      request,
    }) => {
      const layout = await open(page, request);
      const head = page.locator('.layout-head');
      const pageBox = await box(layout.root);
      const headBox = await box(head);
      expect(headBox.x).toBeCloseTo(pageBox.x, 0);
      expect(headBox.width).toBeCloseTo(pageBox.width, 0);
      await expect(head).toHaveCSS('border-bottom-width', '1px');
      // Under the bar: the toolbar, the map and the hint, whole on the screen at the top of the page.
      expect((await box(layout.toolbar)).y).toBeGreaterThan(headBox.y + headBox.height);
      const hint = await box(layout.hint);
      expect(hint.y + hint.height).toBeLessThanOrEqual(size.height);
      // The stage's height is counted so the whole page fits the window: nothing scrolls.
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
      ).toBeLessThanOrEqual(0);
    });

    test("a section's colours open in a bubble, the card keeping its height, closed by a press outside", async ({
      authenticatedPage: page,
      request,
    }) => {
      const layout = await open(page, request);
      const card = layout.sections;
      const before = await box(card);

      const swatch = layout.sectionColour('Gold row');
      await swatch.click();
      const palette = page.getByTestId('layout-panel-palette');
      await expect(palette).toBeVisible();
      await expect(layout.paletteColour('Gold')).toBeFocused();
      const opened = await box(card);
      expect(opened.height).toBeCloseTo(before.height, 0);
      // Under its swatch, over what is under it.
      const swatchBox = await box(swatch);
      expect((await box(palette)).y).toBeGreaterThan(swatchBox.y + swatchBox.height - 1);

      // A press on the card's title, which takes no focus, closes it, the focus on the swatch.
      await page.getByRole('heading', { name: 'Sections in Upper Hall' }).click();
      await expect(palette).toHaveCount(0);
      await expect(swatch).toBeFocused();

      // Escape closes it, and the tool stays as it was.
      await page.keyboard.press('Enter');
      await expect(palette).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
      await expect(swatch).toBeFocused();
      await expect(layout.toolSelect).toHaveAttribute('aria-pressed', 'true');
    });
  });
}

test.describe("A section's colours near the window's foot", () => {
  test('hang above the swatch, on the screen', async ({ authenticatedPage: page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const layout = await open(page, request);
    const swatch = layout.sectionColour('Silver aisle');
    // A window whose foot is 40px under the swatch, the page at its top: under it, the bubble
    // would run past the foot.
    const at = await box(swatch);
    await page.setViewportSize({ width: 1440, height: Math.round(at.y + at.height + 40) });
    await expect.poll(async () => (await box(swatch)).y).toBeCloseTo(at.y, 0);

    await swatch.click();
    const palette = page.getByTestId('layout-panel-palette');
    await expect(palette).toBeVisible();
    const bubble = await box(palette);
    const swatchBox = await box(swatch);
    expect(bubble.y + bubble.height).toBeLessThanOrEqual(swatchBox.y + 1);
    expect(bubble.y).toBeGreaterThanOrEqual(0);
    await expect(layout.paletteColour('Blue')).toBeFocused();
  });
});

test.describe('The keyboard shortcuts', () => {
  test('stand beside the market frame where the window has room, fixed as the page scrolls', async ({
    authenticatedPage: page,
    request,
  }) => {
    await page.setViewportSize({ width: 2560, height: 1200 });
    const layout = await open(page, request);
    await layout.showShortcuts();
    const frame = await box(page.getByTestId('market-frame').first());
    const panel = await box(layout.shortcuts);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(frame.x);
    await expect(layout.shortcuts).toHaveCSS('position', 'fixed');
  });

  test("stand over the map's corner where the window has no room beside the frame, clear of the toolbar and the panel", async ({
    authenticatedPage: page,
    request,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const layout = await open(page, request);
    await layout.showShortcuts();
    const panel = await box(layout.shortcuts);
    const stage = await box(layout.stage);
    expect(panel.x).toBeGreaterThanOrEqual(stage.x);
    expect(panel.y).toBeGreaterThanOrEqual(stage.y);
    expect(overlap(panel, await box(layout.toolbar))).toBe(false);
    expect(overlap(panel, await box(page.locator('aside.layout-panel')))).toBe(false);
    await expect(layout.shortcuts).toHaveCSS('position', 'absolute');
  });
});
