import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { PRICED_VENDOR, seedAPricedVendor } from './helpers/seedAPricedVendor';
import { marketScreenPath } from './helpers/marketScreens';

/**
 * A dialog holds while it writes (T277 ticket 08, T411).
 *
 * A dialog that writes hands `AppDialog` its submission, and the shell refuses every close while
 * the write is out: Cancel and the close control drawn disabled, Escape and the scrim inert, so a
 * slow write can never be closed away and its answer land in the next opening. Record payment's
 * request is held here until the test lets it go.
 */
test('Record payment cannot be closed while it records, and closes on its answer', async ({
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

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await page.route(/\/payments\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts += 1;
    await released;
    await route.continue();
  });

  await page.getByTestId('payment-record').click();
  const dialog = page.getByTestId('record-payment-window');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount (CAD)').fill('35');
  await dialog.getByRole('button', { name: 'Record payment' }).click();

  const confirm = page.getByTestId('record-payment-submit-button');
  await expect(confirm).toHaveText('Recording…');
  await expect(confirm).toBeDisabled();
  await expect.poll(() => posts).toBe(1);

  const cancel = page.getByTestId('record-payment-cancel-button');
  const close = page.getByTestId('record-payment-close-button');
  await expect(cancel).toBeDisabled();
  await expect(close).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveText('Recording…');

  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('payment-paid')).toHaveText('$35.00');
  expect(posts).toBe(1);
});
