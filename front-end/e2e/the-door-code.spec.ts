import type { Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, APP_API } from './fixtures';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { LoginPage } from './pages/LoginPage';
import { vendorPagePath } from './helpers/marketScreens';
import { letVendorsCheckThemselvesIn } from './helpers/selfCheckIn';

/**
 * The door code on Attendance (ADR 0022): shown full screen on whatever stands at the entrance, or
 * printed as a one-page poster, and replaced on demand.
 *
 * An Editor, who may check vendors in, makes the code, reads it full screen with its QR code, makes
 * a new one behind a confirmation and sees it change; a Viewer is offered no Door code, and the
 * server refuses them the code itself.
 *
 * The screen holds the market's self check-in switch (T496), off until someone turns it on: while
 * it is off the screen shows no code and says why. The market every walk here shares has it on,
 * and one walk takes a market where nobody ever set it.
 */
const VIEWER = { email: 'e2e-door-code-viewer@example.com', password: 'e2epassword123' };
const EDITOR = { email: 'e2e-door-code-editor@example.com', password: 'e2epassword123' };
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{3} [23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{3}$/;
const OFF = "Vendors' own check-in and check-out are off. Turn them on to show the door code.";

const SIZES = [
  {
    name: 'on a phone',
    use: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    },
  },
  { name: 'on a laptop', use: { viewport: { width: 1280, height: 800 } } },
] as const;

let marketId: string;
let marketSlug: string;
let marketName: string;

async function signIn(page: Page, person: { email: string; password: string }, width: number) {
  const login = new LoginPage(page);
  await login.login(person.email, person.password);
  await login.waitForMarkets();
  expect(await page.evaluate(() => window.innerWidth)).toBe(width);
}

/** The code on screen, without its space, as the address carries it. */
async function shownCode(door: AttendanceStatusPage): Promise<string> {
  await expect(door.doorCodeValue).toHaveText(CODE);
  return (await door.doorCodeValue.innerText()).replace(' ', '');
}

/** The self check-in switch, and the sentence in the poster's place while it is off. */
const selfSwitch = (page: Page) => page.getByTestId('door-code-self-switch');
const offNote = (page: Page) => page.getByTestId('door-code-off');

/**
 * Nothing scrolls sideways or down, each of `controls` is in the window at a phone's 44px, and the
 * switch is a phone's target with its label and its help line whole in the window.
 */
async function expectTheFrameFits(page: Page, door: AttendanceStatusPage, phone: boolean) {
  const { innerWidth, innerHeight, scrollWidth, scrollHeight, clientHeight } =
    await door.doorCodeScroller.evaluate((el) => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(innerWidth);
  expect(scrollHeight, 'nothing scrolls down').toBeLessThanOrEqual(clientHeight);
  const label = page.locator('label[for="door-code-self-switch"]');
  expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(phone ? 44 : 24);
  for (const [part, name] of [
    [label, "the switch's label"],
    [page.locator('#door-code-self-help'), "the switch's help line"],
  ] as const) {
    const box = (await part.boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(innerWidth);
    expect(box.y + box.height, name).toBeLessThanOrEqual(innerHeight);
  }
  return { innerWidth, innerHeight };
}

/** Off: the frame fits, with Close alone among the controls and the sentence under the name. */
async function expectItFitsOff(page: Page, door: AttendanceStatusPage, phone: boolean) {
  const { innerWidth, innerHeight } = await expectTheFrameFits(page, door, phone);
  const close = (await door.doorCodeClose.boundingBox())!;
  expect(close.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
  const note = (await offNote(page).boundingBox())!;
  expect(note.x).toBeGreaterThanOrEqual(0);
  expect(note.x + note.width).toBeLessThanOrEqual(innerWidth);
  expect(note.y + note.height).toBeLessThanOrEqual(innerHeight);
  const market = (await door.doorCodeMarket.boundingBox())!;
  expect(note.y, 'the sentence stands under the name').toBeGreaterThanOrEqual(
    market.y + market.height,
  );
}

/** Nothing scrolls sideways, every control is a phone's 44px, and the QR code is a square in the
 *  window, as large as what is around it allows. */
async function expectItFits(page: Page, door: AttendanceStatusPage, phone: boolean) {
  const { innerWidth, innerHeight } = await expectTheFrameFits(page, door, phone);
  for (const control of [door.doorCodeClose, door.doorCodePrint, door.doorCodeNew]) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
    expect(box.x + box.width).toBeLessThanOrEqual(innerWidth);
  }
  // The switch stands between the controls and the poster, over neither.
  const self = (await page.locator('#door-code-self-help').boundingBox())!;
  const name = (await door.doorCodeMarket.boundingBox())!;
  expect(name.y, 'the poster starts below the switch').toBeGreaterThanOrEqual(self.y + self.height);
  const qr = (await door.doorCodeQr.boundingBox())!;
  expect(qr.x).toBeGreaterThanOrEqual(0);
  expect(qr.x + qr.width).toBeLessThanOrEqual(innerWidth);
  expect(qr.y + qr.height).toBeLessThanOrEqual(innerHeight);
  // The drawn square is the smaller side of its box; on a phone that is near the window's width.
  expect(Math.min(qr.width, qr.height)).toBeGreaterThanOrEqual(phone ? 300 : 360);
  // The instruction is one line, as is the code, and with who made it all is in the window: at 390
  // the instruction's last word once fell to a line of its own.
  for (const [line, name] of [
    [door.doorCodeInstruction, 'the instruction'],
    [door.doorCodeValue, 'the code'],
  ] as const) {
    const lines = await line.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(lines, `${name} is one line`).toBe(1);
  }
  const made = (await page.getByTestId('door-code-made').boundingBox())!;
  expect(made.y + made.height, 'everything is in the window').toBeLessThanOrEqual(innerHeight);
}

test.beforeAll(async ({ request }) => {
  ensureVerifiedUser(VIEWER.email, VIEWER.password);
  ensureVerifiedUser(EDITOR.email, EDITOR.password);
  ({ marketId, marketSlug } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  ));
  for (const [person, role] of [
    [VIEWER, 'viewer'],
    [EDITOR, 'editor'],
  ] as const) {
    const res = await request.post(`${BACKEND_URL}/markets/${marketId}/roles`, {
      data: { user_email: person.email, role },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const read = await request.get(`${BACKEND_URL}/markets/${marketId}`);
  marketName = (await read.json()).market.name;
  // Every walk of this market needs a code on screen, which only a market with the switch on shows.
  await letVendorsCheckThemselvesIn(request, marketId);
});

test('a market nobody set shows no code until its switch is turned on, and keeps the code while off', async ({
  page,
  request,
}) => {
  const never = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, TEST_USER, 1280);
  const door = new AttendanceStatusPage(page);
  await door.goto(never.marketId);
  await expect(door.rows.first()).toBeVisible({ timeout: 15000 });

  // Never set: off, with no code shown and none to make, print or replace.
  await door.doorCodeButton.click();
  await expect(selfSwitch(page)).toHaveRole('switch');
  await expect(selfSwitch(page)).toHaveAccessibleName('Vendors check themselves in and out');
  await expect(selfSwitch(page)).toHaveAccessibleDescription(
    'While this is off, only organizers check vendors in and out, on Attendance.',
  );
  await expect(selfSwitch(page)).not.toBeChecked();
  await expect(offNote(page)).toHaveText(OFF);
  for (const gone of [door.doorCodeQr, door.doorCodeMake, door.doorCodePrint, door.doorCodeNew]) {
    await expect(gone).toHaveCount(0);
  }

  // Turned on, by the keyboard, which keeps its place: the screen as it was, before a first code.
  await selfSwitch(page).focus();
  await page.keyboard.press('Space');
  await expect(door.doorCodeMake).toBeVisible();
  await expect(selfSwitch(page)).toBeChecked();
  await expect(selfSwitch(page)).toBeFocused();
  await expect(offNote(page)).toHaveCount(0);
  await door.doorCodeMake.click();
  const code = await shownCode(door);
  await expect(door.doorCode).toContainText("Scan with your phone's camera to check in or out");

  // Turned off: the code leaves the screen, and the market keeps it.
  await selfSwitch(page).uncheck();
  await expect(offNote(page)).toHaveText(OFF);
  for (const gone of [door.doorCodeQr, door.doorCodeValue, door.doorCodePrint, door.doorCodeNew]) {
    await expect(gone).toHaveCount(0);
  }
  // Closed and opened again, it is off as the server holds it.
  await door.doorCodeClose.click();
  await door.doorCodeButton.click();
  await expect(selfSwitch(page)).not.toBeChecked();
  await expect(offNote(page)).toHaveText(OFF);

  // On again: the same code, so every poster of it works again.
  await selfSwitch(page).check();
  expect(await shownCode(door)).toBe(code);
  await expect(door.doorCodePrint).toBeVisible();
});

test('an Editor makes the door code, reads it full screen and makes a new one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, EDITOR, 1280);
  const door = new AttendanceStatusPage(page);
  await door.goto(marketId);
  await expect(door.rows.first()).toBeVisible({ timeout: 15000 });

  await door.doorCodeButton.click();
  await expect(door.doorCode).toBeVisible();
  await expect(door.doorCodeMarket).toHaveText(marketName);
  await expect(door.doorCodeClose).toBeFocused();
  // No code yet: the screen offers to make one, and nothing to print or replace.
  await expect(door.doorCodeQr).toHaveCount(0);
  await expect(door.doorCodePrint).toHaveCount(0);
  await door.doorCodeMake.click();

  const first = await shownCode(door);
  await expect(door.doorCodeQr).toHaveAttribute(
    'data-url',
    new RegExp(`^https?://[^/]+${vendorPagePath(marketSlug)}\\?door=${first}$`),
  );
  await expect(door.doorCode).toContainText("Scan with your phone's camera to check in or out");
  await expect(page.getByTestId('door-code-made')).toContainText('by you');
  // The page behind is out of play, the app's frame and the roster with it.
  expect(
    await page.getByTestId('attendance-search').evaluate((el) => el.closest('[inert]') !== null),
  ).toBe(true);

  // New code asks first, on Cancel; cancelling keeps the code.
  await door.doorCodeNew.click();
  await expect(door.newCodeConfirm).toContainText('Make a new door code?');
  await expect(door.newCodeConfirm).toContainText(
    'The current code and every printed poster of it stop working.',
  );
  await expect(door.newCodeCancel).toBeFocused();
  await door.newCodeCancel.click();
  await expect(door.newCodeConfirm).toBeHidden();
  expect(await shownCode(door)).toBe(first);

  await door.doorCodeNew.click();
  await door.newCodeConfirmButton.click();
  await expect(door.newCodeConfirm).toBeHidden();
  await expect(door.doorCodeValue).not.toHaveText(`${first.slice(0, 3)} ${first.slice(3)}`);
  const second = await shownCode(door);
  expect(second).not.toBe(first);
  await expect(door.doorCodeQr).toHaveAttribute(
    'data-url',
    new RegExp(`${vendorPagePath(marketSlug)}\\?door=${second}$`),
  );

  // Closed and opened again, it is the new code the server holds.
  await door.doorCodeClose.click();
  await expect(door.doorCode).toHaveCount(0);
  await expect(door.doorCodeButton).toBeFocused();
  await door.doorCodeButton.click();
  expect(await shownCode(door)).toBe(second);
  // Escape closes it too.
  await page.keyboard.press('Escape');
  await expect(door.doorCode).toHaveCount(0);
});

test('the poster prints on one page, with nothing of the app on it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, EDITOR, 1280);
  const made = await page.request.post(`${APP_API}/markets/${marketId}/door-code`);
  expect(made.ok(), await made.text()).toBeTruthy();
  const door = new AttendanceStatusPage(page);
  await door.goto(marketId);
  await door.doorCodeButton.click();
  const code = await shownCode(door);

  await page.emulateMedia({ media: 'print' });
  await expect(door.doorCodeQr).toBeVisible();
  await expect(door.doorCodeMarket).toBeVisible();
  await expect(door.doorCodeValue).toBeVisible();
  for (const hidden of [
    door.doorCodeClose,
    door.doorCodePrint,
    door.doorCodeNew,
    selfSwitch(page),
    page.locator('#door-code-self-help'),
    page.getByTestId('attendance-search'),
    page.getByTestId('phase-rail-current'),
  ]) {
    await expect(hidden).toBeHidden();
  }

  // The poster's own size, not the window's: a QR code 14cm across, at CSS's 96 px to the inch.
  const qr = (await door.doorCodeQr.boundingBox())!;
  expect(Math.round(qr.width)).toBe(529);
  expect(Math.round(qr.height)).toBe(529);

  for (const format of ['Letter', 'A4']) {
    const pdf = (await page.pdf({ format })).toString('latin1');
    expect(pdf.match(/\/Type\s*\/Page[^s]/g) ?? [], `one ${format} page`).toHaveLength(1);
  }
  await page.emulateMedia({ media: 'screen' });
  expect(await shownCode(door)).toBe(code);
});

test('in a short window it scrolls under a shade, and still prints whole with none', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, EDITOR, 1280);
  const made = await page.request.post(`${APP_API}/markets/${marketId}/door-code`);
  expect(made.ok(), await made.text()).toBeTruthy();
  const door = new AttendanceStatusPage(page);
  await door.goto(marketId);
  await door.doorCodeButton.click();
  await shownCode(door);
  await expect(door.doorCodeScroller, 'it fits a laptop, so it says nothing of more').toBeVisible();
  await expect(door.doorCodeShade('bottom')).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 320 });
  await expect(door.doorCodeShade('bottom')).toBeVisible();
  await expect(door.doorCodeShade('top')).toHaveCount(0);

  // The screen's top holds the close, with nothing of the poster riding up over it.
  await expect(door.doorCodeClose).toBeInViewport({ ratio: 1 });
  const close = (await door.doorCodeClose.boundingBox())!;
  const market = (await door.doorCodeMarket.boundingBox())!;
  expect(market.y, 'the poster starts below the controls').toBeGreaterThanOrEqual(
    close.y + close.height,
  );

  // Its foot can be reached, where the shade goes.
  await door.doorCodeScroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(door.doorCodeShade('bottom')).toHaveCount(0);
  await expect(door.doorCodeShade('top')).toBeVisible();
  // Short of whole by a fraction of a pixel, the scroller's height being rounded.
  await expect(door.doorCodeMade).toBeInViewport({ ratio: 0.9 });

  // On paper: all of it, on one page, with no shade, however short the window it is printed from.
  await door.doorCodeScroller.evaluate((el) =>
    el.scrollTo({ top: (el.scrollHeight - el.clientHeight) / 2 }),
  );
  await expect(door.doorCodeShade('bottom')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(door.doorCodeShade('bottom')).toBeHidden();
  await expect(door.doorCodeShade('top')).toBeHidden();
  const qr = (await door.doorCodeQr.boundingBox())!;
  expect(Math.round(qr.width)).toBe(529);
  for (const format of ['Letter', 'A4']) {
    const pdf = (await page.pdf({ format })).toString('latin1');
    expect(pdf.match(/\/Type\s*\/Page[^s]/g) ?? [], `one ${format} page`).toHaveLength(1);
  }
  await page.emulateMedia({ media: 'screen' });
});

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);
    const width = size.use.viewport.width;
    const phone = width < 640;

    test('the door code fits the window, with its switch on and off', async ({ page }) => {
      await signIn(page, EDITOR, width);
      const made = await page.request.post(`${APP_API}/markets/${marketId}/door-code`);
      expect(made.ok(), await made.text()).toBeTruthy();
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.doorCodeButton).toBeVisible({ timeout: 15000 });
      if (phone) {
        expect((await door.doorCodeButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await door.doorCodeButton.click();
      const code = await shownCode(door);

      await expectItFits(page, door, phone);

      await selfSwitch(page).uncheck();
      await expect(offNote(page)).toHaveText(OFF);
      await expectItFitsOff(page, door, phone);

      // On again, for the walks that follow, and the screen is as it was.
      await selfSwitch(page).check();
      expect(await shownCode(door)).toBe(code);
      await expectItFits(page, door, phone);
    });

    test('a Viewer is offered no Door code, and is refused the code', async ({ page }) => {
      await signIn(page, VIEWER, width);
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.rows.first()).toBeVisible({ timeout: 15000 });

      await expect(door.doorCodeButton).toHaveCount(0);
      for (const ask of [page.request.get, page.request.post]) {
        const res = await ask.call(page.request, `${APP_API}/markets/${marketId}/door-code`);
        expect(res.status()).toBe(403);
        expect(await res.json()).not.toHaveProperty('code');
      }
    });
  });
}
