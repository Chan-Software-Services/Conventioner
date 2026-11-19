import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { seedMarketDayMap, type SeededMarketDayMap } from './helpers/seedMarketDayMap';
import { AttendanceStatusPage } from './pages/AttendanceStatusPage';

/**
 * Attendance's map draws its floorplan in step (T501): on the seam's market, North Wing and South
 * Wing are laid out on two fixture images of their own bytes. A location's tables and its image
 * appear together, in the same frame, and a switch never draws one location's tables over the
 * other's image, however long the new image takes; past two seconds the tables stand on the floor
 * with "Loading the floorplan..." until it lands. Once the open image has landed the other one is
 * fetched with no click, so a switch to it, and back, asks for no image again; a background image
 * that failed is fetched again when its location opens. A reload asks the server about the
 * browser's copy of each image, which answers 304, and an open image that cannot be loaded leaves
 * the tables on the floor with a line saying so.
 *
 * What each frame drew is recorded in the page, by `requestAnimationFrame`: the image's object URL,
 * told by its blob's size in bytes, and the ids of the tables drawn, each location's starting with
 * its own prefix (`north-table`, `south-table`).
 */

interface Frame {
  /** The drawn image's bytes; 0 for none, -1 for an object URL the page did not make here. */
  image: number;
  /** Which location's tables are drawn: none, or one location's. */
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
        '[data-testid="attendance-map"] [data-testid="layout-map"]',
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
  /** Each location's image: its gridfs id, and its size in bytes as served. */
  north: { id: string; bytes: number };
  south: { id: string; bytes: number };
}

async function imagesOf(request: APIRequestContext, seeded: SeededMarketDayMap): Promise<Images> {
  const read = await request.get(`${BACKEND_URL}/markets/${seeded.marketId}`);
  expect(read.ok()).toBe(true);
  const { market } = (await read.json()) as {
    market: { setupObject: { floorplans: { locationId: string; imageGridfsId: string }[] } };
  };
  const image = async (locationId: string) => {
    const id = market.setupObject.floorplans.find(
      (fp) => fp.locationId === locationId,
    )!.imageGridfsId;
    const served = await request.get(`${BACKEND_URL}/floorplans/${id}`);
    expect(served.ok()).toBe(true);
    return { id, bytes: (await served.body()).length };
  };
  const images = { north: await image(seeded.north.id), south: await image(seeded.south.id) };
  // Told apart by their bytes, as the frames tell them.
  expect(images.north.bytes).not.toBe(images.south.bytes);
  return images;
}

/** Every image request the page sends, by gridfs id, in order. */
function imageRequests(page: Page, images: Images): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    for (const { id } of [images.north, images.south]) {
      if (request.url().endsWith(`/floorplans/${id}`)) sent.push(id);
    }
  });
  return sent;
}

/** A frame that draws one location's tables over the other's image. */
function mixed(frames: Frame[], images: Images): Frame[] {
  return frames.filter(
    (frame) =>
      frame.tables === 'both' ||
      (frame.tables === 'north' && frame.image === images.south.bytes) ||
      (frame.tables === 'south' && frame.image === images.north.bytes),
  );
}

/** Holds each request for an image until the test releases it; `arrived` once the first has. */
async function holdImage(page: Page, id: string) {
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/floorplans/${id}`, async (route: Route) => {
    arrive();
    await released;
    await route.continue();
  });
  return { arrived, release };
}

async function openTheMap(page: Page, seeded: SeededMarketDayMap): Promise<AttendanceStatusPage> {
  const door = new AttendanceStatusPage(page);
  await door.goto(seeded.marketId);
  await door.viewMap.click();
  await expect(door.map).toBeVisible();
  return door;
}

async function seed(request: APIRequestContext) {
  const seeded = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  return { seeded, images: await imagesOf(request, seeded) };
}

test.describe("Attendance's map draws its floorplan in step", () => {
  test('a switch draws the new tables with their own image alone, in one frame, and asks for no image a second time', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { seeded, images } = await seed(request);
    await recordFrames(page);
    const sent = imageRequests(page, images);
    const south = await holdImage(page, images.south.id);

    const door = await openTheMap(page, seeded);
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(door.mapTable('Aisle A 1')).toBeVisible();

    // South Wing's image is asked for once North Wing's landed, with no click.
    await south.arrived;
    expect(sent).toEqual([images.north.id, images.south.id]);

    // Switched while it is held: neither its tables nor North Wing's image stand on the map.
    await door.locationSelect.selectOption({ label: 'South Wing' });
    await expect(page).toHaveURL(/[?&]location=loc-south-wing(&|$)/);
    await expect(door.map.getByTestId('layout-table')).toHaveCount(0);
    await expect(door.mapImage).toHaveCount(0);
    south.release();

    await expect.poll(() => drawnImage(page)).toBe(images.south.bytes);
    await expect(door.mapTable('Aisle B 1')).toBeVisible();
    await expect(door.mapImageLoading).toHaveCount(0);

    // A second opening of each asks for no image.
    await door.locationSelect.selectOption({ label: 'North Wing' });
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(door.mapTable('Aisle A 1')).toBeVisible();
    await door.locationSelect.selectOption({ label: 'South Wing' });
    await expect.poll(() => drawnImage(page)).toBe(images.south.bytes);
    await expect(door.mapTable('Aisle B 1')).toBeVisible();
    expect(sent).toEqual([images.north.id, images.south.id]);

    const frames = await framesOf(page);
    expect(mixed(frames, images)).toEqual([]);
    // Each location's tables first appear in the frame its image does.
    expect(frames.find((frame) => frame.tables === 'north')?.image).toBe(images.north.bytes);
    expect(frames.find((frame) => frame.tables === 'south')?.image).toBe(images.south.bytes);
  });

  test('past two seconds the tables stand on the floor, saying the floorplan is loading, and the image joins them', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { seeded, images } = await seed(request);
    await recordFrames(page);
    const north = await holdImage(page, images.north.id);

    const door = await openTheMap(page, seeded);
    await north.arrived;
    await expect(door.map.getByTestId('layout-table')).toHaveCount(0);

    // The wait runs out: the tables on the plain floor, and the line under the map.
    await expect(door.mapTable('Aisle A 1')).toBeVisible({ timeout: 5000 });
    await expect(door.mapImageLoading).toHaveText('Loading the floorplan...');
    await expect(door.mapImage).toHaveCount(0);

    north.release();
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(door.mapImageLoading).toHaveCount(0);
    await expect(door.mapTable('Aisle A 1')).toBeVisible();

    const frames = await framesOf(page);
    expect(mixed(frames, images)).toEqual([]);
    expect(frames.find((frame) => frame.tables === 'north')?.image).toBe(0);
  });

  test('a background image that failed is fetched again when its location opens', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { seeded, images } = await seed(request);
    await recordFrames(page);
    const sent = imageRequests(page, images);
    let refuse = true;
    let refused: () => void = () => {};
    const wasRefused = new Promise<void>((resolve) => (refused = resolve));
    await page.route(`**/floorplans/${images.south.id}`, async (route) => {
      if (!refuse) return route.continue();
      refuse = false;
      await route.abort('connectionreset');
      refused();
    });

    const door = await openTheMap(page, seeded);
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await wasRefused;
    // Nothing is said of it while its location is closed.
    await expect(door.mapImageFailed).toHaveCount(0);

    await door.locationSelect.selectOption({ label: 'South Wing' });
    await expect.poll(() => drawnImage(page)).toBe(images.south.bytes);
    await expect(door.mapTable('Aisle B 1')).toBeVisible();
    await expect(door.mapImageFailed).toHaveCount(0);
    expect(sent).toEqual([images.north.id, images.south.id, images.south.id]);
    expect(mixed(await framesOf(page), images)).toEqual([]);
  });

  test('an open image that cannot be loaded leaves the tables on the floor, saying so', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { seeded, images } = await seed(request);
    await page.route(`**/floorplans/${images.north.id}`, (route) =>
      route.fulfill({ status: 500, body: '' }),
    );

    const door = await openTheMap(page, seeded);
    await expect(door.mapImageFailed).toHaveText(
      'The floorplan could not be loaded. The tables are drawn without it.',
    );
    await expect(door.mapTable('Aisle A 1')).toBeVisible();
    await expect(door.mapImage).toHaveCount(0);
  });

  test('a reload asks about each image the browser keeps, and is answered 304', async ({
    authenticatedPage: page,
    request,
  }) => {
    // No `page.route` here: Playwright turns the browser's cache off while it routes requests.
    const { seeded, images } = await seed(request);
    await recordFrames(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const urls = new Map<string, string>();
    const asked = new Map<string, string | undefined>();
    const answered = new Map<string, number>();
    cdp.on('Network.requestWillBeSent', (event) => urls.set(event.requestId, event.request.url));
    cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
      const header = Object.entries(event.headers).find(
        ([name]) => name.toLowerCase() === 'if-none-match',
      );
      asked.set(event.requestId, header?.[1] as string | undefined);
    });
    cdp.on('Network.responseReceivedExtraInfo', (event) =>
      answered.set(event.requestId, event.statusCode),
    );
    /** Each image request since `from`: its image, the tag it carried and the status answered. */
    const exchanges = () =>
      [...urls]
        .flatMap(([requestId, url]) => {
          const image = [images.north, images.south].find(({ id }) =>
            url.endsWith(`/floorplans/${id}`),
          );
          return image
            ? [{ id: image.id, asked: asked.get(requestId), status: answered.get(requestId) }]
            : [];
        })
        .filter((exchange) => exchange.status !== undefined);

    const door = await openTheMap(page, seeded);
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    // Both images downloaded whole, the second in the background.
    await expect
      .poll(() => exchanges().map(({ id, status }) => `${id} ${status}`))
      .toEqual([`${images.north.id} 200`, `${images.south.id} 200`]);

    urls.clear();
    await page.reload();
    await expect.poll(() => drawnImage(page)).toBe(images.north.bytes);
    await expect(door.mapTable('Aisle A 1')).toBeVisible();
    await expect.poll(exchanges).toEqual([
      { id: images.north.id, asked: `"${images.north.id}"`, status: 304 },
      { id: images.south.id, asked: `"${images.south.id}"`, status: 304 },
    ]);
  });
});
