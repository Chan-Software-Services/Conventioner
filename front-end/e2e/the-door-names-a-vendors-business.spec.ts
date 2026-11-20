import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import {
  detectLayout,
  gates,
  minTargetAt,
  SPACE_SCALE,
  TYPE_SCALE,
} from './helpers/layoutDetectors';
import { marketScreenPath } from './helpers/marketScreens';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { setApplicationAnswer } from './helpers/seedApplication';
import { seedMarketDayMap } from './helpers/seedMarketDayMap';
import { seedPublishedMarketWithAssignments } from './helpers/seeds';
import { calendarToday } from './helpers/vendorSignIn';

/**
 * The door names a vendor's business (T502).
 *
 * An organizer at the door finds a vendor by the name on their name tag, and for some that is a
 * business name. Attendance shows the built-in business name as a second, smaller, muted line under
 * the vendor's name: in their row, in their drawer's head and on the printed roster, and its list
 * search and its map search find them by it. A vendor who gave none has the row they had, with no
 * empty line, and the map's tables still name the person.
 *
 * It reads Attendance by its test ids and not through `AttendanceStatusPage`, which another change
 * to the door's words is rewriting beside this one.
 */
const TODAY = calendarToday();
const BUSINESS_NAME = 'essential_business_name';
const FULL_NAME = 'essential_full_name';
const PAPER_AND_PINE = 'Paper & Pine';
/** The longest a row is asked to hold: a 60-character name over an 80-character business name. */
const LONG_NAME = 'Maximiliana Featherstonehaugh-Abernathy of Lower Wintercombe';
const LONG_BUSINESS =
  'Featherstonehaugh & Abernathy Hand-bound Notebooks, Letterpress and Paper Goods.';

interface Door {
  marketId: string;
  /** Trades as Paper & Pine. */
  trades: string;
  /** Gave no business name. */
  plain: string;
  /** The long name and the long business name: expected, checked in, and checked out. */
  long: string;
  longIn: string;
  longOut: string;
}

async function ok(response: Promise<{ ok(): boolean; text(): Promise<string> }>, what: string) {
  const res = await response;
  expect(res.ok(), `${what}: ${await res.text()}`).toBeTruthy();
}

/** A market on its day, today: five vendors seated, three of them under the longest names. */
async function seedTheDoor(request: APIRequestContext): Promise<Door> {
  const at = Date.now();
  const vendor = (who: string) => `business-${who}-${at}@example.com`;
  const door = {
    trades: vendor('trades'),
    plain: vendor('plain'),
    long: vendor('long'),
    longIn: vendor('long-in'),
    longOut: vendor('long-out'),
  };
  const { marketId } = await seedPublishedMarketWithAssignments(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    {
      marketDate: TODAY,
      intakeMode: 'form',
      vendors: Object.values(door),
      namePrefix: 'E2E Door Business',
    },
  );
  setApplicationAnswer(marketId, door.trades, BUSINESS_NAME, PAPER_AND_PINE);
  for (const email of [door.long, door.longIn, door.longOut]) {
    setApplicationAnswer(marketId, email, FULL_NAME, LONG_NAME);
    setApplicationAnswer(marketId, email, BUSINESS_NAME, LONG_BUSINESS);
  }
  const attendance = `${BACKEND_URL}/markets/${marketId}/attendance`;
  for (const vendorEmail of [door.longIn, door.longOut]) {
    await ok(request.post(attendance, { data: { vendorEmail, date: TODAY } }), 'check in');
  }
  await ok(
    request.post(`${attendance}/check-out`, { data: { vendorEmail: door.longOut, date: TODAY } }),
    'check out',
  );
  return { marketId, ...door };
}

const rows = (page: Page) => page.getByTestId('attendance-row');
const rowOf = (page: Page, email: string) =>
  page.locator(`[data-testid="attendance-row"][data-vendor="${email}"]`);
const businessOf = (page: Page, email: string) =>
  rowOf(page, email).getByTestId('vendor-identity-business');
const shownVendors = (page: Page) =>
  rows(page).evaluateAll((all) => all.map((row) => row.getAttribute('data-vendor')));

async function openTheDoor(page: Page, marketId: string, query = ''): Promise<void> {
  await page.goto(`${marketScreenPath(marketId, 'attendance')}${query}`);
  await expect(page.getByTestId('attendance-summary')).toBeVisible();
}

/** The layout sweep's gating findings on the page as it stands: none. */
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

const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
const bottomOf = async (locator: Locator) => {
  const box = await boxOf(locator);
  return box.y + box.height;
};

/**
 * How much taller a line is than one line of its own type: nothing, for a line that never wraps.
 * Measured against a copy of it holding one letter, so no line height is written here.
 */
const pastOneLine = (line: Locator) =>
  line.evaluate((el) => {
    const one = el.cloneNode(false) as HTMLElement;
    one.textContent = 'X';
    one.removeAttribute('data-testid');
    el.after(one);
    const extra = el.getBoundingClientRect().height - one.getBoundingClientRect().height;
    one.remove();
    return Math.round(extra);
  });

/** How a line of the identity is drawn: its size, its ink, and whether it reads as a link. */
const drawn = (line: Locator) =>
  line.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      size: style.fontSize,
      ink: style.color,
      underlined: style.textDecorationLine.includes('underline'),
    };
  });

for (const size of PHONE_AND_DESK) {
  test.describe(size.name, () => {
    test.use(size.use);
    const { expectFits, press } = inTheWindow(size);

    test("a vendor's business name stands under their name, in their row, their drawer and on paper, and the search finds them by it", async ({
      authenticatedPage: page,
      request,
      expectAccessible,
    }) => {
      const door = await seedTheDoor(request);
      await openTheDoor(page, door.marketId);
      await expect(rows(page)).toHaveCount(5);

      // The row: the name, the business name, the address, top to bottom.
      const row = rowOf(page, door.trades);
      await toTheMiddle(row);
      const name = row.getByTestId('vendor-identity-name');
      const business = businessOf(page, door.trades);
      const address = row.getByTestId('vendor-identity-email');
      await expect(business).toHaveText(PAPER_AND_PINE);
      await expect(business).toHaveAttribute('title', PAPER_AND_PINE);
      expect(await bottomOf(name)).toBeLessThanOrEqual((await boxOf(business)).y + 0.5);
      expect(await bottomOf(business)).toBeLessThanOrEqual((await boxOf(address)).y + 0.5);
      // Small and muted as the address is, on one line, and only the name reads as a link.
      const quiet = await drawn(address);
      expect(await drawn(business)).toEqual({ size: '12px', ink: quiet.ink, underlined: false });
      expect((await drawn(name)).underlined).toBe(true);
      expect((await drawn(name)).ink).not.toBe(quiet.ink);
      expect(await pastOneLine(business), 'one line').toBe(0);

      // A vendor with none has no such line, and a shorter row for it.
      await expect(businessOf(page, door.plain)).toHaveCount(0);
      await expect(
        rowOf(page, door.plain).locator('[data-testid="vendor-identity"] > *'),
      ).toHaveCount(2);
      expect((await boxOf(rowOf(page, door.plain))).height).toBeLessThan((await boxOf(row)).height);

      // A long business name asks the row for no room: it is cut, and the row's one button stays
      // beside the vendor, as it is beside a vendor with none.
      for (const email of [door.long, door.plain]) {
        await toTheMiddle(rowOf(page, email));
        const button = await boxOf(rowOf(page, email).getByTestId('attendance-check-in'));
        const vendor = await boxOf(rowOf(page, email).getByTestId('attendance-vendor'));
        expect(button.y, `${email}'s button stands beside them`).toBeLessThan(
          vendor.y + vendor.height,
        );
        expect(button.x, `${email}'s button stands after them`).toBeGreaterThanOrEqual(
          vendor.x + vendor.width,
        );
      }
      await expect(businessOf(page, door.long)).toHaveAttribute('title', LONG_BUSINESS);
      expect(await pastOneLine(businessOf(page, door.long)), 'one line').toBe(0);

      await expectFits(page, 'the door');
      await expectNoLayoutFault(page, 'the door');
      await expectAccessible('the door, with business names');

      // The list's search finds them by a part of it, in any case.
      const search = page.getByTestId('attendance-search');
      for (const words of ['pine', 'PAPER &']) {
        await search.fill(words);
        await expect(rows(page)).toHaveCount(1);
        expect(await shownVendors(page)).toEqual([door.trades]);
      }
      await search.fill('');
      await expect(rows(page)).toHaveCount(5);

      // Their drawer's head: the business name under the title and before the address.
      const drawer = page.getByTestId('vendors-detail-panel');
      const drawerBusiness = page.getByTestId('vendors-detail-business');
      await toTheMiddle(row);
      await press(row.getByTestId('attendance-vendor'));
      await expect(drawer).toHaveAttribute('aria-hidden', 'false');
      await expect(page.getByTestId('vendors-detail-email')).toHaveText(door.trades);
      await expect(drawerBusiness).toHaveText(PAPER_AND_PINE);
      expect(await bottomOf(page.getByTestId('vendors-detail-title'))).toBeLessThanOrEqual(
        (await boxOf(drawerBusiness)).y + 0.5,
      );
      expect(await bottomOf(drawerBusiness)).toBeLessThanOrEqual(
        (await boxOf(page.getByTestId('vendors-detail-email'))).y + 0.5,
      );
      await expectFits(page, 'the drawer');
      await expectAccessible('the drawer, with a business name');
      await page.getByTestId('vendors-detail-close').click();
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');

      // A long one, which the row cuts, is whole in the head: it wraps inside it, cut nowhere.
      await toTheMiddle(rowOf(page, door.long));
      await press(rowOf(page, door.long).getByTestId('attendance-vendor'));
      await expect(page.getByTestId('vendors-detail-email')).toHaveText(door.long);
      await expect(drawerBusiness).toHaveText(LONG_BUSINESS);
      expect(
        await drawerBusiness.evaluate((line) => line.scrollWidth - line.clientWidth),
        'nothing past its edge',
      ).toBe(0);
      const head = await boxOf(page.getByTestId('vendors-detail-head'));
      const wrapped = await boxOf(drawerBusiness);
      expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(head.x + head.width);
      expect(wrapped.y + wrapped.height).toBeLessThanOrEqual(
        (await boxOf(page.getByTestId('vendors-detail-email'))).y + 0.5,
      );
      await expectFits(page, 'the drawer, a long business name');
      await page.getByTestId('vendors-detail-close').click();
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');

      // A vendor with none has none in the head either.
      await toTheMiddle(rowOf(page, door.plain));
      await press(rowOf(page, door.plain).getByTestId('attendance-vendor'));
      await expect(page.getByTestId('vendors-detail-email')).toHaveText(door.plain);
      await expect(drawerBusiness).toHaveCount(0);
      await page.getByTestId('vendors-detail-close').click();
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');

      // On paper: under the name, whole, and nothing for a vendor with none.
      await page.emulateMedia({ media: 'print' });
      const printed = (email: string) =>
        page.locator(`[data-testid="attendance-print-row"][data-vendor="${email}"]`);
      const printedBusiness = printed(door.trades).getByTestId('attendance-print-business');
      await expect(printedBusiness).toHaveText(PAPER_AND_PINE);
      expect(
        await bottomOf(printed(door.trades).getByTestId('attendance-print-name')),
      ).toBeLessThanOrEqual((await boxOf(printedBusiness)).y + 0.5);
      const whole = printed(door.long).getByTestId('attendance-print-business');
      await expect(whole).toHaveText(LONG_BUSINESS);
      expect(
        await whole.evaluate(
          (el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
        ),
        'the long business name prints whole',
      ).toBe(true);
      await expect(printed(door.plain).getByTestId('attendance-print-business')).toHaveCount(0);
      await page.emulateMedia({ media: 'screen' });
    });
  });
}

test.describe('on the narrowest phone', () => {
  const NARROW = {
    phone: true,
    use: { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true },
  } as const;
  test.use(NARROW.use);
  const { expectFits } = inTheWindow(NARROW);

  test('a row with a long name and a long business name keeps every part inside its card', async ({
    authenticatedPage: page,
    request,
    expectAccessible,
  }) => {
    expect([LONG_NAME.length, LONG_BUSINESS.length]).toEqual([60, 80]);
    const door = await seedTheDoor(request);
    await openTheDoor(page, door.marketId);
    await expect(rows(page)).toHaveCount(5);

    // Each state of the row: its one button, its table, its chips and their "Undo?".
    const states = [
      { email: door.long, parts: ['attendance-check-in', 'attendance-row-status'] },
      {
        email: door.longIn,
        parts: ['attendance-check-out', 'attendance-undo', 'attendance-row-status'],
      },
      {
        email: door.longOut,
        parts: ['attendance-row-status', 'attendance-undo-check-out', 'attendance-row-out'],
      },
    ];
    for (const { email, parts } of states) {
      const row = rowOf(page, email);
      await toTheMiddle(row);
      const card = await boxOf(row);
      for (const part of [
        'attendance-vendor',
        'vendor-identity-name',
        'vendor-identity-business',
        'vendor-identity-email',
        'attendance-row-table',
        ...parts,
      ]) {
        const piece = row.getByTestId(part);
        await expect(piece, `${email}'s ${part}`).toBeVisible();
        const box = await boxOf(piece);
        const inside = {
          left: box.x >= card.x - 0.5,
          top: box.y >= card.y - 0.5,
          right: box.x + box.width <= card.x + card.width + 0.5,
          bottom: box.y + box.height <= card.y + card.height + 0.5,
        };
        expect(inside, `${email}'s ${part} lies inside its card`).toEqual({
          left: true,
          top: true,
          right: true,
          bottom: true,
        });
      }
      // The business name is one line, cut, with its whole text in its title.
      const business = businessOf(page, email);
      await expect(business).toHaveAttribute('title', LONG_BUSINESS);
      expect(await pastOneLine(business), 'one line').toBe(0);
      expect(
        await business.evaluate((el) => el.scrollHeight > el.clientHeight),
        'cut where the card ends',
      ).toBe(true);
    }
    await expectFits(page, 'the door at 320');
    await expectNoLayoutFault(page, 'the door at 320');
    await expectAccessible('the door at 320, long business names');
  });
});

test("the map's search finds a vendor by their business name and says it, and the map still names the person", async ({
  authenticatedPage: page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const [wren] = seeded.vendors;
  setApplicationAnswer(seeded.marketId, wren!.email, BUSINESS_NAME, PAPER_AND_PINE);
  await openTheDoor(page, seeded.marketId, '?view=map');
  const map = page.getByTestId('attendance-map');
  await expect(map.getByTestId('layout-map')).toBeVisible();

  const field = page.getByTestId('attendance-map-search-input');
  const options = page.getByTestId('attendance-map-search-option');
  for (const words of ['pine', 'PAPER &']) {
    await field.fill(words);
    await expect(options).toHaveCount(1);
    await expect(options).toHaveAttribute('data-value', wren!.email);
  }
  // Named as their row names them, and saying why they were found before where they sit.
  await expect(options).toContainText(wren!.preferredName);
  await expect(options).toContainText(
    new RegExp(`${PAPER_AND_PINE}, Table ${wren!.today.tableCode}`),
  );

  // The map names the person on their table, and the business name nowhere.
  await expect(
    map.getByRole('button', {
      name: new RegExp(`^${wren!.today.tableCode}, .*${wren!.preferredName}`),
    }),
  ).toHaveCount(1);
  await expect(map).not.toContainText(PAPER_AND_PINE);

  // Picked, their drawer opens with it in its head.
  await options.click();
  await expect(page.getByTestId('vendors-detail-panel')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.getByTestId('vendors-detail-email')).toHaveText(wren!.email);
  await expect(page.getByTestId('vendors-detail-business')).toHaveText(PAPER_AND_PINE);
  await expect(map).not.toContainText(PAPER_AND_PINE);
});
