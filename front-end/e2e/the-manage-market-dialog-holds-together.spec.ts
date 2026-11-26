import type { Locator, Page } from '@playwright/test';
import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import { ManageMarketPage } from './pages/ManageMarketPage';
import { seedApplicantMarket } from './helpers/seedApplicantMarket';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { grantMarketRole } from './helpers/grantMarketRole';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { uniqueMarketName } from './helpers/uniqueName';

/**
 * Manage market holds together (bug 15, and items 14 and 15 of bug 43; E26/F10/S01).
 *
 * Its buttons were the compact size, smaller than every other button in the product. "Add user",
 * now "Invite someone", turned into a lone Cancel above the row it opened. The owner's own row
 * offered a role select the server refused every use of, and the refusal appeared at the foot of
 * the dialog: it is said under the person's row now, as `changing-a-role-asks-first.spec.ts`
 * proves. Delete asked "Are you sure?" inline, Confirm before Cancel, with focus left on the page.
 *
 * The invite row's email field was narrower than its role select at a desk, cutting off a typed
 * address, and the row kept an address and a role across openings: Escape left them to come back on
 * another market, and Cancel kept the role (T642). `manageMarketInvites.test.ts` proves that Cancel
 * now leaves the row empty at Editor.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const COLLEAGUE = { email: 'e2e-manage-market@example.com', password: 'e2epassword123' };

test.beforeAll(() => ensureVerifiedUser(COLLEAGUE.email, COLLEAGUE.password));

async function openManage(page: Page, marketName: string): Promise<ManageMarketPage> {
  await page.goto(`/markets?q=${encodeURIComponent(marketName)}`);
  await page.getByTestId('market-card-manage-button').click();
  const manage = new ManageMarketPage(page);
  await manage.waitForOverlay();
  return manage;
}

const height = (locator: Locator) =>
  locator.evaluate((el) => Math.round(el.getBoundingClientRect().height));

const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not rendered');
  return b;
};

/** How far the longest of a select's names runs past the room it leaves beside its arrow. */
const overrun = (select: Locator) =>
  select.evaluate((el) => {
    const field = el as HTMLSelectElement;
    const style = getComputedStyle(field);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = style.font;
    const widest = Math.max(
      ...[...field.options].map((option) => context.measureText(option.text).width),
    );
    const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return widest - room;
  });

/** An address of an ordinary length, a fixture's. */
const TYPED = 'someone.new@example.com';

/** Types the address into the open row: all of it shows, and every role reads whole. */
async function expectTypedInFull(manage: ManageMarketPage) {
  await manage.fillAddUserEmail(TYPED);
  const hidden = await manage.addUserInput.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(hidden, 'none of the address is scrolled out of the field').toBeLessThanOrEqual(0);
  expect(await overrun(manage.addUserSelect), 'every role reads whole').toBeLessThanOrEqual(0);
}

/** One line: the field takes what the role and the buttons leave, and the role only its own. */
async function expectOneLine(page: Page, manage: ManageMarketPage) {
  const [form, field, role, send, cancel] = await Promise.all(
    [
      page.locator('form').filter({ has: manage.addUserInput }),
      manage.addUserInput,
      manage.addUserSelect,
      manage.addUserSubmit,
      manage.addUserCancel,
    ].map(box),
  );
  for (const control of [role, send, cancel]) {
    expect(control.y, 'on the field’s line').toBeCloseTo(field.y, 0);
  }
  expect(field.width, 'the field is wider than the role').toBeGreaterThan(role.width);
  expect(field.x, 'from the row’s start').toBeCloseTo(form.x, 0);
  expect(cancel.x + cancel.width, 'to the row’s end').toBeCloseTo(form.x + form.width, 0);
}

test('its controls are the product size, and inviting someone is one row with its own Cancel', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketName } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const manage = await openManage(page, marketName);

  // The product's control height, which the fields beside them already have.
  for (const button of [manage.addUserButton, manage.deleteButton]) {
    expect(await height(button)).toBe(36);
  }

  // The owner's own role is a fact, not a choice the server will refuse.
  const owner = page.locator('.user-card').filter({ hasText: TEST_USER.email });
  await expect(owner.getByTestId('manage-market-role-select')).toHaveCount(0);
  await expect(owner).toContainText('Owner');

  await manage.clickAddUser();
  await expect(manage.addUserButton).toHaveCount(0);
  await expectTypedInFull(manage);
  // Cancel sits in the row it cancels, on its one line, at the same height.
  await expectOneLine(page, manage);
  expect(await height(manage.addUserCancel)).toBe(36);

  await manage.addUserCancel.click();
  await expect(manage.addUserInput).toHaveCount(0);
  await expect(manage.addUserButton).toBeVisible();
});

test('on a phone, the email field and the role each take the invite row, with its buttons beneath', async ({
  authenticatedPage: page,
  request,
}) => {
  // Beside the role, Add and Cancel at 390, the field and the role were squeezed to 66px each,
  // "User e" and "Edi" (T142); beside the role alone, Send invitation left Cancel a line of its
  // own.
  await page.setViewportSize({ width: 390, height: 844 });
  const { marketName } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const manage = await openManage(page, marketName);
  await manage.clickAddUser();

  const form = await box(page.locator('form').filter({ has: manage.addUserInput }));
  const field = await box(manage.addUserInput);
  expect(field.width, 'the field takes the row').toBeGreaterThanOrEqual(form.width - 1);

  const role = page.getByTestId('manage-market-add-user-select');
  const cancel = page.getByTestId('manage-market-add-user-cancel');
  const roleBox = await box(role);
  expect(roleBox.y, 'the role beneath the field').toBeGreaterThanOrEqual(field.y + field.height);
  expect(roleBox.width, 'the role takes the row').toBeGreaterThanOrEqual(form.width - 1);
  const buttons = [await box(manage.addUserSubmit), await box(cancel)];
  for (const b of [roleBox, ...buttons]) {
    expect(b.height, 'a 44px target').toBeGreaterThanOrEqual(44);
    expect(b.x + b.width, 'inside the window').toBeLessThanOrEqual(390);
  }
  for (const b of buttons) {
    expect(b.y, 'beneath the role').toBeGreaterThanOrEqual(roleBox.y + roleBox.height);
    expect(b.y, 'on one row').toBe(buttons[0].y);
  }
  expect(
    Math.abs(buttons[1].x + buttons[1].width - (form.x + form.width)),
    'at the row’s end',
  ).toBeLessThan(1);

  await expectTypedInFull(manage);
});

// The widths the two tests above do not reach.
for (const window of [
  {
    width: 641,
    height: 900,
    oneLine: true,
    measures: 'the narrowest one-line invite row shows a typed address and every role whole',
  },
  {
    width: 320,
    height: 568,
    oneLine: false,
    measures: 'the stacked invite row shows a typed address and every role whole',
  },
]) {
  test(`at ${window.width}, ${window.measures}`, async ({ authenticatedPage: page, request }) => {
    await page.setViewportSize({ width: window.width, height: window.height });
    const { marketName } = await seedDraftMarket(
      request,
      BACKEND_URL,
      TEST_USER.email,
      TEST_USER.password,
    );
    const manage = await openManage(page, marketName);
    await manage.clickAddUser();

    await expectTypedInFull(manage);
    if (window.oneLine) await expectOneLine(page, manage);
  });
}

test('an invite row left by Escape comes back empty at Editor on another market', async ({
  authenticatedPage: page,
  request,
}) => {
  const prefix = uniqueMarketName('E2E Invite Row');
  for (const letter of ['A', 'B']) {
    await seedDraftMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
      name: `${prefix} ${letter}`,
    });
  }
  // Both markets listed at once: Manage market is mounted once for the list, so no reload may come
  // between the two openings.
  await page.goto(`/markets?q=${encodeURIComponent(prefix)}`);
  const manage = new ManageMarketPage(page);
  const manageMarket = async (letter: string) => {
    await page
      .getByTestId('market-card')
      .filter({ hasText: `${prefix} ${letter}` })
      .getByTestId('market-card-manage-button')
      .click();
    await manage.waitForOverlay();
  };

  await manageMarket('A');
  await manage.clickAddUser();
  await manage.fillAddUserEmail(TYPED);
  await manage.selectAddUserRole('viewer');
  await manage.addUserInput.press('Escape');
  await expect(manage.window).toHaveCount(0);

  await manageMarket('B');
  await expect(manage.window).toContainText(`${prefix} B`);
  await manage.clickAddUser();
  await expect(manage.addUserInput).toHaveValue('');
  await expect(manage.addUserSelect).toHaveValue('editor');
});

test('deleting is a destructive dialog that opens on Cancel and says what goes', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketName } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  const manage = await openManage(page, marketName);
  await manage.deleteButton.click();

  const dialog = page.getByTestId('manage-market-delete-window');
  await expect(dialog).toContainText(`Delete ${marketName}?`);
  await expect(page.getByTestId('manage-market-delete-consequence')).toContainText(
    'its applications, its assignments, its check-in records',
  );
  // A form market taking applications has its public pages, and they go too (T469).
  await expect(page.getByTestId('manage-market-delete-public')).toHaveText(
    'Its market page and vendor page will stop working for anyone who has the links.',
  );
  await expect(manage.deleteCancelButton).toBeFocused();

  await manage.deleteCancelButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(manage.window).toBeVisible();

  await manage.deleteButton.click();
  await manage.deleteConfirmButton.click();
  await expect(manage.window).toHaveCount(0);
  await expect(page.getByTestId('market-card')).toHaveCount(0);
});

test('inviting someone already on the market says so and leaves their role as it was', async ({
  authenticatedPage: page,
  request,
}) => {
  const { marketId, marketName } = await seedApplicantMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
  );
  await grantMarketRole(request, marketId, COLLEAGUE, 'editor');
  const manage = await openManage(page, marketName);

  // "Add user" once overwrote whatever role the address held, the Owner's too: changing a role is
  // its row's, where the Owner and the market's Admins are guarded, and an invitation is refused.
  await manage.invite(COLLEAGUE.email, 'viewer');

  await expect(manage.addUserError).toHaveText(
    `${COLLEAGUE.email} already has a role on this market. Change it in their row under Users with access.`,
  );
  const row = page.locator('.user-entry').filter({ hasText: COLLEAGUE.email });
  await expect(row.getByTestId('manage-market-role-select')).toHaveValue('editor');
  await expect(manage.addUserInput).toHaveValue(COLLEAGUE.email);
});
