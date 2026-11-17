import type { Locator, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { LoginPage } from './pages/LoginPage';

/**
 * The door as a map (T422 ticket 10): Attendance switches from its list to a map of the open day,
 * on the seam's seeded market. Today North Wing's Aisle A 1 is Ember Ceramics' (checked in), 2 is
 * Kiln & Co's (expected), 3 is shared by Loom House (left) and Paper Moth Press (right), and 4 is
 * free; South Wing's Aisle B holds three more.
 *
 * The map shows each table by whether its vendor is here, a press on a vendor's table opens their
 * drawer as their row does, each half of the shared table its own, and the map follows a check-in
 * made on the list, and one made elsewhere, which the roster's re-read brings with no reload. The
 * legend names "No vendor" on North Wing, where Aisle A 4 is free, and not on South Wing, whose
 * tables are all held. The drawer holds no check-in (D39): a check-in is the list's.
 *
 * The map's search finds one vendor of the day in a dropdown, each row saying where they sit, and
 * picking one opens their drawer and outlines their table, on South Wing when they sit there; typing
 * alone outlines nothing (T466, release walk F3).
 */

const VIEWER = { email: 'e2e-door-map-viewer@example.com', password: 'e2epassword123' };

/** The roster reads itself again every 15 seconds; a check-in made elsewhere shows within that. */
const REREAD = 20_000;

/** The vendors of Aisle A today, in the order `DAY_MAP_VENDORS` seats them. */
function aisleA(seeded: SeededMarketDayMap) {
  const [ember, kiln, loom, moth] = seeded.vendors;
  return { ember: ember!.email, kiln: kiln!.email, loom: loom!.email, moth: moth!.email };
}

/** The map's one outline stands round `target`: its box holds the target's middle, and no more. */
async function expectAround(mark: Locator, target: Locator): Promise<void> {
  const round = (await mark.boundingBox())!;
  const box = (await target.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  expect(x).toBeGreaterThan(round.x);
  expect(x).toBeLessThan(round.x + round.width);
  expect(y).toBeGreaterThan(round.y);
  expect(y).toBeLessThan(round.y + round.height);
  expect(round.width).toBeLessThan(box.width * 1.5);
}

async function openTheMap(page: Page, seeded: SeededMarketDayMap): Promise<AttendanceStatusPage> {
  const door = new AttendanceStatusPage(page);
  await door.goto(seeded.marketId);
  await expect(door.viewList).toHaveAttribute('aria-pressed', 'true');
  await door.viewMap.click();
  await expect(door.viewMap).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]view=map(&|$)/);
  await expect(door.map).toBeVisible();
  return door;
}

for (const size of PHONE_AND_DESK) {
  test.describe(`the door as a map ${size.name}`, () => {
    test.use(size.use);
    const { press, expectFits } = inTheWindow(size);

    test("draws each table by its vendor's arrival and opens the vendor pressed", async ({
      authenticatedPage: page,
      request,
      expectAccessible,
    }) => {
      const seeded = await seedMarketDayMap(
        request,
        BACKEND_URL,
        TEST_USER.email,
        TEST_USER.password,
      );
      const vendors = aisleA(seeded);
      const door = await openTheMap(page, seeded);
      await expectFits(page, 'The door as a map');
      await expectAccessible('the door as a map');

      // The list's own controls stay the list's: the Show toggles are not on the map.
      await expect(page.getByTestId('attendance-show-all')).toHaveCount(0);
      await expect(door.rows).toHaveCount(0);
      await expect(door.legend).toHaveText(['Here', 'Expected', 'No vendor']);
      if (!size.phone) {
        // At a desk the whole map, its zoom and its legend stand in the window as the page opens,
        // as the layout page's does (T422 ticket 11).
        const bottom = async (locator: typeof door.legend) => {
          const box = (await locator.boundingBox())!;
          return box.y + box.height;
        };
        const height = page.viewportSize()!.height;
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(await bottom(page.getByTestId('day-map-zoom'))).toBeLessThanOrEqual(height);
        expect(await bottom(door.legend.last())).toBeLessThanOrEqual(height);
        // The map stands on the screen's 24px inset under the pinned tools, as the list's first
        // line does: the day map keeps no empty row over it for the switch it does not draw (T466).
        const toolsBottom = await bottom(door.tools);
        const mapTop = (await door.dayMap.locator('.day-map__frame').boundingBox())!.y;
        expect(Math.round(mapTop - toolsBottom)).toBe(24);
      }

      // North Wing, the first location, opens: Ember Ceramics here, Kiln & Co expected, the shared
      // table half here and half expected, and Aisle A 4 with nobody.
      expect(await door.tone('Aisle A 1')).toBe('filled');
      expect(await door.tone('Aisle A 2')).toBe('outlined');
      expect(await door.tone('Aisle A 3', 'left')).toBe('outlined');
      expect(await door.tone('Aisle A 3', 'right')).toBe('outlined');
      expect(await door.tone('Aisle A 4')).toBe('free');

      // A vendor's table opens their drawer, the day and the view kept; Back closes it, on the map.
      await press(door.mapTable('Aisle A 2'));
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'false');
      await expect(door.drawerEmail).toHaveText(vendors.kiln);
      await expect(page).toHaveURL(/[?&]view=map(&|$)/);
      await expect(page.getByTestId('vendor-drawer-tab-application')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.goBack();
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(door.map).toBeVisible();
      await expect(page).toHaveURL(/[?&]view=map(&|$)/);
      await expect(page).not.toHaveURL(/vendor=/);

      // Each half of the shared table opens its own vendor.
      for (const [half, email] of [
        ['left', vendors.loom],
        ['right', vendors.moth],
      ] as const) {
        await press(door.mapTable('Aisle A 3', half));
        await expect(door.drawerEmail).toHaveText(email);
        await door.drawerClose.click();
        await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');
      }

      // A table with nobody says so, under the map, and opens nothing.
      await press(door.mapTable('Aisle A 4'));
      await expect(door.mapNote).toHaveText(/^Table Aisle A 4: no vendor on \w{3} \d+, \d{4}\.$/);
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');

      // Kiln & Co checked in on the list: their table is filled on the map.
      await door.viewList.click();
      await door.checkIn(vendors.kiln);
      await expect(door.status(vendors.kiln)).not.toHaveText('Not yet');
      await door.viewMap.click();
      await expect.poll(() => door.tone('Aisle A 2')).toBe('filled');

      // Paper Moth Press checks in elsewhere, at a second organizer's door: the re-read brings it.
      const elsewhere = await request.post(`${BACKEND_URL}/markets/${seeded.marketId}/attendance`, {
        data: { vendorEmail: vendors.moth, date: seeded.today },
      });
      expect(elsewhere.ok(), await elsewhere.text()).toBeTruthy();
      await expect.poll(() => door.tone('Aisle A 3', 'right'), { timeout: REREAD }).toBe('filled');
      expect(await door.tone('Aisle A 3', 'left')).toBe('outlined');

      // The map is kept across a reload, and across the other location.
      await page.reload();
      await expect(door.viewMap).toHaveAttribute('aria-pressed', 'true');
      // The location is the toolbar's select, beside the day (T466).
      await expect(page.getByTestId('day-map-locations')).toHaveCount(0);
      await door.locationSelect.selectOption({ label: 'South Wing' });
      await expect(page).toHaveURL(/[?&]location=loc-south-wing(&|$)/);
      await expect(door.mapTable('Aisle B 1')).toBeVisible();
      // Every table of South Wing's Aisle B is held today: its legend names no free table.
      await expect(door.legend).toHaveText(['Here', 'Expected']);
      await expectFits(page, 'The door as a map, South Wing');
    });

    test('the search finds one vendor, and a pick opens their drawer and outlines their table', async ({
      authenticatedPage: page,
      request,
    }) => {
      const seeded = await seedMarketDayMap(
        request,
        BACKEND_URL,
        TEST_USER.email,
        TEST_USER.password,
      );
      const vendors = aisleA(seeded);
      const door = await openTheMap(page, seeded);
      const search = door.mapSearch;
      const marks = door.map.getByTestId('layout-map-read');
      await expect(search.field).toHaveAttribute('placeholder', 'Name, email or table');
      await expect(page.getByRole('combobox', { name: 'Find a vendor' })).toBeVisible();
      await expect(door.search).toHaveCount(0);

      // Typing finds the day's vendors at a table, each row saying where they sit, its list lying
      // over the map, and outlines nothing.
      await search.field.fill('Aisle A');
      await expect(search.options).toHaveCount(4);
      expect(await search.offered()).toEqual(
        [vendors.ember, vendors.kiln, vendors.loom, vendors.moth].sort(),
      );
      await expect(search.option(vendors.moth)).toContainText('Table Aisle A 3, right half');
      await expect(marks).toHaveCount(0);
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');
      const listBox = (await search.list.boundingBox())!;
      const onTop = await page.evaluate(
        ([x, y]) =>
          Boolean(
            document
              .elementFromPoint(x!, y!)
              ?.closest('[data-testid="attendance-map-search-list"]'),
          ),
        [listBox.x + listBox.width / 2, listBox.y + listBox.height / 2],
      );
      expect(onTop, 'the list lies over the map, nothing over it').toBe(true);
      // From the field's start, as wide as a row reads (32rem) rather than the row's whole room, so
      // a name and where they sit stand close; on a phone as wide as the field.
      const fieldBox = (await search.field.boundingBox())!;
      expect(Math.abs(listBox.x - fieldBox.x)).toBeLessThanOrEqual(1);
      expect(listBox.width).toBeLessThanOrEqual(Math.min(fieldBox.width, 512) + 1);
      expect(listBox.y + listBox.height).toBeGreaterThan(
        (await door.bar.boundingBox())!.y + (await door.bar.boundingBox())!.height,
      );
      await expectFits(page, 'The door as a map, its search open');

      // The arrow keys and Enter pick the second of the shared table's two, outlining their half.
      await search.field.fill('Aisle A 3');
      await expect(search.options).toHaveCount(2);
      const second = await search.options.nth(1).getAttribute('data-value');
      await search.field.press('ArrowDown');
      await expect(search.field).toHaveAttribute(
        'aria-activedescendant',
        (await search.options.nth(1).getAttribute('id'))!,
      );
      await search.field.press('Enter');
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'false');
      await expect(door.drawerEmail).toHaveText(second!);
      await expect(marks).toHaveCount(1);
      await expectAround(
        marks,
        door.mapTable('Aisle A 3', second === vendors.moth ? 'right' : 'left'),
      );
      await expect(search.field).toHaveValue('');
      await expect(search.list).toHaveCount(0);

      // Closing the drawer clears the outline.
      await door.drawerClose.click();
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(marks).toHaveCount(0);

      // A vendor of South Wing, by their name: the map switches there and outlines their table.
      const femi = seeded.vendors.find((one) => one.today.tableCode === 'Aisle B 3')!;
      await search.field.fill(femi.preferredName);
      await expect(search.options).toHaveCount(1);
      await expect(search.option(femi.email)).toContainText('Table Aisle B 3, a whole table');
      await search.field.press('Enter');
      await expect(door.drawerEmail).toHaveText(femi.email);
      await expect(page).toHaveURL(/[?&]location=loc-south-wing(&|$)/);
      await expect(door.locationSelect).toHaveValue('loc-south-wing');
      await expect(marks).toHaveCount(1);
      await expectAround(marks, door.mapTable('Aisle B 3'));

      // Back closes the drawer and leaves the map on South Wing, where the vendor sits.
      await page.goBack();
      await expect(door.drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(door.locationSelect).toHaveValue('loc-south-wing');
      await expect(door.mapTable('Aisle B 3')).toBeVisible();
      await expect(marks).toHaveCount(0);
    });
  });
}

test.describe('a Viewer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('reads the map and opens the drawer, and nothing on the map writes', async ({
    page,
    request,
  }) => {
    ensureVerifiedUser(VIEWER.email, VIEWER.password);
    const seeded = await seedMarketDayMap(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    const role = await request.post(`${BACKEND_URL}/markets/${seeded.marketId}/roles`, {
      data: { user_email: VIEWER.email, role: 'viewer' },
    });
    expect(role.ok(), await role.text()).toBeTruthy();

    const login = new LoginPage(page);
    await login.login(VIEWER.email, VIEWER.password);
    await login.waitForMarkets();

    const writes: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() !== 'GET' && new URL(sent.url()).pathname.startsWith('/api/markets/')) {
        writes.push(`${sent.method()} ${sent.url()}`);
      }
    });
    const door = await openTheMap(page, seeded);
    expect(await door.tone('Aisle A 1')).toBe('filled');
    await expect(door.checkIns).toHaveCount(0);
    await door.mapTable('Aisle A 1').click();
    await expect(door.drawerEmail).toHaveText(aisleA(seeded).ember);
    await door.drawerClose.click();
    await door.mapTable('Aisle A 4').click();
    await expect(door.mapNote).toBeVisible();
    expect(writes).toEqual([]);
  });
});
