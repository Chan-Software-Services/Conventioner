import type { Locator, Page } from '@playwright/test';
import { marketPagePath } from '../helpers/marketScreens';

/**
 * A market's page, at its own address `/<slug>` (T469): for anyone, the public map while it is
 * open, the application call while the market takes applications, and otherwise a notice of where
 * it stands, each with a way to the vendor page at `/<slug>/vendor`. The map, once it shows, is
 * read through `PublicMapPage`.
 */
export class MarketPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Open the page, its query with it, and wait for the market to answer: whatever it shows. */
  async goto(slug: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    await this.page.goto(`${marketPagePath(slug)}${search ? `?${search}` : ''}`);
    await this.call
      .or(this.notice)
      .or(this.page.getByTestId('public-map-heading'))
      .or(this.page.getByTestId('page-not-found'))
      .or(this.readFailed)
      .waitFor();
  }

  /**
   * Everything a visitor is shown at `/<slug>`, as text, with the slug masked out: a market with no
   * vendor page must read exactly as a slug that names nothing, so the whole page is compared.
   */
  async renderedText(slug: string): Promise<string> {
    await this.page.goto(marketPagePath(slug));
    await this.page.waitForLoadState('networkidle');
    const text = (await this.page.locator('body').innerText()).trim();
    return text.split(slug).join('<slug>');
  }

  get name(): Locator {
    return this.page.getByTestId('market-page-name');
  }

  /** The market's dates, one item a date; absent for a market with none. */
  get dates(): Locator {
    return this.page.getByTestId('market-page-dates');
  }

  get notFound(): Locator {
    return this.page.getByTestId('market-page-not-found');
  }

  get readFailed(): Locator {
    return this.page.getByTestId('market-page-read-failed');
  }

  get retryButton(): Locator {
    return this.page.getByTestId('market-page-retry');
  }

  // ── The application call ─────────────────────────────────────────────────

  get call(): Locator {
    return this.page.getByTestId('market-page-call');
  }

  get applyLink(): Locator {
    return this.page.getByTestId('market-page-apply');
  }

  /** "Sign in", in "Already applied? Sign in". */
  get signInLink(): Locator {
    return this.page.getByTestId('market-page-sign-in');
  }

  // ── A notice ─────────────────────────────────────────────────────────────

  get notice(): Locator {
    return this.page.getByTestId('market-page-notice');
  }

  get noticeLine(): Locator {
    return this.page.getByTestId('market-page-notice-line');
  }

  /** "Vendor sign-in", or "Your vendor page" for a tab signed in for this market. */
  get vendorLink(): Locator {
    return this.page.getByTestId('market-page-vendor-link');
  }
}
