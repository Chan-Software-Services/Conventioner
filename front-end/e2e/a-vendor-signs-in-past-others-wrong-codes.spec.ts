import { test, expect, BACKEND_URL, TEST_USER, VendorPage } from './fixtures';
import { createApplicantLoginChallenge, seedApplicantMarket } from './helpers/seedApplicantMarket';
import {
  VERIFY_CODE_PER_ADDRESS_CEILING,
  fillSignInLimit,
  signInLimitCount,
} from './helpers/signInLimits';
import { ROOM_IN_WINDOW_WAIT_MS } from './helpers/signInWindow';

/**
 * Why E2E: the stack together, the screen's Sign in meeting the server's sign-in limits.
 *
 * A vendor's code sign-in counts wrong codes per caller and address, and per address alone up to
 * fifty, which only many callers together reach; past that a try asks the human check rather than
 * refusing (T539). The vendor's sign-in sends the check's token with every Sign in, so a vendor
 * whose address others have tried signs in with their right code and sees nothing new. The address's
 * count is filled as fifty other callers' wrong codes would leave it (`helpers/signInLimits.ts`).
 */

const ASKED = { message: "Confirm you're a person, then try again.", captcha: 'required' };
const CODE = '481537';

test("a vendor's right code signs in past fifty others' wrong ones, through the check", async ({
  page,
  request,
}) => {
  test.setTimeout(30_000 + ROOM_IN_WINDOW_WAIT_MS);
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const vendor = `tried-by-others-${Date.now()}@example.com`;
  await fillSignInLimit(VERIFY_CODE_PER_ADDRESS_CEILING, vendor);
  const vendorPage = new VendorPage(page);
  await vendorPage.goto(market.marketSlug);
  await vendorPage.requestCode(vendor);
  createApplicantLoginChallenge(market.marketId, vendor, CODE);

  const tried = page.waitForRequest('**/applicant-login/verify-code');
  await vendorPage.enterCode(CODE);
  const body = (await tried).postDataJSON() as { captcha_token?: unknown };

  expect(typeof body.captcha_token).toBe('string');
  expect(body.captcha_token).not.toBe('');
  await expect(vendorPage.signedInAs).toContainText(vendor);
  // The right code took its try back, so only the others' wrong ones stay counted.
  expect(signInLimitCount(VERIFY_CODE_PER_ADDRESS_CEILING, vendor)).toBe(
    VERIFY_CODE_PER_ADDRESS_CEILING.attempts,
  );
});

test('past fifty wrong codes, a code sign-in that sends no token is asked to pass the check', async ({
  request,
}) => {
  test.setTimeout(30_000 + ROOM_IN_WINDOW_WAIT_MS);
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const vendor = `unchecked-try-${Date.now()}@example.com`;
  await fillSignInLimit(VERIFY_CODE_PER_ADDRESS_CEILING, vendor);
  createApplicantLoginChallenge(market.marketId, vendor, CODE);

  const response = await request.post(
    `${BACKEND_URL}/public/markets/${market.marketSlug}/applicant-login/verify-code`,
    { data: { email: vendor, code: CODE } },
  );

  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual(ASKED);
  // A try refused for want of the check is taken back.
  expect(signInLimitCount(VERIFY_CODE_PER_ADDRESS_CEILING, vendor)).toBe(
    VERIFY_CODE_PER_ADDRESS_CEILING.attempts,
  );
});
