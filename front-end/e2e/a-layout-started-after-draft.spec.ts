import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { LayoutPage } from './pages/LayoutPage';
import { seedAssignedMarket } from './helpers/seedAssignedMarket';
import { LAYOUT_FLOORPLAN_PATH, storedLayoutTables } from './helpers/seeds';

/**
 * A layout started after Draft follows the plan (T422 ticket 03, ADR 0033). On a market already
 * assigned, its six Hall A seats settled and vendors at them, the organizer opens Main Hall, which
 * has no layout, uploads its floorplan and sets its scale. The layout follows the plan: the page
 * says so, the tools that add tables are on and the table types stay settled. A row drawn longer
 * than the plan places six tables and says so; a removal leaves the other numbers alone; the
 * Number field gives a table the free number and swaps two; the Sections card counts what is
 * placed of the plan's six; and a reload draws the same layout, its section's count as typed.
 */
const PLAN = 6;
const named = (number: number) => `Hall A ${number}, Standard 6 ft`;

test.describe('A layout started after Draft', () => {
  test('follows the plan: a row placed up to the count, a number set, the counts read, the layout kept', async ({
    authenticatedPage: page,
    request,
  }) => {
    test.setTimeout(120_000);
    const { marketId } = await seedAssignedMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
      { tables: PLAN },
    );
    const layout = new LayoutPage(page);
    await layout.goto(marketId);

    // No layout yet: the setup is settled, and the upload is offered all the same.
    await expect(layout.setupSettled).toContainText('The setup is settled');
    await expect(layout.uploadDropzone).toBeVisible();
    await layout.uploadFileInput.setInputFiles(LAYOUT_FLOORPLAN_PATH);
    await expect(layout.calibrationMap).toBeVisible();
    await layout.calibrate([0, 300], [800, 300], '30');
    await expect(layout.scale).toHaveText('30.0 m across');

    await expect(layout.followsPlan).toHaveText(
      "This layout follows the plan: place each section's tables, up to its count. The seats " +
        'themselves are settled.',
    );
    await expect(layout.setupSettled).toHaveCount(0);
    await expect(layout.toolAdd).toBeEnabled();
    await expect(layout.toolRow).toBeEnabled();
    await expect(layout.toolFill).toBeEnabled();
    await expect(layout.typesAdd).toBeDisabled();
    await expect(layout.sectionCounts).toHaveText('0 of 6');

    // A straight row drawn long enough for eight places the plan's six, and says so.
    await layout.toolRow.click();
    await expect(layout.addSection.locator('option:checked')).toHaveText('Hall A');
    await layout.saved(() =>
      layout.drag([2000, 3000], [18_000, 3000], {
        hold: async () => {
          await expect(layout.rowCount).toHaveText('8 tables');
        },
      }),
    );
    await expect(layout.status).toHaveText('Hall A has 6 tables in the plan; 6 were placed.');
    await expect(layout.tables).toHaveCount(PLAN);
    await expect(layout.sectionCounts).toHaveText('6 of 6');

    // Another row has no seat left to draw.
    await layout.drag([2000, 9000], [8000, 9000]);
    await expect(layout.status).toHaveText("Hall A's 6 tables are all on the layout.");
    await expect(layout.tables).toHaveCount(PLAN);

    // Hall A 3 removed: the others keep their numbers.
    await layout.toolSelect.click();
    await layout.table(named(3)).click();
    await expect(layout.selectionTitle).toHaveText('Hall A 3');
    await expect(layout.selectionSection).toBeEnabled();
    await expect(layout.selectionType).toBeDisabled();
    await layout.saved(() => layout.selectionRemove.click());
    await expect(layout.sectionCounts).toHaveText('5 of 6');
    for (const number of [1, 2, 4, 5, 6]) await expect(layout.table(named(number))).toBeVisible();

    // Hall A 6 takes the free 3; then Hall A 1 takes 2, which Hall A 2 held: the two swap.
    await layout.table(named(6)).click();
    await expect(layout.selectionNumber).toHaveValue('6');
    await layout.selectionNumber.fill('7');
    await layout.selectionNumber.press('Enter');
    await expect(layout.selectionNumberError).toHaveText('Type a number from 1 to 6.');
    await layout.saved(async () => {
      await layout.selectionNumber.fill('3');
      await layout.selectionNumber.press('Enter');
    });
    await expect(layout.selectionTitle).toHaveText('Hall A 3');
    await expect(layout.selectionNumberError).toHaveCount(0);

    const where = async () =>
      new Map(
        (await storedLayoutTables(request, BACKEND_URL, marketId)).map((table) => [
          table.number,
          table.xMm,
        ]),
      );
    const before = await where();
    await layout.table(named(1)).click();
    await layout.saved(async () => {
      await layout.selectionNumber.fill('2');
      await layout.selectionNumber.press('Enter');
    });
    await expect(layout.selectionTitle).toHaveText('Hall A 2');
    const after = await where();
    expect([after.get(1), after.get(2)]).toEqual([before.get(2), before.get(1)]);
    expect([...after.keys()].sort()).toEqual([1, 2, 3, 4, 5]);

    // A reload draws the layout as stored, and the section keeps its typed count.
    await page.reload();
    await expect(layout.tables).toHaveCount(5);
    await expect(layout.followsPlan).toBeVisible();
    await expect(layout.sectionCounts).toHaveText('5 of 6');
    for (const number of [1, 2, 3, 4, 5]) await expect(layout.table(named(number))).toBeVisible();
    const read = await request.get(`${BACKEND_URL}/markets/${marketId}`);
    const { market } = (await read.json()) as {
      market: { setupObject: { sections: { count: number }[]; floorplans: unknown[] } };
    };
    expect(market.setupObject.sections.map((section) => section.count)).toEqual([PLAN]);
  });
});
