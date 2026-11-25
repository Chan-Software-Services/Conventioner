import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap } from './helpers/seedMarketDayMap';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { calendarToday } from './helpers/vendorSignIn';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';

/**
 * The door's tools hold still (T466, release walk F5).
 *
 * Attendance's dates, List and Map, Print roster, Door code and Refresh, and under them the count,
 * the list's Show buttons and the search, scrolled away with the roster as the organizer read down
 * it. From 1024px they are one block pinned under the market's frame from the start, so it never
 * moves as the list or the map scrolls, a failed refresh's line shown or not; on a phone the block
 * scrolls with the page, as the frame's rail does, every target a thumb's 44px and nothing past the
 * screen's edge.
 */

const TODAY = calendarToday();
const SCROLLS = [0, 5, 40, 200, 900];
const DESKS = [1100, 1440, 1990];
/** The roster's own read, not a write to it. */
const THE_ROSTER = /\/markets\/[^/]+\/attendance$/;

/** A market on its day, today, with 30 vendors seated: a list long enough to scroll 900px at a
 *  1990px desk, 900 tall. */
async function aLongDoor(request: APIRequestContext): Promise<string> {
  const at = Date.now();
  const { marketId } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    {
      marketDate: TODAY,
      intakeMode: 'form',
      vendors: Array.from({ length: 30 }, (_, n) => `door-held-${at}-${n}@example.com`),
      namePrefix: 'E2E Door Held Still',
    },
  );
  return marketId;
}

/**
 * In px from the window's top, unrounded, so a fraction of a pixel shows: the frame's bottom, the
 * pinned block's top, and the scroll.
 */
function parts(page: Page) {
  return page.evaluate(() => {
    const edge = (testid: string, side: 'top' | 'bottom') =>
      document.querySelector(`[data-testid="${testid}"]`)!.getBoundingClientRect()[side];
    return {
      frame: edge('market-frame', 'bottom'),
      tools: edge('attendance-tools', 'top'),
      scrolled: Math.round(window.scrollY),
    };
  });
}

/** Two edges less than half a hundredth of a pixel apart stand at the same place. */
const AT = 2;

/** How far the page can scroll down. */
const furthest = (page: Page) =>
  page.evaluate(() =>
    Math.floor(document.documentElement.scrollHeight - document.documentElement.clientHeight),
  );

async function scrollTo(page: Page, y: number) {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), `${y}px`).toBe(y);
}

/**
 * At every scroll the block's top is the frame's bottom and where it stood at rest: pinned from the
 * start, never moving, not by a fraction of a pixel. A page shorter than a scroll is scrolled as far
 * as it goes.
 */
async function expectHeldStill(page: Page, at: string) {
  const most = await furthest(page);
  await scrollTo(page, 0);
  const rest = await parts(page);
  for (const y of SCROLLS.map((y) => Math.min(y, most))) {
    await scrollTo(page, y);
    const now = await parts(page);
    expect(now.tools, `${at}, ${y}px: the tools stand under the frame`).toBeCloseTo(now.frame, AT);
    expect(now.tools, `${at}, ${y}px: the tools stand where they did at rest`).toBeCloseTo(
      rest.tools,
      AT,
    );
  }
  await scrollTo(page, 0);
}

test('the list: the toolbar and the count row never move at a desk, a failed refresh shown or not', async ({
  authenticatedPage: page,
  request,
}) => {
  test.slow();
  const marketId = await aLongDoor(request);
  const door = new AttendanceStatusPage(page);
  for (const width of DESKS) {
    const at = `the list at ${width}`;
    await page.setViewportSize({ width, height: 900 });
    await door.goto(marketId);
    await expect(door.rows).toHaveCount(30, { timeout: 15000 });
    expect(await furthest(page), `${at} scrolls 900px`).toBeGreaterThanOrEqual(900);
    await expectHeldStill(page, at);

    // A refresh that cannot reach the server says so under Refresh, inside the block, which grows,
    // and Print roster and Door code stay on Refresh's line.
    await page.route(THE_ROSTER, (route) =>
      route.request().method() === 'GET' ? route.abort() : route.continue(),
    );
    await door.refresh.click();
    await expect(door.refreshError).toBeVisible();
    await expect(door.tools.getByTestId('attendance-refresh-error')).toBeVisible();
    const line = async (testid: string) =>
      Math.round((await page.getByTestId(testid).boundingBox())!.y);
    expect(await line('attendance-print'), at).toBe(await line('attendance-refresh'));
    expect(await line('attendance-door-code'), at).toBe(await line('attendance-refresh'));
    const error = (await door.refreshError.boundingBox())!;
    const refresh = (await door.refresh.boundingBox())!;
    expect(error.y, `${at}: the line stands under Refresh`).toBeGreaterThan(refresh.y);
    expect(Math.round(error.x + error.width), `${at}: right-aligned with Refresh`).toBe(
      Math.round(refresh.x + refresh.width),
    );
    await expectHeldStill(page, `${at}, a refresh failed`);
    await page.unroute(THE_ROSTER);
  }
});

/**
 * The map stands whole in a desk's window 900 tall (T422 ticket 11), so the page does not scroll
 * there; 600 tall, where the map keeps its 20rem floor, it does.
 */
test('the map: the toolbar and the count row never move at a desk', async ({
  authenticatedPage: page,
  request,
}) => {
  const seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const door = new AttendanceStatusPage(page);
  for (const width of DESKS) {
    const at = `the map at ${width}`;
    await page.setViewportSize({ width, height: 600 });
    await door.goto(seeded.marketId);
    await door.viewMap.click();
    await expect(door.map).toBeVisible();
    await expect(door.locationSelect).toHaveValue(seeded.north.id);
    expect(await furthest(page), `${at} scrolls`).toBeGreaterThanOrEqual(40);
    await expectHeldStill(page, at);
  }
});

test('at a desk each row is 12px over and under its tallest item, every control 28px', async ({
  authenticatedPage: page,
  request,
}) => {
  const marketId = await aLongDoor(request);
  const door = new AttendanceStatusPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await door.goto(marketId);
  await expect(door.rows).toHaveCount(30, { timeout: 15000 });
  for (const row of [door.toolbar, door.bar]) {
    const measured = await row.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const items = [...el.querySelectorAll('select, button, input, h2')].map((one) =>
        one.getBoundingClientRect(),
      );
      return {
        over: Math.min(...items.map((one) => one.top)) - box.top,
        under: box.bottom - 1 - Math.max(...items.map((one) => one.bottom)),
        heights: [...el.querySelectorAll('select, button, input')].map((one) =>
          Math.round(one.getBoundingClientRect().height),
        ),
      };
    });
    expect(Math.round(measured.over)).toBe(12);
    expect(Math.round(measured.under)).toBe(12);
    expect(new Set(measured.heights)).toEqual(new Set([28]));
  }
});

test.describe('on a phone', () => {
  test.use(PHONE_AND_DESK[0].use);
  const { expectFits } = inTheWindow(PHONE_AND_DESK[0]);

  test('the tools scroll with the page, every target 44px, nothing past the edge', async ({
    authenticatedPage: page,
    request,
  }) => {
    const marketId = await aLongDoor(request);
    const door = new AttendanceStatusPage(page);
    await door.goto(marketId);
    await expect(door.rows).toHaveCount(30, { timeout: 15000 });
    await expectFits(page, 'the door on a phone');

    const controls = door.tools.locator('select, button, input');
    expect(await controls.count()).toBeGreaterThan(0);
    for (const box of await controls.evaluateAll((all) =>
      all.map((el) => {
        const { left, right, height } = el.getBoundingClientRect();
        return { id: el.getAttribute('data-testid'), left, right, height };
      }),
    )) {
      expect(Math.round(box.height), `${box.id} is a thumb's target`).toBeGreaterThanOrEqual(44);
      expect(box.left, `${box.id} starts inside the screen`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${box.id} ends inside the screen`).toBeLessThanOrEqual(390);
    }

    const rest = await parts(page);
    for (const y of SCROLLS) {
      await scrollTo(page, y);
      const now = await parts(page);
      expect(now.tools, `${y}px: the tools went with the page`).toBeCloseTo(rest.tools - y, AT);
    }
  });
});
