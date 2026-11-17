import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The day's vendors on a market's public map (T422 ticket 09, T465), `/<slug>/map`, opened signed
 * out on the seam's seeded market: today five vendors are named, at North Wing's Aisle A and South
 * Wing's Aisle B, Aisle A 3 shared by Loom House and Paper Moth Press. The list names each with
 * their table and hall; a press opens the vendor's hall, picks their table and brings the map into
 * view.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

for (const size of PHONE_AND_DESK) {
  test.describe(`the public map's vendors ${size.name}`, () => {
    test.use(size.use);
    const { press } = inTheWindow(size);

    test('finding a vendor narrows the list, and a press opens their hall and table', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.vendors).toHaveText([
        /^Ember Ceramics\s*Table Aisle A 1, North Wing$/,
        /^Kiln & Co\s*Table Aisle A 2, North Wing$/,
        /^Loom House\s*Table Aisle A 3, North Wing$/,
        /^Paper Moth Press\s*Table Aisle A 3, North Wing$/,
        /^Salt & Sage\s*Table Aisle B 3, South Wing$/,
      ]);
      await expect(map.vendorsCount).toHaveText('5 vendors');

      await map.find.fill('salt');
      await expect(map.vendors).toHaveText([/^Salt & Sage/]);
      const before = page.url();
      await map.find.press('Enter');
      await expect(map.vendors).toHaveCount(1);
      expect(page.url()).toBe(before);

      // Scrolled away from the map first, so bringing it into view is seen.
      await map.vendors.first().scrollIntoViewIfNeeded();
      await press(map.vendors.first());
      await expect(map.map).toHaveAccessibleName(/^South Wing layout/);
      await expect(map.location(seeded.south.name)).toHaveAttribute('aria-pressed', 'true');
      await expect(map.card).toContainText('Aisle B 3');
      await expect(map.card).toContainText('Salt & Sage');
      await expect(page).toHaveURL(new RegExp(`location=${seeded.south.id}&table=south-table-3`));
      await expect(map.dayMap).toBeInViewport();
    });
  });
}
