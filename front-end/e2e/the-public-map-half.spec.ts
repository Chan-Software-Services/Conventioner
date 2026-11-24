import type { Locator, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * A shared table's half picked alone on the public map (T465 ticket 07), opened signed out on the
 * seam's seeded market: North Wing's Aisle A 3 (`north-table-3`) is shared today by Loom House
 * (left) and Paper Moth Press (right), and nobody sits there tomorrow.
 *
 * A press on one half picks it alone: the map outlines that half, the card names only its vendor
 * under "Left half" or "Right half", and the address carries `half` beside `table`, so a reload or
 * a shared link opens the same half. This proves it in a real browser at a phone and a desk, its
 * outline and the screen reader's sweep with it. The rules themselves, a vendor opened from the list
 * opening their half, and a half the table is not split into on the day, or one that is no side,
 * opening the whole table with no error, are proved in `thePublicMapPage.test.ts`.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

const SHARED = 'north-table-3';

/** The map's one outline, round a half (a path) or round the whole table (a rect). */
async function expectOutlined(map: PublicMapPage, what: 'whole' | Locator) {
  const marks = map.map.getByTestId('layout-map-read');
  await expect(marks).toHaveCount(1);
  if (what === 'whole') {
    await expect(marks.locator('rect')).toHaveCount(1);
    await expect(marks.locator('path')).toHaveCount(0);
    return;
  }
  await expect(marks.locator('path')).toHaveCount(1);
  await expect(marks.locator('rect')).toHaveCount(0);
  // The outline stands round the half named: its centre inside that half's own box.
  const mark = (await marks.boundingBox())!;
  const half = (await what.boundingBox())!;
  const x = mark.x + mark.width / 2;
  const y = mark.y + mark.height / 2;
  expect(x, "the outline's centre is across the half").toBeGreaterThan(half.x);
  expect(x).toBeLessThan(half.x + half.width);
  expect(y, "the outline's centre is down the half").toBeGreaterThan(half.y);
  expect(y).toBeLessThan(half.y + half.height);
}

/** The card shows Aisle A 3's right half alone, Paper Moth Press at it. */
async function expectTheRightHalfAlone(map: PublicMapPage) {
  await expect(map.cardCode).toHaveText('Aisle A 3');
  await expect(map.cardWhole).toHaveCount(0);
  await expect(map.cardHalves.getByRole('heading', { level: 3 })).toHaveText(['Right half']);
  await expect(map.cardNames).toHaveText(['Paper Moth Press']);
  await expect(map.cardWebsites).toHaveText(['paper-moth.test']);
  await expect(map.card).not.toContainText('Loom House');
  await expectOutlined(map, map.table('Aisle A 3', 'right'));
}

/** Nothing on the page says an error. */
async function expectNoAlert(page: Page) {
  await expect(page.getByRole('alert')).toHaveCount(0);
}

for (const size of PHONE_AND_DESK) {
  test.describe(`a half of a shared table picked alone ${size.name}`, () => {
    test.use(size.use);
    const { press } = inTheWindow(size);

    test('a press on the right half picks it alone, and the address keeps it', async ({
      page,
      expectAccessible,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await press(map.table('Aisle A 3', 'right'));
      await expect(page).toHaveURL(
        new RegExp(
          `\\?date=${seeded.today}&location=${seeded.north.id}&table=${SHARED}&half=right$`,
        ),
      );
      await expectTheRightHalfAlone(map);
      await expectNoAlert(page);
      await expectAccessible('the public map, a half picked');

      // A reload opens the same half.
      await page.reload();
      await expectTheRightHalfAlone(map);

      // The link, opened fresh in another tab, opens the same half too.
      const link = page.url();
      const fresh = await page.context().newPage();
      try {
        const there = new PublicMapPage(fresh);
        await fresh.goto(link);
        await expectTheRightHalfAlone(there);
        await expectNoAlert(fresh);
      } finally {
        await fresh.close();
      }

      // The left half, pressed next, takes its place; a whole table writes no half.
      await press(map.table('Aisle A 3', 'left'));
      await expect(page).toHaveURL(new RegExp(`&table=${SHARED}&half=left$`));
      await expect(map.cardHalves.getByRole('heading', { level: 3 })).toHaveText(['Left half']);
      await expect(map.cardNames).toHaveText(['Loom House']);
      await expectOutlined(map, map.table('Aisle A 3', 'left'));
      await press(map.table('Aisle A 1'));
      await expect(page).toHaveURL(new RegExp(`&table=north-table-1$`));
      await expectOutlined(map, 'whole');
    });
  });
}
