import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { LoginPage } from './pages/LoginPage';
import { calendarToday } from './helpers/vendorSignIn';

/**
 * A Viewer at the door reads why they cannot check vendors in (E38/F15/S04).
 *
 * Before the market is published the Attendance tab's note stands in for its page, and the
 * read-only line is left out under it, which a walk took for the line missing. In Market Days the
 * door is the page, so a Viewer reads the line there as on every other page, and is offered no
 * Check in and no Undo, on a phone at the door as at a desk.
 *
 * Two things looked off beside it, for the same role on the same screen: the rail told the Viewer
 * "Check vendors in at the door.", and at a desk each row kept the empty column a Check in stands in,
 * so its status stopped short of the row's edge. An Editor, who checks vendors in, keeps both.
 *
 * A vendor checked out (T496) reads the same way: a Viewer sees when they were checked out and by
 * whom, ending the row, and no Undo of it. An Editor's row ends in at most one button, Check in or
 * Check out, the two one width, and each undo is a quiet "Undo?" just left of the chip it undoes: a
 * row checked out has no button, and its one "Undo?" stands by when they left, not by its status.
 */
const VIEWER = { email: 'e2e-door-viewer@example.com', password: 'e2epassword123' };
const EDITOR = { email: 'e2e-door-editor@example.com', password: 'e2epassword123' };
const HERE = 'alice@example.com';
const NOT_YET = 'bob@example.com';
/** Checked in, then out. */
const OUT = 'carol@example.com';

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
  { name: 'at a desk', use: { viewport: { width: 1440, height: 900 } } },
] as const;

let marketId: string;

/** px between a box's right edge and the right edge of the row's content, inside its padding. */
async function shortOfTheRowsEnd(row: Locator, inside: Locator): Promise<number> {
  const rowBox = await row.boundingBox();
  const box = await inside.boundingBox();
  expect(rowBox, 'the row is drawn').not.toBeNull();
  expect(box, 'the box is drawn').not.toBeNull();
  const padding = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
  });
  return Math.round(rowBox!.x + rowBox!.width - padding - (box!.x + box!.width));
}

/**
 * A vendor's address on their row is whole, on one line. On a phone the status shared a column with
 * the action, so a wide one ("9:44 AM by e2e@example.com") squeezed the vendor's line and broke the
 * address mid-word, for a Viewer as for an Editor (E38/F15/S04).
 */
async function expectAddressWhole(row: Locator, vendor: string): Promise<void> {
  const address = row.getByTestId('vendor-identity-email');
  await expect(address).toHaveText(vendor);
  const lines = await address.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines, `${vendor}'s address is on one line`).toBe(1);
}

/**
 * An "Undo?" stands just left of the chip it undoes, on the chip's line, and its tap area is at
 * least as tall as the chip.
 */
async function expectLeftOf(undo: Locator, chip: Locator, what: string): Promise<void> {
  const undoBox = (await undo.boundingBox())!;
  const chipBox = (await chip.boundingBox())!;
  const gap = chipBox.x - (undoBox.x + undoBox.width);
  expect(gap, `${what} ends just before the chip`).toBeGreaterThanOrEqual(0);
  expect(gap, `${what} ends just before the chip`).toBeLessThanOrEqual(8);
  expect(
    Math.abs(undoBox.y + undoBox.height / 2 - (chipBox.y + chipBox.height / 2)),
    `${what} is on the chip's line`,
  ).toBeLessThanOrEqual(1);
  expect(undoBox.height, `${what} is as tall as the chip`).toBeGreaterThanOrEqual(chipBox.height);
}

/** Signed in on the test's own page, so the size the test uses is the window the door is drawn in. */
async function signIn(page: Page, person: { email: string; password: string }, width: number) {
  const login = new LoginPage(page);
  await login.login(person.email, person.password);
  await login.waitForMarkets();
  expect(await page.evaluate(() => window.innerWidth)).toBe(width);
}

test.beforeAll(async ({ request }) => {
  ensureVerifiedUser(VIEWER.email, VIEWER.password);
  ensureVerifiedUser(EDITOR.email, EDITOR.password);
  // On its day, today: the door offers no check-in for a day that has not begun (T318).
  ({ marketId } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { marketDate: calendarToday(), vendors: [HERE, NOT_YET, OUT] },
  ));
  // The seed leaves the owner's session on `request`: they give each person their role, check one
  // vendor in, so the door has a row an Undo would stand on, and check another in and out.
  for (const [person, role] of [
    [VIEWER, 'viewer'],
    [EDITOR, 'editor'],
  ] as const) {
    const res = await request.post(`${BACKEND_URL}/markets/${marketId}/roles`, {
      data: { user_email: person.email, role },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  for (const [vendorEmail, path] of [
    [HERE, 'attendance'],
    [OUT, 'attendance'],
    [OUT, 'attendance/check-out'],
  ] as const) {
    const res = await request.post(`${BACKEND_URL}/markets/${marketId}/${path}`, {
      data: { vendorEmail, date: calendarToday() },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
});

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);

    const width = size.use.viewport.width;

    test('a Viewer reads the read-only line at the door, and is offered no check-in', async ({
      page,
    }) => {
      await signIn(page, VIEWER, width);
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.row(NOT_YET)).toBeVisible({ timeout: 15000 });
      await expect(door.row(HERE)).toBeVisible();
      await expect(door.status(HERE)).not.toHaveText('Not yet');

      await expect(door.readOnly).toHaveCount(1);
      await expect(door.readOnly).toBeVisible();
      await expect(door.readOnly).toContainText('You can view this market but not change it.');
      // No tab's note stands in for the door once the market is published.
      await expect(page.getByTestId('market-tab-note')).toHaveCount(0);

      await expect(door.checkIns).toHaveCount(0);
      await expect(door.undos).toHaveCount(0);
      await expect(door.checkOuts).toHaveCount(0);
      await expect(door.checkOutUndos).toHaveCount(0);

      // The rail says what a Viewer may do at the door, and leaves the rest to the line above.
      await expect(page.getByTestId('phase-rail-next')).toHaveText(
        'Follow who has checked in at the door.',
      );

      // Each status ends its row, with no empty column beside it, and each address is whole.
      for (const vendor of [HERE, NOT_YET]) {
        await expectAddressWhole(door.row(vendor), vendor);
        expect(
          await shortOfTheRowsEnd(door.row(vendor), door.status(vendor)),
          `${vendor}'s status ends the row`,
        ).toBeLessThanOrEqual(1);
      }

      // A vendor checked out: their status as it was, then when they were checked out and by whom,
      // which ends the row; at a desk the two stand one over the other, each at the row's end.
      await expect(door.status(OUT)).toHaveText(new RegExp(`by ${TEST_USER.email}$`));
      await expect(door.out(OUT)).toHaveText(
        new RegExp(`^Out \\d{1,2}:\\d{2}\\s[AP]M by ${TEST_USER.email}$`),
      );
      await expectAddressWhole(door.row(OUT), OUT);
      expect(
        await shortOfTheRowsEnd(door.row(OUT), door.out(OUT)),
        'the check-out ends the row',
      ).toBeLessThanOrEqual(1);
      if (width > 640) {
        expect(
          await shortOfTheRowsEnd(door.row(OUT), door.status(OUT)),
          'the status ends the row too',
        ).toBeLessThanOrEqual(1);
      }
    });

    test('an Editor is told to check vendors in, each row ends in at most one button, and each "Undo?" stands by its chip', async ({
      page,
    }) => {
      await signIn(page, EDITOR, width);
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.row(NOT_YET)).toBeVisible({ timeout: 15000 });

      await expect(door.readOnly).toHaveCount(0);
      await expect(page.getByTestId('phase-rail-next')).toHaveText(
        "Print each day's roster, then check vendors in at the door.",
      );

      // One button a row at most: Check in, Check out, or none once checked out.
      const checkIn = door.action(NOT_YET, 'check-in');
      const checkOut = door.action(HERE, 'check-out');
      const undo = door.action(HERE, 'undo');
      const undoCheckOut = door.action(OUT, 'undo-check-out');
      for (const [vendor, buttons] of [
        [NOT_YET, ['Check in']],
        [HERE, ['Check out']],
        [OUT, []],
      ] as const) {
        await expect(door.row(vendor).locator('.btn'), `${vendor}'s buttons`).toHaveText([
          ...buttons,
        ]);
      }
      await expect(door.action(OUT, 'undo')).toHaveCount(0);

      // Check in and Check out are one width.
      const checkInBox = (await checkIn.boundingBox())!;
      const checkOutBox = (await checkOut.boundingBox())!;
      expect(Math.abs(checkInBox.width - checkOutBox.width), 'Check in and Check out').toBeLessThan(
        0.5,
      );

      // Each "Undo?" just left of the chip it undoes: the check-in's by the status, the check-out's
      // by when they left.
      await expect(undo).toHaveText('Undo?');
      await expect(undoCheckOut).toHaveText('Undo?');
      await expectLeftOf(undo, door.status(HERE), "the check-in's Undo?");
      await expectLeftOf(undoCheckOut, door.out(OUT), "the check-out's Undo?");

      // At a desk the button has its column at the row's end, the status left of it; on a phone the
      // button is on the vendor's line and the status under it, at the end of each.
      for (const [vendor, action] of [
        [NOT_YET, checkIn],
        [HERE, checkOut],
      ] as const) {
        const row = door.row(vendor);
        await expectAddressWhole(row, vendor);
        expect(
          await shortOfTheRowsEnd(row, action),
          `${vendor}'s button ends the row`,
        ).toBeLessThanOrEqual(1);
        const status = await door.status(vendor).boundingBox();
        const button = await action.boundingBox();
        if (width > 640) expect(status!.x + status!.width).toBeLessThan(button!.x);
        else expect(status!.y).toBeGreaterThan(button!.y);
      }
      await expectAddressWhole(door.row(OUT), OUT);
      // Every row's chips end at one edge, a row with no button among them.
      const chipEnds = await Promise.all(
        [NOT_YET, HERE, OUT].map(async (vendor) => {
          const box = (await door.status(vendor).boundingBox())!;
          return Math.round(box.x + box.width);
        }),
      );
      expect(new Set(chipEnds).size, `the chips' ends ${chipEnds}`).toBe(1);
    });
  });
}
