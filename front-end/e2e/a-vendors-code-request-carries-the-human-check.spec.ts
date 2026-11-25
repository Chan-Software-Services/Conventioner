import { test, expect, BACKEND_URL, TEST_USER, VendorPage } from './fixtures';
import { createApplicantLoginChallenge, seedApplicantMarket } from './helpers/seedApplicantMarket';

/**
 * Why E2E: the stack together, the page's request meeting the server's human check.
 *
 * A vendor's code request asks the human check (T539): the screen's Send code sends the check's
 * token as `captcha_token`, and the server, which asks it on every code request, mails the code.
 * The stack runs with no site key and `DISABLE_CAPTCHA`, so the screen sends the placeholder token
 * and the server passes it; a request that sends none is refused there as in production, so a
 * screen that forgot the token would fail here.
 */

const ASKED = { message: "Confirm you're a person, then try again.", captcha: 'required' };
const CODE = '730518';

test("the screen's Send code carries the check's token, and the vendor signs in", async ({
  page,
  request,
}) => {
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const vendor = `checked-${Date.now()}@example.com`;
  const vendorPage = new VendorPage(page);
  await vendorPage.goto(market.marketSlug);

  const asked = page.waitForRequest('**/applicant-login/request-code');
  await vendorPage.requestCode(vendor);
  const body = (await asked).postDataJSON() as { captcha_token?: unknown };
  expect(typeof body.captcha_token).toBe('string');
  expect(body.captcha_token).not.toBe('');
  await expect(vendorPage.codeInput).toBeVisible();

  createApplicantLoginChallenge(market.marketId, vendor, CODE);
  await vendorPage.enterCode(CODE);
  await expect(vendorPage.signedInAs).toContainText(vendor);
});

test('a code request that sends no token is asked to pass the check', async ({ request }) => {
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );

  const response = await request.post(
    `${BACKEND_URL}/public/markets/${market.marketSlug}/applicant-login/request-code`,
    { data: { email: `unchecked-${Date.now()}@example.com` } },
  );

  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual(ASKED);
});
