import { marketScreenPath } from '../helpers/marketScreens';
import { ChoiceField } from './ChoiceField';
import type { Locator, Page } from '@playwright/test';

/**
 * Page object for a market's Tools tab (/markets/:marketId/tools): the manual tools an organizer
 * runs in any phase, Discord's card first (E46/F01/S02), then the Public map's (T422).
 */
export class ToolsPage {
  readonly page: Page;
  readonly tools: Locator;
  readonly discordCard: Locator;
  readonly serverName: Locator;
  readonly roleValue: Locator;
  readonly questionValue: Locator;
  readonly inviteValue: Locator;
  readonly roleChoice: ChoiceField;
  readonly inviteInput: Locator;
  readonly inviteError: Locator;
  readonly roleWarning: Locator;
  readonly questionChoice: ChoiceField;
  readonly roleLabel: Locator;
  readonly questionLabel: Locator;
  readonly giving: Locator;
  readonly givingNeedsRole: Locator;
  readonly givingNeedsQuestion: Locator;
  readonly givingNeedsAssignment: Locator;
  readonly givingItems: Locator;
  readonly givingVendorsLink: Locator;
  readonly publicMapCard: Locator;
  readonly publicMapName: ChoiceField;
  readonly publicMapWebsite: ChoiceField;
  readonly publicMapInstagram: ChoiceField;
  readonly publicMapSwitch: Locator;
  readonly publicMapSwitchReason: Locator;
  readonly publicMapRefusal: Locator;
  readonly publicMapSaveError: Locator;
  readonly publicMapMissing: Locator;
  readonly publicMapUrl: Locator;
  readonly publicMapCopy: Locator;
  readonly publicMapOpen: Locator;

  constructor(page: Page) {
    this.page = page;
    this.tools = page.getByTestId('market-tools');
    this.discordCard = page.getByTestId('plan-card-discord');
    this.serverName = page.getByTestId('discord-server-name');
    this.roleValue = page.getByTestId('discord-role-value');
    this.questionValue = page.getByTestId('discord-question-value');
    this.inviteValue = page.getByTestId('discord-invite-value');
    this.roleChoice = new ChoiceField(page, 'discord-role-select');
    this.inviteInput = page.getByTestId('discord-invite-input');
    this.inviteError = page.getByTestId('discord-invite-error');
    this.roleWarning = page.getByTestId('discord-role-warning');
    this.questionChoice = new ChoiceField(page, 'discord-question-select');
    this.roleLabel = page.locator('label[for="discord-role"]');
    this.questionLabel = page.locator('label[for="discord-question"]');
    this.giving = page.getByTestId('discord-giving');
    this.givingNeedsRole = page.getByTestId('discord-giving-needs-role');
    this.givingNeedsQuestion = page.getByTestId('discord-giving-needs-question');
    this.givingNeedsAssignment = page.getByTestId('discord-giving-needs-assignment');
    this.givingItems = page.getByTestId('discord-giving-needs').getByRole('listitem');
    this.givingVendorsLink = page.getByTestId('discord-giving-vendors');
    this.publicMapCard = page.getByTestId('plan-card-public-map');
    this.publicMapName = new ChoiceField(page, 'public-map-name-select');
    this.publicMapWebsite = new ChoiceField(page, 'public-map-website-select');
    this.publicMapInstagram = new ChoiceField(page, 'public-map-instagram-select');
    this.publicMapSwitch = page.getByTestId('public-map-switch');
    this.publicMapSwitchReason = page.getByTestId('public-map-switch-reason');
    this.publicMapRefusal = page.getByTestId('public-map-refusal');
    this.publicMapSaveError = page.getByTestId('public-map-save-error');
    this.publicMapMissing = page.getByTestId('public-map-missing');
    this.publicMapUrl = page.getByTestId('public-map-url');
    this.publicMapCopy = page.getByTestId('public-map-copy');
    this.publicMapOpen = page.getByTestId('public-map-open');
  }

  async goto(marketId: string): Promise<void> {
    await this.page.goto(marketScreenPath(marketId, 'tools'));
  }

  /** On a small server, a select: the server's role, once the card has read the server's roles. */
  roleOption(roleId: string): Locator {
    return this.roleChoice.root.locator(`option[value="${roleId}"]`);
  }

  /** Write in "Invite link" and leave the field, which saves it, until the server has answered. */
  async leaveInviteLink(text: string): Promise<void> {
    const answered = this.page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().endsWith('/discord'),
    );
    await this.inviteInput.fill(text);
    await this.inviteInput.blur();
    await answered;
  }

  /**
   * Do one thing on the Public map card that saves, and wait until the server has answered it and
   * the market read after it has come back, so the next step meets the card as stored.
   */
  async savePublicMap(act: () => Promise<void>): Promise<void> {
    const saved = this.page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().endsWith('/public-map'),
    );
    // Waited for from the start, so a read that answers quickly is not missed; a refused save
    // reads nothing, so it is left to time out unheard.
    const reread = this.page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && /\/markets\/[^/?]+(\?|$)/.test(response.url()),
    );
    reread.catch(() => undefined);
    await act();
    if ((await saved).ok()) await reread;
  }
}
