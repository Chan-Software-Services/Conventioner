import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { LayoutPage } from './pages/LayoutPage';
import { seedLayout, storedLayoutTables, type SeedTable, type SeededLayout } from './helpers/seeds';

/**
 * A table is placed, moved, turned and removed with the pointer (T257 ticket 04), and several at
 * once selected by a box, moved, turned, duplicated, lined up and removed together (ticket 05);
 * the selection wears a frame with a turn knob on each corner, and a box takes only the tables
 * wholly inside it (T422),
 * on Upper Hall, 30 m by 22.5 m. Every gesture is the pointer's own (`page.mouse`), and what it
 * did is read from the table's name on the map, the selection's card and the layout the server
 * stored, never from the page's state.
 */
const SIX_FOOT = { width: 1830, depth: 760 };

/** Upper Hall's tables as the server holds them. */
const storedTables = (request: APIRequestContext, marketId: string) =>
  storedLayoutTables(request, BACKEND_URL, marketId);

/** Gold row's table of a number, as stored. */
async function gold(request: APIRequestContext, marketId: string, number: number) {
  const table = (await storedTables(request, marketId)).find(
    (one) => one.sectionId === 'sec-gold' && one.number === number,
  );
  if (!table) throw new Error(`No Gold row ${number} is stored`);
  return table;
}

const gold_1 = (request: APIRequestContext, marketId: string) => gold(request, marketId, 1);

async function open(
  page: Page,
  request: APIRequestContext,
  tables: SeedTable[],
): Promise<{ layout: LayoutPage; seeded: SeededLayout }> {
  const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    metresAcross: 30,
    tables,
  });
  const layout = new LayoutPage(page);
  await layout.goto(seeded.marketId, seeded.upper.id);
  await expect(layout.stage).toBeVisible();
  await expect(layout.tables).toHaveCount(tables.length);
  return { layout, seeded };
}

const GOLD_1 = 'Gold row 1, Standard 6 ft';
const GOLD_2 = 'Gold row 2, Standard 6 ft';

const middleOf = (box: { x: number; y: number; width: number; height: number }) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** The corners whose knob stands inside the stage with nothing over it, so a press there takes it. */
async function knobsInReach(page: Page, layout: LayoutPage): Promise<string[]> {
  const stage = (await layout.stage.boundingBox())!;
  const reachable: string[] = [];
  for (const corner of ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const) {
    const box = await layout.turnKnobAt(corner).boundingBox();
    if (!box) continue;
    const middle = middleOf(box);
    const inStage =
      middle.x > stage.x &&
      middle.x < stage.x + stage.width &&
      middle.y > stage.y &&
      middle.y < stage.y + stage.height;
    const pressed = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-turn-handle]')),
      [middle.x, middle.y],
    );
    if (inStage && pressed) reachable.push(corner);
  }
  return reachable;
}

/** Drag a turn knob round a centre on the screen by some degrees, in two moves, with a key held
 *  from before the press until after the release; `hold` runs before the button is let go. */
async function turnByKnob(
  page: Page,
  knob: Locator,
  centre: { x: number; y: number },
  degrees: number,
  key?: string,
  hold?: () => Promise<void>,
) {
  const from = middleOf((await knob.boundingBox())!);
  const start = Math.atan2(from.y - centre.y, from.x - centre.x);
  const reach = Math.hypot(from.x - centre.x, from.y - centre.y);
  const at = (by: number) => {
    const angle = start + (by * Math.PI) / 180;
    return { x: centre.x + reach * Math.cos(angle), y: centre.y + reach * Math.sin(angle) };
  };
  if (key) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(at(degrees / 2).x, at(degrees / 2).y, { steps: 3 });
  await page.mouse.move(at(degrees).x, at(degrees).y, { steps: 3 });
  await hold?.();
  await page.mouse.up();
  if (key) await page.keyboard.up(key);
}

test.describe('A table moves by pointer', () => {
  test('Add table places each table where it is clicked, numbered in turn, at its true size', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, []);

    await layout.toolAdd.click();
    await expect(layout.toolAdd).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.addSection).toHaveValue('sec-gold');
    await layout.saved(async () => {
      await layout.clickAt([6000, 6000]);
      await expect(layout.table(GOLD_1)).toBeVisible();
      // The tool stays on: the next click places the next table.
      await layout.clickAt([12_000, 9000]);
      await expect(layout.table(GOLD_2)).toBeVisible();
    });
    // The tool's card stands in the selection's place while it is on; Escape goes back to Select,
    // with the table just placed selected.
    await expect(layout.selection).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(layout.toolSelect).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.toolCard).toHaveCount(0);
    await expect(layout.selectionTitle).toHaveText('Gold row 2');
    await expect(layout.selectionSection.locator('option:checked')).toHaveText('Gold row');
    await expect(layout.selectionType.locator('option:checked')).toHaveText('Standard 6 ft');
    await expect(layout.selectionPosition).toHaveText('12.0 m, 9.0 m');

    // At its true size: a six foot table, 1,830 by 760 mm at the map's scale.
    const { scale } = await layout.onScreen([0, 0]);
    const top = (await layout.tableTop(GOLD_2).boundingBox())!;
    expect(top.width - 1.5).toBeCloseTo(SIX_FOOT.width * scale, 0);
    expect(top.height - 1.5).toBeCloseTo(SIX_FOOT.depth * scale, 0);

    // Each stands where it was clicked, to the pixel, which is about 40 mm of this hall.
    const pixel = 1 / scale;
    const first = await gold(request, seeded.marketId, 1);
    const second = await gold(request, seeded.marketId, 2);
    expect(Math.abs(first.xMm - 6000)).toBeLessThan(pixel);
    expect(Math.abs(first.yMm - 6000)).toBeLessThan(pixel);
    expect(Math.abs(second.xMm - 12_000)).toBeLessThan(pixel);
    expect(Math.abs(second.yMm - 9000)).toBeLessThan(pixel);

    // Silver aisle's first table is numbered on its own, T taking Add table back up.
    await page.keyboard.press('t');
    await expect(layout.addSection).toHaveValue('sec-gold');
    await layout.addSection.selectOption({ label: 'Silver aisle' });
    await layout.saved(async () => {
      await layout.clickAt([20_000, 15_000]);
      await expect(layout.table('Silver aisle 1, Standard 6 ft')).toBeVisible();
    });

    // "No section" is a choice that stays chosen: two tables of none, numberless.
    await layout.addSection.selectOption({ label: 'No section' });
    await layout.saved(async () => {
      await layout.clickAt([24_000, 4000]);
      await expect(layout.addSection).toHaveValue('');
      await layout.clickAt([24_000, 8000]);
    });
    await expect(layout.table('Table in no section, Standard 6 ft')).toHaveCount(2);
    await page.keyboard.press('v');
    await expect(layout.selectionTitle).toHaveText('Table in no section');

    await page.reload();
    await expect(layout.tables).toHaveCount(5);
    await expect(layout.table(GOLD_2)).toBeVisible();
    await expect(layout.table('Silver aisle 1, Standard 6 ft')).toBeVisible();
  });

  test("a dragged table snaps to another's edge with a guide, moves freely with Alt, and stays where it was dropped", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [5000, 5000] },
      { section: 'sec-gold', at: [12_000, 8000] },
    ]);

    // Gold row 2 is dropped five pixels short of standing against Gold row 1's right edge.
    await layout.saved(() =>
      layout.drag([12_000, 8000], [5000 + SIX_FOOT.width, 8000], {
        nudgePx: [5, 0],
        hold: async () => {
          await expect(layout.guides).toHaveCount(1);
        },
      }),
    );
    await expect(layout.guides).toHaveCount(0);
    // Snapped: its left edge is the other's right edge, to the tenth of a millimetre.
    let moved = await gold(request, seeded.marketId, 2);
    expect(moved.xMm).toBeCloseTo(5000 + SIX_FOOT.width, 1);
    expect(moved.yMm).toBeCloseTo(8000, 1);
    await expect(layout.selectionPosition).toHaveText('6.8 m, 8.0 m');

    // With Alt held the same five pixels are kept: no guide, no snap.
    const snapped = moved;
    await page.keyboard.down('Alt');
    await layout.saved(() =>
      layout.drag([snapped.xMm, snapped.yMm], [snapped.xMm, snapped.yMm], {
        nudgePx: [5, 0],
        hold: async () => {
          await expect(layout.guides).toHaveCount(0);
        },
      }),
    );
    await page.keyboard.up('Alt');
    const { scale } = await layout.onScreen([0, 0]);
    moved = await gold(request, seeded.marketId, 2);
    // Five pixels, to within the pixel the pointer's place is rounded to.
    expect(Math.abs(moved.xMm - snapped.xMm - 5 / scale)).toBeLessThan(1 / scale);

    // Gold row 1 never moved, and a reload shows Gold row 2 where it was dropped.
    const still = await gold(request, seeded.marketId, 1);
    expect([still.xMm, still.yMm]).toEqual([5000, 5000]);
    await page.reload();
    await expect(layout.tables).toHaveCount(2);
    const at = await layout.onScreen([moved.xMm, moved.yMm]);
    const top = (await layout.tableTop(GOLD_2).boundingBox())!;
    expect(top.x + top.width / 2).toBeCloseTo(at.x, 0);
    expect(top.y + top.height / 2).toBeCloseTo(at.y, 0);
  });

  test("a table cannot be dragged past the image's edge", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [27_000, 5000] },
    ]);
    // Dropped two metres past the east wall and above the north one.
    await layout.saved(() => layout.drag([27_000, 5000], [32_000, -2000]));
    const table = await gold(request, seeded.marketId, 1);
    expect([table.xMm, table.yMm]).toEqual([30_000, 0]);
  });

  test('a corner\'s knob turns a table in 15° steps about its centre, by the degree with Shift, and R and "Turn 90°" by a quarter', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [15_000, 11_000] },
    ]);
    await layout.clickAt([15_000, 11_000]);
    await expect(layout.table(GOLD_1)).toHaveAttribute('aria-pressed', 'true');
    // The frame hugs the table, a knob on each of its four corners.
    await expect(layout.selectionFrame).toBeVisible();
    await expect(layout.turnKnobs).toHaveCount(4);

    // The top-right knob is dragged round the table's centre by 40°, which holds at 45°.
    const centre = await layout.onScreen([15_000, 11_000]);
    await layout.saved(() => turnByKnob(page, layout.turnKnob, centre, 40));
    let table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(45);
    // About its centre: it stands where it stood.
    expect([table.xMm, table.yMm]).toEqual([15_000, 11_000]);
    // Its number turns with it: the table is drawn turned, the number inside it, and the frame
    // turned with it.
    await expect(layout.table(GOLD_1)).toHaveAttribute('transform', /rotate\(45\)/);
    await expect(layout.tableNumber(GOLD_1)).toHaveText('1');
    await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(45\)/);

    // With Shift the turn is by the whole degree: 23.4° on is 23°.
    await layout.saved(() => turnByKnob(page, layout.turnKnob, centre, 23.4, 'Shift'));
    table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(68);
    // Alt frees it no more: 23.4° on is held to 30°.
    await layout.saved(() => turnByKnob(page, layout.turnKnob, centre, 23.4, 'Alt'));
    table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(98);
    // Shift pressed and let go with the knob held and the pointer still turns it again at once:
    // 23.4° on reads 23° with Shift down and 30° once it is let go (D11).
    await layout.saved(() =>
      turnByKnob(page, layout.turnKnob, centre, 23.4, undefined, async () => {
        await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(128\)/);
        await page.keyboard.down('Shift');
        await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(121\)/);
        await page.keyboard.up('Shift');
        await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(128\)/);
      }),
    );
    table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(128);

    await layout.saved(() => page.keyboard.press('r'));
    table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(218);

    await layout.saved(() => layout.selectionTurn.click());
    table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(308);
    expect([table.xMm, table.yMm]).toEqual([15_000, 11_000]);
    await expect(layout.table(GOLD_1)).toHaveAttribute('transform', /rotate\(308\)/);
  });

  test('the frame of a table in a column of turned ones hugs it, its knobs never move off its corners, and the knob held stays under the pointer as it turns', async ({
    authenticatedPage: page,
    request,
  }) => {
    // Four tables turned a quarter, end to end down the west wall: above and below the third
    // stand the second and the fourth.
    const column: SeedTable[] = [0, 1, 2, 3].map((i) => ({
      section: 'sec-gold',
      at: [2000, 4000 + i * 1830],
      rotation: 90,
    }));
    const { layout, seeded } = await open(page, request, column);
    const third: [number, number] = [2000, 4000 + 2 * 1830];
    await layout.clickAt(third);
    await expect(layout.table('Gold row 3, Standard 6 ft')).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.turnKnobs).toHaveCount(4);

    // The frame stands 6 px outside the table's edges, turned with it, and each knob on one of
    // its corners: covering a neighbour's end if need be, never moved to another side.
    const centre = await layout.onScreen(third);
    const half = { across: (760 / 2) * centre.scale + 6, along: (1830 / 2) * centre.scale + 6 };
    const corners = {
      'top-left': { x: centre.x + half.across, y: centre.y - half.along },
      'top-right': { x: centre.x + half.across, y: centre.y + half.along },
      'bottom-right': { x: centre.x - half.across, y: centre.y + half.along },
      'bottom-left': { x: centre.x - half.across, y: centre.y - half.along },
    } as const;
    for (const [corner, at] of Object.entries(corners)) {
      const knob = middleOf(
        (await layout.turnKnobAt(corner as keyof typeof corners).boundingBox())!,
      );
      expect(Math.abs(knob.x - at.x), corner).toBeLessThan(1);
      expect(Math.abs(knob.y - at.y), corner).toBeLessThan(1);
    }
    const frame = (await layout.selectionFrame.locator('rect').boundingBox())!;
    // The box takes the frame's 1 px line whole, half a pixel each side of its middle.
    expect(frame.width).toBeCloseTo(2 * half.across + 1, 0);
    expect(frame.height).toBeCloseTo(2 * half.along + 1, 0);

    // Dragged exactly 30° round the table's centre, the knob held is still under the pointer, the
    // frame turned whole with it; let go, the table is turned to 120°.
    const knob = layout.turnKnobAt('bottom-right');
    const from = middleOf((await knob.boundingBox())!);
    const start = Math.atan2(from.y - centre.y, from.x - centre.x);
    const reach = Math.hypot(from.x - centre.x, from.y - centre.y);
    const at = (degrees: number) => {
      const angle = start + (degrees * Math.PI) / 180;
      return { x: centre.x + reach * Math.cos(angle), y: centre.y + reach * Math.sin(angle) };
    };
    await layout.saved(async () => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(at(15).x, at(15).y, { steps: 3 });
      await page.mouse.move(at(30).x, at(30).y, { steps: 3 });
      await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(120\)/);
      const held = middleOf((await knob.boundingBox())!);
      expect(Math.hypot(held.x - at(30).x, held.y - at(30).y)).toBeLessThan(1.5);
      await page.mouse.up();
    });
    expect((await gold(request, seeded.marketId, 3)).rotation).toBe(120);
    await expect(layout.selectionFrame).toHaveAttribute('transform', /rotate\(120\)/);
  });

  test("a table in the floorplan's corner keeps a knob in reach, and turns by it at 800%", async ({
    authenticatedPage: page,
    request,
  }) => {
    // Tight in the top-left corner: the frame's outer corners lie past the floorplan's edge.
    const { layout, seeded } = await open(page, request, [{ section: 'sec-gold', at: [915, 380] }]);
    await layout.clickAt([915, 380]);
    await expect(layout.turnKnobs).toHaveCount(4);
    expect(await knobsInReach(page, layout)).toContain('bottom-right');

    // Zoomed all the way in by Ctrl and the wheel over the table, which stays under the pointer.
    const table = await layout.onScreen([915, 380]);
    await page.mouse.move(table.x, table.y);
    await page.keyboard.down('Control');
    for (
      let notch = 0;
      notch < 40 && !(await layout.zoom.textContent())?.endsWith('800%');
      notch += 1
    ) {
      await page.mouse.wheel(0, -100);
    }
    await page.keyboard.up('Control');
    await expect(layout.zoom).toHaveText(/800%$/);
    expect(await knobsInReach(page, layout)).toContain('bottom-right');

    const centre = await layout.onScreen([915, 380]);
    await layout.saved(() => turnByKnob(page, layout.turnKnobAt('bottom-right'), centre, 15));
    expect((await gold(request, seeded.marketId, 1)).rotation).toBe(15);
  });

  test('removing Gold row 2 of 4 makes 3 and 4 into 2 and 3, and Section Setup reads 3', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [4000, 4000] },
      { section: 'sec-gold', at: [8000, 4000] },
      { section: 'sec-gold', at: [12_000, 4000] },
      { section: 'sec-gold', at: [16_000, 4000] },
    ]);
    await layout.clickAt([8000, 4000]);
    await expect(layout.selectionTitle).toHaveText('Gold row 2');
    await layout.saved(async () => {
      await layout.selectionRemove.click();
      await expect(layout.tables).toHaveCount(3);
    });
    await expect(layout.selection).toContainText('Select tables to change them.');
    // The button pressed went with the selection; the focus is on the map, not lost.
    await expect(layout.table(GOLD_1)).toBeFocused();

    // The table that was Gold row 3, at 12 m, is Gold row 2 now, and the last is Gold row 3.
    const tables = await storedTables(request, seeded.marketId);
    expect(tables.map((one) => [one.number, one.xMm])).toEqual([
      [1, 4000],
      [2, 12_000],
      [3, 16_000],
    ]);
    await layout.clickAt([12_000, 4000]);
    await expect(layout.selectionTitle).toHaveText('Gold row 2');
    await expect(layout.sections).toContainText('3 tables');

    await layout.backToSetup.click();
    await expect(page.getByTestId('setup-section-count-0')).toHaveText('3');
    await expect(page.getByTestId('setup-section-count-source-0')).toHaveText('from the layout');
    await expect(page.getByTestId('setup-section-count-input-0')).toHaveCount(0);
    await expect(page.getByTestId(`plan-layout-open-${seeded.upper.id}`)).toHaveText(
      "Open Upper Hall's layout · 3 tables",
    );
    // Lower Hall has no layout: its section's count is still typed.
    await expect(page.getByTestId('setup-section-count-input-2')).toHaveValue('4');
    await expect(page.getByTestId('setup-section-total')).toHaveText('Total tables: 7');
  });

  test('the keys and the buttons undo and redo every change, and each undo saves', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [6000, 6000] },
    ]);
    await expect(layout.undo).toBeDisabled();
    await expect(layout.redo).toBeDisabled();

    // Three changes: a table added, the first moved, then turned.
    await layout.toolAdd.click();
    await layout.saved(() => layout.clickAt([20_000, 15_000]));
    await layout.toolSelect.click();
    await layout.saved(() => layout.drag([6000, 6000], [6000, 12_000]));
    await layout.saved(() => page.keyboard.press('r'));
    const turned = await gold(request, seeded.marketId, 1);
    expect(turned.rotation).toBe(90);
    const dropped = [turned.xMm, turned.yMm];

    // Ctrl+Z takes back the turn, and saves.
    await layout.saved(() => page.keyboard.press('Control+z'));
    expect((await gold(request, seeded.marketId, 1)).rotation).toBe(0);
    // The button takes back the move.
    await layout.saved(() => layout.undo.click());
    let first = await gold(request, seeded.marketId, 1);
    expect([first.xMm, first.yMm]).toEqual([6000, 6000]);
    // And the added table.
    await layout.saved(async () => {
      await page.keyboard.press('Control+z');
      await expect(layout.tables).toHaveCount(1);
    });
    expect(await storedTables(request, seeded.marketId)).toHaveLength(1);
    await expect(layout.undo).toBeDisabled();

    // Ctrl+Shift+Z, Ctrl+Y and the button bring each back, across those saves.
    await layout.saved(async () => {
      await page.keyboard.press('Control+Shift+z');
      await expect(layout.tables).toHaveCount(2);
    });
    await layout.saved(() => page.keyboard.press('Control+y'));
    first = await gold(request, seeded.marketId, 1);
    expect([first.xMm, first.yMm]).toEqual(dropped);
    await layout.saved(() => layout.redo.click());
    expect((await gold(request, seeded.marketId, 1)).rotation).toBe(90);
    await expect(layout.redo).toBeDisabled();
    expect(await storedTables(request, seeded.marketId)).toHaveLength(2);
  });

  test('a box dragged on the floor selects the tables wholly inside it, and Shift, Ctrl+A and Escape change the selection', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await open(page, request, [
      { section: 'sec-gold', at: [6000, 6000] },
      { section: 'sec-gold', at: [10_000, 6000] },
      { section: 'sec-gold', at: [14_000, 6000] },
      { section: 'sec-silver', at: [10_000, 12_000] },
    ]);

    // The box ends past Gold row 2's right end and over Gold row 3's centre, short of its right
    // end: Gold row 2 is wholly in it and selected, Gold row 3 is not, nor the table below.
    await layout.drag([4000, 4500], [14_500, 8000], {
      hold: async () => {
        await expect(layout.selectBox).toBeVisible();
        // What the box will take is selected as it is drawn.
        await expect(layout.selectionTitle).toHaveText('2 tables selected');
      },
    });
    await expect(layout.selectBox).toHaveCount(0);
    await expect(layout.selectionCounts).toHaveText('2 in Gold row');
    await expect(layout.table(GOLD_1)).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.table(GOLD_2)).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.table('Gold row 3, Standard 6 ft')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Shift and a click adds a table, and takes one out.
    await layout.shiftClickAt([14_000, 6000]);
    await expect(layout.selectionTitle).toHaveText('3 tables selected');
    await layout.shiftClickAt([6000, 6000]);
    await expect.poll(() => layout.pressedNames()).toEqual([GOLD_2, 'Gold row 3, Standard 6 ft']);

    // A box drawn with Shift held adds its tables to those selected. It starts on the floor under
    // the table: a press on a section's name, which stands over it, would move the name.
    await page.keyboard.down('Shift');
    await layout.drag([7000, 13_500], [13_000, 11_500]);
    await page.keyboard.up('Shift');
    await expect(layout.selectionCounts).toHaveText('2 in Gold row, 1 in Silver aisle');

    // Escape selects nothing, Ctrl+A every table, and a press on the floor nothing again.
    await page.keyboard.press('Escape');
    await expect(layout.selection).toContainText('Select tables to change them.');
    await page.keyboard.press('Control+a');
    await expect(layout.selectionTitle).toHaveText('4 tables selected');
    await layout.clickAt([22_000, 18_000]);
    await expect(layout.selection).toContainText('Select tables to change them.');

    // A box put back with Escape leaves the selection as it was.
    await layout.clickAt([10_000, 12_000]);
    await expect(layout.selectionTitle).toHaveText('Silver aisle 1');
    await layout.drag([4000, 4500], [15_000, 8000], {
      hold: async () => {
        await expect(layout.selectionTitle).toHaveText('3 tables selected');
        await page.keyboard.press('Escape');
        await expect(layout.selectBox).toHaveCount(0);
      },
    });
    await expect(layout.selectionTitle).toHaveText('Silver aisle 1');
  });

  test('several tables are dragged, turned, duplicated and removed together, each one step of undo', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [6000, 6000] },
      { section: 'sec-gold', at: [10_000, 6000] },
      { section: 'sec-silver', at: [20_000, 15_000] },
    ]);
    const { scale } = await layout.onScreen([0, 0]);
    const pixel = 1 / scale;
    const golds = async () =>
      (await storedTables(request, seeded.marketId))
        .filter((table) => table.sectionId === 'sec-gold')
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

    await layout.drag([4000, 4500], [12_000, 7500]);
    await expect.poll(() => layout.pressedNames()).toEqual([GOLD_1, GOLD_2]);

    // Dragged by one of them, 4 m down the hall, both go, keeping their places beside each other.
    // Alt: placed freely, so the distance is the pointer's own.
    await page.keyboard.down('Alt');
    await layout.saved(() => layout.drag([6000, 6000], [6000, 10_000]));
    await page.keyboard.up('Alt');
    let [first, second] = await golds();
    expect(Math.abs(first.yMm - 10_000)).toBeLessThan(pixel);
    expect(first.xMm).toBe(6000);
    expect(second.xMm - first.xMm).toBe(4000);
    expect(second.yMm).toBe(first.yMm);
    const moved = first.yMm;
    // The table left out of the selection stands where it stood.
    const silver = (await storedTables(request, seeded.marketId)).find(
      (table) => table.sectionId === 'sec-silver',
    )!;
    expect([silver.xMm, silver.yMm]).toEqual([20_000, 15_000]);

    // R turns the two a quarter about the middle of the selection, as one.
    await layout.saved(() => page.keyboard.press('r'));
    [first, second] = await golds();
    expect([first.rotation, second.rotation]).toEqual([90, 90]);
    expect(first.xMm).toBe(8000);
    expect(second.xMm).toBe(8000);
    expect(first.yMm).toBeCloseTo(moved - 2000, 1);
    expect(second.yMm).toBeCloseTo(moved + 2000, 1);

    // One undo takes the whole turn back, and one more the whole drag.
    await layout.saved(() => page.keyboard.press('Control+z'));
    [first, second] = await golds();
    expect([first.rotation, first.xMm, first.yMm]).toEqual([0, 6000, moved]);
    expect([second.rotation, second.xMm, second.yMm]).toEqual([0, 10_000, moved]);
    await layout.saved(() => page.keyboard.press('Control+z'));
    [first, second] = await golds();
    expect([first.yMm, second.yMm]).toEqual([6000, 6000]);
    await expect(layout.undo).toBeDisabled();

    // Duplicate puts a copy of each a table depth and 300 mm down, numbered on, and selects them.
    await layout.saved(async () => {
      await layout.selectionDuplicate.click();
      await expect(layout.tables).toHaveCount(5);
    });
    await expect
      .poll(() => layout.pressedNames())
      .toEqual(['Gold row 3, Standard 6 ft', 'Gold row 4, Standard 6 ft']);
    const four = await golds();
    expect(four.map((table) => [table.number, table.xMm, table.yMm])).toEqual([
      [1, 6000, 6000],
      [2, 10_000, 6000],
      [3, 6000, 7060],
      [4, 10_000, 7060],
    ]);

    // Undone from the card's button, the copies go and the card empties: the focus goes to the
    // map, not lost with the button. Redone, they are selected again by Shift and a click.
    await layout.selectionDuplicate.focus();
    await layout.saved(async () => {
      await page.keyboard.press('Control+z');
      await expect(layout.tables).toHaveCount(3);
    });
    await expect(layout.selection).toContainText('Select tables to change them.');
    await expect(layout.map.locator('[data-table-id][tabindex="0"]')).toBeFocused();
    await layout.saved(async () => {
      await page.keyboard.press('Control+y');
      await expect(layout.tables).toHaveCount(5);
    });
    await layout.clickAt([6000, 7060]);
    await layout.shiftClickAt([10_000, 7060]);
    await expect(layout.selectionCounts).toHaveText('2 in Gold row');
    await expect
      .poll(() => layout.pressedNames())
      .toEqual(['Gold row 3, Standard 6 ft', 'Gold row 4, Standard 6 ft']);

    // Remove takes both copies, and one undo brings both back.
    await layout.saved(async () => {
      await layout.selectionRemove.click();
      await expect(layout.tables).toHaveCount(3);
    });
    expect(await golds()).toHaveLength(2);
    await layout.saved(async () => {
      await layout.undo.click();
      await expect(layout.tables).toHaveCount(5);
    });
    expect(await golds()).toHaveLength(4);
    // And one more takes the duplicates away again: the whole Duplicate was one step.
    await layout.saved(async () => {
      await layout.undo.click();
      await expect(layout.tables).toHaveCount(3);
    });
    await expect(layout.undo).toBeDisabled();
  });

  test('Align and Space evenly line up a ragged selection', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [5000, 6000] },
      { section: 'sec-gold', at: [9000, 6400] },
      { section: 'sec-gold', at: [16_000, 5700] },
      { section: 'sec-silver', at: [20_000, 15_000] },
    ]);
    const golds = async () =>
      (await storedTables(request, seeded.marketId))
        .filter((table) => table.sectionId === 'sec-gold')
        .map((table) => [table.number, table.xMm, table.yMm]);

    // One table has nothing to line up with: the menu comes with a second.
    await layout.clickAt([5000, 6000]);
    await expect(layout.selectionAlign).toHaveCount(0);
    await layout.drag([2000, 3000], [19_000, 9000]);
    await expect(layout.selectionTitle).toHaveText('3 tables selected');

    await layout.saved(() => layout.align('Align top'));
    expect(await golds()).toEqual([
      [1, 5000, 5700],
      [2, 9000, 5700],
      [3, 16_000, 5700],
    ]);
    // The menu gave the focus back to its button.
    await expect(layout.selectionAlign).toBeFocused();

    await layout.saved(() => layout.align('Space evenly across'));
    expect(await golds()).toEqual([
      [1, 5000, 5700],
      [2, 10_500, 5700],
      [3, 16_000, 5700],
    ]);

    await layout.saved(() => layout.align('Align left'));
    expect((await golds()).map(([, x]) => x)).toEqual([5000, 5000, 5000]);
    // Each was one step: an undo spaces them again.
    await layout.saved(() => layout.undo.click());
    expect((await golds()).map(([, x]) => x)).toEqual([5000, 10_500, 16_000]);
    // The table left out never moved.
    const silver = (await storedTables(request, seeded.marketId)).find(
      (table) => table.sectionId === 'sec-silver',
    )!;
    expect([silver.xMm, silver.yMm]).toEqual([20_000, 15_000]);
  });

  test("a section's colour and the place its name is dragged to survive a reload", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [6000, 6000] },
      { section: 'sec-gold', at: [7830, 6000] },
      { section: 'sec-silver', at: [20_000, 15_000] },
    ]);
    const styles = async () => {
      const read = await request.get(`${BACKEND_URL}/markets/${seeded.marketId}`);
      const { market } = (await read.json()) as {
        market: {
          setupObject: {
            floorplans: {
              sectionStyles: {
                sectionId: string;
                color: number;
                labelAt: { xMm: number; yMm: number } | null;
              }[];
            }[];
          };
        };
      };
      return market.setupObject.floorplans[0].sectionStyles;
    };

    // Gold row is drawn in the first colour until another is chosen from its swatch.
    await expect(layout.tableTop(GOLD_1)).toHaveAttribute('fill', 'var(--layout-section-1-fill)');
    await layout.sectionColour('Gold row').click();
    await expect(layout.paletteColour('Gold')).toHaveAttribute('aria-pressed', 'true');
    await layout.saved(() => layout.paletteColour('Violet').click());
    await expect(layout.tableTop(GOLD_1)).toHaveAttribute('fill', 'var(--layout-section-5-fill)');
    await expect(layout.sectionColour('Gold row')).toBeFocused();
    expect(await styles()).toEqual([{ sectionId: 'sec-gold', color: 5, labelAt: null }]);

    // Its name is dragged from beside its tables out onto the floor.
    const label = (await layout.sectionLabel('Gold row').boundingBox())!;
    const to = await layout.onScreen([15_000, 3000]);
    await layout.saved(async () => {
      await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x, (label.y + to.y) / 2, { steps: 4 });
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.mouse.up();
    });
    const pixel = 1 / to.scale;
    const [gold] = await styles();
    expect(gold.color).toBe(5);
    expect(Math.abs(gold.labelAt!.xMm - 15_000)).toBeLessThan(pixel);
    expect(Math.abs(gold.labelAt!.yMm - 3000)).toBeLessThan(pixel);
    // No table moved, and none was selected by the drag.
    expect((await gold_1(request, seeded.marketId)).xMm).toBe(6000);
    await expect(layout.selection).toContainText('Select tables to change them.');

    await page.reload();
    await expect(layout.tables).toHaveCount(3);
    await expect(layout.tableTop(GOLD_1)).toHaveAttribute('fill', 'var(--layout-section-5-fill)');
    const after = (await layout.sectionLabel('Gold row').boundingBox())!;
    const there = await layout.onScreen([gold.labelAt!.xMm, gold.labelAt!.yMm]);
    expect(after.x + after.width / 2).toBeCloseTo(there.x, 0);
    expect(after.y + after.height / 2).toBeCloseTo(there.y, 0);
  });
});

/**
 * A knob turned by a finger. A phone's width, 640 px and below, only reads a layout, so the
 * narrowest window that edits one is a tablet's, held upright, and its touch screen.
 */
test.describe('A table turned by touch', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

  test("a finger dragged from a corner's knob turns the table in 15° steps", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout, seeded } = await open(page, request, [
      { section: 'sec-gold', at: [15_000, 11_000] },
    ]);
    const centre = await layout.onScreen([15_000, 11_000]);
    await page.touchscreen.tap(centre.x, centre.y);
    await expect(layout.table(GOLD_1)).toHaveAttribute('aria-pressed', 'true');
    await expect(layout.turnKnobs).toHaveCount(4);

    const from = middleOf((await layout.turnKnob.boundingBox())!);
    const start = Math.atan2(from.y - centre.y, from.x - centre.x);
    const reach = Math.hypot(from.x - centre.x, from.y - centre.y);
    const at = (degrees: number) => {
      const angle = start + (degrees * Math.PI) / 180;
      return {
        x: Math.round(centre.x + reach * Math.cos(angle)),
        y: Math.round(centre.y + reach * Math.sin(angle)),
      };
    };
    const cdp = await page.context().newCDPSession(page);
    await layout.saved(async () => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: Math.round(from.x), y: Math.round(from.y) }],
      });
      for (let step = 1; step <= 10; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [at(step * 4)],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    });
    // 40° by the finger, held to 45°, about the table's centre; the view did not pan under it.
    const table = await gold(request, seeded.marketId, 1);
    expect(table.rotation).toBe(45);
    expect([table.xMm, table.yMm]).toEqual([15_000, 11_000]);
    const after = await layout.onScreen([15_000, 11_000]);
    expect(Math.hypot(after.x - centre.x, after.y - centre.y)).toBeLessThan(1);
  });
});
