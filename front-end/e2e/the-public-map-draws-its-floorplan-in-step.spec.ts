import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { PublicMapPage } from './pages/PublicMapPage';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';

/**
 * The public map draws each hall's floorplan in step (T501), signed out, on the seam's market with
 * its map open: North Wing and South Wing are laid out on two fixture images of their own bytes.
 * A hall's tables and its image appear together, in the same frame, and a switch never draws one
 * hall's tables over the other's image; once the open image has landed the other one is fetched
 * with no click, so a switch to it, and back, asks for no image again. The image is the original,
 * in its own colours and at full strength. Past two seconds, or once the image failed, the tables
 * stand on the floor, and the page says nothing of it; a card opened by a link speaks from its table
 * once the held tables are drawn.
 *
 * What each frame drew is recorded in the page, by `requestAnimationFrame`: the image's object URL,
 * told by its blob's size in bytes, and the ids of the tables drawn, each hall's starting with its
 * own prefix (`north-table`, `south-table`).
 */

interface Frame {
  /** The drawn image's bytes; 0 for none, -1 for an object URL the page did not make here. */
  image: number;
  /** Which hall's tables are drawn: none, or one hall's. */
  tables: 'none' | 'north' | 'south' | 'both';
}

/** Records every frame whose drawing differs from the one before, from the page's first. */
async function recordFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __blobBytes: Record<string, number>;
      __frames: { image: number; tables: string }[];
    };
    w.__blobBytes = {};
    w.__frames = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (made: Blob | MediaSource) => {
      const url = make(made);
      if (made instanceof Blob) w.__blobBytes[url] = made.size;
      return url;
    };
    let last = '';
    const tick = () => {
      const map = document.querySelector(
        '[data-testid="public-map-hall"] [data-testid="layout-map"]',
      );
      const href = map?.querySelector('[data-testid="layout-map-image"]')?.getAttribute('href');
      const ids = [...(map?.querySelectorAll('[data-testid="layout-table"]') ?? [])].map(
        (table) => table.getAttribute('data-table-id') ?? '',
      );
      const north = ids.some((id) => id.startsWith('north-table'));
      const south = ids.some((id) => id.startsWith('south-table'));
      const frame = {
        image: href ? (w.__blobBytes[href] ?? -1) : 0,
        tables: north && south ? 'both' : north ? 'north' : south ? 'south' : 'none',
      };
      const key = `${frame.image}:${frame.tables}`;
      if (key !== last) w.__frames.push(frame);
      last = key;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
}

/** The bytes of the image the map draws now, 0 for none. */
async function drawnImage(page: Page): Promise<number> {
  return (await framesOf(page)).at(-1)?.image ?? 0;
}

interface Images {
  /** Each hall's image, by its location id: its size in bytes as served. */
  north: { id: string; bytes: number };
  south: { id: string; bytes: number };
}

/** The public image route of a hall. */
const imagePath = (seeded: SeededMarketDayMap, locationId: string) =>
  `/public/markets/${seeded.slug}/map/image/${locationId}`;

async function imagesOf(request: APIRequestContext, seeded: SeededMarketDayMap): Promise<Images> {
  const image = async (id: string) => {
    const served = await request.get(`${BACKEND_URL}${imagePath(seeded, id)}`);
    expect(served.ok()).toBe(true);
    return { id, bytes: (await served.body()).length };
  };
  const images = { north: await image(seeded.north.id), south: await image(seeded.south.id) };
  // Told apart by their bytes, as the frames tell them.
  expect(images.north.bytes).not.toBe(images.south.bytes);
  return images;
}

/** Every image request the page sends, by location id, in order. */
function imageRequests(page: Page, seeded: SeededMarketDayMap): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    for (const id of [seeded.north.id, seeded.south.id]) {
      if (new URL(request.url()).pathname.endsWith(imagePath(seeded, id))) sent.push(id);
    }
  });
  return sent;
}

/** What the page says outside the drawing of the hall. */
async function said(map: PublicMapPage): Promise<string> {
  return map.root.evaluate((root) => {
    const copy = root.cloneNode(true) as Element;
    for (const drawing of copy.querySelectorAll('[data-testid="layout-map"]')) drawing.remove();
    return copy.textContent ?? '';
  });
}

/** A frame that draws one hall's tables over the other's image. */
function mixed(frames: Frame[], images: Images): Frame[] {
  return frames.filter(
    (frame) =>
      frame.tables === 'both' ||
      (frame.tables === 'north' && frame.image === images.south.bytes) ||
      (frame.tables === 'south' && frame.image === images.north.bytes),
  );
}

/** Holds each request for a hall's image until the test releases it; `arrived` once the first has. */
async function holdImage(page: Page, seeded: SeededMarketDayMap, id: string) {
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${imagePath(seeded, id)}`, async (route: Route) => {
    arrive();
    await released;
    await route.continue();
  });
  return { arrived, release };
}

test.describe.configure({ mode: 'serial' });

let seeded: SeededMarketDayMap;
let images: Images;

test.beforeAll(async ({ request }) => {
  seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  images = await imagesOf(request, seeded);
});

test.describe('the public map draws its floorplan in step', () => {
  test('a switch draws the new tables with their own image alone, in one frame, and asks for no image a second time', async ({
    page,
  }) => {
    await recordFrames(page);
    const sent = imageRequests(page, seeded);
    const south = await holdImage(page, seeded, images.south.id);

    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(map.table('Aisle A 1')).toBeVisible();

    // The original image: in its own colours, at full strength.
    await expect(map.mapImage).not.toHaveAttribute('opacity');
    await expect(map.mapImage).toHaveCSS('filter', 'none');
    for (const words of ['Show the floorplan', 'Greyscale', 'Faded']) {
      await expect(page.getByText(words)).toHaveCount(0);
    }
    await expect(page.getByRole('checkbox')).toHaveCount(0);

    // South Wing's image is asked for once North Wing's landed, with no click.
    await south.arrived;
    expect(sent).toEqual([images.north.id, images.south.id]);

    // Switched while it is held: neither its tables nor North Wing's image stand on the map.
    await map.locationSelect.selectOption({ label: seeded.south.name });
    await expect(page).toHaveURL(new RegExp(`[?&]location=${seeded.south.id}(&|$)`));
    await expect(map.map.getByTestId('layout-table')).toHaveCount(0);
    await expect(map.mapImage).toHaveCount(0);
    south.release();

    await expect.poll(() => drawnImage(page)).toBe(images.south.bytes);
    await expect(map.table('Aisle B 1')).toBeVisible();

    // A second opening of each asks for no image.
    await map.locationSelect.selectOption({ label: seeded.north.name });
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(map.table('Aisle A 1')).toBeVisible();
    await map.locationSelect.selectOption({ label: seeded.south.name });
    await expect.poll(() => drawnImage(page)).toBe(images.south.bytes);
    await expect(map.table('Aisle B 1')).toBeVisible();
    expect(sent).toEqual([images.north.id, images.south.id]);

    const frames = await framesOf(page);
    expect(mixed(frames, images)).toEqual([]);
    // Each hall's tables first appear in the frame its image does.
    expect(frames.find((frame) => frame.tables === 'north')?.image).toBe(images.north.bytes);
    expect(frames.find((frame) => frame.tables === 'south')?.image).toBe(images.south.bytes);
  });

  test('past two seconds the tables stand on the floor, the page saying nothing, and the image joins them', async ({
    page,
  }) => {
    await recordFrames(page);
    const north = await holdImage(page, seeded, images.north.id);

    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await north.arrived;
    await expect(map.map.getByTestId('layout-table')).toHaveCount(0);
    const before = await said(map);

    await expect(map.table('Aisle A 1')).toBeVisible({ timeout: 5000 });
    await expect(map.mapImage).toHaveCount(0);
    await expect(map.root).not.toContainText(/floorplan|loading/i);
    expect(await said(map)).toBe(before);

    north.release();
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(map.table('Aisle A 1')).toBeVisible();

    const frames = await framesOf(page);
    expect(mixed(frames, images)).toEqual([]);
    expect(frames.find((frame) => frame.tables === 'north')?.image).toBe(0);
  });

  test('an image that cannot be loaded leaves the tables on the floor, the page saying nothing', async ({
    page,
  }) => {
    await page.route(`**${imagePath(seeded, images.north.id)}`, (route) =>
      route.fulfill({ status: 500, body: '' }),
    );
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug);
    await expect(map.table('Aisle A 1')).toBeVisible();
    await expect(map.mapImage).toHaveCount(0);
    await expect(map.root).not.toContainText(/floorplan|could not/i);
  });

  test("a link to a table opens its card speaking from the table, once the hall's tables are drawn", async ({
    page,
  }) => {
    test.skip(page.viewportSize()!.width < 1000, 'the card speaks from its table at a desk');
    const north = await holdImage(page, seeded, images.north.id);
    const map = new PublicMapPage(page);
    await map.goto(seeded.slug, {
      date: seeded.today,
      location: seeded.north.id,
      table: 'north-table-1',
    });
    await north.arrived;
    await expect(map.map.getByTestId('layout-table')).toHaveCount(0);
    north.release();

    await expect(map.mapImage).toHaveAttribute('href', /^blob:/);
    await expect(map.bubble).toBeVisible();
    await expect(map.bubble.getByTestId('public-map-card')).toContainText('Aisle A 1');
    // It speaks from the table: the two boxes touch or overlap, the tail between them.
    const table = (await map.table('Aisle A 1').boundingBox())!;
    const bubble = (await map.bubble.boundingBox())!;
    const apart = Math.max(
      bubble.x - (table.x + table.width),
      table.x - (bubble.x + bubble.width),
      bubble.y - (table.y + table.height),
      table.y - (bubble.y + bubble.height),
    );
    expect(apart).toBeLessThan(40);
  });
});
