import type { Locator, Page } from '@playwright/test';

/**
 * A market's public map, `/<slug>/map` (T422): the market's name, the day buttons, the day map
 * (its location switch, the drawing, the zoom and the legend), the card of the table picked, and
 * the find field over the day's vendors. Its tables and halves are found by their accessible
 * names, as a layout's are ("Aisle A 3, Standard 6 ft, left half, Loom House"), since what the
 * spec proves is what a screen reader hears.
 */
export class PublicMapPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Open the map, its query with it, and wait for the market to answer: its map, or not. */
  async goto(slug: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    await this.page.goto(`/${slug}/map${search ? `?${search}` : ''}`);
    await this.heading
      .or(this.page.getByTestId('page-not-found'))
      .or(this.page.getByTestId('public-map-read-failed'))
      .waitFor();
  }

  /**
   * Everything a visitor is shown at `/<slug>/map`, as text, with the slug masked out: a market
   * whose map is not open must read exactly as a slug naming nothing.
   */
  async renderedText(slug: string): Promise<string> {
    await this.page.goto(`/${slug}/map`);
    await this.page.waitForLoadState('networkidle');
    const text = (await this.page.locator('body').innerText()).trim();
    return text.split(slug).join('<slug>');
  }

  get heading(): Locator {
    return this.page.getByTestId('public-map-heading');
  }

  get notFound(): Locator {
    return this.page.getByTestId('public-map-not-found');
  }

  get days(): Locator {
    return this.page.getByTestId('public-map-day');
  }

  /** The day button of a market date, `YYYY-MM-DD`. */
  day(date: string): Locator {
    return this.page.locator(`[data-testid="public-map-day"][data-date="${date}"]`);
  }

  get dayMap(): Locator {
    return this.page.getByTestId('public-map-map');
  }

  get map(): Locator {
    return this.page.getByTestId('layout-map');
  }

  get mapImage(): Locator {
    return this.page.getByTestId('layout-map-image');
  }

  /** The location switch's button of a location, by its name. */
  location(name: string): Locator {
    return this.page.getByTestId('day-map-locations').getByRole('button', { name, exact: true });
  }

  get legend(): Locator {
    return this.page.getByTestId('day-map-legend-item');
  }

  get zoomIn(): Locator {
    return this.page.getByTestId('day-map-zoom-in');
  }

  /** A table of the open location, or one half of a shared table, by the start of its name. */
  table(code: string, half?: 'left' | 'right'): Locator {
    const name = half ? `${code}, Standard 6 ft, ${half} half` : `${code}, Standard 6 ft`;
    return this.map.getByRole('button', { name });
  }

  /** Every pressable table and half of the open location. */
  get targets(): Locator {
    return this.map.getByRole('button');
  }

  get card(): Locator {
    return this.page.getByTestId('public-map-card');
  }

  get cardHalves(): Locator {
    return this.card.getByTestId('public-map-card-half');
  }

  get find(): Locator {
    return this.page.getByTestId('public-map-vendors-find');
  }

  get vendorsCount(): Locator {
    return this.page.getByTestId('public-map-vendors-count');
  }

  get vendors(): Locator {
    return this.page.getByTestId('public-map-vendor');
  }

  get vendorsEmpty(): Locator {
    return this.page.getByTestId('public-map-vendors-empty');
  }

  /** The SVG map's view box, in millimetres of the hall. */
  async view(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = (await this.map.getAttribute('viewBox'))!.split(' ').map(Number);
    return { x: box[0], y: box[1], width: box[2], height: box[3] };
  }
}
