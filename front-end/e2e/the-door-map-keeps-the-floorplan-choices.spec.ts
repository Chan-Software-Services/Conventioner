import type { Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import {
  detectLayout,
  gates,
  minTargetAt,
  SPACE_SCALE,
  TYPE_SCALE,
} from './helpers/layoutDetectors';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { NORTH_WING, seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { grantMarketRole } from './helpers/grantMarketRole';
import { withUser } from './helpers/withUser';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';
import { LayoutPage } from './pages/LayoutPage';

/**
 * Attendance's map offers the Layout page's floorplan choices (T501, Q6, Daniel: (a)): under the
 * map's legend, one line of three ticks, "Show the floorplan", "Greyscale" and "Faded", in a group
 * named "Floorplan", for everyone who sees the map, an organizer, an Editor with no check-in right
 * and a Viewer alike. They are the Layout page's own remembered choices, so one made on either page
 * is the other's when the person goes there. On a phone each tick is a 44px target and the line
 * wraps inside the window.
 */

const DESK = PHONE_AND_DESK[1].use;
const PHONE = PHONE_AND_DESK[0];

const EDITOR = { email: 'e2e-door-choices-editor@example.com', password: 'e2epassword123' };
const VIEWER = { email: 'e2e-door-choices-viewer@example.com', password: 'e2epassword123' };

async function openTheMap(page: Page, seeded: SeededMarketDayMap): Promise<AttendanceStatusPage> {
  const door = new AttendanceStatusPage(page);
  await door.goto(seeded.marketId);
  await door.viewMap.click();
  await expect(door.map).toBeVisible();
  await expect(door.mapImage).toBeVisible();
  return door;
}

function ticksOf(page: Page) {
  const group = page.getByRole('group', { name: 'Floorplan', exact: true });
  return {
    group,
    show: group.getByRole('checkbox', { name: 'Show the floorplan', exact: true }),
    grey: group.getByRole('checkbox', { name: 'Greyscale', exact: true }),
    faded: group.getByRole('checkbox', { name: 'Faded', exact: true }),
  };
}

/** The three ticks stand ticked and offered, under the legend. */
async function expectTheTicks(page: Page, door: AttendanceStatusPage): Promise<void> {
  const ticks = ticksOf(page);
  await expect(ticks.group.getByRole('checkbox')).toHaveCount(3);
  for (const tick of [ticks.show, ticks.grey, ticks.faded]) {
    await expect(tick).toBeChecked();
    await expect(tick).toBeEnabled();
  }
  const legend = (await door.dayMap.getByTestId('day-map-legend').boundingBox())!;
  const group = (await ticks.group.boundingBox())!;
  expect(group.y).toBeGreaterThanOrEqual(legend.y + legend.height);
}

test.describe("Attendance's map offers the Layout page's floorplan choices", () => {
  test.use({ viewport: DESK.viewport });

  test('an organizer, an Editor with no check-in right and a Viewer each see the three ticks', async ({
    authenticatedPage: page,
    browser,
    request,
  }) => {
    ensureVerifiedUser(EDITOR.email, EDITOR.password);
    ensureVerifiedUser(VIEWER.email, VIEWER.password);
    const seeded = await seedMarketDayMap(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    for (const [person, role] of [
      [EDITOR, 'editor'],
      [VIEWER, 'viewer'],
    ] as const) {
      await grantMarketRole(request, seeded.marketId, person, role);
    }
    const raised = await request.put(
      `${BACKEND_URL}/markets/${seeded.marketId}/permissions/check-in`,
      {
        data: { role: 'admin' },
      },
    );
    expect(raised.ok(), await raised.text()).toBeTruthy();

    await expectTheTicks(page, await openTheMap(page, seeded));

    for (const person of [EDITOR, VIEWER]) {
      await withUser(
        browser,
        person.email,
        person.password,
        async (theirs) => {
          const door = await openTheMap(theirs, seeded);
          await expectTheTicks(theirs, door);
          // Neither may check a vendor in, the Editor by the raised row: the ticks are not the door's.
          await door.viewList.click();
          await expect(door.rows.first()).toBeVisible();
          await expect(door.checkIns).toHaveCount(0);
        },
        { viewport: DESK.viewport },
      );
    }
  });

  test("a choice made on either page is the other's", async ({
    authenticatedPage: page,
    request,
  }) => {
    const seeded = await seedMarketDayMap(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    const door = await openTheMap(page, seeded);
    const ticks = ticksOf(page);
    await expect(door.mapImage).toHaveAttribute('opacity', '0.5');
    await expect(door.mapImage).not.toHaveClass(/layout-map__image--colour/);

    // Faded unticked on the attendance map: the image at full strength, there and on the Layout page.
    await ticks.faded.click();
    await expect(ticks.faded).not.toBeChecked();
    await expect(door.mapImage).not.toHaveAttribute('opacity', /.*/);

    const layout = new LayoutPage(page);
    await layout.goto(seeded.marketId, NORTH_WING.id);
    await expect(layout.mapImage).toBeVisible();
    await expect(layout.mapImage).not.toHaveAttribute('opacity', /.*/);
    await layout.openViewMenu();
    await expect(layout.viewFaded).toHaveAttribute('aria-checked', 'false');
    await expect(layout.viewGrey).toHaveAttribute('aria-checked', 'true');

    // Greyscale unticked on the Layout page: the attendance map draws the image in its colours.
    await layout.viewGrey.click();
    await expect(layout.viewGrey).toHaveAttribute('aria-checked', 'false');
    await expect(layout.mapImage).toHaveClass(/layout-map__image--colour/);

    await openTheMap(page, seeded);
    await expect(ticks.grey).not.toBeChecked();
    await expect(ticks.faded).not.toBeChecked();
    await expect(door.mapImage).toHaveClass(/layout-map__image--colour/);

    // Show unticked: no image, and the other two disabled; the Layout page draws none either.
    await ticks.show.click();
    await expect(door.mapImage).toHaveCount(0);
    await expect(door.mapTable('Aisle A 1')).toBeVisible();
    await expect(ticks.grey).toBeDisabled();
    await expect(ticks.faded).toBeDisabled();
    await layout.goto(seeded.marketId, NORTH_WING.id);
    await expect(layout.map).toBeVisible();
    await expect(layout.mapImage).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use(PHONE.use);

  test('each tick is a 44px target, the line wraps inside the window, and the layout sweep finds nothing', async ({
    authenticatedPage: page,
    request,
  }) => {
    const seeded = await seedMarketDayMap(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    const door = await openTheMap(page, seeded);
    const ticks = ticksOf(page);
    const window = inTheWindow(PHONE);
    await ticks.group.scrollIntoViewIfNeeded();
    await window.expectInside(ticks.group, 'The Floorplan ticks');
    for (const tick of [ticks.show, ticks.grey, ticks.faded]) {
      // The label is the target, the box inside it.
      const label = (await tick.locator('xpath=ancestor::label[1]').boundingBox())!;
      expect(label.height).toBeGreaterThanOrEqual(44);
      expect(label.width).toBeGreaterThanOrEqual(44);
    }
    await window.press(ticks.faded.locator('xpath=ancestor::label[1]'));
    await expect(ticks.faded).not.toBeChecked();
    await expect(door.mapImage).not.toHaveAttribute('opacity', /.*/);

    await window.expectFits(page, "Attendance's map");
    const { width } = page.viewportSize()!;
    const findings = await page.evaluate(detectLayout, {
      spaceScale: SPACE_SCALE,
      textScale: TYPE_SCALE,
      minTarget: minTargetAt(width),
    });
    expect(
      findings.filter((finding) => gates(finding, width)),
      "Attendance's map: the layout detectors' gating findings",
    ).toEqual([]);
  });
});
