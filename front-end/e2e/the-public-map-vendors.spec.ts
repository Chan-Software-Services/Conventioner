import type { Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The vendor panel on a market's public map (T422 ticket 09, T465 ticket 06), `/<slug>/map`, opened
 * signed out on the seam's seeded market: today five vendors are named, at North Wing's Aisle A and
 * South Wing's Aisle B, Aisle A 3 shared by Loom House and Paper Moth Press.
 *
 * "Find a vendor" drops down the vendors the words find by the public name, the website's host, the
 * Instagram handle, the table code or the section name, and never by an email address, a full name
 * or a preferred name, none of which reaches the browser; a pick opens the vendor's hall and card
 * and empties the field. Under it every vendor of the day is listed, unfiltered and uncounted, each
 * led by their table's code; the list blurs under the field only once it has scrolled.
 */

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
});

/** The map's own route, as the browser asks it. */
const isTheMapAnswer = (url: string, slug: string) =>
  new URL(url).pathname.endsWith(`/public/markets/${slug}/map`);

/** The day's five named vendors, as the list draws them: the code, the name, the hall. */
const TODAYS_ROWS = [
  /^Aisle A 1\s*Ember Ceramics\s*Table Aisle A 1, North Wing$/,
  /^Aisle A 2\s*Kiln & Co\s*Table Aisle A 2, North Wing$/,
  /^Aisle A 3\s*Loom House\s*Table Aisle A 3, North Wing$/,
  /^Aisle A 3\s*Paper Moth Press\s*Table Aisle A 3, North Wing$/,
  /^Aisle B 3\s*Salt & Sage\s*Table Aisle B 3, South Wing$/,
];

/**
 * A day longer than the seed's, so the list scrolls 200px in any window: South Wing's answer as the
 * server sent it, with 40 more tables in its Aisle B, each with a fixture vendor today. The seed is
 * not changed for a scroll alone.
 */
async function lengthenTheDay(page: Page, slug: string, today: string): Promise<void> {
  await page.route(
    (url) => isTheMapAnswer(url.href, slug),
    async (route) => {
      const response = await route.fetch();
      const answer = await response.json();
      const south = answer.locations.find(
        (location: { id: string }) => location.id === seeded.south.id,
      );
      const model = south.layout.tables[0];
      for (let n = 1; n <= 40; n++) {
        const tableId = `crowd-table-${n}`;
        south.layout.tables.push({ ...model, id: tableId, number: 100 + n });
        answer.seats.push({
          date: today,
          tableId,
          half: 'whole',
          name: `Crowdfixture Stall ${String(n).padStart(2, '0')}`,
          website: null,
          instagram: null,
        });
      }
      await route.fulfill({ response, json: answer });
    },
  );
}

for (const size of PHONE_AND_DESK) {
  test.describe(`the public map's vendors ${size.name}`, () => {
    test.use(size.use);
    const { press } = inTheWindow(size);

    test('the search finds a vendor by public fields alone, and none other reaches the browser', async ({
      page,
      expectAccessible,
    }) => {
      const map = new PublicMapPage(page);
      const answered = page.waitForResponse((response) =>
        isTheMapAnswer(response.url(), seeded.slug),
      );
      await map.goto(seeded.slug);
      const received = await (await answered).text();
      for (const vendor of seeded.vendors) {
        expect(received).not.toContain(vendor.email);
        expect(received).not.toContain(vendor.fullName);
        expect(received).not.toContain(vendor.preferredName);
      }

      const salt = seeded.vendors.find((vendor) => vendor.answers.businessName === 'Salt & Sage')!;
      const offered = async (words: string) => {
        await map.searchInput.fill(words);
        await expect(map.searchList).toBeVisible();
      };

      for (const words of [
        'salt & sage',
        'salt-and-sage.test',
        'example_sage',
        '@example_sage',
        'Aisle B 3',
        'aisleb3',
        'aisle b',
      ]) {
        await offered(words);
        await expect(map.searchOptions, `"${words}" finds Salt & Sage`).toHaveText([
          /^Salt & Sage\s*Table Aisle B 3, South Wing$/,
        ]);
      }

      await offered('example');
      await expect(map.searchOptions).toHaveText([
        /^Ember Ceramics/,
        /^Kiln & Co/,
        /^Loom House/,
        /^Salt & Sage/,
      ]);
      await expectAccessible('the public map, the search open');
      await expect(map.vendors, 'the words filter no row').toHaveText(TODAYS_ROWS);

      for (const words of [salt.email, salt.fullName, salt.preferredName]) {
        await offered(words);
        await expect(map.searchOptions).toHaveCount(0);
        await expect(map.searchNone).toHaveText(`No vendor matches "${words}".`);
      }
    });

    test("a pick opens the vendor's hall and card, and empties the field", async ({ page }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.locationSelect).toHaveValue(seeded.north.id);

      await map.searchInput.fill('aisleb3');
      await press(map.searchOptions.first());
      await expect(map.map).toHaveAccessibleName(/^South Wing layout/);
      await expect(map.locationSelect).toHaveValue(seeded.south.id);
      await expect(map.card).toContainText('Aisle B 3');
      await expect(map.card).toContainText('Salt & Sage');
      await expect(page).toHaveURL(new RegExp(`location=${seeded.south.id}&table=south-table-3`));
      await expect(map.searchInput).toHaveValue('');
      // At a desk the field keeps the focus for the next search; on a phone the card opens over
      // the field, so the focus goes to the card's Close, never left under it (WCAG 2.4.11).
      await expect(size.phone ? map.cardClose : map.searchInput).toBeFocused();
      await expect(map.searchList).toBeHidden();
      await expect(map.vendors).toHaveText(TODAYS_ROWS);
      await expect(map.vendors.filter({ hasText: 'Salt & Sage' })).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expect(map.dayMap).toBeInViewport();
    });

    test('lists every vendor of the day with no count, and a press opens their table', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.vendors).toHaveText(TODAYS_ROWS);
      await expect(map.vendorsPanel).toHaveAccessibleName('Vendors');
      await expect(page.getByTestId('public-map-vendors-count')).toHaveCount(0);
      await expect(map.vendorsPanel.getByText(/\d+ vendors?\b/)).toHaveCount(0);

      await press(map.vendors.filter({ hasText: 'Loom House' }));
      await expect(page).toHaveURL(new RegExp(`location=${seeded.north.id}&table=north-table-3`));
      await expect(map.card).toContainText('Loom House');
      await expect(map.vendors.filter({ hasText: 'Kiln & Co' })).not.toHaveAttribute(
        'aria-current',
      );
      await expect(map.dayMap).toBeInViewport();
    });

    test('the list fades under the field once scrolled, and covers nothing at the top', async ({
      page,
    }) => {
      await lengthenTheDay(page, seeded.slug, seeded.today);
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.vendors).toHaveCount(45);
      await expect(map.vendorsFade).toHaveCount(0);

      // Nothing lies over the first row's top at rest: a point just inside it finds the row.
      const first = map.vendors.first();
      const box = (await first.boundingBox())!;
      const listBox = (await map.vendorsList.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(listBox.y);
      const atTop = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[data-testid="public-map-vendor"]')
            ?.textContent ?? null,
        { x: box.x + box.width / 2, y: box.y + 3 },
      );
      expect(atTop).toContain(await first.textContent());

      await map.vendorsList.evaluate((list) => list.scrollTo({ top: 200 }));
      await expect.poll(() => map.vendorsList.evaluate((list) => list.scrollTop)).toBe(200);
      await expect(map.vendorsFade).toBeVisible();
      const fade = (await map.vendorsFade.boundingBox())!;
      expect(Math.abs(fade.y - listBox.y)).toBeLessThan(1);
      expect(Math.abs(fade.width - listBox.width)).toBeLessThan(1);

      await map.vendorsList.evaluate((list) => list.scrollTo({ top: 0 }));
      await expect(map.vendorsFade).toHaveCount(0);
    });
  });
}
