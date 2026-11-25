import type { Page } from '@playwright/test';
import { test, expect, LoginPage } from './fixtures';
import { plantSignInCode } from './helpers/accountSecrets';
import { deleteUser } from './helpers/deleteUser';
import {
  ORGANIZER_CODE_PER_ADDRESS_CEILING,
  PASSWORD_PER_ADDRESS_CEILING,
  fillSignInLimit,
  signInLimitCount,
} from './helpers/signInLimits';
import { ROOM_IN_WINDOW_WAIT_MS } from './helpers/signInWindow';
import { ensureVerifiedUser } from './helpers/verifiedUser';

/**
 * Why E2E: the stack together, the organizer's sign-in screen meeting the server's sign-in limits.
 *
 * An organizer's password and code sign-ins count wrong tries per caller and address, and per
 * address alone up to a ceiling (`PASSWORD_PER_ADDRESS_CEILING`,
 * `ORGANIZER_CODE_PER_ADDRESS_CEILING`), which only many callers together reach; past that a try
 * asks the human check rather than refusing (T539). The organizer's forms send no token until the
 * server asks, so an everyday sign-in loads no script of Cloudflare's; asked, the form puts the
 * check on the page and sends once more with its token, and the organizer is signed in. The
 * address's count is filled as other callers' wrong tries would leave it
 * (`helpers/signInLimits.ts`), on an account of the spec's own, so no other spec's sign-in meets
 * the check.
 */

const PASSWORD = 'E2eTriedByOthers123!';
const CODE = '246810';

function uniqueEmail(): string {
  return `e2e-tried-by-others-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** The `captcha_token` of every sign-in request to `path` the page sends, in order. */
function tokensSentTo(page: Page, path: string): Array<unknown> {
  const tokens: Array<unknown> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith(path)) return;
    tokens.push((request.postDataJSON() as { captcha_token?: unknown }).captcha_token);
  });
  return tokens;
}

function expectSentTwiceTheSecondWithAToken(tokens: Array<unknown>) {
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBeUndefined();
  expect(typeof tokens[1]).toBe('string');
  expect(tokens[1]).not.toBe('');
}

test("an organizer's right password signs in past fifty others' wrong ones, through the check", async ({
  page,
}) => {
  test.setTimeout(30_000 + ROOM_IN_WINDOW_WAIT_MS);
  const email = uniqueEmail();
  ensureVerifiedUser(email, PASSWORD);
  try {
    await fillSignInLimit(PASSWORD_PER_ADDRESS_CEILING, email);
    const tokens = tokensSentTo(page, '/login');
    const login = new LoginPage(page);

    await login.login(email, PASSWORD);
    await login.waitForMarkets();

    expectSentTwiceTheSecondWithAToken(tokens);
    // The right password took its try back, and so did the try refused for want of the check.
    expect(signInLimitCount(PASSWORD_PER_ADDRESS_CEILING, email)).toBe(
      PASSWORD_PER_ADDRESS_CEILING.attempts,
    );
  } finally {
    deleteUser(email);
  }
});

test("an organizer's right code signs in past fifty others' wrong ones, through the check", async ({
  page,
}) => {
  test.setTimeout(30_000 + ROOM_IN_WINDOW_WAIT_MS);
  const email = uniqueEmail();
  ensureVerifiedUser(email, PASSWORD);
  try {
    await fillSignInLimit(ORGANIZER_CODE_PER_ADDRESS_CEILING, email);
    // No email leaves the stack: the code is asked for as usual, and set where the server keeps it.
    await page.route('**/request-otp', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ msg: 'A sign-in code has been sent to your email.' }),
      }),
    );
    const tokens = tokensSentTo(page, '/login-otp');
    const login = new LoginPage(page);
    await login.goto();
    await login.switchToOtp();
    await login.otpEmailInput.fill(email);
    await login.otpSubmitButton.click();
    await expect(login.otpCodeInput).toBeVisible();
    plantSignInCode(email, CODE);

    await login.otpCodeInput.fill(CODE);
    await login.otpSubmitButton.click();
    await login.waitForMarkets();

    expectSentTwiceTheSecondWithAToken(tokens);
    expect(signInLimitCount(ORGANIZER_CODE_PER_ADDRESS_CEILING, email)).toBe(
      ORGANIZER_CODE_PER_ADDRESS_CEILING.attempts,
    );
  } finally {
    deleteUser(email);
  }
});
