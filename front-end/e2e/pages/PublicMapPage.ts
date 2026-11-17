import type { Locator, Page } from '@playwright/test';
import { marketPagePath } from '../helpers/marketScreens';

/**
 * A market's public map, at the market's own address, `/<slug>`, which the market page shows while
 * the map is open (T422, T465, ADR 0039): one sheet filling the window, its map side (the market's
 * name, the day and hall selects, the hall the day map fills, the legend and the zoom), the card of
 * the table picked (a speech bubble at a desk, the vendor panel's top on a phone), and the vendor
 * panel (the "Find a vendor" search over every named vendor of the day). Its tables and halves are
 * found by their accessible names, as a layout's are ("Aisle A 3, Standard 6 ft, left half, Loom
 * House"), since what the spec proves is what a screen reader hears.
 */
export class PublicMapPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Open the market page, its query with it, and wait for the market to answer: its map, or not. */
  async goto(slug: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    await this.page.goto(`${marketPagePath(slug)}${search ? `?${search}` : ''}`);
    await this.heading
      .or(this.page.getByTestId('page-not-found'))
      .or(this.page.getByTestId('public-map-read-failed'))
      // A map that is not open is a notice on the market page (T469).
      .or(this.page.getByTestId('market-page-notice'))
      .waitFor();
  }

  /** The page's whole column, once the market answered with a map, or while it is read. */
  get root(): Locator {
    return this.page.getByTestId('public-map');
  }

  /** "Loading…", while the map is read. */
  get loading(): Locator {
    return this.page.getByTestId('public-map-loading');
  }

  /** "The map could not be loaded.", with Try again (`ReadFailed`). */
  get readFailed(): Locator {
    return this.page.getByTestId('public-map-read-failed');
  }

  /** The market's name, the page's `h1`. */
  get heading(): Locator {
    return this.page.getByTestId('public-map-heading');
  }

  /** The line under the market's name. */
  get subtitle(): Locator {
    return this.page.getByTestId('public-map-subtitle');
  }

  /** "Page not found", for a market whose map is not open. */
  get notFound(): Locator {
    return this.page.getByTestId('public-map-not-found');
  }

  /** The day select, a pill at the map side's top right (T465 ticket 03). */
  get daySelect(): Locator {
    return this.page.getByTestId('public-map-day-select');
  }

  /** The hall select, shown for two locations or more (T465 ticket 03). */
  get locationSelect(): Locator {
    return this.page.getByTestId('public-map-location-select');
  }

  /** The box the day map stands in. */
  get dayMap(): Locator {
    return this.page.getByTestId('public-map-map');
  }

  /** The hall, the map side's area the drawing fills (T465 ticket 03). */
  get hall(): Locator {
    return this.page.getByTestId('public-map-hall');
  }

  /** The open hall's legend of sections and free tables (T465 ticket 03). */
  get sectionLegend(): Locator {
    return this.page.getByTestId('public-map-legend');
  }

  /** Each item of that legend, its kind in `data-kind`, `section` or `free` (T465 ticket 03). */
  get sectionLegendItems(): Locator {
    return this.page.getByTestId('public-map-legend-item');
  }

  /** The blurred backdrop dealt from the sections' colours (T465 ticket 04). */
  get backdrop(): Locator {
    return this.page.getByTestId('public-map-backdrop');
  }

  get map(): Locator {
    return this.page.getByTestId('layout-map');
  }

  get mapImage(): Locator {
    return this.page.getByTestId('layout-map-image');
  }

  /** The day map's own legend items, which the page never draws: its legend is `sectionLegend`. */
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

  /** The speech bubble the card stands in at a desk, saying where it opened by `data-side`,
   *  `data-vert` and its tail's offset `--tail-x` (T465 ticket 05). */
  get bubble(): Locator {
    return this.page.getByTestId('public-map-bubble');
  }

  /** The card of the table picked. */
  get card(): Locator {
    return this.page.getByTestId('public-map-card');
  }

  /** The box the card scrolls in at the vendor panel's top, under 1000px (T465 ticket 08). */
  get cardScroller(): Locator {
    return this.page.getByTestId('public-map-card-scroller');
  }

  /** The table's code in its section's pill, on the card (T465 ticket 05). */
  get cardCode(): Locator {
    return this.card.getByTestId('public-map-card-code');
  }

  /** The card's Close button (T465 ticket 05). */
  get cardClose(): Locator {
    return this.card.getByTestId('public-map-card-close');
  }

  /** The card's part for a whole table. */
  get cardWhole(): Locator {
    return this.card.getByTestId('public-map-card-whole');
  }

  /** The card's parts for each half of a shared table, left then right. */
  get cardHalves(): Locator {
    return this.card.getByTestId('public-map-card-half');
  }

  /** Each vendor's public name on the card. */
  get cardNames(): Locator {
    return this.card.getByTestId('public-map-card-name');
  }

  /** Each vendor's website link on the card. */
  get cardWebsites(): Locator {
    return this.card.getByTestId('public-map-card-website');
  }

  /** Each vendor's Instagram link on the card. */
  get cardInstagrams(): Locator {
    return this.card.getByTestId('public-map-card-instagram');
  }

  /** "Find a vendor", the panel's `SearchPicker` (T465 ticket 06). */
  get search(): Locator {
    return this.page.getByTestId('public-map-find');
  }

  /** The search's field (T465 ticket 06). */
  get searchInput(): Locator {
    return this.page.getByTestId('public-map-find-input');
  }

  /** The search's dropdown list (T465 ticket 06). */
  get searchList(): Locator {
    return this.page.getByTestId('public-map-find-list');
  }

  /** Each vendor the search offers (T465 ticket 06). */
  get searchOptions(): Locator {
    return this.page.getByTestId('public-map-find-option');
  }

  /** The search's "No vendor matches" (T465 ticket 06). */
  get searchNone(): Locator {
    return this.page.getByTestId('public-map-find-none');
  }

  /** The vendor panel. */
  get vendorsPanel(): Locator {
    return this.page.getByTestId('public-map-vendors');
  }

  /** The panel's scrolling list of the day's vendors, a `ScrollBox` (T465 ticket 06). */
  get vendorsList(): Locator {
    return this.page.getByTestId('public-map-vendors-list');
  }

  /** The blurring band at the list's top once it has scrolled (T465 ticket 06). */
  get vendorsFade(): Locator {
    return this.page.getByTestId('public-map-vendors-fade');
  }

  /** Each vendor's row, a button. */
  get vendors(): Locator {
    return this.page.getByTestId('public-map-vendor');
  }

  /** "No vendors are listed for this day yet." */
  get vendorsEmpty(): Locator {
    return this.page.getByTestId('public-map-vendors-empty');
  }

  /** The SVG map's view box, in millimetres of the hall. */
  async view(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = (await this.map.getAttribute('viewBox'))!.split(' ').map(Number);
    return { x: box[0], y: box[1], width: box[2], height: box[3] };
  }
}
