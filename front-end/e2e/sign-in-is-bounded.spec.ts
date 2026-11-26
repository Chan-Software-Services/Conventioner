import { test, expect, APP_API, BACKEND_URL, TEST_USER, VendorPage } from './fixtures';
import { HUMAN_CHECK_TOKEN } from './helpers/humanCheck';
import { seedApplicantMarket } from './helpers/seedApplicantMarket';
import { waitForRoomInWindow } from './helpers/signInWindow';

/**
 * Nobody can use the applicant sign-in to flood an address with codes (T12).
 *
 * One caller may ask for only so many codes to an address in a window
 * (`REQUEST_CODE_PER_CALLER_AND_ADDRESS` in `back-end/sign_in_limits.py`); past that the back end
 * answers 429 with a Retry-After and sends nothing, and the sign-in screen says so in words. The
 * count is per caller and address, so the ones the limit allows are asked for over the API through
 * the dev server's proxy (`APP_API`), which the page's own calls take and so reach the back end as
 * the same caller, and the one past it through the screen, as a vendor would meet it.
 */

const ALLOWED_PER_CALLER_AND_ADDRESS = 5;

test('asking for codes past the limit says to wait, and sends nothing more', async ({
  page,
  request,
}) => {
  // The wait for a fresh window can run to a minute, longer than the default test timeout.
  test.setTimeout(120_000);
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  await waitForRoomInWindow();
  const address = `flooded-${Date.now()}@example.com`;
  const requestCode = () =>
    page.request.post(
      `${APP_API}/public/markets/${market.marketSlug}/applicant-login/request-code`,
      { data: { email: address, captcha_token: HUMAN_CHECK_TOKEN } },
    );

  for (let i = 0; i < ALLOWED_PER_CALLER_AND_ADDRESS; i += 1) {
    expect((await requestCode()).status()).toBe(200);
  }

  const login = new VendorPage(page);
  await login.goto(market.marketSlug);
  await login.emailInput.fill(address);
  await login.requestButton.click();

  await expect(login.error).toHaveText(
    /^Too many sign-in attempts\. Please try again in \d+ minutes?\.$/,
  );
  await expect(page.getByTestId('vendor-sign-in-email-step')).toBeVisible();
  await expect(login.codeInput).toHaveCount(0);

  const refused = await requestCode();
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0);
});
