import type { APIRequestContext, Browser, Locator } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, VendorPage } from './fixtures';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { calendarToday, forgetSignInAttempts, signInOnThePage } from './helpers/vendorSignIn';
import { hideDevToolsPanel } from './helpers/hideDevToolsPanel';
import { PHONE_AND_DESK, inTheWindow } from './helpers/phoneWindow';
import { letVendorsCheckThemselvesIn } from './helpers/selfCheckIn';

/**
 * A vendor checks out on their own vendor page, where they checked in, behind the market's self
 * check-in switch (T496).
 *
 * The organizer of the live market asked for a check-out, since a vendor leaving may have things
 * to return, and for a way to keep the door to organizers alone. So a checked-in vendor checks out
 * with the door code, as they checked in, and undoes a mis-tap; and at a market whose switch is
 * off the page offers neither, and answers a scanned door code by saying who to ask.
 *
 * Walked on the phone a vendor holds at the door: every control a 44px target, nothing past the
 * window's width.
 */
const PHONE = PHONE_AND_DESK[0];
const onThePhone = inTheWindow(PHONE);
const TODAY = calendarToday();
const TIME = String.raw`\d{1,2}:\d{2}\s[AP]M`;

/** A vendor's phone: a browser of its own under a phone's emulation, signed in as nobody. */
async function aPhone(browser: Browser) {
  const context = await browser.newContext(PHONE.use);
  await hideDevToolsPanel(context);
  const page = await context.newPage();
  return { context, page, vendorPage: new VendorPage(page) };
}

/** Make the market's door code over the organizer's API; the code, and its address as a path. */
async function makeDoorCode(request: APIRequestContext, marketId: string) {
  const made = await request.post(`${BACKEND_URL}/markets/${marketId}/door-code`);
  expect(made.ok(), await made.text()).toBeTruthy();
  const { code, url } = (await made.json()) as { code: string; url: string };
  const at = new URL(url);
  return { code, path: `${at.pathname}${at.search}` };
}

/** The vendor's day as the organizer's roster holds it. */
async function dayOf(request: APIRequestContext, marketId: string, vendor: string) {
  const roster = await request.get(`${BACKEND_URL}/markets/${marketId}/attendance`);
  expect(roster.ok(), await roster.text()).toBeTruthy();
  const { roster: rows } = (await roster.json()) as {
    roster: {
      vendorEmail: string;
      checkedInAt: string | null;
      checkedOutAt: string | null;
      checkedOutVia: string | null;
    }[];
  };
  return rows.find((row) => row.vendorEmail === vendor);
}

/**
 * Every control of today's card is a 44px target inside the window, and the page fits it;
 * answers how many controls the card has.
 */
async function expectAPhonesCard(vendorPage: VendorPage, what: string) {
  await onThePhone.expectFits(vendorPage.page, what);
  const controls: Locator[] = await vendorPage.todayCard.locator('button, input').all();
  for (const control of controls) {
    const name = (await control.getAttribute('data-testid')) ?? 'a control';
    const box = await control.boundingBox();
    expect(box, `${name} is drawn, ${what}`).not.toBeNull();
    expect(box!.height, `${name} is a 44px target, ${what}`).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width, `${name} ends inside the window, ${what}`).toBeLessThanOrEqual(
      PHONE.use.viewport.width,
    );
  }
  return controls.length;
}

test.beforeEach(() => forgetSignInAttempts());

test('a vendor checks in, then out, with the door code, and undoes the check-out', async ({
  browser,
  request,
}) => {
  const vendor = `check-out-${Date.now()}@example.com`;
  const seed = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { marketDate: TODAY, vendors: [vendor] },
  );
  await letVendorsCheckThemselvesIn(request, seed.marketId);
  const door = await makeDoorCode(request, seed.marketId);
  const typed = `${door.code.slice(0, 3)} ${door.code.slice(3)}`.toLowerCase();

  const phone = await aPhone(browser);
  await phone.vendorPage.goto(seed.marketSlug);
  await signInOnThePage(phone.vendorPage, seed.marketId, vendor);

  // In, as ever.
  expect(await expectAPhonesCard(phone.vendorPage, 'before the check-in')).toBe(2);
  await phone.vendorPage.checkInWith(typed);
  await expect(phone.vendorPage.checkedIn).toHaveText(new RegExp(`Checked in at ${TIME}$`));

  // Checked in, the card offers the check-out under it, and the check-in's Undo still.
  await expect(phone.vendorPage.checkOutButton).toBeDisabled();
  await expect(phone.vendorPage.undoButton).toBeVisible();
  expect(await expectAPhonesCard(phone.vendorPage, 'checked in')).toBe(3);

  // The poster scanned again fills the check-out's field and ends nobody's day.
  await phone.page.goto(door.path);
  await expect(phone.vendorPage.checkOutCodeInput).toHaveValue(door.code);
  await expect.poll(() => new URL(phone.page.url()).search).toBe('');
  await expect(phone.vendorPage.checkedOut).toHaveCount(0);
  expect((await dayOf(request, seed.marketId, vendor))?.checkedOutAt).toBeNull();

  // Their own tap checks them out.
  await phone.vendorPage.checkOutButton.tap();
  await expect(phone.vendorPage.checkedOut).toHaveText(new RegExp(`Checked out at ${TIME}$`));
  await expect(phone.vendorPage.checkedIn).toBeVisible();
  // One Undo, the check-out's.
  await expect(phone.vendorPage.undoButton).toHaveCount(0);
  await expect(phone.vendorPage.checkOutCodeInput).toHaveCount(0);
  expect(await expectAPhonesCard(phone.vendorPage, 'checked out')).toBe(1);
  const out = await dayOf(request, seed.marketId, vendor);
  expect(out?.checkedOutAt).toBeTruthy();
  expect(out?.checkedOutVia).toBe('door_code');

  // It holds over a reload: the vendor's own read carries it.
  await phone.page.reload();
  await expect(phone.vendorPage.checkedOut).toBeVisible();

  // A mis-tap undone: checked in again, with the check-out to make.
  await phone.vendorPage.undoCheckOutButton.tap();
  await expect(phone.vendorPage.checkedOut).toHaveCount(0);
  await expect(phone.vendorPage.checkedIn).toBeVisible();
  await expect(phone.vendorPage.checkOutCodeInput).toHaveValue('');
  await expect(phone.vendorPage.undoButton).toBeVisible();
  const back = await dayOf(request, seed.marketId, vendor);
  expect(back?.checkedOutAt).toBeNull();
  expect(back?.checkedInAt).toBeTruthy();
  await phone.context.close();
});

test('with the switch off the page offers no check-in or check-out, and answers a scan by saying who to ask', async ({
  browser,
  request,
}) => {
  const vendor = `door-is-ours-${Date.now()}@example.com`;
  // A market nobody turned the switch on for: off, as every market is until someone does.
  const seed = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { marketDate: TODAY, vendors: [vendor] },
  );
  const door = await makeDoorCode(request, seed.marketId);

  // Scanned signed out: said at once, over the sign-in, and nothing waits for a sign-in.
  const phone = await aPhone(browser);
  await phone.page.goto(door.path);
  await expect(phone.vendorPage.selfCheckInOff).toHaveText(
    'Vendors are checked in and out by an organizer at this market. Ask at the door.',
  );
  await expect(phone.vendorPage.doorCodeHeld).toHaveCount(0);
  await expect.poll(() => new URL(phone.page.url()).search).toBe('');
  await onThePhone.expectFits(phone.page, 'the notice over the sign-in');

  // Signed in, nobody is checked in, and the card has no control: an organizer checks them in.
  await signInOnThePage(phone.vendorPage, seed.marketId, vendor);
  await expect(phone.vendorPage.atTheDoor).toHaveText('An organizer checks you in at the door.');
  await expect(phone.vendorPage.todayCard).toContainText('Today');
  expect(await expectAPhonesCard(phone.vendorPage, 'with the switch off')).toBe(0);
  expect((await dayOf(request, seed.marketId, vendor))?.checkedInAt).toBeNull();

  // The organizer checks them in at the door; the page reads it, and who checks them out.
  const checkedIn = await request.post(`${BACKEND_URL}/markets/${seed.marketId}/attendance`, {
    data: { vendorEmail: vendor, date: TODAY },
  });
  expect(checkedIn.ok(), await checkedIn.text()).toBeTruthy();
  await phone.page.reload();
  await expect(phone.vendorPage.checkedIn).toHaveText(new RegExp(`Checked in at ${TIME}$`));
  await expect(phone.vendorPage.atTheDoor).toHaveText('An organizer checks you out at the door.');
  expect(await expectAPhonesCard(phone.vendorPage, 'checked in at the door')).toBe(0);

  // Turned on, both come back: the check-in's Undo and the check-out.
  await letVendorsCheckThemselvesIn(request, seed.marketId);
  await phone.page.reload();
  await expect(phone.vendorPage.atTheDoor).toHaveCount(0);
  await expect(phone.vendorPage.undoButton).toBeVisible();
  await phone.vendorPage.checkOutWith(door.code);
  await expect(phone.vendorPage.checkedOut).toHaveText(new RegExp(`Checked out at ${TIME}$`));
  await phone.context.close();
});
