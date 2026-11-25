import { randomInt } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from './fixtures';
import { inviteToMarket, inviteToOrganization } from './helpers/invitations';
import { seedDraftMarket } from './helpers/seedDraftMarket';
import { uniqueMarketName } from './helpers/uniqueName';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { withUser } from './helpers/withUser';
import { InvitationsPage } from './pages/InvitationsPage';

/**
 * Why E2E: the session (only the address signed in answers its invitations), the stack together
 * (an accept gives the role the market then opens with), and layout at a phone's width.
 *
 * A person invited through the API (T538, ADR 0047) signs in, reads the Markets list's line, opens
 * the Invitations page, accepts a market invitation and opens the market as its Editor, declines
 * an organization invitation, and reads an invitation withdrawn meanwhile as ended. The fixture
 * organizer invites; the invitee is an address of each test's own, so no earlier run's invitation
 * is counted in the line. Fixture data.
 */

const PASSWORD = 'e2epassword123';
const ENDED =
  'This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no longer ' +
  'give it. Ask them to invite you again.';

interface Invited {
  invitee: { email: string; password: string };
  market: { id: string; name: string };
  withdrawn: { id: string; name: string; invitationId: string };
  organization: { id: string; name: string };
}

/** Three invitations to a fresh address from the fixture organizer: a market as an Editor, an
 * organization as a member, and a second market as a Viewer, to be withdrawn. */
async function invite(request: APIRequestContext): Promise<Invited> {
  const invitee = {
    email: `e2e-invitee-${Date.now()}${randomInt(1000, 10000)}@example.com`,
    password: PASSWORD,
  };
  ensureVerifiedUser(invitee.email, invitee.password);
  const market = await seedDraftMarket(request, BACKEND_URL, TEST_USER.email, TEST_USER.password, {
    name: uniqueMarketName('E2E Invited Market'),
  });
  const withdrawn = await seedDraftMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { name: uniqueMarketName('E2E Withdrawn Market') },
  );
  const organizationName = uniqueMarketName('E2E Invited Organization');
  const made = await request.post(`${BACKEND_URL}/organizations`, {
    data: { name: organizationName },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { organization_id: organizationId } = (await made.json()) as { organization_id: string };

  await inviteToMarket(request, market.marketId, invitee.email, 'editor');
  await inviteToOrganization(request, organizationId, invitee.email, 'member');
  const toWithdraw = await inviteToMarket(request, withdrawn.marketId, invitee.email, 'viewer');
  return {
    invitee,
    market: { id: market.marketId, name: market.marketName },
    withdrawn: {
      id: withdrawn.marketId,
      name: withdrawn.marketName,
      invitationId: toWithdraw.id,
    },
    organization: { id: organizationId, name: organizationName },
  };
}

/** The page's own width against the window's: nothing scrolls sideways. */
async function expectNoSidewaysScroll(page: Page, width: number): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

for (const window of [
  { name: 'at a desk', viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'on a phone', viewport: { width: 390, height: 844 }, phone: true },
]) {
  test.describe(window.name, () => {
    test('an invitee reads the line, accepts, declines and meets an ended invitation', async ({
      browser,
      request,
    }) => {
      const invited = await invite(request);
      const options = window.phone
        ? { viewport: window.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
        : { viewport: window.viewport };

      await withUser(
        browser,
        invited.invitee.email,
        invited.invitee.password,
        async (page) => {
          const invitations = new InvitationsPage(page);
          await expect(invitations.waitingLine).toHaveText(
            'You have 3 invitations waiting. See invitations',
          );
          await invitations.waitingLine.getByRole('link', { name: 'See invitations' }).click();
          await page.waitForURL((url) => url.pathname === '/invitations');
          await invitations.waitForRead();

          await expect(invitations.rows).toHaveCount(3);
          await expect(invitations.sentence(invited.market.name)).toHaveText(
            `${TEST_USER.email} invited you to ${invited.market.name} as an Editor.`,
          );
          await expect(invitations.until(invited.market.name)).toHaveText(
            /^Until \d+ \w+, \d{2}:\d{2}\.$/,
          );
          await expect(invitations.sentence(invited.organization.name)).toHaveText(
            `${TEST_USER.email} invited you to the organization ${invited.organization.name} as a member.`,
          );
          await expectNoSidewaysScroll(page, window.viewport.width);

          // Withdrawn while the page was open: accepting it says it has ended, and offers nothing.
          const withdrawn = await request.delete(
            `${BACKEND_URL}/markets/${invited.withdrawn.id}/invitations/${invited.withdrawn.invitationId}`,
          );
          expect(withdrawn.ok(), await withdrawn.text()).toBe(true);
          await invitations.accept(invited.withdrawn.name);
          await expect(invitations.outcome(invited.withdrawn.name)).toHaveText(ENDED);
          await expect(invitations.acceptButton(invited.withdrawn.name)).toHaveCount(0);
          await expect(invitations.declineButton(invited.withdrawn.name)).toHaveCount(0);

          await invitations.decline(invited.organization.name);
          await expect(invitations.outcome(invited.organization.name)).toHaveText(
            `You declined the invitation to ${invited.organization.name}.`,
          );
          await expect(invitations.outcome(invited.organization.name)).toBeFocused();

          await invitations.accept(invited.market.name);
          await expect(invitations.outcome(invited.market.name)).toHaveText(
            `You are now an Editor on ${invited.market.name}.`,
          );
          await expect(invitations.outcome(invited.market.name)).toBeFocused();
          // Every row keeps its place until the page is read again.
          await expect(invitations.rows).toHaveCount(3);
          await expectNoSidewaysScroll(page, window.viewport.width);

          await invitations.openLink(invited.market.name).click();
          await page.waitForURL((url) => url.pathname.startsWith(`/markets/${invited.market.id}`));
          await expect(page.getByTestId('market-bar-title')).toHaveText(invited.market.name, {
            timeout: 15000,
          });
          // An Editor of a draft is told nothing of reading only: a Viewer would be.
          await expect(page.getByTestId('market-read-only')).toHaveCount(0);

          // Read again, nothing waits, and the Markets list says nothing of invitations.
          await invitations.goto();
          await expect(invitations.none).toHaveText('No invitations are waiting for you.');
          await page.goto('/markets');
          await expect(page.getByTestId('markets-result-count')).toBeVisible();
          await expect(invitations.waitingLine).toHaveCount(0);
        },
        options,
      );
    });
  });
}
