import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { eachWindow, expectLaidOut, openEntry } from './helpers/componentLibrary';
import { inTheWindow } from './helpers/phoneWindow';

/**
 * The component library's `toolbars` entry (T466): `ToolRow`, `ToolGroup`, `SegmentedControl` and
 * `PinnedTools` on the fixture, at a desk and on a phone. A toolbar row is 12px over and under its
 * compact controls, its field as tall as its buttons, its end at its inline end with a rule between
 * groups, and on a phone the end starts its own line and the rules go; a segmented control is one
 * joined box whose pressed option is green on all four edges, one option always on; and the pinned
 * block stays put as the rows scroll at a desk and scrolls away with them on a phone.
 */

const box = async (locator: Locator) => (await locator.boundingBox())!;
/** The read-outs under one demo: `toolbar`, `count-row`, `statuses` or `pinned`. */
const readOutOf = (page: Page, demo: string): Locator =>
  page.getByTestId(`library-demo-${demo}`).getByTestId('read-out');

/** Each edge's colour and width, read off the button's own computed border. */
const edgesOf = (button: Locator) =>
  button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: style.borderTopColor,
      right: style.borderRightColor,
      bottom: style.borderBottomColor,
      left: style.borderLeftColor,
      leftWidth: style.borderLeftWidth,
    };
  });

const GREEN = 'rgb(54, 130, 111)';

eachWindow('the toolbars entry', (size) => {
  test.beforeEach(async ({ page }) => {
    await openEntry(page, 'toolbars');
  });

  test('names what it serves, with no choices left, and fits the window', async ({
    page,
    expectAccessible,
  }) => {
    await expect(page.getByTestId('library-serves')).toHaveText(
      'Serves: Attendance, Applications (release walk F5, F7)',
    );
    await expect(page.getByTestId('choices-for-you')).toHaveCount(0);
    await expectLaidOut(page, size, 'the toolbars entry');
    await expectAccessible('the toolbars entry');
  });

  test('a toolbar row: 12px over and under its controls, a field as tall as a button', async ({
    page,
  }) => {
    const row = page.getByTestId('library-toolbar');
    const date = page.getByTestId('library-toolbar-date');
    const print = page.getByTestId('library-toolbar-print');
    const refresh = page.getByTestId('library-toolbar-refresh');
    const height = size.phone ? 44 : 28;

    expect((await box(date)).height).toBe(height);
    expect((await box(print)).height).toBe(height);
    await expect(date).toHaveAccessibleName('Market date');

    const rowBox = await box(row);
    const dateBox = await box(date);
    await expect(row).toHaveCSS('border-bottom-width', '1px');
    expect(dateBox.y - rowBox.y).toBe(12);
    // The row ends 12px under its last line's controls, then its 1px rule.
    const refreshBox = await box(refresh);
    expect(rowBox.y + rowBox.height - 1 - (refreshBox.y + refreshBox.height)).toBe(12);
    // Refresh is the last control, at the row's inline end.
    const inset = size.phone ? 16 : 24;
    if (size.phone) {
      // The end starts its own line, at the start edge.
      const viewBox = await box(page.getByTestId('library-toolbar-view'));
      expect(viewBox.y).toBeGreaterThan(dateBox.y + dateBox.height);
      expect(viewBox.x).toBe(dateBox.x);
    } else {
      expect(rowBox.x + rowBox.width - (refreshBox.x + refreshBox.width)).toBe(inset);
      expect(refreshBox.y).toBe(dateBox.y);
    }
    expect(dateBox.x - rowBox.x).toBe(inset);
  });

  test('a rule stands between two groups at a desk, and none on a phone', async ({ page }) => {
    const groups = page.getByTestId('library-toolbar-group');
    await expect(groups).toHaveCount(3);
    if (size.phone) {
      for (const group of await groups.all()) await expect(group).toHaveCSS('display', 'contents');
    } else {
      await expect(groups.nth(0)).toHaveCSS('border-left-width', '0px');
      for (const index of [1, 2]) {
        await expect(groups.nth(index)).toHaveCSS('border-left-width', '1px');
        await expect(groups.nth(index)).toHaveCSS('padding-left', '12px');
      }
    }
  });

  test('the toolbar works: a date, the view, Print roster and Refresh each land', async ({
    page,
  }) => {
    const { press } = inTheWindow(size);
    const view = page.getByTestId('library-toolbar-view');
    const readOuts = readOutOf(page, 'toolbar');

    await page.getByTestId('library-toolbar-date').selectOption({ index: 1 });
    await expect(readOuts.nth(0)).not.toHaveText('Market date: nothing');
    await press(page.getByTestId('library-toolbar-view-map'));
    await expect(readOuts.nth(1)).toHaveText('Show as: Map');
    await press(page.getByTestId('library-toolbar-print'));
    await expect(readOuts.nth(2)).toHaveText('Pressed: Print roster');
    await press(page.getByTestId('library-toolbar-refresh'));
    await expect(readOuts.nth(2)).toHaveText('Pressed: Refresh');
    // Refresh says no time here: the screen says it elsewhere.
    await expect(page.getByTestId('library-toolbar-updated')).toHaveCount(0);
  });

  test('a second row: the search takes the room the count leaves', async ({ page }) => {
    const row = await box(page.getByTestId('library-count-row'));
    const count = await box(page.getByTestId('library-count'));
    const search = page.getByTestId('library-search');
    const searchBox = await box(search);
    const inset = size.phone ? 16 : 24;

    expect(searchBox.height).toBe(size.phone ? 44 : 28);
    expect(Math.round(row.x + row.width - inset - (searchBox.x + searchBox.width))).toBe(0);
    if (!size.phone) expect(searchBox.x).toBeGreaterThan(count.x + count.width);
    await expect(search).toHaveAccessibleName('Find a vendor');
    await search.fill('Ana');
    await expect(readOutOf(page, 'count-row')).toHaveText('Finding: Ana');
  });

  test('a segmented control is one joined box, its pressed option green all round', async ({
    page,
  }) => {
    const { press } = inTheWindow(size);
    const view = page.getByTestId('library-toolbar-view');
    const list = page.getByTestId('library-toolbar-view-list');
    const map = page.getByTestId('library-toolbar-view-map');

    await expect(view).toHaveAccessibleName('Show as');
    await expect(view.getByRole('button', { pressed: true })).toHaveText('List');

    // The two meet at one 1px edge: no gap and no overlap.
    const [listBox, mapBox] = [await box(list), await box(map)];
    expect(mapBox.x).toBe(listBox.x + listBox.width);
    expect((await edgesOf(map)).leftWidth).toBe('0px');

    await press(map);
    await expect(view.getByRole('button', { pressed: true })).toHaveText('Map');
    await expect(readOutOf(page, 'toolbar').nth(1)).toHaveText('Show as: Map');
    // Map's start edge is List's end edge, green; its other three are its own.
    expect((await edgesOf(list)).right).toBe(GREEN);
    expect(await edgesOf(map)).toMatchObject({ top: GREEN, right: GREEN, bottom: GREEN });

    // Pressed again it stays on: a segmented choice always has one option.
    await press(map);
    await expect(view.getByRole('button', { pressed: true })).toHaveText('Map');

    // Only the outer corners are round.
    await expect(list).toHaveCSS('border-top-right-radius', '0px');
    await expect(list).not.toHaveCSS('border-top-left-radius', '0px');
    await expect(map).toHaveCSS('border-top-left-radius', '0px');
    await expect(map).not.toHaveCSS('border-top-right-radius', '0px');
  });

  test('five statuses: joined at a desk, apart and whole on a phone', async ({ page }) => {
    const { press } = inTheWindow(size);
    const statuses = page.getByTestId('library-statuses');
    const options = statuses.getByRole('button');
    await expect(statuses).toHaveAccessibleName('Filter');
    await expect(options).toHaveText([
      'Any status',
      'Open',
      'Needs follow-up',
      'Approved',
      'Rejected',
    ]);

    const open = await box(options.nth(1));
    const followUp = await box(options.nth(2));
    if (size.phone) {
      // Apart a small step, each with its whole border and its corners.
      for (const option of await options.all()) {
        await expect(option).toHaveCSS('border-left-width', '1px');
        await expect(option).not.toHaveCSS('border-top-left-radius', '0px');
      }
      const lines = new Set(
        await Promise.all((await options.all()).map(async (option) => (await box(option)).y)),
      );
      expect(lines.size).toBeGreaterThan(1);
      expect(followUp.x === open.x + open.width + 4 || followUp.y > open.y).toBe(true);
    } else {
      expect(followUp.x).toBe(open.x + open.width);
      expect(followUp.y).toBe(open.y);
    }

    await press(page.getByTestId('library-statuses-reviewer_approved'));
    await expect(readOutOf(page, 'statuses')).toHaveText('Showing: Approved');
  });

  test('the pinned block stays put at a desk as the rows scroll, and scrolls away on a phone', async ({
    page,
  }) => {
    const scroller = page.getByTestId('library-pinned-box');
    const block = page.getByTestId('library-pinned');
    await scroller.scrollIntoViewIfNeeded();
    const at = async (top: number) => {
      await scroller.evaluate((element, y) => (element.scrollTop = y), top);
      return (await box(block)).y - (await box(scroller)).y;
    };

    const rest = await at(0);
    expect(rest).toBe(0);
    for (const top of [5, 40, 200]) {
      expect(await at(top), `scrolled ${top}px`).toBe(size.phone ? -top : 0);
    }

    // Pinned or not, its view switch works.
    await at(0);
    await inTheWindow(size).press(page.getByTestId('library-pinned-view-one'));
    await expect(readOutOf(page, 'pinned')).toHaveText('View: One by one');
  });
});
