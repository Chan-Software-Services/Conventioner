import { test, expect, LoginPage } from './fixtures';

/**
 * A sign-in sends once (T277 ticket 08, report 4.8).
 *
 * Send code pressed twice sent two requests, and the server's one-code wait answered the second
 * with a refusal that replaced "code sent", while a good code sat in the inbox. The button says
 * "Sending…" and takes no press while its request is out, and a press that comes anyway sends
 * nothing.
 *
 * The request goes to the real server, held until both presses are in, so the second press meets
 * a request still out whatever the machine's speed. A fresh address, so the limits on the codes
 * asked for it (`back-end/sign_in_limits.py`) count this spec's requests alone.
 */

const CODE_SENT = 'If an account exists for that address, a sign-in code has been sent to it.';

test('Send code pressed twice sends one request, and "code sent" stays', async ({ page }) => {
  const login = new LoginPage(page);
  const address = `e2e-sends-once-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  let sent = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/request-otp', async (route) => {
    sent += 1;
    await released;
    await route.continue();
  });

  await login.goto();
  await login.switchToOtp();
  await login.otpEmailInput.fill(address);
  await login.otpSubmitButton.dblclick();

  // Soft, so a build that sends twice goes on to show what the second request did.
  await expect.soft(login.otpSubmitButton).toHaveText('Sending…');
  await expect.soft(login.otpSubmitButton).toBeDisabled();

  release();

  await expect(login.otpSuccessMessage).toHaveText(CODE_SENT);
  await expect(login.otpCodeInput).toBeVisible();
  await expect(login.otpErrorMessage).toBeHidden();
  await expect(login.otpSubmitButton).toHaveText('Sign in');
  expect(sent).toBe(1);
});
