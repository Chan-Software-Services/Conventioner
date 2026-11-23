import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { expectWholeAddress } from './helpers/addressBreaks';
import {
  detectLayout,
  gates,
  minTargetAt,
  SPACE_SCALE,
  TYPE_SCALE,
} from './helpers/layoutDetectors';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { calendarToday } from './helpers/vendorSignIn';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { ManageMarketPage } from './pages/ManageMarketPage';

/**
 * An organizer checks a vendor out at the door (T496).
 *
 * The door recorded that a vendor came and nothing that they left, and the market's organizer asked
 * for a check-out, since a vendor leaving may have things to return. On Attendance, whoever checks
 * vendors in now checks a checked-in vendor out on their row and can undo it, the row says when
 * and by whom, and the market's history says both.
 *
 * Walked on the phone in an organizer's hand, under a phone's emulation, and at a desk: a check-in,
 * a check-out and its undo, each row inside the window, each address on one line, and on the phone
 * every button a thumb's 44px. A check-out changes nothing else: the count stays as it was.
 */
const TODAY = calendarToday();
const at = Date.now();
/** Checked in, out, and the check-out undone in the walk: an address that fits beside a button. */
const COMES = `out${at % 1000}@example.com`;
/**
 * Checked in before the walk, and checked out in it: an address whose half before the "@" is wider
 * than the room Check out leaves on a phone's line, and narrower than the line.
 */
const LONG = `door-leaves-before-the-close-${at}@example.com`;
/** Checked in, then freed: here with no table, and checked out in the walk. */
const FREED = `free${at % 1000}@example.com`;
/** Never comes. */
const WAITING = `door-stays-out-${at}@example.com`;

const TIME = '\\d{1,2}:\\d{2}\\s[AP]M';

async function ok(response: Promise<{ ok(): boolean; text(): Promise<string> }>, what: string) {
  const res = await response;
  expect(res.ok(), `${what}: ${await res.text()}`).toBeTruthy();
}

/**
 * A market on its day, today: one vendor checked in, one checked in and then freed with "anyway",
 * as an organizer would, and two not checked in.
 */
async function seedTheDoor(
  request: APIRequestContext,
): Promise<{ marketId: string; marketName: string }> {
  const { marketId, marketName } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    {
      marketDate: TODAY,
      intakeMode: 'form',
      vendors: [COMES, LONG, FREED, WAITING],
      namePrefix: 'E2E Door Check-out',
    },
  );
  const attendance = `${BACKEND_URL}/markets/${marketId}/attendance`;
  for (const vendorEmail of [LONG, FREED]) {
    await ok(request.post(attendance, { data: { vendorEmail, date: TODAY } }), 'check in');
  }
  await ok(
    request.delete(`${BACKEND_URL}/markets/${marketId}/placements`, {
      data: { email: FREED, date: TODAY, whileHere: true },
    }),
    'free anyway',
  );
  return { marketId, marketName };
}

/** The layout sweep's gating findings on the page as it stands: none, the phone's 44px included. */
async function expectNoLayoutFault(page: Page, what: string): Promise<void> {
  const width = page.viewportSize()!.width;
  const findings = await page.evaluate(detectLayout, {
    spaceScale: SPACE_SCALE,
    textScale: TYPE_SCALE,
    minTarget: minTargetAt(width),
  });
  expect(
    findings.filter((finding) => gates(finding, width)),
    what,
  ).toEqual([]);
}

/** A row scrolled to the window's middle, so the whole of it is in view. */
const toTheMiddle = (row: Locator) =>
  row.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

/** The lines a vendor's address is drawn on: one, when it is whole. */
async function expectAddressOnOneLine(row: Locator, vendor: string, what: string): Promise<void> {
  const address = row.getByTestId('vendor-identity-email');
  await expect(address).toHaveText(vendor);
  const lines = await address.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines, `${vendor}'s address is on one line, ${what}`).toBe(1);
}

/** The door's writes to a market, as the page sends them, each answered. */
function doorWrite(page: Page, marketId: string, method: 'POST' | 'DELETE', path: string) {
  return page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      res.url().endsWith(`/markets/${marketId}/attendance${path}`),
  );
}

for (const size of PHONE_AND_DESK) {
  test.describe(size.name, () => {
    test.use(size.use);
    const { expectFits, expectInside, press } = inTheWindow(size);

    /** The row as it stands: inside the window, its address whole, its buttons a thumb's size. */
    async function expectTheRowSound(
      page: Page,
      door: AttendanceStatusPage,
      vendor: string,
      what: string,
    ): Promise<void> {
      const row = door.row(vendor);
      await toTheMiddle(row);
      await expectInside(row, `${vendor}'s row, ${what}`);
      await expectAddressOnOneLine(row, vendor, what);
      if (size.phone) {
        for (const button of await row.locator('.door-action button, .door-undo').all()) {
          const box = (await button.boundingBox())!;
          const name = await button.getAttribute('aria-label');
          expect(box.height, `${name} is a thumb's height, ${what}`).toBeGreaterThanOrEqual(44);
          expect(box.width, `${name} is a thumb's width, ${what}`).toBeGreaterThanOrEqual(44);
        }
      }
      await expectFits(page, `the door, ${what}`);
      await expectNoLayoutFault(page, `the door, ${what}`);
    }

    test('checks a vendor in, then out, and undoes the check-out, and the history says so', async ({
      authenticatedPage: page,
      request,
    }) => {
      const { marketId, marketName } = await seedTheDoor(request);
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.rows).toHaveCount(4);
      await expect(door.summary).toHaveText('1 of 3 checked in');

      // Not checked in: Check in alone, as before.
      await expect(door.action(COMES, 'check-in')).toBeVisible();
      await expect(door.action(COMES, 'check-out')).toHaveCount(0);
      await expect(door.out(COMES)).toHaveCount(0);
      await expectTheRowSound(page, door, COMES, 'a vendor expected');

      // A check-in: the row ends in Check out, and its "Undo?" stands just left of the status.
      await press(door.action(COMES, 'check-in'));
      await expect(door.status(COMES)).toHaveText(new RegExp(`^Checked in ${TIME}$`));
      await expect(door.statusBy(COMES)).toHaveText('by you');
      await expect(door.action(COMES, 'check-out')).toHaveText('Check out');
      await expect(door.action(COMES, 'check-out')).toHaveAccessibleName(/^Check out /);
      await expect(door.action(COMES, 'undo')).toHaveText('Undo?');
      await expect(door.action(COMES, 'undo')).toHaveAccessibleName(/'s check-in$/);
      await expect(door.out(COMES)).toHaveCount(0);
      await expect(door.summary).toHaveText('2 of 3 checked in');
      await expectTheRowSound(page, door, COMES, 'a vendor checked in');
      await expect(door.row(COMES).locator('.btn')).toHaveText(['Check out']);
      const undo = (await door.action(COMES, 'undo').boundingBox())!;
      const arrival = (await door.status(COMES).boundingBox())!;
      expect(undo.x + undo.width, 'Undo? stands before the status').toBeLessThanOrEqual(arrival.x);
      expect(
        Math.abs(undo.y + undo.height / 2 - (arrival.y + arrival.height / 2)),
        'Undo? and the status share a line',
      ).toBeLessThanOrEqual(1);

      // A check-out: the row keeps its status, says when and by whom, and offers no button and one
      // "Undo?", just left of when they left.
      const arrived = await door.status(COMES).innerText();
      const checkedOut = doorWrite(page, marketId, 'POST', '/check-out');
      await press(door.action(COMES, 'check-out'));
      expect((await checkedOut).ok()).toBeTruthy();
      await expect(door.out(COMES)).toHaveText(new RegExp(`^Checked out ${TIME}$`));
      await expect(door.outBy(COMES)).toHaveText('by you');
      await expect(door.out(COMES)).toHaveClass(/chip--neutral/);
      await expect(door.status(COMES)).toHaveText(arrived);
      await expect(door.status(COMES)).toHaveClass(/chip--positive/);
      await expect(door.action(COMES, 'undo-check-out')).toHaveText('Undo?');
      await expect(door.action(COMES, 'undo-check-out')).toHaveAccessibleName(/'s check-out$/);
      await expect(door.action(COMES, 'check-out')).toHaveCount(0);
      await expect(door.action(COMES, 'undo')).toHaveCount(0);
      await expect(door.row(COMES).locator('.btn')).toHaveCount(0);
      const undoOut = (await door.action(COMES, 'undo-check-out').boundingBox())!;
      const departure = (await door.out(COMES).boundingBox())!;
      expect(undoOut.x + undoOut.width, 'Undo? stands before the out chip').toBeLessThanOrEqual(
        departure.x,
      );
      expect(
        Math.abs(undoOut.y + undoOut.height / 2 - (departure.y + departure.height / 2)),
        'Undo? and the out chip share a line',
      ).toBeLessThanOrEqual(1);
      // A vendor checked out still came.
      await expect(door.summary).toHaveText('2 of 3 checked in');
      await expectTheRowSound(page, door, COMES, 'a vendor checked out');

      // It is the server's record, not the page's: read again, the row says the same.
      await page.reload();
      await expect(door.out(COMES)).toHaveText(new RegExp(`^Checked out ${TIME}$`));
      await expect(door.outBy(COMES)).toHaveText('by you');
      await expect(door.status(COMES)).toHaveText(arrived);
      // Under Checked out, and neither Checked in nor Not checked in (T501).
      await door.show('checked-out');
      await expect(door.row(COMES)).toBeVisible();
      await door.show('checked-in');
      await expect(door.row(COMES)).toHaveCount(0);
      await door.show('not-checked-in');
      await expect(door.row(COMES)).toHaveCount(0);
      await door.show('all');

      // A vendor here with no table is checked out too.
      await expect(door.table(FREED)).toHaveText('No table');
      await toTheMiddle(door.row(FREED));
      await press(door.action(FREED, 'check-out'));
      await expect(door.out(FREED)).toHaveText(new RegExp(`^Checked out ${TIME}$`));
      await expect(door.outBy(FREED)).toHaveText('by you');
      await expect(door.unseatedHeading).toHaveText('Checked in, with no table on this date (1)');
      await expectTheRowSound(page, door, FREED, 'a vendor with no table checked out');

      // A long address is never broken inside its first half to make room for the button: on a
      // phone it goes under the vendor, at the line's end.
      const long = door.row(LONG);
      await toTheMiddle(long);
      await expect(door.action(LONG, 'check-out')).toBeVisible();
      await expectWholeAddress(door.vendor(LONG), LONG);
      await expectInside(long, 'the long address, checked in');
      const longWho = (await door.vendor(LONG).boundingBox())!;
      const longCheckOut = (await door.action(LONG, 'check-out').boundingBox())!;
      const rowBox = (await long.boundingBox())!;
      if (size.phone) {
        expect(longCheckOut.y, 'the button stands under the vendor').toBeGreaterThanOrEqual(
          longWho.y + longWho.height,
        );
      }
      const padding = await long.evaluate((el) => {
        const style = getComputedStyle(el);
        return parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
      });
      expect(
        Math.abs(rowBox.x + rowBox.width - padding - (longCheckOut.x + longCheckOut.width)),
        "Check out ends the row's line",
      ).toBeLessThanOrEqual(1);
      await press(door.action(LONG, 'check-out'));
      await expect(door.out(LONG)).toBeVisible();
      await expectWholeAddress(door.vendor(LONG), LONG);
      await expectInside(long, 'the long address, checked out');
      await expectFits(page, 'the door, a long address checked out');

      // The undo of the check-out: still checked in, and Check out is offered again.
      await toTheMiddle(door.row(COMES));
      const undone = doorWrite(page, marketId, 'DELETE', '/check-out');
      await press(door.action(COMES, 'undo-check-out'));
      expect((await undone).ok()).toBeTruthy();
      await expect(door.out(COMES)).toHaveCount(0);
      await expect(door.status(COMES)).toHaveText(arrived);
      await expect(door.action(COMES, 'check-out')).toBeEnabled();
      await expect(door.action(COMES, 'undo')).toBeEnabled();
      await expect(door.summary).toHaveText('2 of 3 checked in');
      await expectTheRowSound(page, door, COMES, 'the check-out undone');

      // The market's history says the check-out and its undo, newest first.
      await page.goto(`/markets?q=${encodeURIComponent(marketName)}`);
      await page.getByTestId('market-card-manage-button').click();
      const manage = new ManageMarketPage(page);
      await manage.waitForOverlay();
      await manage.openHistory();
      const me = TEST_USER.email;
      const sentences = manage.historySentences;
      await expect(sentences.nth(0)).toHaveText(
        new RegExp(`^${me} undid the check-out of .*${COMES} on `),
      );
      await expect(sentences.nth(1)).toHaveText(new RegExp(`^${me} checked .*${LONG} out on `));
      await expect(sentences.nth(2)).toHaveText(new RegExp(`^${me} checked .*${FREED} out on `));
      await expect(sentences.nth(3)).toHaveText(new RegExp(`^${me} checked .*${COMES} out on `));
      await expect(sentences.nth(4)).toHaveText(new RegExp(`^${me} checked .*${COMES} in on `));
    });
  });
}
