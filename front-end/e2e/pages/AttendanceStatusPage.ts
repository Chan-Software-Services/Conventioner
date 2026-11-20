import { marketScreenPath } from '../helpers/marketScreens';
import type { Locator, Page } from '@playwright/test';
import { PersonChooser } from './PersonChooser';

/**
 * Page object for the organizer's Attendance page (/markets/:marketId/attendance): one market date
 * at a time, every vendor expected that day, and who has come (E29/F01).
 */
export class AttendanceStatusPage {
  readonly page: Page;
  readonly summary: Locator;
  readonly rows: Locator;
  /** The list's search, which filters its rows. */
  readonly search: Locator;
  /**
   * The map's search in its place (T466): a search with a dropdown of the day's vendors, by
   * address, a pick opening that vendor's drawer.
   */
  readonly mapSearch: PersonChooser;
  /**
   * The tools pinned under the market's frame at a desk (T466): the toolbar, then the count row of
   * the count, the list's Show buttons and the search.
   */
  readonly tools: Locator;
  readonly toolbar: Locator;
  readonly bar: Locator;
  /** The toolbar's day, and on the map with two locations laid out or more, its location. */
  readonly dateSelect: Locator;
  readonly locationSelect: Locator;
  /** The frame's line saying why the person looking may change nothing, above the door (T15). */
  readonly readOnly: Locator;
  /** "Checked in, with no table on this date (n)", over the rows of vendors here with no seat (T318). */
  readonly unseatedHeading: Locator;
  /** Every row's Check in and Undo, offered only to whoever may check vendors in. */
  readonly checkIns: Locator;
  readonly undos: Locator;
  /** Every checked-in row's Check out, and every checked-out row's Undo of it (T496). */
  readonly checkOuts: Locator;
  readonly checkOutUndos: Locator;
  /**
   * When the roster was last read, over the list (on the map it is the day map's note), Refresh,
   * and the line a failed re-read leaves under the toolbar's end (T318, T466).
   */
  readonly updated: Locator;
  readonly refresh: Locator;
  readonly refreshError: Locator;
  /** "Print roster" and the sheet it prints (T318). */
  readonly print: Locator;
  readonly printSheet: Locator;
  readonly printRows: Locator;
  /** "Door code", offered in Market Days to whoever may check vendors in (ADR 0022). */
  readonly doorCodeButton: Locator;
  /** The door code's full-screen view, and what it shows. */
  readonly doorCode: Locator;
  readonly doorCodeScroller: Locator;
  readonly doorCodeMade: Locator;
  readonly doorCodeMarket: Locator;
  readonly doorCodeValue: Locator;
  /** "Scan with your phone's camera to check in or out". */
  readonly doorCodeInstruction: Locator;
  /** The QR code, an SVG whose `data-url` is the address it encodes. */
  readonly doorCodeQr: Locator;
  readonly doorCodeMake: Locator;
  readonly doorCodePrint: Locator;
  readonly doorCodeNew: Locator;
  readonly doorCodeClose: Locator;
  readonly newCodeConfirm: Locator;
  readonly newCodeConfirmButton: Locator;
  readonly newCodeCancel: Locator;
  /** "List" and "Map" in the toolbar (T422): the roster as its list, or as the open day's map. */
  readonly viewList: Locator;
  readonly viewMap: Locator;
  /** The map of the open day, its drawing, its legend's lines and the line a free table leaves. */
  readonly dayMap: Locator;
  /** The day map's box, its border round the drawing. */
  readonly mapFrame: Locator;
  readonly map: Locator;
  readonly legend: Locator;
  readonly mapNote: Locator;
  /** "<n> checked in with no table" and "<n> vendors are at tables not on a layout.", under the
   *  map. */
  readonly mapUnseated: Locator;
  readonly mapOffLayout: Locator;
  /** "No location has a layout yet.", where nothing is laid out. */
  readonly mapNone: Locator;
  /** The open location's floorplan image, drawn under its tables (T501). */
  readonly mapImage: Locator;
  /** "Loading the floorplan..." once the tables stand on the floor without it, and the line saying
   *  it could not be loaded (T501). */
  readonly mapImageLoading: Locator;
  readonly mapImageFailed: Locator;
  /**
   * The vendor drawer, the address it is open on, and its close. The panel stays in the page when
   * closed, slid out and `aria-hidden`, so whether it is open is read off that attribute.
   */
  readonly drawer: Locator;
  readonly drawerEmail: Locator;
  readonly drawerClose: Locator;

  constructor(page: Page) {
    this.page = page;
    this.summary = page.getByTestId('attendance-summary');
    this.rows = page.getByTestId('attendance-row');
    this.search = page.getByTestId('attendance-search');
    this.mapSearch = new PersonChooser(page, 'attendance-map-search');
    this.tools = page.getByTestId('attendance-tools');
    this.toolbar = page.getByTestId('attendance-toolbar');
    this.bar = page.getByTestId('attendance-bar');
    this.dateSelect = page.getByTestId('attendance-date-select');
    this.locationSelect = page.getByTestId('attendance-location-select');
    this.unseatedHeading = page.getByTestId('attendance-unseated-heading');
    this.readOnly = page.getByTestId('market-read-only');
    this.checkIns = page.getByTestId('attendance-check-in');
    this.undos = page.getByTestId('attendance-undo');
    this.checkOuts = page.getByTestId('attendance-check-out');
    this.checkOutUndos = page.getByTestId('attendance-undo-check-out');
    this.updated = page.getByTestId('attendance-updated');
    this.refresh = page.getByTestId('attendance-refresh');
    this.refreshError = page.getByTestId('attendance-refresh-error');
    this.print = page.getByTestId('attendance-print');
    this.printSheet = page.getByTestId('attendance-print-sheet');
    this.printRows = page.getByTestId('attendance-print-row');
    this.doorCodeButton = page.getByTestId('attendance-door-code');
    this.doorCode = page.getByTestId('door-code');
    this.doorCodeScroller = page.getByTestId('door-code-scroll');
    this.doorCodeMade = page.getByTestId('door-code-made');
    this.doorCodeMarket = page.getByTestId('door-code-market');
    this.doorCodeValue = page.getByTestId('door-code-value');
    this.doorCodeInstruction = page.getByTestId('door-code-instruction');
    this.doorCodeQr = page.getByTestId('door-code-qr');
    this.doorCodeMake = page.getByTestId('door-code-make');
    this.doorCodePrint = page.getByTestId('door-code-print');
    this.doorCodeNew = page.getByTestId('door-code-new');
    this.doorCodeClose = page.getByTestId('door-code-close');
    this.newCodeConfirm = page.getByTestId('door-code-new-confirm-window');
    this.newCodeConfirmButton = page.getByTestId('door-code-new-confirm-submit-button');
    this.newCodeCancel = page.getByTestId('door-code-new-confirm-cancel-button');
    this.viewList = page.getByTestId('attendance-view-list');
    this.viewMap = page.getByTestId('attendance-view-map');
    this.dayMap = page.getByTestId('attendance-map');
    this.mapFrame = this.dayMap.getByTestId('day-map-frame');
    this.map = this.dayMap.getByTestId('layout-map');
    this.legend = this.dayMap.getByTestId('day-map-legend-item');
    this.mapNote = page.getByTestId('attendance-map-note');
    this.mapUnseated = page.getByTestId('attendance-map-unseated');
    this.mapOffLayout = page.getByTestId('attendance-map-off-layout');
    this.mapNone = page.getByTestId('attendance-map-none');
    this.mapImage = this.map.getByTestId('layout-map-image');
    this.mapImageLoading = page.getByTestId('attendance-map-image-loading');
    this.mapImageFailed = page.getByTestId('attendance-map-image-failed');
    this.drawer = page.getByTestId('vendors-detail-panel');
    this.drawerEmail = page.getByTestId('vendors-detail-email');
    this.drawerClose = page.getByTestId('vendors-detail-close');
  }

  /**
   * A table of the open location on the map, or one half of a shared table, by the start of its
   * accessible name ("Aisle A 3, Standard 6 ft, left half, Loom House"), as a screen reader hears it.
   */
  mapTable(code: string, half?: 'left' | 'right'): Locator {
    const name = half ? `${code}, Standard 6 ft, ${half} half` : `${code}, Standard 6 ft`;
    return this.map.getByRole('button', { name });
  }

  /**
   * How a table, or a half, is drawn: `filled` in its section's colour (checked in), `checkedOut`
   * in its section's darker out shade (checked out, T501), `outlined` on white (not checked in) or
   * `free` on the floor's colour (no vendor), read off its top's paint.
   */
  async tone(
    code: string,
    half?: 'left' | 'right',
  ): Promise<'filled' | 'checkedOut' | 'outlined' | 'free'> {
    const target = this.mapTable(code, half);
    const shape = half
      ? target.locator('path').first()
      : target.getByTestId('layout-table-top').first();
    const fill = (await shape.getAttribute('fill')) ?? '';
    if (fill === 'white') return 'outlined';
    if (fill.includes('layout-floor')) return 'free';
    if (/-out\)$/.test(fill)) return 'checkedOut';
    return 'filled';
  }

  doorCodeShade(edge: 'top' | 'bottom'): Locator {
    return this.page.getByTestId(`door-code-scroll-shade-${edge}`);
  }

  async goto(marketId: string): Promise<void> {
    await this.page.goto(marketScreenPath(marketId, 'attendance'));
  }

  /** One vendor's row on the date shown. */
  row(vendorEmail: string): Locator {
    return this.page.locator(`[data-testid="attendance-row"][data-vendor="${vendorEmail}"]`);
  }

  /**
   * "Not yet" ("Did not come" once the day is over), or when they checked in and who made it, and,
   * for a check-in made at another table than the one they hold now, which (T318).
   */
  status(vendorEmail: string): Locator {
    return this.row(vendorEmail).getByTestId('attendance-row-status');
  }

  /**
   * On a checked-out row, after its status: when they were checked out and who made it, "Out 4:05 PM
   * by you" or, for the vendor's own, "Scanned out at 4:05 PM" (T496).
   */
  out(vendorEmail: string): Locator {
    return this.row(vendorEmail).getByTestId('attendance-row-out');
  }

  /** A row's Check in, Check out, Undo of the check-in or Undo of the check-out, by its test id. */
  action(
    vendorEmail: string,
    which: 'check-in' | 'undo' | 'check-out' | 'undo-check-out',
  ): Locator {
    return this.row(vendorEmail).getByTestId(`attendance-${which}`);
  }

  /** Where a vendor sits on the date shown, "Table ..." or "No table" (T318). */
  table(vendorEmail: string): Locator {
    return this.row(vendorEmail).getByTestId('attendance-row-table');
  }

  /** A vendor's name on their row, which opens their drawer (E35/F01/S02). */
  vendor(vendorEmail: string): Locator {
    return this.row(vendorEmail).getByTestId('attendance-vendor');
  }

  async show(which: 'all' | 'not-yet' | 'here'): Promise<void> {
    await this.page.getByTestId(`attendance-show-${which}`).click();
  }

  async checkIn(vendorEmail: string): Promise<void> {
    await this.row(vendorEmail).getByTestId('attendance-check-in').click();
  }

  async undo(vendorEmail: string): Promise<void> {
    await this.row(vendorEmail).getByTestId('attendance-undo').click();
  }
}
