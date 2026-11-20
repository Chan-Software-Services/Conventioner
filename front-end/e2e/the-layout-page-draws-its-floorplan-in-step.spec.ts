import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { LayoutPage } from './pages/LayoutPage';
import {
  LOWER_HALL,
  SECOND_FLOORPLAN_PATH,
  UPPER_HALL_TABLES,
  seedLayout,
  startLayout,
  type SeededLayout,
} from './helpers/seeds';

/**
 * The Layout page draws its floorplan in step (T501): on a market whose Upper Hall and Lower Hall
 * are each laid out on a fixture image of its own bytes, a location's tables and its image appear
 * together, and a move from one location's layout to the other's never draws the new tables over
 * the old image, however long the new image takes, in the editor and where the layout is read.
 * Once the open image has landed the other one is fetched with no click, so a move to it, and
 * back, asks for no image again.
 *
 * What each frame drew is recorded in the page, by `requestAnimationFrame`: the image's object URL,
 * told by its blob's size in bytes, and the ids of the tables drawn, each location's starting with
 * its own prefix (`table` for Upper Hall, `lower` for Lower Hall).
 */

interface Frame {
  /** The drawn image's bytes; 0 for none, -1 for an object URL the page did not make here. */
  image: number;
  /** Which location's tables are drawn: none, or one location's. */
  tables: 'none' | 'upper' | 'lower' | 'both';
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
      const map = document.querySelector('[data-testid="layout-map"]');
      const href = map?.querySelector('[data-testid="layout-map-image"]')?.getAttribute('href');
      const ids = [...(map?.querySelectorAll('[data-testid="layout-table"]') ?? [])].map(
        (table) => table.getAttribute('data-table-id') ?? '',
      );
      const upper = ids.some((id) => id.startsWith('table-'));
      const lower = ids.some((id) => id.startsWith('lower-'));
      const frame = {
        image: href ? (w.__blobBytes[href] ?? -1) : 0,
        tables: upper && lower ? 'both' : upper ? 'upper' : lower ? 'lower' : 'none',
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
  upper: { id: string; bytes: number };
  lower: { id: string; bytes: number };
}

async function imagesOf(request: APIRequestContext, seeded: SeededLayout): Promise<Images> {
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
  const images = { upper: await image(seeded.upper.id), lower: await image(seeded.lower.id) };
  // Told apart by their bytes, as the frames tell them.
  expect(images.upper.bytes).not.toBe(images.lower.bytes);
  return images;
}

/** Every image request the page sends, by gridfs id, in order. */
function imageRequests(page: Page, images: Images): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    for (const { id } of [images.upper, images.lower]) {
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
      (frame.tables === 'upper' && frame.image === images.lower.bytes) ||
      (frame.tables === 'lower' && frame.image === images.upper.bytes),
  );
}

/** Holds each request for an image until the test releases it. */
async function holdImage(page: Page, id: string) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/floorplans/${id}`, async (route: Route) => {
    await released;
    await route.continue();
  });
  return { release };
}

/** Upper Hall laid out on the first fixture image, Lower Hall on the second, both calibrated. */
async function seed(request: APIRequestContext) {
  const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    metresAcross: 30,
    tables: UPPER_HALL_TABLES,
  });
  await startLayout(request, BACKEND_URL, seeded.marketId, {
    locationId: LOWER_HALL.id,
    metresAcross: 30,
    tables: [
      { section: 'sec-bronze', at: [6000, 6000] },
      { section: 'sec-bronze', at: [8000, 6000] },
    ],
    tablePrefix: 'lower',
    image: SECOND_FLOORPLAN_PATH,
  });
  return { seeded, images: await imagesOf(request, seeded) };
}

/**
 * Open Upper Hall's layout with Lower Hall's image held, move to Lower Hall, and see the map draw
 * neither its tables nor any image until that image lands, then both in one frame.
 */
async function moveWhileTheImageIsHeld(page: Page, request: APIRequestContext) {
  const { seeded, images } = await seed(request);
  await recordFrames(page);
  const lower = await holdImage(page, images.lower.id);

  const layout = new LayoutPage(page);
  await layout.goto(seeded.marketId, seeded.upper.id);
  await expect.poll(() => drawnImage(page)).toBe(images.upper.bytes);
  await expect(layout.table('Gold row 1, Standard 6 ft')).toBeVisible();

  await layout.location('Lower Hall').click();
  await expect(page).toHaveURL(new RegExp(`/layout/${LOWER_HALL.id}$`));
  // While Lower Hall's image is held, the hall's floor alone: no table, and no image.
  await expect
    .poll(async () => (await framesOf(page)).at(-1))
    .toEqual({ image: 0, tables: 'none' });
  await expect(layout.tables).toHaveCount(0);
  await expect(layout.mapImage).toHaveCount(0);
  lower.release();

  await expect.poll(() => drawnImage(page)).toBe(images.lower.bytes);
  await expect(layout.table('Bronze corner 1, Standard 6 ft')).toBeVisible();

  const frames = await framesOf(page);
  expect(mixed(frames, images)).toEqual([]);
  // Each location's tables first appear in the frame its image does.
  expect(frames.find((frame) => frame.tables === 'upper')?.image).toBe(images.upper.bytes);
  expect(frames.find((frame) => frame.tables === 'lower')?.image).toBe(images.lower.bytes);
  return { layout, images };
}

test.describe('The Layout page draws its floorplan in step', () => {
  test("a move in the editor draws no frame of the new tables over the old location's image", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await moveWhileTheImageIsHeld(page, request);
    await expect(layout.editor).toBeVisible();
  });

  test("a move where the layout is read draws no frame of the new tables over the old location's image", async ({
    authenticatedPage: page,
    request,
  }) => {
    // At a phone's width the layout is read, never edited.
    await page.setViewportSize({ width: 390, height: 844 });
    const { layout } = await moveWhileTheImageIsHeld(page, request);
    await expect(layout.editor).toHaveCount(0);
  });

  test("the other location's image is fetched with no click, and a second opening asks for none", async ({
    authenticatedPage: page,
    request,
  }) => {
    const { seeded, images } = await seed(request);
    await recordFrames(page);
    const sent = imageRequests(page, images);

    const layout = new LayoutPage(page);
    await layout.goto(seeded.marketId, seeded.upper.id);
    await expect.poll(() => drawnImage(page)).toBe(images.upper.bytes);
    await expect.poll(() => [...sent]).toEqual([images.upper.id, images.lower.id]);

    await layout.location('Lower Hall').click();
    await expect.poll(() => drawnImage(page)).toBe(images.lower.bytes);
    await expect(layout.table('Bronze corner 1, Standard 6 ft')).toBeVisible();
    await layout.location('Upper Hall').click();
    await expect.poll(() => drawnImage(page)).toBe(images.upper.bytes);
    await expect(layout.table('Gold row 1, Standard 6 ft')).toBeVisible();
    expect(sent).toEqual([images.upper.id, images.lower.id]);
    expect(mixed(await framesOf(page), images)).toEqual([]);
  });
});
