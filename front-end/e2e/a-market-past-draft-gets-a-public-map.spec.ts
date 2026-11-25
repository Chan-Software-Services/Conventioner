import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { PHONE } from './helpers/screens';
import { marketPagePath } from './helpers/marketScreens';
import { DAY_MAP_QUESTIONS, seedMarketDayMap } from './helpers/seedMarketDayMap';
import { LAYOUT_FLOORPLAN_PATH } from './helpers/seeds';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { LayoutPage } from './pages/LayoutPage';
import { MarketPage } from './pages/MarketPage';
import { MarketSetupPage } from './pages/MarketSetupPage';
import { PublicMapPage } from './pages/PublicMapPage';
import { ToolsPage } from './pages/ToolsPage';

/**
 * A market past Draft gets a public map (T422, phase 1's journey): the seam no slice crosses, from
 * a market planned with no layout to a visitor reading a vendor's table on its map.
 *
 * The market (`seedMarketDayMap`, `inAssignment`) is in Assignment with no location laid out: its
 * sections' counts were typed on Section Setup, Aisle A's four and Aisle B's three, and its seven
 * vendors are seated by those counts, Kiln & Co at Aisle A 2 today; its results are not out.
 *
 * The organizer starts North Wing's layout, which follows the plan, and places Aisle A's four tables
 * with Row of tables. On Tools, as the market's Admin, they choose the three public questions and
 * turn the map on, which waits for the results; they publish them. A visitor, signed out on a
 * phone, opens the market's address, which is now its map, presses Kiln & Co's table and reads it.
 * The organizer moves the market to Market Days, and at the door Attendance's map draws the same
 * table as Kiln & Co's, and says Aisle B's three, in South Wing, are on no layout.
 */
test('a market past Draft with no layout gets a public map a visitor reads a vendor on', async ({
  authenticatedPage: page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const seed = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    inAssignment: true,
  });
  const kiln = seed.vendors.find((vendor) => vendor.answers.businessName === 'Kiln & Co')!;
  expect(kiln.today.tableCode).toBe('Aisle A 2');

  // North Wing has no layout: past Draft, Market Setup offers to lay it out, the upload is
  // offered, and the layout follows the plan.
  const setup = new MarketSetupPage(page);
  await setup.goto(seed.marketId);
  const layOut = page.getByTestId(`plan-layout-start-${seed.north.id}`);
  await expect(layOut).toHaveText(`Lay out ${seed.north.name}`);
  await layOut.click();
  const layout = new LayoutPage(page);
  await expect(page).toHaveURL(new RegExp(`/markets/${seed.marketId}/layout/${seed.north.id}$`));
  await expect(layout.root).toBeVisible({ timeout: 15000 });
  await expect(layout.followsPlan).toBeVisible();
  await layout.uploadFileInput.setInputFiles(LAYOUT_FLOORPLAN_PATH);
  await expect(layout.calibrationMap).toBeVisible();
  await layout.calibrate([0, 300], [800, 300], '30');
  await expect(layout.scale).toHaveText('30.0 m across');
  await expect(layout.sectionCounts).toHaveText('0 of 4');

  // Row of tables places Aisle A's four by Enter, numbered 1 to 4 in the order drawn.
  await layout.toolRow.click();
  await expect(layout.addSection.locator('option:checked')).toHaveText('Aisle A');
  await layout.drag([3000, 6000], [16_000, 6000], {
    hold: async () => {
      await expect(layout.rowCount).toHaveText('7 tables');
    },
  });
  await layout.saved(() => page.keyboard.press('Enter'));
  await expect(layout.status).toHaveText('Aisle A has 4 tables in the plan; 4 were placed.');
  await expect(layout.tables).toHaveCount(4);
  await expect(layout.sectionCounts).toHaveText('4 of 4');

  // On Tools, the Admin chooses what the map shows and turns it on; it waits for the results.
  const tools = new ToolsPage(page);
  await tools.goto(seed.marketId);
  await expect(tools.publicMapCard).toBeVisible({ timeout: 15000 });
  await expect(tools.publicMapMissing).toHaveText('The map opens once results are published.');
  await tools.savePublicMap(() => tools.publicMapName.choose(DAY_MAP_QUESTIONS.name.key));
  await tools.savePublicMap(() => tools.publicMapWebsite.choose(DAY_MAP_QUESTIONS.website.key));
  await tools.savePublicMap(() => tools.publicMapInstagram.choose(DAY_MAP_QUESTIONS.instagram.key));
  await tools.savePublicMap(() => tools.publicMapSwitch.check());
  await expect(tools.publicMapSwitch).toBeChecked();
  await expect(tools.publicMapSaveError).toHaveCount(0);
  // The map's address is the market's own, its market page (T469).
  const address = new URL(marketPagePath(seed.slug), page.url()).toString();
  await expect(tools.publicMapUrl).toHaveText(address);

  // Signed out, the map is not there until the results are out: the market page says
  // applications are closed, as it does for any market in Assignment before its results.
  const visitor = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  // Held at the seed's instant, since the map opens on the browser's today: a run past midnight
  // would open it on the seed's next day, where Kiln & Co has no table.
  await visitor.clock.setFixedTime(seed.seededAt);
  const visitorPage = await visitor.newPage();
  const marketPage = new MarketPage(visitorPage);
  const map = new PublicMapPage(visitorPage);
  await marketPage.goto(seed.slug);
  await expect(marketPage.noticeLine).toHaveText('Applications are closed.');
  await expect(map.heading).toHaveCount(0);

  await setup.openPublishResults(seed.marketId);
  await setup.confirmPublishResults();
  await tools.goto(seed.marketId);
  await expect(tools.publicMapUrl).toHaveText(address);
  await expect(tools.publicMapMissing).toHaveCount(0);

  // The visitor opens the address on today's map, presses Kiln & Co's table and reads it.
  await marketPage.goto(seed.slug);
  await expect(visitorPage).toHaveURL(address);
  await expect(map.heading).toHaveText(seed.marketName);
  await expect(map.daySelect).toHaveValue(seed.today);
  // North Wing alone is laid out, so the map has no location select.
  await expect(map.locationSelect).toHaveCount(0);
  await expect(map.targets).toHaveCount(5);
  await map.table('Aisle A 2').tap();
  await expect(map.card).toContainText('Aisle A 2');
  await expect(map.cardNames).toHaveText(['Kiln & Co']);
  await expect(map.cardWebsites).toHaveAttribute('href', 'https://kiln-and-co.test/shop');
  await expect(map.table('Aisle A 2')).toHaveAccessibleName('Aisle A 2, Standard 6 ft, Kiln & Co');
  await expect(map.page).toHaveURL(/[?&]table=/);
  await visitor.close();

  // The market is published, which opens its days; at the door, Attendance's map draws the same
  // table as Kiln & Co's, and opens their drawer.
  const door = new AttendanceStatusPage(page);
  await door.goto(seed.marketId);
  await setup.advancePhaseTo('market_days', 'Market Days');
  // The move lands on the door with no day in its address, so it opens on the browser's today:
  // named the seed's day, so a run past midnight does not read the seed's next day's seats.
  await door.goto(seed.marketId, seed.today);
  await door.viewMap.click();
  await expect(door.map).toBeVisible();
  await expect(door.mapTable('Aisle A 2')).toBeVisible();
  expect(await door.tone('Aisle A 2')).toBe('outlined');
  await expect(door.mapOffLayout).toContainText('3 vendors are at tables not on a layout.');
  await door.mapTable('Aisle A 2').click();
  await expect(door.drawerEmail).toHaveText(kiln.email);
});
