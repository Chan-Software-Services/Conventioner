import type { Locator, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, LoginPage } from './fixtures';
import { ensureTestOrgAuthenticated, loginViaApi } from './helpers/seeds';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { ManageMarketPage } from './pages/ManageMarketPage';

/**
 * The page behind a dialog holds still (T473).
 *
 * A dialog holds the page behind it `inert`, and `inert` takes no scroll: the scrim is a fixed box
 * with nothing of its own to scroll, so a wheel or a thumb's drag over it scrolled the page behind,
 * which stayed out of play but moved. The page now holds still while any dialog is open, a second
 * dialog over the first included, and is where it was, and scrolls again, once the last has closed;
 * a dialog's own body still scrolls.
 *
 * Manage market, over the Markets page, is the dialog, and its Permissions the one over it. A user
 * of its own with twelve markets, so the Markets page is taller than the window at a desk too, and
 * shows them all with no search.
 */

const RUN = Date.now();
const USER = { email: `e2e-holds-still-${RUN}@example.com`, password: 'HoldsStill123!' };
const MARKETS = 12;

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

/** Where the page stands, and how far it could go. */
const pageScroll = (page: Page) =>
  page.evaluate(() => ({
    y: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
  }));

/**
 * A point on the scrim the person would put a pointer or a thumb on: the middle of the band above
 * the window, which every dialog here leaves, 24px on a phone. Checked to be the scrim, so a wheel
 * there is never a wheel over the dialog.
 */
async function overTheScrim(page: Page, testid: string): Promise<{ x: number; y: number }> {
  const window = (await page.getByTestId(`${testid}-window`).boundingBox())!;
  expect(window.y, 'a band of scrim above the window').toBeGreaterThanOrEqual(16);
  const point = { x: window.x + window.width / 2, y: window.y / 2 };
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
    point,
  );
  expect(hit, 'the point is on the scrim').toBe(`${testid}-background`);
  return point;
}

/** The drag a thumb makes, by the default gesture source, which moves a page where touch did not. */
async function drag(page: Page, from: { x: number; y: number }, yDistance: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', { ...from, yDistance, speed: 2000 });
  await cdp.detach();
}

/**
 * A wheel and a drag each way over the dialog's scrim, and the page still where it stood. The wheel
 * is sent and then a frame is waited on, since a page that moves does so before the next frame.
 */
async function expectTheScrimMovesNothing(page: Page, testid: string, at: number): Promise<void> {
  const point = await overTheScrim(page, testid);
  await page.mouse.move(point.x, point.y);
  for (const [how, move] of [
    ['a wheel down', () => page.mouse.wheel(0, 400)],
    ['a wheel up', () => page.mouse.wheel(0, -400)],
    ['a drag down the page', () => drag(page, point, -300)],
    ['a drag up the page', () => drag(page, point, 300)],
  ] as const) {
    await move();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
    expect((await pageScroll(page)).y, `${how} over the ${testid} scrim`).toBe(at);
  }
}

/** A wheel over the dialog's body scrolls that body, and the page behind stays where it stood. */
async function expectTheBodyScrolls(body: Locator, page: Page, at: number): Promise<void> {
  expect(
    await body.evaluate((el) => el.scrollHeight - el.clientHeight),
    'the body has more than it shows',
  ).toBeGreaterThan(40);
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop), 'the body scrolls')
    .toBeGreaterThan(0);
  expect((await pageScroll(page)).y, 'the page behind the body').toBe(at);
}

test.describe('The page behind a dialog holds still', () => {
  test.beforeAll(async ({ request }) => {
    ensureVerifiedUser(USER.email, USER.password);
    await loginViaApi(request, BACKEND_URL, USER.email, USER.password);
    const organizationId = await ensureTestOrgAuthenticated(request, BACKEND_URL);
    for (let n = 1; n <= MARKETS; n++) {
      await seedDraftMarket(request, BACKEND_URL, USER.email, USER.password, {
        name: `Holds Still ${n} ${RUN}`,
        organizationId,
      });
    }
  });

  for (const [width, viewport] of [
    ['on a phone', PHONE],
    ['at a desk', DESK],
  ] as const) {
    test.describe(width, () => {
      test.use({ viewport });

      test('Manage market, and Permissions over it, hold the page where it was', async ({
        page,
      }) => {
        const login = new LoginPage(page);
        await login.login(USER.email, USER.password);
        await login.waitForMarkets();
        const manageButtons = page.getByTestId('market-card-manage-button');
        await expect(manageButtons).toHaveCount(MARKETS);

        // The page partway down, room to move either way, and a card's Manage in view there, so
        // opening it scrolls nothing.
        const { max } = await pageScroll(page);
        expect(max, 'the page is taller than the window').toBeGreaterThan(200);
        const start = Math.round(max / 2);
        await page.evaluate((y) => window.scrollTo(0, y), start);
        await expect.poll(async () => (await pageScroll(page)).y).toBe(start);
        const inView = await manageButtons.evaluateAll((buttons) =>
          buttons.findIndex((button) => {
            const box = button.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
          }),
        );
        expect(inView, 'a Manage in view').toBeGreaterThanOrEqual(0);
        // A card's Manage button's box, so a page that moved sideways as its scroll was held
        // shows: the gutter `base.css` keeps for the bar is there whether or not the page may
        // scroll.
        const cardManage = manageButtons.nth(inView);
        const cardManageAt = await cardManage.boundingBox();
        await cardManage.click();
        const manage = new ManageMarketPage(page);
        await manage.waitForOverlay();
        expect((await pageScroll(page)).y, 'opening scrolled nothing').toBe(start);
        expect(await cardManage.boundingBox(), 'the Manage behind, where it was').toEqual(
          cardManageAt,
        );

        await expectTheScrimMovesNothing(page, 'manage-market', start);
        await expectTheBodyScrolls(page.getByTestId('manage-market-body'), page, start);

        await manage.showPermissions();
        await expectTheScrimMovesNothing(page, 'manage-market-permissions', start);
        await expectTheBodyScrolls(page.getByTestId('manage-market-permissions-body'), page, start);

        // Permissions closes first, and Manage market beneath still holds the page.
        await page.keyboard.press('Escape');
        await expect(manage.permissionsWindow).toHaveCount(0);
        await expectTheScrimMovesNothing(page, 'manage-market', start);

        // The last one closes: the page is where it was, and scrolls again.
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('manage-market-window')).toHaveCount(0);
        expect((await pageScroll(page)).y, 'the page where it was').toBe(start);
        expect(await cardManage.boundingBox(), 'the Manage, where it was').toEqual(cardManageAt);
        await page.mouse.wheel(0, 400);
        await expect
          .poll(async () => (await pageScroll(page)).y, 'the page scrolls again')
          .toBeGreaterThan(start);
      });
    });
  }
});
