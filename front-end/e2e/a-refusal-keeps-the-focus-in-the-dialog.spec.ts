import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { PRICED_VENDOR, seedAPricedVendor } from './helpers/seedAPricedVendor';
import { marketScreenPath } from './helpers/marketScreens';

/**
 * A refused confirm leaves focus inside its dialog (T315, T223 notes 34 and 35).
 *
 * Record payment holds while it records (T411): pressing the confirm disables the control that
 * held the focus, Cancel and the close with it, so the browser drops it to `<body>`, and the
 * refusal ends the hold with the dialog still open. The shell moves focus back inside, to the
 * first safe control, so the next Tab stays in the dialog rather than starting from the page
 * behind it, which is inert.
 */
const REFUSAL = 'That payment could not be recorded.';

test('a refused Record payment leaves focus inside its dialog, and Tab stays there', async ({
  authenticatedPage: page,
  request,
}) => {
  const marketId = await seedAPricedVendor(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const query = new URLSearchParams({ vendor: PRICED_VENDOR, vendorTab: 'payment' });
  await page.goto(`${marketScreenPath(marketId, 'vendors')}?${query.toString()}`);
  await expect(page.getByTestId('payment-tab')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('payment-record').click();
  const dialog = page.getByTestId('record-payment-window');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount (CAD)').fill('35');

  await page.route(/\/payments\/[^/?]+$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 400, json: { error: REFUSAL } })
      : route.fallback(),
  );
  const confirm = dialog.getByRole('button', { name: 'Record payment' });
  await confirm.click();
  await expect(dialog.getByTestId('record-payment-error')).toHaveText(REFUSAL);
  await expect(confirm).toBeEnabled();

  const focusIsInside = () => dialog.evaluate((window) => window.contains(document.activeElement));
  await expect.poll(focusIsInside).toBe(true);
  await expect(dialog.getByLabel('Amount (CAD)')).toBeFocused();

  await page.keyboard.press('Tab');
  expect(await focusIsInside()).toBe(true);
});
