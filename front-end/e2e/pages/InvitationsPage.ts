import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page object for the Invitations page (InvitationsView, T538): every invitation waiting for the
 * signed-in address, each a row with Accept and Decline, then what came of it in that row.
 *
 * A row is found by the name of what it invites to, since the inviter and the role sit beside it in
 * one sentence; the Markets list's line pointing here is `waitingLine` on Markets.
 */
export class InvitationsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly loading: Locator;
  readonly none: Locator;
  readonly readFailed: Locator;
  readonly retryButton: Locator;
  readonly rows: Locator;
  /** The Markets list's "You have an invitation waiting." line, and its "See invitations". */
  readonly waitingLine: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Invitations' });
    this.loading = page.getByTestId('invitations-loading');
    this.none = page.getByTestId('invitations-none');
    this.readFailed = page.getByTestId('invitations-read-failed');
    this.retryButton = page.getByTestId('invitations-retry');
    this.rows = page.getByTestId('invitation-row');
    this.waitingLine = page.getByTestId('markets-invitations-waiting');
  }

  /** Open the page and wait for its first read to answer. */
  async goto(): Promise<void> {
    await this.page.goto('/invitations');
    await this.waitForRead();
  }

  async waitForRead(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.loading).toBeHidden();
  }

  /** The row of the invitation to `targetName`. */
  row(targetName: string): Locator {
    return this.rows.filter({
      has: this.page.getByTestId('invitation-sentence').filter({ hasText: targetName }),
    });
  }

  sentence(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-sentence');
  }

  until(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-until');
  }

  acceptButton(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-accept');
  }

  declineButton(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-decline');
  }

  /** What came of the row's answer: what they are now, a decline, or why it has ended. */
  outcome(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-outcome');
  }

  /** An accepted invitation's link to the market, or to Organizations. */
  openLink(targetName: string): Locator {
    return this.row(targetName).getByTestId('invitation-open');
  }

  async accept(targetName: string): Promise<void> {
    await this.acceptButton(targetName).click();
    await expect(this.outcome(targetName)).toBeVisible();
  }

  async decline(targetName: string): Promise<void> {
    await this.declineButton(targetName).click();
    await expect(this.outcome(targetName)).toBeVisible();
  }
}
