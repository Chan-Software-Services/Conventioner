import type { Locator, Page, Request } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { inTheWindow, PHONE_AND_DESK } from './helpers/phoneWindow';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * A market's public map (T422 ticket 09), `/<slug>/map`, opened signed out on the seam's seeded
 * market: North Wing's Aisle A of four tables, Aisle A 3 shared by Loom House (left) and Paper Moth
 * Press (right), and South Wing's Aisle B of three, one vendor there with no public name and one
 * whose business name was an email address, withheld. Today seven vendors are seated, tomorrow
 * two.
 *
 * The page is one sheet filling the window under the app bar (T465): it never scrolls, the day and
 * the hall are two selects at the map side's top right, and the legend names the open hall's
 * sections. The list of the day's vendors is proved in `the-public-map-vendors.spec.ts`.
 *
 * The allowlist on the page: whatever a visitor presses, the page's text and its links hold no
 * email address and none of the seeded personal markers, and every request goes to the map's two
 * public routes or the app's own files. A market whose map is off reads exactly as an address
 * naming nothing.
 */

/** A market date as the day select offers it, "Nov 18", read in UTC as the page reads it. */
const shortDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

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
        await map.daySelect.selectOption(date);
        await expect(map.daySelect).toHaveValue(date);
        for (const hall of [seeded.north.name, seeded.south.name]) {
          await map.locationSelect.selectOption({ label: hall });
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
      const publicRoute = new RegExp(
        `^/api/public/markets/${seeded.slug}/map(/image/(${seeded.north.id}|${seeded.south.id}))?$`,
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
      // No card shows before a pick.
      await expect(map.card).toHaveCount(0);

      await press(map.table('Aisle A 1'));
      await expect(page).toHaveURL(
        new RegExp(`\\?date=${seeded.today}&location=${seeded.north.id}&table=north-table-1$`),
      );
      await expect(map.card).toContainText('Aisle A 1');
      await expect(map.cardNames).toHaveText(['Ember Ceramics']);
      const website = map.cardWebsites;
      await expect(website).toHaveText('ember-ceramics.test');
      await expect(website).toHaveAttribute('href', 'https://ember-ceramics.test/');
      const instagram = map.cardInstagrams;
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
      await expect(map.card).toContainText('Aisle A 4');
      await expect(map.cardWhole).toHaveText(/^This table is free on \w{3} \d+ \w{3}\.$/);
    });

    test('each half of the shared table is pressed on its own, and the card reads that half', async ({
      page,
      expectAccessible,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await press(map.table('Aisle A 3', 'left'));
      await expect(map.card).toContainText('Aisle A 3');
      await expect(map.cardHalves.getByRole('heading', { level: 3 })).toHaveText(['Left half']);
      await expect(map.cardHalves).toContainText('Loom House');
      await expect(map.cardHalves.getByTestId('public-map-card-instagram')).toHaveText(
        '@example_loom',
      );
      await expect(map.card).not.toContainText('Paper Moth Press');
      await press(map.table('Aisle A 3', 'right'));
      await expect(map.cardHalves.getByRole('heading', { level: 3 })).toHaveText(['Right half']);
      await expect(map.cardHalves).toContainText('Paper Moth Press');
      await expect(map.cardHalves.getByTestId('public-map-card-website')).toHaveText(
        'paper-moth.test',
      );
      await expect(map.card).not.toContainText('Loom House');
      await expect(map.table('Aisle A 3', 'left')).toHaveAccessibleName(
        'Aisle A 3, Standard 6 ft, left half, Loom House',
      );
      await expect(map.table('Aisle A 3', 'right')).toHaveAccessibleName(
        'Aisle A 3, Standard 6 ft, right half, Paper Moth Press',
      );
      await expectAccessible('the public map, a shared table picked');
    });

    test('a change of day and of location redraws the map, the address keeping them', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.daySelect).toHaveValue(seeded.today);
      await expect(map.daySelect).toHaveAccessibleName('Market day');
      await expect(map.daySelect.locator('option')).toHaveText([
        shortDay(seeded.today),
        shortDay(seeded.tomorrow),
      ]);
      await expect(map.locationSelect).toHaveAccessibleName('Location');
      await expect(map.locationSelect.locator('option')).toHaveText([
        seeded.north.name,
        seeded.south.name,
      ]);
      await expect(map.page.getByTestId('day-map-locations')).toHaveCount(0);
      await expect(map.dayButtons).toHaveCount(0);
      await expect(map.table('Aisle A 1')).toHaveAccessibleName(/Ember Ceramics$/);

      await map.daySelect.selectOption(seeded.tomorrow);
      await expect(page).toHaveURL(new RegExp(`date=${seeded.tomorrow}`));
      await expect(map.table('Aisle A 1')).toHaveAccessibleName(/Loom House$/);
      await expect(map.table('Aisle A 2')).toHaveAccessibleName(/Ember Ceramics$/);
      await expect(map.table('Aisle A 3')).toHaveAccessibleName(/no vendor$/);
      await expect(map.vendors).toHaveCount(2);

      await map.locationSelect.selectOption({ label: seeded.south.name });
      await expect(page).toHaveURL(new RegExp(`location=${seeded.south.id}`));
      await expect(map.locationSelect).toHaveValue(seeded.south.id);
      await expect(map.map).toHaveAccessibleName('South Wing layout, 3 tables');
      await expect(map.targets).toHaveCount(3);
      // No one sits in South Wing tomorrow.
      for (const n of [1, 2, 3])
        await expect(map.table(`Aisle B ${n}`)).toHaveAccessibleName(/no vendor$/);
      // A vendor with no public name, today: taken, and nothing of them shown.
      await map.daySelect.selectOption(seeded.today);
      await press(map.table('Aisle B 1'));
      await expect(map.card).toContainText('Aisle B 1');
      await expect(map.cardWhole).toHaveText(
        'A vendor is at this table. Their details are not listed.',
      );
      // An email given as the business name is withheld, and with it every link of theirs.
      await press(map.table('Aisle B 2'));
      await expect(map.card).toContainText('Aisle B 2');
      await expect(map.cardWhole).toHaveText(
        'A vendor is at this table. Their details are not listed.',
      );
      await expect(map.card.getByRole('link')).toHaveCount(0);
    });

    test("the legend names the open hall's sections, and a free table only on a day it has one", async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.sectionLegend).toHaveAccessibleName('Legend');
      // Today North Wing's Aisle A 4 is free.
      await expect(map.sectionLegendItems).toHaveText(['Aisle A', 'Free table']);
      expect(
        await map.sectionLegendItems.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-kind')),
        ),
      ).toEqual(['section', 'free']);
      // The stage is drawn and labelled on the map, and is no item of the legend.
      await expect(map.map.getByTestId('layout-map-zone-label')).toHaveText('Stage');
      await expect(map.sectionLegend).not.toContainText('Stage');
      // No "Taken" and no "Free": the day map draws no legend of its own here.
      await expect(map.legend).toHaveCount(0);

      // Every table of South Wing is taken today: no "Free table".
      await map.locationSelect.selectOption({ label: seeded.south.name });
      await expect(map.sectionLegendItems).toHaveText(['Aisle B']);
      // Tomorrow nobody sits there.
      await map.daySelect.selectOption(seeded.tomorrow);
      await expect(map.sectionLegendItems).toHaveText(['Aisle B', 'Free table']);
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
      await expect(map.daySelect).toHaveValue(seeded.tomorrow);
      await expect(map.card).toContainText('Aisle A 1');
      await expect(map.card).toContainText('Loom House');
      await page.reload();
      await expect(map.card).toContainText('Loom House');

      await map.goto(seeded.slug, { date: '2001-01-01', location: 'no-such-hall', table: 'x' });
      await expect(map.daySelect).toHaveValue(seeded.today);
      await expect(map.map).toHaveAccessibleName(/^North Wing layout/);
      await expect(map.card).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('a market with its map off reads exactly as an address naming nothing', async ({
      page,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(closed.slug);
      await expect(map.notFound).toBeVisible();
      await expect(page.getByTestId('page-not-found')).toContainText('Page not found');
      const gated = await map.renderedText(closed.slug);
      const nothing = await map.renderedText('no-such-market-zz');
      expect(gated).toBe(nothing);
    });

    test('an organizer reads it with the logo alone in the bar', async ({ authenticatedPage }) => {
      const map = new PublicMapPage(authenticatedPage);
      await map.goto(seeded.slug);
      await expect(map.heading).toBeVisible();
      const bar = authenticatedPage.getByTestId('app-bar');
      await expect(bar.getByAltText('Conventioner', { exact: true })).toBeVisible();
      await expect(bar.getByRole('link')).toHaveCount(0);
      await expect(bar.getByRole('button')).toHaveCount(0);
      await expect(authenticatedPage).toHaveTitle(`${seeded.marketName} map`);
    });

    if (size.phone) {
      test('on a phone it stacks, and a pinch zooms the map, never the page', async ({ page }) => {
        const map = new PublicMapPage(page);
        await map.goto(seeded.slug);
        await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
        // The sheet stands 12px in, its edge 1px: the map side over the panel.
        const box = (await map.dayMap.boundingBox())!;
        expect(box.x).toBeCloseTo(13, 0);
        await press(map.table('Aisle A 1'));
        const card = (await map.card.boundingBox())!;
        expect(card.y).toBeGreaterThan(box.y + box.height);

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
      test('at a desk the map takes the left, the list a 21rem panel, and the card speaks from the hall', async ({
        page,
      }) => {
        const map = new PublicMapPage(page);
        await map.goto(seeded.slug);
        await press(map.table('Aisle A 1'));
        const root = (await map.root.boundingBox())!;
        const left = (await map.dayMap.boundingBox())!;
        const hall = (await map.hall.boundingBox())!;
        const card = (await map.card.boundingBox())!;
        const list = (await map.vendors.first().boundingBox())!;
        // The panel is 21rem from the map side's end to the sheet's inner edge (the column's 16px
        // padding and the sheet's 1px edge in from the page's).
        expect(root.x + root.width - 16 - 1 - (left.x + left.width)).toBeCloseTo(336, 0);
        expect(list.x).toBeGreaterThan(left.x + left.width);
        // The card is the bubble, inside the hall; the panel holds no card.
        await expect(map.bubble.getByTestId('public-map-card')).toBeVisible();
        expect(card.x).toBeGreaterThanOrEqual(hall.x);
        expect(card.x + card.width).toBeLessThanOrEqual(hall.x + hall.width);
        expect(card.y).toBeGreaterThanOrEqual(hall.y);
        expect(card.y + card.height).toBeLessThanOrEqual(hall.y + hall.height);
        await map.zoomIn.click();
        await expect.poll(async () => (await map.view()).width).toBeLessThan(30_000);
      });
    }
  });
}

/** The page's boxes, read in one go: the column, the map side, the hall, the selects, the drawn
 *  map, the legend and the zoom. */
async function sheetBoxes(map: PublicMapPage) {
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  return {
    root: await box(map.root),
    side: await box(map.dayMap),
    hall: await box(map.hall),
    day: await box(map.daySelect),
    location: await box(map.locationSelect),
    drawn: await box(map.map),
    legend: await box(map.sectionLegend),
    zoom: await box(map.page.getByTestId('day-map-zoom')),
  };
}

const WINDOWS = [
  ...PHONE_AND_DESK,
  { name: 'at a wide desk', phone: false, use: { viewport: { width: 1990, height: 1309 } } },
] as const;

for (const size of WINDOWS) {
  test.describe(`the public map's sheet ${size.name}`, () => {
    test.use(size.use);

    test('fills the window under the app bar, and the page never scrolls', async ({
      page,
      expectAccessible,
    }) => {
      const map = new PublicMapPage(page);
      await map.goto(seeded.slug);
      await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
      await expect(page.locator('html')).toHaveClass(/(^|\s)fills-the-window(\s|$)/);
      const { height } = size.use.viewport;

      const measured = await page.evaluate(() => ({
        scroll: document.documentElement.scrollHeight,
        client: document.documentElement.clientHeight,
      }));
      expect(measured.scroll, 'the document is no taller than the window').toBe(measured.client);
      const boxes = await sheetBoxes(map);
      expect(boxes.root.y + boxes.root.height).toBeCloseTo(height, 0);

      // The hall is inside the map side, under the selects, which cover none of it.
      expect(boxes.hall.x).toBeGreaterThanOrEqual(boxes.side.x);
      expect(boxes.hall.y + boxes.hall.height).toBeLessThanOrEqual(
        boxes.side.y + boxes.side.height,
      );
      for (const select of [boxes.day, boxes.location]) {
        expect(select.y + select.height, 'a select stands clear of the hall').toBeLessThanOrEqual(
          boxes.hall.y,
        );
        // 12px in from the map side's top and end.
        expect(boxes.side.x + boxes.side.width - (select.x + select.width)).toBeGreaterThanOrEqual(
          12 - 0.5,
        );
      }
      expect(boxes.day.y - boxes.side.y).toBeCloseTo(12, 0);

      if (size.phone) {
        // The legend and the zoom stand in a row under the drawn hall, covering none of it.
        for (const pill of [boxes.legend, boxes.zoom])
          expect(pill.y).toBeGreaterThanOrEqual(boxes.drawn.y + boxes.drawn.height);
        expect(boxes.legend.x + boxes.legend.width).toBeLessThanOrEqual(boxes.zoom.x);
      } else {
        // The legend over the hall's bottom-left corner and the zoom over its bottom-right.
        expect(boxes.legend.x - boxes.hall.x).toBeCloseTo(12, 0);
        expect(
          boxes.hall.y + boxes.hall.height - (boxes.legend.y + boxes.legend.height),
        ).toBeCloseTo(12, 0);
        expect(boxes.hall.x + boxes.hall.width - (boxes.zoom.x + boxes.zoom.width)).toBeCloseTo(
          12,
          0,
        );
      }

      // Only the panel scrolls: a wheel over the map side moves no page.
      await page.mouse.move(boxes.side.x + 40, boxes.side.y + 40);
      await page.mouse.wheel(0, 400);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expectAccessible(`the public map's sheet ${size.name}`);
    });
  });
}
