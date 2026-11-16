import type { Request } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { savePlan } from './helpers/savePlan';
import { marketSetupPath } from './helpers/marketScreens';

/**
 * The form tab sends one whole-form save at a time (T420).
 *
 * Each "Ask this" tick saved the whole form at once, its own `PUT`, and nothing held a second while
 * the first was out: two quick ticks went out at the same `formRevision`, the server refused the
 * second as "the market changed", and the tab read the form again, dropping the second tick's
 * choice. A tick made while a save is out now waits for its answer, and goes at the revision the
 * answer carried.
 */

const FORM_WRITE = /\/markets\/[^/]+\/application-form$/;

function isFormWrite(req: Request): boolean {
  return req.method() === 'PUT' && FORM_WRITE.test(req.url());
}

const TIER = { id: 1, name: 'Gold' };
const PLAN = {
  priority: [],
  marketDates: [{ date: '2026-11-07' }],
  tiers: [TIER],
  locations: [{ name: 'Hall' }],
  sections: [
    { name: 'North', location: { name: 'Hall' }, tier: TIER, count: 2 },
    { name: 'South', location: { name: 'Hall' }, tier: TIER, count: 2 },
  ],
  assignmentOptions: { maxAssignmentsPerVendor: null, maxHalfTableProportionPerSection: null },
  floorplans: null,
};

test('a second tick while the first saves is sent after it, at the revision it answered', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId } = await seedDraftMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { intakeMode: 'form' },
  );
  await savePlan(request, BACKEND_URL, TEST_USER.email, marketId, PLAN);

  // The first save of the form is held on the wire until the test lets it go.
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await page.route(FORM_WRITE, async (route) => {
    if (route.request().method() !== 'PUT' || held) return route.continue();
    held = true;
    await released;
    await route.continue();
  });
  const writes: Request[] = [];
  page.on('request', (req) => {
    if (isFormWrite(req)) writes.push(req);
  });

  await page.goto(marketSetupPath(marketId, 'form'));
  const section = page.getByTestId('essential-asks-section').getByRole('checkbox');
  const vendorRequest = page.getByTestId('essential-asks-request').getByRole('checkbox');
  await expect(section).toBeChecked();
  await expect(vendorRequest).toBeChecked();

  const firstSent = page.waitForRequest(isFormWrite);
  await section.uncheck();
  await firstSent;
  await vendorRequest.uncheck();
  // Both boxes show their choice while the first save is out, and the second waits for it.
  await expect(section).not.toBeChecked();
  await expect(vendorRequest).not.toBeChecked();
  expect(writes).toHaveLength(1);

  const firstAnswered = page.waitForResponse((res) => isFormWrite(res.request()));
  const secondSent = page.waitForRequest((req) => isFormWrite(req) && req !== writes[0]);
  release();
  const answer = (await (await firstAnswered).json()) as { formRevision: number };
  const second = await secondSent;
  const secondAnswered = await page.waitForResponse((res) => res.request() === second);

  expect(secondAnswered.status()).toBe(200);
  expect(writes).toHaveLength(2);
  const body = second.postDataJSON() as { formRevision: number; unaskedEssentials: string[] };
  expect(body.formRevision).toBe(answer.formRevision);
  expect(body.unaskedEssentials).toEqual(
    expect.arrayContaining(['essential_section_ranking', 'essential_request']),
  );
  await expect(page.getByTestId('form-builder-save-success')).toBeVisible();
  await expect(page.getByTestId('form-builder-save-error')).toHaveCount(0);

  // Both choices are the server's.
  await page.reload();
  await expect(section).not.toBeChecked();
  await expect(vendorRequest).not.toBeChecked();
});
