import type { Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The public map's backdrop (T465 ticket 04), opened signed out on the seam's seeded market: a
 * fixed, blurred layer under the sheet that reaches every edge of the window, painted in light
 * mixes of the market's own section colours, as each hall's legend shows them, and taking no press.
 * How the colours are dealt to its shapes is proved in `publicMapBackdrop.test.ts`.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

/** The computed colours of the open hall's section swatches, `{ fill, edge }`. */
async function hallSections(map: PublicMapPage) {
  await expect(map.sectionLegendItems.first()).toBeVisible();
  return map.sectionLegendItems.evaluateAll((items) =>
    items
      .filter((item) => item.getAttribute('data-kind') === 'section')
      .map((item) => {
        const swatch = getComputedStyle(item.querySelector('rect')!);
        return { fill: swatch.fill, edge: swatch.stroke };
      }),
  );
}

/** Each section's light mix, as the browser computes `fill` from it. */
function mixesOf(page: Page, sections: { fill: string; edge: string }[]) {
  return page.evaluate((sections) => {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.append(probe);
    document.body.append(svg);
    const mixes = sections.map(({ fill, edge }) => {
      probe.style.fill = `color-mix(in oklch, ${edge} 12%, ${fill})`;
      return getComputedStyle(probe).fill;
    });
    svg.remove();
    return [...new Set(mixes)];
  }, sections);
}

const WINDOWS = [
  ...PHONE_AND_DESK,
  { name: 'at a wide desk', phone: false, use: { viewport: { width: 1990, height: 1309 } } },
] as const;

for (const size of WINDOWS) {
  test.describe(`the public map's backdrop ${size.name}`, () => {
    test.use(size.use);

    test("covers the window in the sections' colours, and takes no press", async ({ page }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
      const { width, height } = size.use.viewport;

      // The layer's box reaches past every edge of the window, so its blur never fades at one.
      const box = (await map.backdrop.boundingBox())!;
      expect(box.x).toBeLessThanOrEqual(0);
      expect(box.y).toBeLessThanOrEqual(0);
      expect(box.x + box.width).toBeGreaterThanOrEqual(width);
      expect(box.y + box.height).toBeGreaterThanOrEqual(height);
      const layer = await map.backdrop.evaluate((svg) => {
        const style = getComputedStyle(svg);
        return { position: style.position, filter: style.filter, events: style.pointerEvents };
      });
      expect(layer).toEqual({ position: 'fixed', filter: 'blur(80px)', events: 'none' });

      // Its shapes are painted in the light mixes of the sections of every hall, and no other.
      const sections = await hallSections(map);
      const options = await map.locationSelect
        .locator('option')
        .evaluateAll((all) => all.map((option) => (option as HTMLOptionElement).value));
      expect(options.length, 'the seed draws two halls').toBe(2);
      await map.locationSelect.selectOption(options[1]!);
      await expect(map.locationSelect).toHaveValue(options[1]!);
      sections.push(...(await hallSections(map)));
      const mixes = await mixesOf(page, sections);
      const painted = await map.backdrop
        .locator('path')
        .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).fill));
      expect(painted).toHaveLength(4);
      expect(new Set(painted)).toEqual(new Set(mixes));
      const paper = await map.backdrop
        .locator('rect')
        .evaluate((rect) => getComputedStyle(rect).fill);
      expect(paper).toBe('rgb(251, 250, 248)');

      // A press at a bottom corner of the window, outside the sheet, reaches no backdrop element.
      const sheet = [(await map.dayMap.boundingBox())!, (await map.vendorsPanel.boundingBox())!];
      for (const x of [2, width - 2]) {
        const y = height - 2;
        for (const part of sheet) {
          const inside =
            x >= part.x && x <= part.x + part.width && y >= part.y && y <= part.y + part.height;
          expect(inside, 'the corner is outside the sheet').toBe(false);
        }
        expect(
          await page.evaluate(
            ({ x, y }) => {
              const at = document.elementFromPoint(x, y);
              return at !== null && Boolean(at.closest('[data-testid="public-map-backdrop"]'));
            },
            { x, y },
          ),
          'the topmost element at the corner is no backdrop element',
        ).toBe(false);
        // A real press there: the element it lands on is outside the backdrop.
        await page.evaluate(() => {
          const pressed: string[] = [];
          (window as unknown as { pressed: string[] }).pressed = pressed;
          document.addEventListener(
            'pointerdown',
            (event) =>
              pressed.push(
                (event.target as Element).closest('[data-testid="public-map-backdrop"]')
                  ? 'backdrop'
                  : 'elsewhere',
              ),
            { capture: true, once: true },
          );
        });
        if (size.phone) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await expect
          .poll(() => page.evaluate(() => (window as unknown as { pressed: string[] }).pressed))
          .toEqual(['elsewhere']);
      }
    });
  });
}
