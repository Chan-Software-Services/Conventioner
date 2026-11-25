import type { Locator } from '@playwright/test';
import {
  test,
  expect,
  LoginPage,
  NewMarketPage,
  TEST_USER,
  BACKEND_URL,
  APP_API,
} from './fixtures';
import {
  ensureTestOrg,
  ensureTestOrgs,
  loginViaApi,
  seedLayout,
  seedPublishedMarketWithAssignments,
} from './helpers/seeds';
import { LayoutPage } from './pages/LayoutPage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { acceptInvitation } from './helpers/invitations';
import { MarketsPage } from './pages/MarketsPage';
import { VendorsPage } from './pages/VendorsPage';

/**
 * What a dialog is in this product (E20/F01/S01), proved on the create-market dialog.
 *
 * A dialog is a native `<form>` in a modal doing one small job. That single fact is the whole
 * Enter contract: submission runs the same handler as the confirm button, so it inherits that
 * handler's guard, and a disabled submit makes Enter inert with no key handler anywhere.
 *
 * Enter did nothing here before, on the first screen of the product, while six other views each
 * hand-rolled their own answer - `@keydown.enter` in three, `@keyup.enter` in two, two of those
 * with `.prevent`.
 */
test.describe('The create-market dialog is the dialog idiom', () => {
  test.beforeAll(async ({ request }) => {
    // Two, so the dialog has a choice to make: with one it picks it, and "a name but no
    // organization yet" below cannot happen.
    await ensureTestOrgs(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, 2);
  });

  async function openTheDialog(page: import('@playwright/test').Page): Promise<NewMarketPage> {
    await page.goto('/markets');
    await page.getByTestId('markets-create-button').click();
    const dialog = new NewMarketPage(page);
    await dialog.waitForOverlay();
    return dialog;
  }

  test('it opens with focus inside it, on something that is not disabled', async ({
    authenticatedPage: page,
  }) => {
    // The page behind is inert, so the button that opened this is no longer a place focus can
    // sensibly sit. The first control is the organization select, which is DISABLED while it
    // fetches - and `focus()` on a disabled element is a silent no-op, which left the dialog
    // opening with focus on <body>.
    const dialog = await openTheDialog(page);
    await expect(dialog.nameInput).toBeFocused();
  });

  test('closing gives focus back to the button that opened it, whichever way it closes', async ({
    authenticatedPage: page,
  }) => {
    // Closing unmounts the window, which dropped focus to <body>: the next Tab started at the top
    // of the page (T45).
    const opener = page.getByTestId('markets-create-button');
    const dialog = await openTheDialog(page);
    await page.keyboard.press('Escape');
    await expect(dialog.nameInput).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await dialog.waitForOverlay();
    await dialog.cancelButton.click();
    await expect(opener).toBeFocused();

    await opener.click();
    await dialog.waitForOverlay();
    // A corner: the dialog is centred in the scrim, so a default click lands on the dialog.
    await dialog.overlayBackground.click({ position: { x: 8, y: 8 } });
    await expect(opener).toBeFocused();
  });

  test('Enter creates the market, through the same guard the button has', async ({
    authenticatedPage: page,
  }) => {
    const dialog = await openTheDialog(page);

    // Nothing filled in: the confirm is disabled, so Enter must do nothing at all.
    await expect(dialog.submitButton).toBeDisabled();
    await dialog.nameInput.press('Enter');
    await expect(dialog.nameInput).toBeVisible();
    await expect(page).toHaveURL(/\/markets/);

    // A name but still no organization: still disabled, so still inert.
    await dialog.fillMarketName(`Enter Submits ${Date.now()}`);
    await expect(dialog.submitButton).toBeDisabled();
    await dialog.nameInput.press('Enter');
    await expect(dialog.nameInput).toBeVisible();

    // An organization, but not yet how vendors apply (E31/F03/S01): still inert.
    await dialog.selectFirstOrg();
    await expect(dialog.submitButton).toBeDisabled();

    // Everything answered, and now Enter does exactly what the button does.
    await dialog.choosePath('form');
    await expect(dialog.submitButton).toBeEnabled();
    await dialog.nameInput.press('Enter');
    await dialog.waitForSetupRedirect();
  });

  test('the name field reads as a field, and the error sits under it', async ({
    authenticatedPage: page,
  }) => {
    const dialog = await openTheDialog(page);

    // It was `all: unset` inside a container declaring a radius with no border and no background,
    // so it rendered as bare text and read as a suggested title rather than as somewhere to type.
    const dressed = await dialog.nameInput.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        border: style.borderTopWidth,
        background: style.backgroundColor,
        height: el.getBoundingClientRect().height,
      };
    });
    expect(parseFloat(dressed.border)).toBeGreaterThan(0);
    expect(dressed.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(dressed.height).toBeGreaterThan(24);

    // A name the server will refuse, so the error is a real one.
    const taken = `Duplicate Dialog ${Date.now()}`;
    // With the page's own cookies, so at the page's own address for the API (`APP_API`).
    await loginViaApi(page.request, APP_API, TEST_USER.email, TEST_USER.password);
    const orgId = await ensureTestOrg(page.request, APP_API, TEST_USER.email, TEST_USER.password);
    await page.request.post(`${APP_API}/markets`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        name: taken,
        creationDate: new Date().toISOString(),
        organizationId: orgId,
      },
    });

    await dialog.fillMarketName(taken);
    await dialog.selectFirstOrg();
    await dialog.choosePath('form');
    await dialog.clickSubmit();
    await expect(dialog.errorMessage).toBeVisible();

    // In flow beneath the input, not at `top: 35px; left: 50%` measured against one arrangement.
    const placed = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="new-market-name-input"]')!;
      const error = document.querySelector('[data-testid="new-market-error"]')!;
      return {
        position: getComputedStyle(error).position,
        below: error.getBoundingClientRect().top >= input.getBoundingClientRect().bottom,
      };
    });
    expect(placed.position).toBe('static');
    expect(placed.below).toBe(true);
  });
});

/**
 * With exactly one organization the select is a control offering no decision - and one that still
 * has to be operated before the dialog will submit. It says which organization instead.
 */
test.describe('The create-market dialog with exactly one organization', () => {
  const ONE_ORG_USER = { email: 'e2e-oneorg@example.com', password: 'e2eoneorg123' };

  test.beforeAll(async ({ playwright }) => {
    ensureVerifiedUser(ONE_ORG_USER.email, ONE_ORG_USER.password);

    const api = await playwright.request.newContext({
      baseURL: BACKEND_URL,
      ignoreHTTPSErrors: true,
    });
    await api.post('/login', { data: ONE_ORG_USER });
    const existing = (await (await api.get('/organizations')).json()) as {
      organizations: unknown[];
    };
    if (existing.organizations.length === 0) {
      await api.post('/organizations', {
        headers: { 'Content-Type': 'application/json' },
        data: { name: 'The Only Org' },
      });
    }
    await api.dispose();
  });

  test('it names the organization rather than asking a question with one answer', async ({
    page,
  }) => {
    const login = new LoginPage(page);
    await login.login(ONE_ORG_USER.email, ONE_ORG_USER.password);
    await login.waitForMarkets();

    await page.goto('/markets');
    await expect(page.getByTestId('markets-create-button')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('markets-create-button').click();

    const dialog = new NewMarketPage(page);
    await dialog.waitForOverlay();

    await expect(dialog.orgOnly).toHaveText('The Only Org');
    await expect(dialog.orgSelect).toHaveCount(0);

    // And it is chosen, so all that is left is to name the market, say how vendors apply, and press
    // Enter.
    await dialog.fillMarketName(`One Org Market ${Date.now()}`);
    await dialog.choosePath('form');
    await expect(dialog.submitButton).toBeEnabled();
    await dialog.nameInput.press('Enter');
    await dialog.waitForSetupRedirect();
  });
});

/**
 * Closing never means saved, and saving never closes (E20/F01/S02).
 *
 * Three actions here each succeeded and then emitted the close event, and the PARENT treated
 * close as its refresh signal - so closing was the only thing that re-read the data, and adding
 * two people meant reopening the dialog between them. Adding someone is inviting them now (T538):
 * the invitations a test never accepts go to addresses of its run's own, so a retry never meets the
 * limit on invitations to one address.
 */
test.describe('Manage organization stays open', () => {
  const SECOND = { email: 'e2e-dialog-second@example.com', password: 'e2edialog123' };
  const runAddress = (who: string) => `e2e-dialog-${who}-${Date.now()}@example.test`;

  test.beforeAll(() => {
    ensureVerifiedUser(SECOND.email, SECOND.password);
  });

  /** The id of the fixture organizer's organization named `name`, as the API lists it. */
  async function idOf(request: import('@playwright/test').APIRequestContext, name: string) {
    await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
    const listed = await request.get(`${BACKEND_URL}/organizations`);
    expect(listed.ok(), await listed.text()).toBe(true);
    const { organizations } = (await listed.json()) as {
      organizations: Array<{ id: string; name: string }>;
    };
    return organizations.find((org) => org.name === name)!.id;
  }

  async function openAFreshOrg(page: import('@playwright/test').Page) {
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();

    const orgName = `E2E DialogStays ${Date.now()}`;
    await orgs.createOrg(orgName);
    const card = await orgs.findCard(orgName);

    await card.getByTestId('organizations-manage-button').click();
    await orgs.waitForManageOverlay();
    return { orgs, orgName, card };
  }

  test('two people are invited in a row, with no reopening', async ({
    authenticatedPage: page,
  }) => {
    const { orgs } = await openAFreshOrg(page);
    const second = runAddress('second');
    const third = runAddress('third');

    await orgs.inviteAdmin(second);
    await expect(orgs.invitation(second)).toBeVisible({ timeout: 5000 });
    await expect(orgs.manageWindow).toBeVisible();

    // No reopening: the invite form is still there with an empty field, ready for the next person.
    await expect(orgs.addAdminInput).toBeVisible();
    await expect(orgs.addAdminInput).toHaveValue('');

    // Enter, not the button - the row is a native form, so both go through the same handler.
    await orgs.addAdminInput.fill(third);
    await orgs.addAdminInput.press('Enter');
    await expect(orgs.invitation(third)).toBeVisible({ timeout: 5000 });
    await expect(orgs.manageWindow).toBeVisible();

    // Closed only by the person's own close.
    await orgs.manageCloseButton.click();
    await expect(orgs.manageWindow).toBeHidden();
  });

  test('a refused invitation keeps the dialog open with what was typed still in the field', async ({
    authenticatedPage: page,
  }) => {
    const { orgs } = await openAFreshOrg(page);

    // An address already in the organization: its owner's.
    await orgs.inviteAdmin(TEST_USER.email);

    await expect(orgs.addAdminError).toHaveText(`${TEST_USER.email} owns this organization.`, {
      timeout: 5000,
    });
    await expect(orgs.manageWindow).toBeVisible();
    await expect(orgs.addAdminInput).toHaveValue(TEST_USER.email);
  });

  test('its controls are the product size, inviting is one row with its own Cancel, and it opens on no Remove', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { orgs, orgName, card } = await openAFreshOrg(page);
    const height = (button: import('@playwright/test').Locator) =>
      button.evaluate((el) => Math.round(el.getBoundingClientRect().height));

    // Manage market's "Invite someone": the product's height, secondary.
    for (const button of [orgs.addAdminButton, orgs.addMemberButton, orgs.deleteButton]) {
      expect(await height(button)).toBe(36);
    }

    await orgs.inviteAdmin(SECOND.email);
    await expect(orgs.invitation(SECOND.email)).toBeVisible();
    await expect(orgs.addAdminButton).toHaveCount(0);
    const cancel = page.getByTestId('manage-org-add-admin-cancel');
    const add = await orgs.addAdminSubmit.boundingBox();
    const cancelBox = await cancel.boundingBox();
    expect(Math.abs((add?.y ?? 0) - (cancelBox?.y ?? -100))).toBeLessThan(2);
    await cancel.click();
    await expect(orgs.addAdminInput).toHaveCount(0);
    await expect(orgs.addAdminButton).toBeVisible();

    // Opened again with an admin listed, it starts on "Invite admin", never on their Remove.
    await acceptInvitation(SECOND, await idOf(request, orgName));
    await orgs.manageCloseButton.click();
    await card.getByTestId('organizations-manage-button').click();
    await orgs.waitForManageOverlay();
    await expect(orgs.adminEmails).toHaveText([SECOND.email]);
    await expect(orgs.addAdminButton).toBeFocused();
  });

  test('the explicit close and the backdrop both still close it', async ({
    authenticatedPage: page,
  }) => {
    const { orgs } = await openAFreshOrg(page);

    await orgs.manageCloseButton.click();
    await expect(orgs.manageWindow).toBeHidden({ timeout: 5000 });

    await orgs.manageButtons.first().click();
    await orgs.waitForManageOverlay();
    // A corner: the dialog is centred in the scrim, so a default click lands on the dialog.
    await orgs.manageOverlayBackground.click({ position: { x: 8, y: 8 } });
    await expect(orgs.manageWindow).toBeHidden({ timeout: 5000 });
  });

  test('Escape closes it', async ({ authenticatedPage: page }) => {
    const { orgs } = await openAFreshOrg(page);

    await page.keyboard.press('Escape');
    await expect(orgs.manageWindow).toBeHidden({ timeout: 5000 });
  });
});

/**
 * Enter means one thing, everywhere (E20/F01/S03).
 *
 * Four dialogs had no Enter handling at all, and six other places each invented their own -
 * `@keydown.enter` in three views, `@keyup.enter` in two, two of those preventing the default.
 * They are all native forms now, so Enter runs the confirm's own handler and inherits its guard.
 */
test.describe('Enter means the same thing in every dialog', () => {
  test('the create-organization dialog', async ({ authenticatedPage: page }) => {
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();

    await orgs.clickCreate();
    await expect(orgs.createNameInput).toBeVisible({ timeout: 5000 });

    // Empty: the confirm is disabled, so Enter is inert with no key handler saying so.
    await expect(orgs.createSubmitButton).toBeDisabled();
    await orgs.createNameInput.press('Enter');
    await expect(orgs.createNameInput).toBeVisible();

    const name = `E2E EnterOrg ${Date.now()}`;
    await orgs.fillOrgName(name);
    await orgs.createNameInput.press('Enter');
    await orgs.findCard(name);
  });

  test('the manage-market dialog, which had no Enter handling at all', async ({
    authenticatedPage: page,
    request,
  }) => {
    // Its OWN market. This test renames what it opens, and taking whichever card came first
    // renamed the shared seed fixture out from under `smoke.spec.ts`.
    await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
    const orgId = await ensureTestOrg(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
    const mine = `E2E EnterTarget ${Date.now()}`;
    const created = await request.post(`${BACKEND_URL}/markets`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        name: mine,
        creationDate: new Date().toISOString(),
        organizationId: orgId,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    const markets = new MarketsPage(page);
    await markets.goto();
    await markets.narrowTo(mine);
    const card = markets.card(mine);
    await card.getByTestId('market-card-manage-button').click();

    const dialog = page.getByTestId('manage-market-window');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // One organization, fixed at creation, said as one line - no control to move it (E21/F03/S05).
    await expect(page.getByTestId('manage-market-organization')).toContainText('Belongs to');
    await expect(page.getByTestId('manage-market-add-org-button')).toHaveCount(0);

    // Renaming, by Enter in the field rather than by finding the Save button.
    const rename = page.getByTestId('manage-market-rename-input');
    const save = page.getByTestId('manage-market-rename-save-button');

    // Unchanged: nothing to save, so the confirm is disabled and Enter does nothing.
    await expect(save).toBeDisabled();
    await rename.press('Enter');
    await expect(dialog).toBeVisible();

    const renamed = `E2E EnterRename ${Date.now()}`;
    await rename.fill(renamed);
    await expect(save).toBeEnabled();
    await rename.press('Enter');

    // Saved, and the dialog is still open - saving never closes.
    await expect(save).toBeDisabled({ timeout: 5000 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(renamed).first()).toBeVisible();
  });
});

/**
 * A dialog opened FROM a dialog is live, not inert (E20/F01/S01, found by E20/F04/S01).
 *
 * `useInertBehind` marks every sibling of the open modal's branch, and a second dialog IS a
 * sibling - so the confirmation rendered, said all the right things, and silently could not be
 * pressed. Nothing caught it: it is visible, it is enabled, and only an actual click finds out.
 */
test.describe('A dialog opened from a dialog can be used', () => {
  test('the delete confirmation is clickable while the dialog beneath it is open', async ({
    authenticatedPage: page,
  }) => {
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();

    const name = `E2E StackedDialog ${Date.now()}`;
    await orgs.createOrg(name);
    const card = await orgs.findCard(name);

    await card.getByTestId('organizations-manage-button').click();
    await orgs.waitForManageOverlay();
    await orgs.clickDelete();
    await expect(orgs.deleteWindow).toBeVisible({ timeout: 5000 });

    // Visible and enabled is not the same as reachable, which is exactly how this got through.
    const inert = await orgs.deleteWindow.evaluate((el) => Boolean(el.closest('[inert]')));
    expect(inert, 'the confirmation is inside an inert subtree, so nothing can click it').toBe(
      false,
    );

    await expect(orgs.deleteConfirmButton).toBeEnabled({ timeout: 10000 });
    await orgs.confirmDelete();
    await expect(card).not.toBeVisible({ timeout: 10000 });
  });

  test('and the dialog beneath is inert again once the one above closes', async ({
    authenticatedPage: page,
  }) => {
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();

    const name = `E2E StackedBack ${Date.now()}`;
    await orgs.createOrg(name);
    const card = await orgs.findCard(name);

    await card.getByTestId('organizations-manage-button').click();
    await orgs.waitForManageOverlay();
    await orgs.clickDelete();
    await expect(orgs.deleteWindow).toBeVisible({ timeout: 5000 });

    // Cancelling puts the page back out of play behind the dialog that is still open.
    await orgs.deleteCancelButton.click();
    await expect(orgs.deleteWindow).toBeHidden({ timeout: 5000 });
    await expect(orgs.manageWindow).toBeVisible();
    // And focus is back on Delete, in the dialog beneath, rather than on <body> behind both.
    await expect(orgs.deleteButton).toBeFocused();

    /*
     * Asserted on a control the page HOLDS, not on the page container: the dialogs render inside
     * `.organizations-view`, so it is an ancestor of theirs and on the live spine - it is never
     * marked, and asserting on it would pass whatever the marks said.
     */
    const stillOutOfPlay = await page
      .getByTestId('organizations-create-button')
      .evaluate((el) => el.closest('[inert]') !== null);
    expect(stillOutOfPlay, 'the page behind the manage dialog became reachable again').toBe(true);
  });

  test('Escape closes only the dialog on top, and focus goes back to its opener', async ({
    authenticatedPage: page,
  }) => {
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();

    const name = `E2E StackedEscape ${Date.now()}`;
    await orgs.createOrg(name);
    const card = await orgs.findCard(name);

    await card.getByTestId('organizations-manage-button').click();
    await orgs.waitForManageOverlay();
    await orgs.clickDelete();
    await expect(orgs.deleteWindow).toBeVisible({ timeout: 5000 });

    // Every open dialog took Escape, so one press closed both and left focus on <body> (T114).
    await page.keyboard.press('Escape');
    await expect(orgs.deleteWindow).toBeHidden({ timeout: 5000 });
    await expect(orgs.manageWindow).toBeVisible();
    await expect(orgs.deleteButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(orgs.manageWindow).toBeHidden({ timeout: 5000 });
  });
});

test.describe("Fill an area's dialog is the dialog idiom", () => {
  /** Upper Hall, empty, with Fill an area on and a box dragged over the floor: the dialog open. */
  async function openTheDialog(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
  ): Promise<{ layout: LayoutPage; marketId: string }> {
    const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
      metresAcross: 30,
    });
    const layout = new LayoutPage(page);
    await layout.goto(seeded.marketId, seeded.upper.id);
    await expect(layout.stage).toBeVisible();
    await layout.toolFill.click();
    await layout.drag([2000, 3000], [14_000, 9000]);
    await expect(layout.fillDialog).toBeVisible();
    return { layout, marketId: seeded.marketId };
  }

  test('it is a narrow dialog that opens with the focus on its first field', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await openTheDialog(page, request);

    await expect(layout.fillDialog).toHaveAccessibleName('Fill an area');
    await expect(layout.fillSection).toBeFocused();
    // 26rem, the narrow step.
    expect((await layout.fillDialog.boundingBox())!.width).toBeCloseTo(416, 0);
    // The page behind is out of play while it is open.
    expect(await layout.toolFill.evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
  });

  test('Enter in a field fills, through the same guard the button has', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await openTheDialog(page, request);

    // No whole number: the button is disabled, so Enter does nothing, with no key handler.
    await layout.fillCount.fill('a few');
    await expect(page.getByTestId('layout-fill-count-error')).toHaveText(
      'Type a whole number of tables, 1 to 500.',
    );
    await expect(layout.fillSubmit).toBeDisabled();
    await layout.fillCount.press('Enter');
    await expect(layout.fillDialog).toBeVisible();
    await expect(layout.tables).toHaveCount(0);

    await layout.fillCount.fill('4');
    await layout.saved(() => layout.fillCount.press('Enter'));
    await expect(layout.fillDialog).toBeHidden();
    await expect(layout.status).toHaveText('Placed 4.');
    await expect(layout.tables).toHaveCount(4);
  });

  test('Cancel, the close control, Escape and the backdrop each close it and fill nothing', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await openTheDialog(page, request);
    const reopen = async () => {
      await layout.drag([2000, 3000], [14_000, 9000]);
      await expect(layout.fillDialog).toBeVisible();
    };

    await layout.fillCancel.click();
    await expect(layout.fillDialog).toBeHidden();
    await reopen();
    await page.getByTestId('layout-fill-close-button').click();
    await expect(layout.fillDialog).toBeHidden();
    await reopen();
    await page.keyboard.press('Escape');
    await expect(layout.fillDialog).toBeHidden();
    await reopen();
    // A corner: the dialog is centred in the scrim, so a default click lands on the dialog.
    await page.getByTestId('layout-fill-background').click({ position: { x: 8, y: 8 } });
    await expect(layout.fillDialog).toBeHidden();

    // A box given up is gone, and nothing was placed.
    await expect(layout.fillPreview).toHaveCount(0);
    await expect(layout.tables).toHaveCount(0);
    await expect(layout.undo).toBeDisabled();
  });

  test('opened from "Fill what is in view", closing gives the focus back to that button', async ({
    authenticatedPage: page,
    request,
  }) => {
    const { layout } = await openTheDialog(page, request);
    await layout.fillCancel.click();

    await layout.fillView.click();
    await expect(layout.fillDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(layout.fillDialog).toBeHidden();
    await expect(layout.fillView).toBeFocused();
  });
});

test.describe("A layout's table type dialogs are the dialog idiom", () => {
  /** Upper Hall, calibrated and empty, with Layout settings open on its Table types. */
  async function openTheLayout(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
  ): Promise<LayoutPage> {
    const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
      metresAcross: 30,
    });
    const layout = new LayoutPage(page);
    await layout.goto(seeded.marketId, seeded.upper.id);
    await layout.openSettings();
    await expect(layout.typesCard).toBeVisible();
    return layout;
  }

  test('a type is added in a narrow dialog that opens on its name and holds the page behind it', async ({
    authenticatedPage: page,
    request,
  }) => {
    const layout = await openTheLayout(page, request);
    await layout.typesAdd.click();

    await expect(layout.typeDialog).toHaveAccessibleName('Add a table type');
    await expect(layout.typeName).toBeFocused();
    expect((await layout.typeDialog.boundingBox())!.width).toBeCloseTo(416, 0);
    expect(await layout.typesAdd.evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
  });

  test('Enter in a field adds the type, and a type refused stays in the dialog, saying why under its field', async ({
    authenticatedPage: page,
    request,
  }) => {
    const layout = await openTheLayout(page, request);
    await layout.typesAdd.click();

    await layout.typeName.fill('Standard 6 ft');
    await layout.typeWidth.fill('100');
    await layout.typeDepth.press('Enter');
    await expect(layout.typeDialog).toBeVisible();
    await expect(page.getByTestId('layout-type-name-error')).toHaveText(
      'There is a type named Standard 6 ft already.',
    );
    await expect(page.getByTestId('layout-type-depth-error')).toHaveText(
      'Type the depth as a number of cm.',
    );
    await expect(layout.typeName).toHaveAttribute('aria-invalid', 'true');

    await layout.typeName.fill('Round 5 ft');
    await layout.typeWidth.fill('152');
    await layout.typeDepth.fill('152');
    const written = page.waitForResponse(
      (response) =>
        response.url().includes('/table-types') && response.request().method() === 'PUT',
    );
    await layout.typeDepth.press('Enter');
    expect((await written).ok()).toBe(true);
    await expect(layout.typeDialog).toBeHidden();
    await expect(layout.typeRow('Round 5 ft')).toContainText('152 x 152 cm');
  });

  test('Cancel, the close control, Escape and the backdrop each close it, add nothing, and give the focus back', async ({
    authenticatedPage: page,
    request,
  }) => {
    const layout = await openTheLayout(page, request);
    const reopen = async () => {
      await layout.typesAdd.click();
      await expect(layout.typeDialog).toBeVisible();
      await layout.typeName.fill('Not kept');
    };

    await reopen();
    await layout.typeCancel.click();
    await expect(layout.typeDialog).toBeHidden();
    await expect(layout.typesAdd).toBeFocused();
    await reopen();
    await page.getByTestId('layout-type-close-button').click();
    await expect(layout.typeDialog).toBeHidden();
    await reopen();
    await page.keyboard.press('Escape');
    await expect(layout.typeDialog).toBeHidden();
    await expect(layout.typesAdd).toBeFocused();
    await reopen();
    await page.getByTestId('layout-type-background').click({ position: { x: 8, y: 8 } });
    await expect(layout.typeDialog).toBeHidden();
    await expect(layout.typeRows).toHaveCount(1);
  });

  test('"Save these types" is a narrow dialog Enter saves from; "Use saved types" a wide one listing them', async ({
    authenticatedPage: page,
    request,
  }) => {
    const layout = await openTheLayout(page, request);
    const venue = `Dialog Hall ${Date.now()}`;

    await layout.typesSave.click();
    await expect(layout.saveTypesDialog).toHaveAccessibleName('Save these types');
    await expect(layout.saveTypesName).toBeFocused();
    expect((await layout.saveTypesDialog.boundingBox())!.width).toBeCloseTo(416, 0);
    await layout.saveTypesName.press('Enter');
    await expect(page.getByTestId('layout-save-types-name-error')).toHaveText(
      'Name the saved types, such as the venue.',
    );
    await layout.saveTypesName.fill(venue);
    await layout.saveTypesName.press('Enter');
    await expect(layout.saveTypesDialog).toBeHidden();
    await expect(layout.typesSave).toBeFocused();

    await layout.typesUseSaved.click();
    await expect(layout.savedTypesDialog).toHaveAccessibleName('Use saved types');
    // 38rem, the wide step, for a list.
    expect((await layout.savedTypesDialog.boundingBox())!.width).toBeCloseTo(608, 0);
    await expect(
      layout.savedTypesDialog.getByRole('radio', { name: new RegExp(`^${venue}`) }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(layout.savedTypesDialog).toBeHidden();
    await expect(layout.typesUseSaved).toBeFocused();
  });
});

/**
 * Every dialog's close stands on its title's line (T422, the QC walk's item 11): its middle on the
 * middle of the title's first line, and its glyph as far in from the window's right edge as the
 * title is from its left. The walk found the Layout settings dialog's × 16.5px above the title's
 * line and its glyph 20px from the right against the title's 24px from the left, and every dialog
 * on `AppDialog` with it.
 *
 * What is measured: the title's first line box (the heading's content top plus half its line
 * height), the close's box, and the glyph's own rectangle, a `Range` over the close's text, so the
 * button's padding and its 44px phone target are not taken for the glyph.
 */
test.describe("Every dialog's close stands on its title's line", () => {
  type Head = {
    /** The middle of the title's first line, and of the close's box, from the window's top. */
    titleMiddle: number;
    closeMiddle: number;
    /** The title's letters from the window's left edge, and the glyph's from its right edge. */
    titleInset: number;
    glyphInset: number;
    /** How many lines the title takes, its widest line's right edge, and the close's left edge. */
    titleLines: number;
    titleRight: number;
    closeLeft: number;
  };

  /** Measures `frame`'s head: `title` is its heading and `close` its close, found inside it. */
  async function measureHead(frame: Locator, title: string, close: string): Promise<Head> {
    return frame.evaluate(
      (win, [titleSelector, closeSelector]) => {
        const box = win.getBoundingClientRect();
        const heading = win.querySelector<HTMLElement>(titleSelector!)!;
        const button = win.querySelector<HTMLElement>(closeSelector!)!;
        const style = getComputedStyle(heading);
        const top = heading.getBoundingClientRect().top + parseFloat(style.paddingTop);
        const words = document.createRange();
        words.selectNodeContents(heading);
        const lines = [...words.getClientRects()].filter((rect) => rect.width > 0);
        const glyph = document.createRange();
        glyph.selectNodeContents(button);
        const drawn = [...glyph.getClientRects()].filter((rect) => rect.width > 0);
        const closeBox = button.getBoundingClientRect();
        return {
          titleMiddle: top + parseFloat(style.lineHeight) / 2 - box.top,
          closeMiddle: closeBox.top + closeBox.height / 2 - box.top,
          titleInset: Math.min(...lines.map((rect) => rect.left)) - box.left,
          glyphInset: box.right - Math.max(...drawn.map((rect) => rect.right)),
          titleLines: new Set(lines.map((rect) => Math.round(rect.top))).size,
          titleRight: Math.max(...lines.map((rect) => rect.right)),
          closeLeft: closeBox.left,
        };
      },
      [title, close],
    );
  }

  /** The close's middle within half a pixel of the title's first line's. */
  function expectTheMiddles(head: Head, what: string) {
    expect(
      Math.abs(head.closeMiddle - head.titleMiddle),
      `${what}: the close's middle (${head.closeMiddle}) on the title's first line's (${head.titleMiddle})`,
    ).toBeLessThanOrEqual(0.5);
  }

  /** The middles, and the glyph's inset within half a pixel of the title's. */
  function expectOnTheLine(head: Head, what: string) {
    expectTheMiddles(head, what);
    expect(
      Math.abs(head.glyphInset - head.titleInset),
      `${what}: the glyph ${head.glyphInset}px in from the right, the title ${head.titleInset}px from the left`,
    ).toBeLessThanOrEqual(0.5);
  }

  /**
   * No title of the app is this long, so its words are swapped in the browser: what is measured is
   * how a title that wraps is laid out beside the close, on its first line and clear of it.
   */
  async function expectAWrappedTitleClear(
    frame: Locator,
    title: string,
    close: string,
    what: string,
  ) {
    await frame
      .locator(title)
      .evaluate(
        (heading) =>
          (heading.textContent =
            'A title long enough to wrap, and to wrap again on a phone, beside the close'),
      );
    const wrapped = await measureHead(frame, title, close);
    expect(wrapped.titleLines, `${what}: the long title wraps`).toBeGreaterThan(1);
    expectTheMiddles(wrapped, `${what}, wrapped`);
    expect(
      wrapped.titleRight,
      `${what}: the title's lines end (${wrapped.titleRight}) short of the close (${wrapped.closeLeft})`,
    ).toBeLessThan(wrapped.closeLeft);
  }

  const DIALOG_TITLE = '.dialog-title';
  const DIALOG_CLOSE = '[data-dialog-close]';

  test('in a dialog that scrolls whole and one that scrolls its body, at a desk', async ({
    authenticatedPage: page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seeded = await seedLayout(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
      metresAcross: 30,
    });
    const layout = new LayoutPage(page);
    await layout.goto(seeded.marketId, seeded.upper.id);
    await layout.openSettings();
    await expect(layout.typesCard).toBeVisible();

    // Add a table type: the title and the body scroll together.
    await layout.typesAdd.click();
    await expect(layout.typeDialog).toBeVisible();
    expect(await layout.typeDialog.getByTestId('layout-type-scroll').count()).toBe(1);
    expectOnTheLine(
      await measureHead(layout.typeDialog, DIALOG_TITLE, DIALOG_CLOSE),
      'Add a table type',
    );
    await expectAWrappedTitleClear(
      layout.typeDialog,
      DIALOG_TITLE,
      DIALOG_CLOSE,
      'Add a table type',
    );
    await page.keyboard.press('Escape');
    await expect(layout.typeDialog).toBeHidden();

    // Use saved types: only the body scrolls, under a pinned title.
    await layout.typesUseSaved.click();
    await expect(layout.savedTypesDialog).toBeVisible();
    expect(await layout.savedTypesDialog.getByTestId('layout-saved-types-body').count()).toBe(1);
    expectOnTheLine(
      await measureHead(layout.savedTypesDialog, DIALOG_TITLE, DIALOG_CLOSE),
      'Use saved types',
    );
    await expectAWrappedTitleClear(
      layout.savedTypesDialog,
      DIALOG_TITLE,
      DIALOG_CLOSE,
      'Use saved types',
    );
  });

  /*
   * On a phone `--target-min` makes the close 44px wide and its glyph stands centred in it, a few
   * px further in than the title's inset, as the prototype Daniel approved has it; what holds there
   * is the middle and the clearance.
   */
  test('on a phone, where the close is 44px, in either scroll, with a title that wraps', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Create market: the title and the body scroll together.
    await page.goto('/markets');
    await page.getByTestId('markets-create-button').click();
    const create = page.getByTestId('new-market-window');
    await expect(create).toBeVisible();
    expect(await create.getByTestId('new-market-scroll').count()).toBe(1);
    const short = await measureHead(create, DIALOG_TITLE, DIALOG_CLOSE);
    expect(short.titleLines, 'Create market: its title takes one line').toBe(1);
    expectTheMiddles(short, 'Create market');
    await expectAWrappedTitleClear(create, DIALOG_TITLE, DIALOG_CLOSE, 'Create market');
    await page.keyboard.press('Escape');
    await expect(create).toBeHidden();

    // Manage organization: only the body scrolls.
    const orgs = new OrganizationsPage(page);
    await orgs.goto();
    await orgs.waitForLoaded();
    await page.getByTestId('organizations-manage-button').first().click();
    await orgs.waitForManageOverlay();
    expect(await orgs.manageWindow.getByTestId('manage-org-body').count()).toBe(1);
    expectTheMiddles(
      await measureHead(orgs.manageWindow, DIALOG_TITLE, DIALOG_CLOSE),
      'Manage organization',
    );
    await expectAWrappedTitleClear(
      orgs.manageWindow,
      DIALOG_TITLE,
      DIALOG_CLOSE,
      'Manage organization',
    );
  });

  /*
   * The vendor drawer is not on `AppDialog`, and holds the same rule: its close on the name's first
   * line, under the "Vendor details" eyebrow, and its glyph as far in as the name, at a desk.
   */
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`the vendor drawer's close stands on its title's line too, at ${size.width}`, async ({
      authenticatedPage: page,
      request,
    }) => {
      await page.setViewportSize(size);
      const seed = await seedPublishedMarketWithAssignments(
        request,
        BACKEND_URL,
        TEST_USER.email,
        TEST_USER.password,
      );
      const vendors = new VendorsPage(page);
      await vendors.goto(seed.marketId);
      const row = vendors.vendorListItems.first();
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.click();
      await expect(page.getByTestId('vendors-detail-close')).toBeVisible();
      const panel = page.getByTestId('vendors-detail-panel');
      const title = '#vendor-drawer-title';
      const close = '[data-testid="vendors-detail-close"]';
      const head = await measureHead(panel, title, close);
      if (size.width > 640) expectOnTheLine(head, 'The vendor drawer');
      else expectTheMiddles(head, 'The vendor drawer');
      await expectAWrappedTitleClear(panel, title, close, 'The vendor drawer');
    });
  }
});
