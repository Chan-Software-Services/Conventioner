import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { marketScreenPath } from './helpers/marketScreens';
import { PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedDraftMarket } from './helpers/seedDraftMarket';

/**
 * A draft market at 390x844, and at a desk, where nothing moves.
 *
 * Its Attendance is the tab's note in place of the page ("Opens when the market is published."),
 * which kept the desk's 24px inset on a phone: its words stood at x 40 while the rail, the read-only
 * note and the failed re-read line stood on the phone's gutter at x 32.
 *
 * Its Stats shows the rail with the first step, Draft, the current one: its ring, an outline 4px
 * outside the dot, was cut at the spine's left edge, since on a phone the spine scrolls sideways
 * and so clips what is drawn past it.
 */

/** Where the first character of a text is drawn, rather than the box it stands in. */
const textLeft = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects()[0].left;
  });

/**
 * The current step's ring, the dot's box grown by its outline, and the box of each ancestor up to
 * the rail that clips what it draws: the ring is whole when it lies inside each of them.
 */
const ringAndClips = (page: Page) =>
  page.getByTestId('phase-rail-current').evaluate((step) => {
    const dot = step.querySelector('.phase-step-dot')!;
    const style = getComputedStyle(dot);
    const grow = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const d = dot.getBoundingClientRect();
    const ring = {
      left: d.left - grow,
      right: d.right + grow,
      top: d.top - grow,
      bottom: d.bottom + grow,
    };
    const clips = [];
    for (let el = step.parentElement; el && !el.matches('.phase-rail'); el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = el.getBoundingClientRect();
      clips.push({
        what: el.className,
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
      });
    }
    return { ring, dotLeft: d.left, clips };
  });

let marketId: string;

test.beforeAll(async ({ request }) => {
  ({ marketId } = await seedDraftMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password));
});

for (const size of PHONE_AND_DESK) {
  test.describe(`A draft market, ${size.name}`, () => {
    test.use(size.use);

    test("Attendance's note stands on the rail's line", async ({ authenticatedPage: page }) => {
      await page.goto(marketScreenPath(marketId, 'attendance'));
      const note = page.getByTestId('market-tab-note');
      await expect(note).toHaveText('Opens when the market is published.', { timeout: 15000 });

      // The rail's line is where its first step's dot stands.
      const rail = (await page.locator('.phase-step-dot').first().boundingBox())!;
      expect(await textLeft(note), "the note's words start where the rail's do").toBe(rail.x);
      // On a phone the phone's gutter, 16px inside the card's own 16px; at a desk the desk's 24px.
      expect(rail.x).toBe(size.phone ? 32 : 40);
    });

    test("Stats draws the Draft step's ring whole", async ({ authenticatedPage: page }) => {
      await page.goto(marketScreenPath(marketId, 'stats'));
      await expect(page.getByTestId('phase-rail-current')).toHaveAttribute('data-phase', 'draft', {
        timeout: 15000,
      });

      const { ring, dotLeft, clips } = await ringAndClips(page);
      for (const clip of clips) {
        expect(ring.left, `the ring inside ${clip.what} at its left`).toBeGreaterThanOrEqual(
          clip.left,
        );
        expect(ring.right, `at its right`).toBeLessThanOrEqual(clip.right);
        expect(ring.top, `at its top`).toBeGreaterThanOrEqual(clip.top);
        expect(ring.bottom, `at its bottom`).toBeLessThanOrEqual(clip.bottom);
      }
      // The dot itself keeps its place on the rail's line.
      expect(dotLeft).toBe(size.phone ? 32 : 40);
    });
  });
}
