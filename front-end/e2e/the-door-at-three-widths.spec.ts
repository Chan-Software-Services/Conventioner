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
import { settle } from './helpers/settle';
import { calendarToday } from './helpers/vendorSignIn';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';

/**
 * The door on whichever device stands at the entrance (T318): a phone in the organizer's hand, a
 * tablet on the table, a laptop at the desk.
 *
 * At each, an organizer checks a vendor in and out and undoes each, reads when the roster was read
 * and reads it again, sees Print roster, and reads a vendor here at
 * another table than the one they hold and one here with no table at all, with nothing scrolling
 * sideways, every target a thumb's 44px on the phone, and no address broken mid-word.
 *
 * 768 is no width the app lays out for by name: Attendance fits a phone, so a tablet takes the phone
 * rules or the desk's. Its row takes the phone's: the desk's four columns, at 768, left the vendor a
 * third of the row, and their address broke inside its domain.
 */
const TODAY = calendarToday();
const at = Date.now();
/** Checked in and undone in the walk. */
const COMES = `door-comes-${at}@example.com`;
/** Checked in, then moved to the seat freed below: here, at another table. */
const MOVED = `door-moved-${at}@example.com`;
/** Checked in, then freed: here, with no table. */
const FREED = `door-freed-${at}@example.com`;
/** Never comes. */
const WAITING = `door-waiting-${at}@example.com`;

/** Each window, and the row layout the door gives it: a phone's (one column) or a desk's (four). */
const THREE_WINDOWS = [
  { ...PHONE_AND_DESK[0], rows: 1 },
  {
    name: 'on a tablet',
    phone: false,
    use: {
      viewport: { width: 768, height: 1024 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
    rows: 1,
  },
  { ...PHONE_AND_DESK[1], rows: 4 },
] as const;

type Seat = { vendorEmail: string; tableCode: string | null; tableChoice: string | null };

async function seatsOf(request: APIRequestContext, marketId: string): Promise<Seat[]> {
  const res = await request.get(`${BACKEND_URL}/markets/${marketId}/attendance`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { roster: Seat[] }).roster;
}

async function ok(response: Promise<{ ok(): boolean; text(): Promise<string> }>, what: string) {
  const res = await response;
  expect(res.ok(), `${what}: ${await res.text()}`).toBeTruthy();
}

/**
 * A market on its day, today, with one vendor here at another table than theirs and one here with
 * no table: each checked in at the door, then moved or freed with "anyway", as an organizer would.
 */
async function seedTheDoor(
  request: APIRequestContext,
): Promise<{ marketId: string; movedFrom: string }> {
  const { marketId } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    {
      marketDate: TODAY,
      intakeMode: 'form',
      vendors: [COMES, MOVED, FREED, WAITING],
      namePrefix: 'E2E Door Widths',
      // A long table code, so the moved vendor's line after their chip, "by you, at table" it, is
      // long on a phone (T501).
      sectionName: 'North Gallery Annex',
    },
  );
  const attendance = `${BACKEND_URL}/markets/${marketId}/attendance`;
  for (const vendorEmail of [MOVED, FREED]) {
    await ok(request.post(attendance, { data: { vendorEmail, date: TODAY } }), 'check in');
  }
  const seats = await seatsOf(request, marketId);
  const seatOf = (email: string) => seats.find((row) => row.vendorEmail === email)!;
  const freedSeat = seatOf(FREED);
  const placements = `${BACKEND_URL}/markets/${marketId}/placements`;
  await ok(
    request.delete(placements, { data: { email: FREED, date: TODAY, whileHere: true } }),
    'free anyway',
  );
  await ok(
    request.put(placements, {
      data: {
        email: MOVED,
        date: TODAY,
        tableCode: freedSeat.tableCode,
        tableChoice: freedSeat.tableChoice,
        whileHere: true,
      },
    }),
    'move anyway',
  );
  return { marketId, movedFrom: seatOf(MOVED).tableCode! };
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

/**
 * A row scrolled to the window's middle, so the whole of it is in view: brought only as far as its
 * edge, it rested a fraction of a pixel past the window's foot.
 */
const toTheMiddle = (row: Locator) =>
  row.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

/** The number of columns a row's grid lays out: four at a desk, one on a phone, its lines stacked. */
const columnsOf = (page: Page, email: string) =>
  new AttendanceStatusPage(page)
    .row(email)
    .evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length);

for (const size of THREE_WINDOWS) {
  test.describe(size.name, () => {
    test.use(size.use);
    const { expectFits, expectInside, press } = inTheWindow(size);

    test('checks a vendor in and out, reads the roster again, and says where each vendor stands', async ({
      authenticatedPage: page,
      request,
    }) => {
      const { marketId, movedFrom } = await seedTheDoor(request);
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.rows).toHaveCount(4);

      // Where each stands: three seats today, and the vendor freed while here under them.
      await expect(door.status(MOVED)).toHaveText(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
      await expect(door.statusBy(MOVED)).toHaveText(
        new RegExp(`^by you, at\\stable\\s${movedFrom.replaceAll(' ', '\\s')}$`),
      );
      await expect(door.status(MOVED)).toHaveClass(/chip--attention/);
      await expect(door.unseatedHeading).toHaveText('Checked in, with no table on this date (1)');
      await expect(
        page.getByTestId('attendance-list-unseated').getByTestId('attendance-row'),
      ).toHaveCount(1);
      await expect(door.table(FREED)).toHaveText('No table');
      await expect(door.status(FREED)).toHaveClass(/chip--attention/);
      await expect(door.row(FREED).getByTestId('attendance-undo')).toBeVisible();
      await expect(door.summary).toHaveText('1 of 3 checked in');

      // When the roster was read, and Refresh reads it again.
      await expect(door.updated).toHaveText('Updated just now');
      const reread = page.waitForResponse(
        (res) =>
          res.request().method() === 'GET' && res.url().endsWith(`/markets/${marketId}/attendance`),
      );
      await press(door.refresh);
      expect((await reread).ok()).toBeTruthy();
      await expect(door.updated).toHaveText('Updated just now');
      await expect(door.refreshError).toHaveCount(0);

      // Print roster beside the door code, and no note asking for paper (T466).
      await expect(page.getByText('a printed roster still works')).toHaveCount(0);
      await expect(door.print).toHaveText('Print roster');
      for (const [control, what] of [
        [door.dateSelect, 'the date'],
        [door.print, 'Print roster'],
        [door.doorCodeButton, 'Door code'],
        [door.refresh, 'Refresh'],
      ] as const) {
        await expectInside(control, what);
      }

      // The page as it is, and every row in the window, its address whole.
      await expectFits(page, 'the door');
      await expectNoLayoutFault(page, 'the door');
      for (const email of [COMES, MOVED, FREED, WAITING]) {
        await toTheMiddle(door.row(email));
        await expectInside(door.row(email), `${email}'s row`);
        await expectWholeAddress(door.vendor(email), email);
      }
      // The phone's rows or the desk's: a tablet's row is too narrow for the desk's four columns.
      expect(await columnsOf(page, COMES), 'the row layout').toBe(size.rows);

      // A check-in and its undo, the row saying each.
      await toTheMiddle(door.row(COMES));
      await press(door.row(COMES).getByTestId('attendance-check-in'));
      await expect(door.status(COMES)).toHaveText(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
      await expect(door.statusBy(COMES)).toHaveText('by you');
      await expect(door.status(COMES)).toHaveClass(/chip--positive/);
      await expect(door.summary).toHaveText('2 of 3 checked in');
      await expectInside(door.row(COMES), 'the row checked in');
      await expectFits(page, 'the door, a vendor checked in');
      await expectNoLayoutFault(page, 'the door, a vendor checked in');

      // A check-out and its undo: the row checked out has no button, and its one "Undo?", a thumb's
      // 44px on the phone like every target, by when they left.
      await press(door.action(COMES, 'check-out'));
      await expect(door.out(COMES)).toHaveText(/^Checked out \d{1,2}:\d{2}\s[AP]M$/);
      await expect(door.outBy(COMES)).toHaveText('by you');
      await expect(door.row(COMES).locator('.btn')).toHaveCount(0);
      await expect(door.action(COMES, 'undo')).toHaveCount(0);
      await expectInside(door.row(COMES), 'the row checked out');
      await expectFits(page, 'the door, a vendor checked out');
      await expectNoLayoutFault(page, 'the door, a vendor checked out');
      await press(door.action(COMES, 'undo-check-out'));
      await expect(door.out(COMES)).toHaveCount(0);
      await expect(door.action(COMES, 'check-out')).toBeEnabled();

      await press(door.row(COMES).getByTestId('attendance-undo'));
      await expect(door.status(COMES)).toHaveText('Not checked in');
      await expect(door.row(COMES).getByTestId('attendance-check-in')).toBeEnabled();
      await expect(door.summary).toHaveText('1 of 3 checked in');
      await expectInside(door.row(COMES), 'the row undone');
      await expectFits(page, 'the door, the check-in undone');
    });
  });
}

/**
 * The moved vendor's status at any time of day (T501): its time is the check-in's, so a time whose
 * digits are wider ("10:00 AM") or narrower ("1:11 PM") makes a wider or narrower pill. Each time
 * is served for the check-in in turn, made by the signed-in owner ("by you") and by an organizer
 * with a long address, so the outcome is the same at whatever minute the spec runs: the pill, its
 * "Undo?" and the line after it, "by <who>, at table <code>", stay inside the row's content box on
 * the narrowest phone, on 390 and at a desk, the table's run on one line.
 *
 * The pill held "at table <code>" until T501's review: on a phone it left the row at about one
 * minute in ten at 390, and at every minute at 320.
 */
const TIMES_OF_DAY = [
  [13, 11],
  [11, 55],
  [10, 0],
  [12, 58],
] as const;

/** An organizer whose address is long, as served for the check-in: no account is needed for it. */
const LONG_ORGANIZER = 'e2e-the-door-organizer-of-long@example.com';

const STATUS_WINDOWS = [
  {
    width: 320,
    phone: true,
    use: {
      viewport: { width: 320, height: 700 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    },
  },
  {
    width: 390,
    phone: true,
    use: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    },
  },
  { width: 1440, phone: false, use: { viewport: { width: 1440, height: 900 } } },
] as const;

for (const size of STATUS_WINDOWS) {
  test.describe(`${size.phone ? 'a phone' : 'a desk'} ${size.width} wide`, () => {
    test.use(size.use);
    const { expectFits, press } = inTheWindow(size);

    test("keeps a vendor's status at another table inside their row, at any time of day", async ({
      authenticatedPage: page,
      request,
    }) => {
      const { marketId, movedFrom } = await seedTheDoor(request);
      const [year, month, day] = TODAY.split('-').map(Number) as [number, number, number];
      let served: { checkedInAt: string; checkedInBy: string } | null = null;
      await page.route(
        (url) => url.pathname.endsWith(`/markets/${marketId}/attendance`),
        async (route) => {
          if (route.request().method() !== 'GET' || !served) return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as {
            roster: { vendorEmail: string; checkedInAt?: string; checkedInBy?: string }[];
          };
          for (const row of body.roster) {
            if (row.vendorEmail === MOVED) Object.assign(row, served);
          }
          await route.fulfill({ response, json: body });
        },
      );
      const door = new AttendanceStatusPage(page);
      await door.goto(marketId);
      await expect(door.rows).toHaveCount(4);
      const table = `at\\stable\\s${movedFrom.replaceAll(' ', '\\s')}`;

      for (const [hour, minute] of TIMES_OF_DAY) {
        for (const [by, said] of [
          [TEST_USER.email, 'you'],
          [LONG_ORGANIZER, LONG_ORGANIZER],
        ] as const) {
          const at = new Date(year, month - 1, day, hour, minute);
          served = { checkedInAt: at.toISOString(), checkedInBy: by };
          const time = at
            .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            .replace(/\s+(?=[AP]M$)/, ' ');
          const what = `at ${time}, by ${said}`;
          const reread = page.waitForResponse(
            (res) =>
              res.request().method() === 'GET' &&
              res.url().endsWith(`/markets/${marketId}/attendance`),
          );
          await press(door.refresh);
          await reread;
          // The pill is the state and the time alone, in the attention tone; where they checked in
          // follows who made it on the plain line after it.
          await expect(door.status(MOVED)).toHaveText(`Checked in ${time}`);
          await expect(door.status(MOVED)).toHaveClass(/chip--attention/);
          await expect(door.statusBy(MOVED)).toHaveText(
            new RegExp(`^by ${said.replaceAll('.', '\\.')}, ${table}$`),
          );
          await toTheMiddle(door.row(MOVED));
          await settle(page);
          const boxes = await door.row(MOVED).evaluate((row) => {
            const style = getComputedStyle(row);
            const box = row.getBoundingClientRect();
            const edges = (selector: string) => {
              const rect = row.querySelector(selector)!.getBoundingClientRect();
              return { left: rect.left, right: rect.right, height: rect.height };
            };
            // From "at": the space before it stays on the line above where the line breaks.
            const run = row.querySelector('.door-chip-where')!.firstChild!;
            const where = document.createRange();
            where.setStart(run, run.textContent!.indexOf('at'));
            where.setEnd(run, run.textContent!.length);
            return {
              row: {
                left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
                right:
                  box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
              },
              parts: {
                pill: edges('[data-testid="attendance-row-status"]'),
                'line after it': edges('[data-testid="attendance-row-status-by"]'),
                'Undo?': edges('[data-testid="attendance-undo"]'),
              },
              tableLines: new Set([...where.getClientRects()].map((rect) => Math.round(rect.top)))
                .size,
            };
          });
          for (const [part, edges] of Object.entries(boxes.parts)) {
            expect(edges.left, `${what}, the ${part} starts inside the row`).toBeGreaterThanOrEqual(
              boxes.row.left - 0.5,
            );
            expect(edges.right, `${what}, the ${part} ends inside the row`).toBeLessThanOrEqual(
              boxes.row.right + 0.5,
            );
          }
          expect(boxes.parts.pill.height, `${what}, the pill is one line`).toBeLessThan(30);
          expect(boxes.tableLines, `${what}, "at table <code>" is on one line`).toBe(1);
          await expectWholeAddress(door.vendor(MOVED), MOVED);
          if (by === LONG_ORGANIZER) {
            await expectWholeAddress(door.statusBy(MOVED), LONG_ORGANIZER);
          }
          await expectFits(page, `the door, ${what}`);
        }
      }
    });
  });
}
