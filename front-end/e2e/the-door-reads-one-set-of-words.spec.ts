import { request as apiRequest, type Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { expectWholeAddress } from './helpers/addressBreaks';
import { marketScreenPath } from './helpers/marketScreens';
import {
  detectLayout,
  gates,
  minTargetAt,
  SPACE_SCALE,
  TYPE_SCALE,
} from './helpers/layoutDetectors';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { loginViaApi, seedPublishedMarketWithAssignments } from './helpers/seeds';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';

/**
 * The door says one set of words of a vendor's day (T501): "Not checked in", "Checked in" and
 * "Checked out", on its list, its filters, its map and its printed roster, at every time of day.
 *
 * The list said "Not yet" of a vendor who had not come, "Did not come" once the day was over, and
 * "Out" once they left, while the map said "Here" and "Expected": the organizers read five words
 * for three states. Now a row not checked in says "Not checked in" before, on and after the day,
 * a row an organizer checked in says "Checked in <time>" and once out "Checked out <time>", each
 * with who made it on a plain line after it; the filters are All, Not checked in, Checked in and
 * Checked out, each vendor under one of the last three, and the bar still counts every seated
 * vendor who came, checked out or not.
 *
 * Walked on a phone, under a phone's emulation, and at a desk, on a day to come, the day itself
 * and a day over. A vendor checked in and out by an organizer with a long address reads each chip,
 * "Checked in <time>" and "Checked out <time>", as a one-line pill inside the row, and who made it
 * on a plain muted line after it, under it on a phone and beside it at a desk, the address breaking
 * only before its "@" or a dot.
 */

/**
 * The three days are reckoned, and the door is read, at UTC+14, the first clock to reach a day.
 *
 * A market date has passed only once it has passed everywhere, at UTC-12 (`SetupHasDatesGuard`),
 * and the seed walks the market out of draft with its day over among its dates: reckoned on the
 * runner's clock, that day had passed everywhere from noon UTC, and the seed was refused every
 * afternoon. A day before today at UTC+14 has not yet passed at UTC-12, at any hour, and the
 * organizer's door takes it and today, which have both begun by the server's UTC date.
 */
const ZONE = 'Pacific/Kiritimati';
const DAY = 24 * 60 * 60 * 1000;
/** The calendar day at UTC+14 of an instant, as a market date; the zone keeps no summer time. */
const dayAt = (instant: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(instant));
const NOW = Date.now();
const TODAY = dayAt(NOW);
const YESTERDAY = dayAt(NOW - DAY);
const TOMORROW = dayAt(NOW + DAY);

test.use({ timezoneId: ZONE });

/** An organizer of the market whose address is too long to share a phone's line with the time. */
const LONG_ORGANIZER = {
  email: 'e2e-the-door-organizer-of-long@example.com',
  password: 'e2epassword123',
};
/** Checked in and out by the long-addressed organizer, on each day begun. */
const LEFT = 'door-words-left@example.com';
/** Checked in by the market's owner, who reads "by you", and not out. */
const STAYS = 'door-words-stays@example.com';
/** Never comes. */
const NEVER = 'door-words-never@example.com';

const TIME = '\\d{1,2}:\\d{2}\\s[AP]M';

/** The words the door said of a vendor's day before T501, none of them on its page now. */
const OLD_WORDS = /\b(Here|Expected|Not yet|Did not come)\b/;

let marketId: string;

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

/**
 * Everything the page holds as text, the printed roster's hidden sheet among it, each text node on a
 * line of its own: `textContent` runs neighbouring elements together ("Table A 1" then "Not yet" read
 * "1Not yet"), so a word between two elements would not stand alone for `OLD_WORDS`.
 */
const pageText = (page: Page) =>
  page.locator('body').evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      texts.push(node.textContent ?? '');
    }
    return texts.join('\n');
  });

/** The vendors a filter lists, by address: the list's order is the tables', which differ by day. */
async function listedUnder(
  door: AttendanceStatusPage,
  which: 'all' | 'not-checked-in' | 'checked-in' | 'checked-out',
): Promise<string[]> {
  await door.show(which);
  await expect(door.page.getByTestId(`attendance-show-${which}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const listed = await door.rows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-vendor') ?? ''),
  );
  return listed.toSorted();
}

test.beforeAll(async ({ request }) => {
  ensureVerifiedUser(LONG_ORGANIZER.email, LONG_ORGANIZER.password);
  // A day over, today and a day to come: the market stays on its days past midnight.
  ({ marketId } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    {
      marketDates: [YESTERDAY, TODAY, TOMORROW],
      vendors: [LEFT, STAYS, NEVER],
      namePrefix: 'E2E Door Words',
    },
  ));
  const roles = await request.post(`${BACKEND_URL}/markets/${marketId}/roles`, {
    data: { user_email: LONG_ORGANIZER.email, role: 'editor' },
  });
  expect(roles.ok(), await roles.text()).toBeTruthy();
  const organizer = await apiRequest.newContext({ ignoreHTTPSErrors: true });
  await loginViaApi(organizer, BACKEND_URL, LONG_ORGANIZER.email, LONG_ORGANIZER.password);
  for (const date of [YESTERDAY, TODAY]) {
    const owner = await request.post(`${BACKEND_URL}/markets/${marketId}/attendance`, {
      data: { vendorEmail: STAYS, date },
    });
    expect(owner.ok(), await owner.text()).toBeTruthy();
    for (const path of ['attendance', 'attendance/check-out']) {
      const res = await organizer.post(`${BACKEND_URL}/markets/${marketId}/${path}`, {
        data: { vendorEmail: LEFT, date },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
  }
  await organizer.dispose();
});

const DAYS = [
  {
    name: 'a day to come',
    date: TOMORROW,
    summary: '0 of 3 checked in',
    filters: ['All 3', 'Not checked in 3', 'Checked in 0', 'Checked out 0'],
    under: { notCheckedIn: [LEFT, STAYS, NEVER], checkedIn: [], checkedOut: [] },
  },
  {
    name: 'the day itself',
    date: TODAY,
    summary: '2 of 3 checked in',
    filters: ['All 3', 'Not checked in 1', 'Checked in 1', 'Checked out 1'],
    under: { notCheckedIn: [NEVER], checkedIn: [STAYS], checkedOut: [LEFT] },
  },
  {
    name: 'a day over',
    date: YESTERDAY,
    summary: '2 of 3 checked in',
    filters: ['All 3', 'Not checked in 1', 'Checked in 1', 'Checked out 1'],
    under: { notCheckedIn: [NEVER], checkedIn: [STAYS], checkedOut: [LEFT] },
  },
];

for (const size of PHONE_AND_DESK) {
  test.describe(`the door's words ${size.name}`, () => {
    test.use(size.use);
    const { expectFits, expectInside } = inTheWindow(size);

    for (const day of DAYS) {
      test(`on ${day.name} the door says Not checked in, Checked in and Checked out, and no other word`, async ({
        authenticatedPage: page,
      }) => {
        const door = new AttendanceStatusPage(page);
        await page.goto(`${marketScreenPath(marketId, 'attendance')}?date=${day.date}`);
        await expect(door.rows).toHaveCount(3);
        await expect(door.summary).toHaveText(day.summary);
        await expect(door.filters).toHaveText(day.filters);
        await expect(door.status(NEVER)).toHaveText('Not checked in');

        // Each vendor is under one of the last three filters, and All lists them all.
        expect(await listedUnder(door, 'all')).toEqual([LEFT, NEVER, STAYS].toSorted());
        for (const [which, vendors] of [
          ['not-checked-in', day.under.notCheckedIn],
          ['checked-in', day.under.checkedIn],
        ] as const) {
          expect(await listedUnder(door, which), which).toEqual(vendors.toSorted());
        }
        const checkedOut = await listedUnder(door, 'checked-out');
        expect(checkedOut).toEqual(day.under.checkedOut.toSorted());
        if (checkedOut.length === 0) await expect(page.getByText('Nobody matches.')).toBeVisible();
        await door.show('all');

        if (day.date !== TOMORROW) {
          await expect(door.status(STAYS)).toHaveText(new RegExp(`^Checked in ${TIME}$`));
          await expect(door.statusBy(STAYS)).toHaveText('by you');
          await expect(door.status(LEFT)).toHaveText(new RegExp(`^Checked in ${TIME}$`));
          await expect(door.statusBy(LEFT)).toHaveText(`by ${LONG_ORGANIZER.email}`);
          const out = door.out(LEFT);
          await expect(out).toHaveText(new RegExp(`^Checked out ${TIME}$`));
          await expect(door.outBy(LEFT)).toHaveText(`by ${LONG_ORGANIZER.email}`);
          // The chip at the floor of the type scale, in black on beige; who made it after it, at
          // the same size, muted.
          const drawn = (el: Element) => {
            const style = getComputedStyle(el);
            return [style.fontSize, style.color, style.backgroundColor];
          };
          const tokens = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--mm-black)';
            probe.style.backgroundColor = 'var(--mm-beige)';
            const muted = document.createElement('span');
            muted.style.color = 'var(--mm-text-muted)';
            document.body.append(probe, muted);
            const said = {
              chip: [
                '12px',
                getComputedStyle(probe).color,
                getComputedStyle(probe).backgroundColor,
              ],
              by: ['12px', getComputedStyle(muted).color, 'rgba(0, 0, 0, 0)'],
            };
            probe.remove();
            muted.remove();
            return said;
          });
          expect(await out.evaluate(drawn)).toEqual(tokens.chip);
          expect(await door.outBy(LEFT).evaluate(drawn)).toEqual(tokens.by);
          await out.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await expectInside(door.row(LEFT), "the checked-out vendor's row");
          const row = (await door.row(LEFT).boundingBox())!;
          for (const [chip, by] of [
            [door.status(LEFT), door.statusBy(LEFT)],
            [out, door.outBy(LEFT)],
          ] as const) {
            const chipBox = (await chip.boundingBox())!;
            const byBox = (await by.boundingBox())!;
            for (const [box, what] of [
              [chipBox, 'the chip'],
              [byBox, 'who made it'],
            ] as const) {
              expect(box.x, `${what} starts inside the row`).toBeGreaterThanOrEqual(row.x);
              expect(box.x + box.width, `${what} ends inside the row`).toBeLessThanOrEqual(
                row.x + row.width,
              );
            }
            // A pill of one line, never wrapped.
            expect(chipBox.height, 'the chip is one line').toBeLessThan(30);
            await expectWholeAddress(by, LONG_ORGANIZER.email);
            if (size.phone) {
              // Under the chip, ending where it ends.
              expect(byBox.y, 'who made it is under the chip').toBeGreaterThanOrEqual(
                chipBox.y + chipBox.height - 1,
              );
              expect(
                Math.abs(byBox.x + byBox.width - (chipBox.x + chipBox.width)),
                'who made it ends where the chip ends',
              ).toBeLessThanOrEqual(1);
            } else {
              // Beside the chip, on its line.
              expect(byBox.x, 'who made it is after the chip').toBeGreaterThan(
                chipBox.x + chipBox.width,
              );
              expect(
                Math.abs(byBox.y + byBox.height / 2 - (chipBox.y + chipBox.height / 2)),
                "who made it is on the chip's line",
              ).toBeLessThanOrEqual(1);
            }
          }
        }

        // None of the old words on the list, its filters or the printed roster, nor on the map
        // view. This market lays out no location, so the map view says so and draws no legend: the
        // legend's words are `the-door-as-a-map.spec.ts`'s on today, and Vitest's on the other days.
        expect(await pageText(page)).not.toMatch(OLD_WORDS);
        await expect(door.printSheet).toContainText('Checked in');
        await expectFits(page, `the door's list, ${day.name}`);
        await expectNoLayoutFault(page, `the door's list, ${day.name}`);
        await door.viewMap.click();
        await expect(door.viewMap).toHaveAttribute('aria-pressed', 'true');
        await expect(door.filters).toHaveCount(0);
        expect(await pageText(page)).not.toMatch(OLD_WORDS);
      });
    }
  });
}
