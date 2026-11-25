import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import {
  seedApplicationWithStatus,
  seedPhaseMarket,
  transitionMarket,
} from './helpers/seedPhaseMarket';
import { oneByOnePath } from './helpers/marketScreens';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { grantMarketRole } from './helpers/grantMarketRole';
import { withUser } from './helpers/withUser';
import { ApplicationMonitorPage } from './pages/ApplicationMonitorPage';

/**
 * A verdict undone after the reviewers were chosen is dealt again (T277 ticket 02, its ticket 03).
 *
 * Ana, an Editor, approves the first application before anyone chooses reviewers. Then Ana and Ben
 * are chosen, and the one application still open is dealt to Ana, whose address sorts first. Ana
 * undoes her approval from the line above her card: the application is open again, and the deal
 * hands it to Ben, whose turn it is. Ben's One by one hands it to him as his share. Before, the
 * undone application came back open in nobody's share, and Ben was told his share was done.
 */
const PASSWORD = 'e2epassword123';
const ANA = 'e2e-dealt-again-ana@example.com';
const BEN = 'e2e-dealt-again-ben@example.com';
const UNDONE = 'dealt-again-1@moss.test';
const OPEN = 'dealt-again-2@moss.test';

test('an undone verdict is handed to the reviewer whose turn it is', async ({
  browser,
  request,
}) => {
  for (const email of [ANA, BEN]) ensureVerifiedUser(email, PASSWORD);
  const { marketId } = await seedPhaseMarket(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { intakeMode: 'form' },
  );
  await transitionMarket(request, BACKEND_URL, TEST_USER.email, marketId, 'applications');
  const api = `${BACKEND_URL}/markets/${marketId}`;
  // Seeded one after the other, so they arrive, and are handed out, in this order.
  for (const vendor of [UNDONE, OPEN]) seedApplicationWithStatus(marketId, 'open', vendor);
  for (const [email, role] of [
    [ANA, 'editor'],
    [BEN, 'viewer'],
  ] as const) {
    await grantMarketRole(request, marketId, { email, password: PASSWORD }, role);
  }

  await withUser(browser, ANA, PASSWORD, async (page) => {
    const monitor = new ApplicationMonitorPage(page);
    await page.goto(oneByOnePath(marketId));
    await monitor.waitForLoaded();
    await expect(monitor.email).toHaveText(UNDONE);
    await monitor.approveButton.click();
    await expect(monitor.undoLine).toContainText(UNDONE);

    // Chosen while her verdict can still be undone: the one still open is dealt to Ana.
    const chosen = await request.put(`${api}/reviewers`, { data: { reviewers: [ANA, BEN] } });
    expect(chosen.ok(), await chosen.text()).toBeTruthy();

    await monitor.undoButton.click();
    await expect(monitor.undoLine).toHaveCount(0);
    await expect(monitor.email).toHaveText(UNDONE);
    await expect(monitor.status).toHaveText('Open');
    // Ben's turn: the card Ana undid says it is his now.
    await expect(monitor.dealtWarning).toHaveText(
      `This application is dealt to ${BEN}. If you decide it, its history will say you decided it for them.`,
    );
    // Her list was read before the reviewers were chosen: read again, it holds her share, and she
    // moves on to her own, which lets go of the card she undid for Ben.
    await page.getByTestId('applications-refresh').click();
    await expect(monitor.progress).toHaveText('1 of 1 open');
    await monitor.nextCard();
    await expect(monitor.email).toHaveText(OPEN);
    await expect(monitor.progress).toHaveText('1 of 1 in your share');
  });

  await withUser(browser, BEN, PASSWORD, async (page) => {
    const monitor = new ApplicationMonitorPage(page);
    await page.goto(oneByOnePath(marketId));
    await monitor.waitForLoaded();

    await expect(monitor.email).toHaveText(UNDONE);
    await expect(monitor.progress).toHaveText('1 of 1 in your share');
    await expect(monitor.dealtWarning).toHaveCount(0);
  });
});
