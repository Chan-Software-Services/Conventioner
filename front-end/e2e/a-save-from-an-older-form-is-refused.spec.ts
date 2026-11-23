import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL, VendorPage } from './fixtures';
import { planSetupObject, seedApplicantMarket } from './helpers/seedApplicantMarket';
import { saveApplicationForm } from './helpers/saveApplicationForm';
import { transitionMarket } from './helpers/seedPhaseMarket';
import { signInOnThePage } from './helpers/vendorSignIn';

/**
 * Why E2E: the stack together - what the server refuses and stores, reached through the page - and
 * a real reload reopening the form on the answers kept in the tab.
 *
 * A vendor's save from a page drawn from an older form is refused, and Reload reopens the form as
 * it now asks on the answers they typed (T507).
 *
 * The vendor's page reads the form's version with the form and every save carries it. A form that
 * changed while the page was open - the market taken back to draft and its questions changed, as
 * Reopen for editing allows while nobody has applied - refuses the save, storing nothing, rather
 * than drop an answer to a question it no longer asks without a word.
 */
const DATE = '2099-08-01';
const FORM_CHANGED = 'This form changed since you opened it. Reload to continue.';
const RESTORED = 'Your unsaved answers are back. They reach the market when you save.';

/** The form after the organizer's change: business name kept, what they sell gone, a website new. */
const CHANGED_FIELDS = [
  {
    key: 'business_name',
    label: 'Business Name',
    type: 'text',
    required: true,
    options: [],
    order: 0,
  },
  {
    key: 'website',
    label: 'Website',
    type: 'text',
    required: false,
    options: [],
    order: 1,
  },
];

/** The vendor's application as the market holds it, read as the vendor signed in on `page`. */
async function storedApplication(
  page: Page,
  request: APIRequestContext,
  marketSlug: string,
): Promise<{ formData: Record<string, unknown> } | null> {
  const token = await page.evaluate(
    () =>
      (
        JSON.parse(sessionStorage.getItem('conventioner.applicantSession') ?? '{}') as {
          token: string;
        }
      ).token,
  );
  const read = await request.get(
    `${BACKEND_URL}/public/markets/${marketSlug}/applicant/application`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(read.ok()).toBe(true);
  const { application } = (await read.json()) as {
    application: { formData: Record<string, unknown> } | null;
  };
  return application;
}

test('a save from a form changed since the page opened is refused, and Reload reopens it on the answers', async ({
  page,
  request,
  expectAccessible,
}) => {
  const market = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { setupObject: planSetupObject([DATE]) },
  );
  const vendor = new VendorPage(page);
  await vendor.goto(market.marketSlug);
  await signInOnThePage(vendor, market.marketId, 'older-form-refused@example.com');

  await vendor.applyButton.click();
  await expect(vendor.form).toBeVisible({ timeout: 30000 });
  await vendor.fullNameInput.fill('Ada Older');
  await vendor.fillField('business_name', 'Older Prints');
  await vendor.tierCheckbox(DATE, 'Gold').check();
  await vendor.maxDatesInput.fill('1');
  await vendor.tableChoiceRadio('full').check();
  await vendor.fillField('product_type', 'Letterpress cards');

  // Meanwhile the organizer reopens the market for editing, takes "What do you sell?" away, adds
  // an optional website question, and opens applications again.
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, market.marketId, 'draft');
  await saveApplicationForm(request, BACKEND_URL, market.marketId, { fields: CHANGED_FIELDS });
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, market.marketId, 'applications');

  await vendor.submitButton.click();

  // Refused with the sentence and Reload; every answer typed stays on screen, and nothing is stored.
  await expect(vendor.formError).toContainText(FORM_CHANGED, { timeout: 10000 });
  await expect(vendor.reloadButton).toHaveText('Reload');
  await expect(vendor.input('product_type')).toHaveValue('Letterpress cards');
  await expectAccessible('the application form, its save refused for a changed form');
  expect(await storedApplication(page, request, market.marketSlug)).toBeNull();

  await vendor.reloadButton.click();

  // The form opens again by itself, as it now asks, on the answers typed.
  await expect(vendor.form).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('apply-draft-restored')).toHaveText(RESTORED);
  await expect(vendor.fullNameInput).toHaveValue('Ada Older');
  await expect(vendor.input('business_name')).toHaveValue('Older Prints');
  await expect(vendor.input('product_type')).toHaveCount(0);
  await expect(vendor.input('website')).toHaveValue('');
  await expect(vendor.formError).toHaveCount(0);

  await vendor.submit();
  await expect(vendor.form).toHaveCount(0, { timeout: 10000 });
  await expect(vendor.answers).toContainText('Older Prints');

  const stored = await storedApplication(page, request, market.marketSlug);
  expect(stored?.formData).toMatchObject({
    essential_full_name: 'Ada Older',
    business_name: 'Older Prints',
  });
  expect(stored?.formData).not.toHaveProperty('product_type');
});
