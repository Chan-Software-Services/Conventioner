import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { DAY_MAP_QUESTIONS, seedMarketDayMap } from './helpers/seedMarketDayMap';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { withUser } from './helpers/withUser';
import { PHONE } from './helpers/screens';
import { marketPagePath } from './helpers/marketScreens';
import { ToolsPage } from './pages/ToolsPage';

/**
 * The Public map card on the Tools tab (T422, D25, D26, D30): an Admin chooses which of the form's
 * short text questions hold each vendor's public name, website and Instagram handle, and turns the
 * public map on, and the public read, which asks no sign-in, answers from then on and stops when it
 * is turned off. Someone the "Publish the map" row refuses reads the card and changes nothing.
 *
 * The market is the seam's (`seedMarketDayMap`): on its market days, its results out, two halls
 * laid out, its map not yet on.
 */
const VIEWER = { email: 'e2e-public-map-viewer@example.com', password: 'e2epublicmapviewer1' };

interface PublicSeat {
  name: string | null;
  website: string | null;
  instagram: string | null;
}

test('an Admin chooses the three questions and turns the map on, and anyone may read it', async ({
  authenticatedPage: page,
  request,
  playwright,
  expectAccessible,
}) => {
  const seed = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const anyone = await playwright.request.newContext();
  const read = () => anyone.get(`${BACKEND_URL}/public/markets/${seed.slug}/map`);
  const tools = new ToolsPage(page);

  await tools.goto(seed.marketId);
  await expect(tools.publicMapCard).toBeVisible({ timeout: 15000 });
  const cards = tools.tools.locator(':scope > *');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('data-testid', 'plan-card-discord');
  await expect(cards.nth(1)).toHaveAttribute('data-testid', 'plan-card-public-map');

  // Off, with nothing chosen: the switch waits on the name, and nothing else is missing.
  await expect(tools.publicMapSwitch).not.toBeChecked();
  await expect(tools.publicMapSwitch).toBeDisabled();
  await expect(tools.publicMapSwitchReason).toHaveText('Choose the public name’s question first.');
  await expect(tools.publicMapMissing).toHaveCount(0);
  await expect(tools.publicMapUrl).toHaveCount(0);
  await expectAccessible('the Public map card, off');
  expect((await read()).status()).toBe(404);

  await tools.savePublicMap(() => tools.publicMapName.choose(DAY_MAP_QUESTIONS.name.key));
  await tools.savePublicMap(() => tools.publicMapWebsite.choose(DAY_MAP_QUESTIONS.website.key));
  await tools.savePublicMap(() => tools.publicMapInstagram.choose(DAY_MAP_QUESTIONS.instagram.key));
  await expect(tools.publicMapName.root).toHaveValue(DAY_MAP_QUESTIONS.name.key);
  await expect(tools.publicMapSwitchReason).toHaveCount(0);
  // Chosen, the map is still off, so nothing is public yet.
  expect((await read()).status()).toBe(404);

  await tools.savePublicMap(() => tools.publicMapSwitch.check());
  await expect(tools.publicMapSwitch).toBeChecked();
  await expect(tools.publicMapSaveError).toHaveCount(0);
  // The map's address is the market's own: the market page shows the map once it is open (T469).
  const address = new URL(marketPagePath(seed.slug), page.url()).toString();
  await expect(tools.publicMapUrl).toHaveText(address);
  await expect(tools.publicMapOpen).toHaveAttribute('href', address);
  await expect(tools.publicMapOpen).toHaveAttribute('target', '_blank');
  await expect(tools.publicMapOpen).toHaveAttribute('rel', 'noopener noreferrer');
  await expectAccessible('the Public map card, on');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await tools.publicMapCopy.click();
  await expect(tools.publicMapCopy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

  // And it opens the map, signed in or not.
  const shopper = await page.context().browser()!.newPage();
  await shopper.goto(address);
  await expect(shopper.getByTestId('public-map-heading')).toBeVisible({ timeout: 15000 });
  await shopper.close();

  // Signed out, the read answers with each vendor's public name, from the question chosen.
  const open = await read();
  expect(open.status(), await open.text()).toBe(200);
  const { seats } = (await open.json()) as { seats: PublicSeat[] };
  expect(seats).toContainEqual(
    expect.objectContaining({
      name: 'Ember Ceramics',
      website: 'https://ember-ceramics.test',
      instagram: 'example_ember',
    }),
  );

  await tools.savePublicMap(() => tools.publicMapSwitch.uncheck());
  await expect(tools.publicMapSwitch).not.toBeChecked();
  await expect(tools.publicMapUrl).toHaveCount(0);
  expect((await read()).status()).toBe(404);
  await anyone.dispose();
});

test('someone the row refuses reads the card, every control disabled, and why', async ({
  browser,
  request,
}) => {
  ensureVerifiedUser(VIEWER.email, VIEWER.password);
  const seed = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  const granted = await request.post(`${BACKEND_URL}/markets/${seed.marketId}/roles`, {
    data: { user_email: VIEWER.email, role: 'editor' },
  });
  expect(granted.ok(), await granted.text()).toBeTruthy();

  await withUser(browser, VIEWER.email, VIEWER.password, async (editor) => {
    const tools = new ToolsPage(editor);
    await tools.goto(seed.marketId);
    await expect(tools.publicMapCard).toBeVisible({ timeout: 15000 });
    await expect(tools.publicMapRefusal).toHaveText(
      'Only an Admin or the owner may turn the public map on or off and choose what it shows.',
    );
    await expect(tools.publicMapName.root).toHaveValue(DAY_MAP_QUESTIONS.name.key);
    for (const choice of [tools.publicMapName, tools.publicMapWebsite, tools.publicMapInstagram]) {
      await expect(choice.root).toBeDisabled();
    }
    await expect(tools.publicMapSwitch).toBeChecked();
    await expect(tools.publicMapSwitch).toBeDisabled();
    // The address is the market's to share, whoever reads it.
    await expect(tools.publicMapUrl).toHaveText(
      new URL(marketPagePath(seed.slug), editor.url()).href,
    );
  });
});

test('the card fits a phone, the map on', async ({
  authenticatedPage: page,
  request,
  expectAccessible,
}) => {
  const seed = await seedMarketDayMap(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    publicMap: true,
  });
  await page.setViewportSize(PHONE);
  const tools = new ToolsPage(page);
  await tools.goto(seed.marketId);
  await expect(tools.publicMapUrl).toBeVisible({ timeout: 15000 });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways on a phone').toBeLessThanOrEqual(0);
  for (const control of [tools.publicMapCopy, tools.publicMapOpen, tools.publicMapName.root]) {
    const box = await control.boundingBox();
    expect(box, 'a control of the card is drawn').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  }
  await expectAccessible('the Public map card on a phone');
});
