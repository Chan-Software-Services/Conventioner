import type { Page, Request } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { vendorPagePath } from './helpers/marketScreens';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * A market's public map (T422 ticket 09), `/<slug>/map`, opened signed out on the seam's seeded
 * market: North Wing's Aisle A of four tables, Aisle A 3 shared by Loom House (left) and Paper Moth
 * Press (right), and South Wing's Aisle B of three, one vendor there with no public name and one
 * whose business name was an email address, withheld. Today seven vendors are seated, tomorrow
 * two.
 *
 * The allowlist on the page: whatever a visitor presses, the page's text and its links hold no
 * email address and none of the seeded personal markers, and every request goes to the map's two
 * public routes or the app's own files. A market whose map is off reads exactly as an address
 * naming nothing.
 */

/** An "@" followed by a domain: an email address, wherever it stands. */
const AN_ADDRESS = /@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;
let closed: SeededMarketDayMap;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  closed = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
});

/** Every request the page makes from here on, by its address. */
function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request: Request) => seen.push(request.url()));
  return seen;
}

/** What a visitor can read and follow: the page's text and every link's address. */
async function whatTheVisitorReads(page: Page): Promise<string> {
  const text = await page.locator('body').innerText();
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
  return [text, ...hrefs].join('\n');
}

for (const size of PHONE_AND_DESK) {
  test.describe(`the public map ${size.name}`, () => {
    test.use(size.use);
    const { press, expectFits } = inTheWindow(size);

    test('shows a visitor only the answers chosen, and asks only the public routes', async ({
      page,
      expectAccessible,
    }) => {
      const requests = watchRequests(page);
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.heading).toHaveText(seeded.marketName);
      await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
      await expectFits(page, 'The public map');
      await expectAccessible('the public map, before a pick');

      // Every table and half of every location, on each day, pressed and read.
      const read: string[] = [];
      for (const date of [seeded.today, seeded.tomorrow]) {
        await press(map.day(date));
        await expect(map.day(date)).toHaveAttribute('aria-pressed', 'true');
        for (const hall of [seeded.north.name, seeded.south.name]) {
          await press(map.location(hall));
          await expect(map.map).toHaveAccessibleName(new RegExp(`^${hall} layout`));
          const count = await map.targets.count();
          for (let i = 0; i < count; i++) {
            await press(map.targets.nth(i));
            await expect(map.card.getByRole('heading', { level: 2 })).toBeVisible();
            read.push(await whatTheVisitorReads(page));
          }
        }
      }
      expect(read.length).toBeGreaterThan(10);
      const everything = read.join('\n');
      expect(everything).not.toMatch(AN_ADDRESS);
      for (const marker of seeded.personalMarkers) expect(everything).not.toContain(marker);

      const origin = new URL(page.url()).origin;
      // The market page's own read (T469), which chooses the map, is public too.
      const publicRoute = new RegExp(
        `^/api/public/markets/${seeded.slug}/(vendor-page|map(/image/(${seeded.north.id}|${seeded.south.id}))?)$`,
      );
      const strays = requests.filter((address) => {
        const url = new URL(address);
        if (url.origin !== origin) return true;
        return url.pathname.startsWith('/api/') && !publicRoute.test(url.pathname);
      });
      expect(strays).toEqual([]);
      expect(requests.map((r) => new URL(r).pathname)).toContain(
        `/api/public/markets/${seeded.slug}/map/image/${seeded.north.id}`,
      );
    });

    test("a press on a table reads its vendor, their website's host and their @handle", async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.card).toHaveText('Press a table, or find a vendor below.');
      await expect(map.legend).toHaveText(['Taken', 'Free']);

      await press(map.table('Aisle A 1'));
      await expect(page).toHaveURL(
        new RegExp(`\\?date=${seeded.today}&location=${seeded.north.id}&table=north-table-1$`),
      );
      await expect(map.card.getByRole('heading', { level: 2 })).toHaveText('Table Aisle A 1');
      await expect(map.card).toContainText('Ember Ceramics');
      const website = map.card.getByTestId('public-map-card-website');
      await expect(website).toHaveText('ember-ceramics.test');
      await expect(website).toHaveAttribute('href', 'https://ember-ceramics.test/');
      const instagram = map.card.getByTestId('public-map-card-instagram');
      await expect(instagram).toHaveText('@example_ember');
      await expect(instagram).toHaveAttribute('href', 'https://www.instagram.com/example_ember/');
      for (const link of [website, instagram]) {
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      }
      // The map outlines the table picked.
      await expect(map.map.getByTestId('layout-map-read')).toHaveCount(1);

      // A free table says so for the day.
      await press(map.table('Aisle A 4'));
      await expect(map.card).toHaveText(
        /Table Aisle A 4\s*This table is free on \w{3} \d+ \w{3}\./,
      );
    });

    test('each half of the shared table is pressed on its own, and the card reads both', async ({
      page,
      expectAccessible,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      for (const half of ['left', 'right'] as const) {
        await press(map.table('Aisle A 3', half));
        await expect(map.card.getByRole('heading', { level: 2 })).toHaveText('Table Aisle A 3');
        await expect(map.cardHalves.getByRole('heading', { level: 3 })).toHaveText([
          'Left half',
          'Right half',
        ]);
        await expect(map.cardHalves.nth(0)).toContainText('Loom House');
        await expect(map.cardHalves.nth(0).getByTestId('public-map-card-instagram')).toHaveText(
          '@example_loom',
        );
        await expect(map.cardHalves.nth(1)).toContainText('Paper Moth Press');
        await expect(map.cardHalves.nth(1).getByTestId('public-map-card-website')).toHaveText(
          'paper-moth.test',
        );
      }
      await expect(map.table('Aisle A 3', 'left')).toHaveAccessibleName(
        'Aisle A 3, Standard 6 ft, left half, Loom House',
      );
      await expect(map.table('Aisle A 3', 'right')).toHaveAccessibleName(
        'Aisle A 3, Standard 6 ft, right half, Paper Moth Press',
      );
      await expectAccessible('the public map, a shared table picked');
    });

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
      await expect(map.card).toContainText('Table Aisle B 3');
      await expect(map.card).toContainText('Salt & Sage');
      await expect(page).toHaveURL(new RegExp(`location=${seeded.south.id}&table=south-table-3`));
      await expect(map.dayMap).toBeInViewport();
    });

    test('a change of day and of location redraws the map, the address keeping them', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.day(seeded.today)).toHaveAttribute('aria-pressed', 'true');
      await expect(map.table('Aisle A 1')).toHaveAccessibleName(/Ember Ceramics$/);

      await press(map.day(seeded.tomorrow));
      await expect(page).toHaveURL(new RegExp(`date=${seeded.tomorrow}`));
      await expect(map.table('Aisle A 1')).toHaveAccessibleName(/Loom House$/);
      await expect(map.table('Aisle A 2')).toHaveAccessibleName(/Ember Ceramics$/);
      await expect(map.table('Aisle A 3')).toHaveAccessibleName(/no vendor$/);
      await expect(map.vendors).toHaveCount(2);

      await press(map.location(seeded.south.name));
      await expect(page).toHaveURL(new RegExp(`location=${seeded.south.id}`));
      await expect(map.map).toHaveAccessibleName('South Wing layout, 3 tables');
      await expect(map.targets).toHaveCount(3);
      // No one sits in South Wing tomorrow.
      for (const n of [1, 2, 3])
        await expect(map.table(`Aisle B ${n}`)).toHaveAccessibleName(/no vendor$/);
      // A vendor with no public name, today: taken, and nothing of them shown.
      await press(map.day(seeded.today));
      await press(map.table('Aisle B 1'));
      await expect(map.card).toHaveText(
        /Table Aisle B 1\s*A vendor is at this table\. Their details are not listed\./,
      );
      // An email given as the business name is withheld, and with it every link of theirs.
      await press(map.table('Aisle B 2'));
      await expect(map.card).toHaveText(
        /Table Aisle B 2\s*A vendor is at this table\. Their details are not listed\./,
      );
      await expect(map.card.getByRole('link')).toHaveCount(0);
    });

    test('a link opens its day, location and table, and an unknown value falls back', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug, {
        date: seeded.tomorrow,
        location: seeded.north.id,
        table: 'north-table-1',
      });
      await expect(map.day(seeded.tomorrow)).toHaveAttribute('aria-pressed', 'true');
      await expect(map.card.getByRole('heading', { level: 2 })).toHaveText('Table Aisle A 1');
      await expect(map.card).toContainText('Loom House');
      await page.reload();
      await expect(map.card).toContainText('Loom House');

      await map.goto(seeded.slug, { date: '2001-01-01', location: 'no-such-hall', table: 'x' });
      await expect(map.day(seeded.today)).toHaveAttribute('aria-pressed', 'true');
      await expect(map.map).toHaveAccessibleName(/^North Wing layout/);
      await expect(map.card).toHaveText('Press a table, or find a vendor below.');
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    // At the market's own address a map that is off is a notice of the market page (T469); an
    // address naming nothing, or a draft's, is still "Page not found".
    test('a market with its map off says so, and an address naming nothing reads "Page not found"', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(closed.slug);
      await expect(page.getByTestId('market-page-notice-line')).toHaveText(
        "The map isn't published yet.",
      );
      await expect(map.heading).toHaveCount(0);
      await map.goto('no-such-market-zz');
      await expect(page.getByTestId('page-not-found')).toContainText('Page not found');
    });

    test("an organizer reads it with the logo and the vendor page's link alone in the bar", async ({
      authenticatedPage,
    }) => {
      const map = new PublicMapPage(authenticatedPage);
      await map.goto(seeded.slug);
      await expect(map.heading).toBeVisible();
      const bar = authenticatedPage.getByTestId('app-bar');
      await expect(bar.getByAltText('Conventioner', { exact: true })).toBeVisible();
      const vendorLink = bar.getByRole('link');
      await expect(vendorLink).toHaveCount(1);
      await expect(vendorLink).toHaveText('Vendor sign-in');
      await expect(vendorLink).toHaveAttribute('href', vendorPagePath(seeded.slug));
      await expect(bar.getByRole('button')).toHaveCount(0);
      await expect(authenticatedPage).toHaveTitle(`${seeded.marketName} map`);
    });

    if (size.phone) {
      test('on a phone it stacks, and a pinch zooms the map, never the page', async ({ page }) => {
        const map = new PublicMapPage(page);
        await map.goto(seeded.slug);
        await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
        const box = (await map.dayMap.boundingBox())!;
        const card = (await map.card.boundingBox())!;
        expect(card.y).toBeGreaterThan(box.y + box.height);
        expect(box.x).toBeCloseTo(16, 0);

        // Two fingers spread to 2.5 times apart about Aisle A 2.
        const whole = (await map.view()).width;
        const at = (await map.table('Aisle A 2').boundingBox())!;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.synthesizePinchGesture', {
          x: Math.round(at.x + at.width / 2),
          y: Math.round(at.y + at.height / 2),
          scaleFactor: 2.5,
          relativeSpeed: 400,
          gestureSourceType: 'touch',
        });
        await expect.poll(async () => (await map.view()).width).toBeLessThan(whole / 2);
        expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
        await expectFits(page, 'The pinched public map');

        // A tap on the table, drawn larger now, reads it.
        const larger = (await map.table('Aisle A 2').boundingBox())!;
        expect(larger.width).toBeGreaterThan(at.width * 2);
        await map.table('Aisle A 2').tap();
        await expect(map.card).toContainText('Kiln & Co');
      });
    } else {
      test('at a desk the map takes the left and the card and the list a 22rem column', async ({
        page,
      }) => {
        const map = new PublicMapPage(page);
        await map.goto(seeded.slug);
        const left = (await map.dayMap.boundingBox())!;
        const card = (await map.card.boundingBox())!;
        const list = (await page.getByTestId('public-map-vendors').boundingBox())!;
        expect(card.x).toBeGreaterThan(left.x + left.width);
        expect(card.width).toBeCloseTo(352, 0);
        expect(list.x).toBeCloseTo(card.x, 0);
        expect(list.y).toBeGreaterThan(card.y + card.height);
        expect(card.y).toBeCloseTo(left.y, 0);
        await map.zoomIn.click();
        await expect.poll(async () => (await map.view()).width).toBeLessThan(30_000);
      });
    }
  });
}
