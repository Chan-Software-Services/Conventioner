/**
 * The public map page, `/<market-slug>/map` (T422): its two reads, the public answer and a
 * location's floorplan image, and what the page makes of the answer. Everything a vendor is shown
 * by comes from the three answers the server cleaned (D28); the links are built here again only
 * from those values, and only as an `http`/`https` address or an Instagram handle, so nothing else
 * can ever become a link.
 */
import { tableCode } from '@/components/layout/layoutDrawing';
import {
  publicSeatKey,
  type PublicMapAnswer,
  type PublicMapSeat,
} from '@/components/daymap/dayMap';
import type { SeatHalf } from '@/components/layout/layoutDrawing';
import { api } from '@/utils/api';
import { APPLICANT_READ_TIMEOUT_MS } from '@/utils/applicantApi';

/**
 * What reading the map found: the answer, none (`notFound`: no market here, or one whose map is
 * not open, which answer alike), or `failed` when the request never answered, which is neither.
 */
export interface PublicMapRead {
  map: PublicMapAnswer | null;
  notFound: boolean;
  failed: boolean;
}

const mapPath = (slug: string) => `/public/markets/${encodeURIComponent(slug)}/map`;

export async function fetchPublicMap(slug: string): Promise<PublicMapRead> {
  try {
    const { data } = await api.get(mapPath(slug), { timeout: APPLICANT_READ_TIMEOUT_MS });
    return { map: data as PublicMapAnswer, notFound: false, failed: false };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    return { map: null, notFound: status === 404, failed: status !== 404 };
  }
}

/**
 * A location's floorplan image, as bytes: the API is another origin in production, and the
 * Content-Security-Policy draws images only from the app and from blobs, so the page draws it from
 * an object URL, as the layout page does.
 */
export async function fetchPublicMapImage(slug: string, locationId: string): Promise<Blob> {
  const { data } = await api.get(`${mapPath(slug)}/image/${encodeURIComponent(locationId)}`, {
    responseType: 'blob',
    timeout: APPLICANT_READ_TIMEOUT_MS,
  });
  return data as Blob;
}

/** What the page says of a vendor with no public name (D27), of a day with no vendor listed, and of
 *  a failed read. */
export const DETAILS_NOT_LISTED = 'A vendor is at this table. Their details are not listed.';
export const NO_VENDORS_LISTED = 'No vendors are listed for this day yet.';
export const MAP_COULD_NOT_LOAD = 'The map could not be loaded.';

export const freeTableOn = (day: string) => `This table is free on ${day}.`;
export const freeHalfOn = (day: string) => `This half is free on ${day}.`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A market date as a day of the calendar, or null for text that is no date. A market date is a
 *  calendar day, so it is read in UTC and never moved by the visitor's timezone (`utils/utils.ts`
 *  says why). */
function calendarDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
}

/** A market date as the card says it: "Wed 18 Nov". */
export function dayInWords(date: string): string {
  const day = calendarDay(date);
  if (!day) return date;
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/** A market date as the day select offers it: "Nov 18". */
export function shortDay(date: string): string {
  const day = calendarDay(date);
  return day ? `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}` : date;
}

/**
 * The day the page opens on (D31): the one asked for when it is a market date, else today when it
 * is one, else the next, else the last; as Attendance chooses its day.
 */
export function openingDate(dates: readonly string[], asked: unknown, today: string): string {
  if (typeof asked === 'string' && dates.includes(asked)) return asked;
  return dates.find((date) => date >= today) ?? dates[dates.length - 1] ?? '';
}

/** A side of a shared table, picked alone (T465). */
export type PickedHalf = 'left' | 'right';

/** Where on the map the page stands: the day, the open location, the table picked or none, and
 *  the half of it picked alone or none. */
export interface MapPlace {
  date: string;
  locationId: string;
  tableId: string | null;
  half: PickedHalf | null;
}

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * The place the address names (`?date=&location=&table=&half=`), every value it does not know
 * falling back to the default without an error: the opening day, the asked table's own location or
 * the first, no pick for a table that is not at the open location, and no half that is not `left`
 * or `right` or that names no picked table. A half is read whatever the day: `shownParts` shows the
 * whole table on a day it is not split.
 */
export function mapPlace(
  map: Pick<PublicMapAnswer, 'dates' | 'locations'>,
  query: Record<string, unknown>,
  today: string,
): MapPlace {
  const askedLocation = asString(query.location);
  const askedTable = asString(query.table);
  const holds = (locationId: string, tableId: string | undefined) =>
    Boolean(tableId) &&
    Boolean(
      map.locations
        .find((location) => location.id === locationId)
        ?.layout.tables.some((table) => table.id === tableId),
    );
  const listed = map.locations.find((location) => location.id === askedLocation);
  const ofTable = map.locations.find((location) => holds(location.id, askedTable));
  const locationId = (listed ?? ofTable ?? map.locations[0])?.id ?? '';
  const tableId = askedTable && holds(locationId, askedTable) ? askedTable : null;
  const askedHalf = asString(query.half);
  return {
    date: openingDate(map.dates, query.date, today),
    locationId,
    tableId,
    half: tableId && (askedHalf === 'left' || askedHalf === 'right') ? askedHalf : null,
  };
}

/** A link the card draws: its address and the words it reads as. */
export interface CardLink {
  href: string;
  text: string;
}

/** A website as a link reading its host, only for an `http` or `https` address. */
export function websiteLink(address: string | null): CardLink | null {
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) return null;
  return { href: url.href, text: url.host };
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** An Instagram handle as a link to its profile, reading "@handle". */
export function instagramLink(handle: string | null): CardLink | null {
  if (!handle || !HANDLE.test(handle)) return null;
  return { href: `https://www.instagram.com/${handle}/`, text: `@${handle}` };
}

/** A table of the map, where it is and what it is called. */
interface MapTable {
  tableId: string;
  code: string;
  locationId: string;
  locationName: string;
}

function mapTables(map: Pick<PublicMapAnswer, 'locations'>): Map<string, MapTable> {
  const tables = new Map<string, MapTable>();
  for (const location of map.locations) {
    const sections = new Map(location.sections.map((section) => [section.id, section]));
    for (const table of location.layout.tables) {
      const code = tableCode(table, sections.get(table.sectionId));
      if (!code || tables.has(table.id)) continue;
      tables.set(table.id, {
        tableId: table.id,
        code,
        locationId: location.id,
        locationName: location.name,
      });
    }
  }
  return tables;
}

/** A named vendor of the day, as the list under the map shows them. */
export interface ListedVendor {
  key: string;
  name: string;
  tableId: string;
  code: string;
  locationId: string;
  locationName: string;
}

/** The day's seats that have a public name, at every location, by name. */
export function mapListing(
  map: Pick<PublicMapAnswer, 'locations' | 'seats'>,
  date: string,
): ListedVendor[] {
  const tables = mapTables(map);
  const listed: ListedVendor[] = [];
  for (const seat of map.seats) {
    const table = tables.get(seat.tableId);
    if (seat.date !== date || !seat.name || !table) continue;
    listed.push({ key: publicSeatKey(seat), name: seat.name, ...table });
  }
  return listed.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** One part of a table on the card: the whole table, or a half, and the seat at it or none. */
export interface CardPart {
  side: SeatHalf;
  seat: PublicMapSeat | null;
}

/** A table's card: its code and its parts, a shared table's left then right. */
export interface TableCard {
  code: string;
  halves: CardPart[];
}

/**
 * What the card says of a table on a day: a whole seat, or a shared table's two halves, left then
 * right, a half with nobody at it free; null for a table the map does not draw. A whole seat wins
 * over halves, and the first seat of a part wins, as the drawing reads them.
 */
export function tableCard(
  map: Pick<PublicMapAnswer, 'locations' | 'seats'>,
  date: string,
  tableId: string,
): TableCard | null {
  const table = mapTables(map).get(tableId);
  if (!table) return null;
  const at = map.seats.filter((seat) => seat.date === date && seat.tableId === tableId);
  const part = (side: SeatHalf) => at.find((seat) => seat.half === side) ?? null;
  const whole = part('whole');
  const split = !whole && at.length > 0;
  return {
    code: table.code,
    halves: split
      ? [
          { side: 'left', seat: part('left') },
          { side: 'right', seat: part('right') },
        ]
      : [{ side: 'whole', seat: whole }],
  };
}

/**
 * The parts of a card shown for the half picked (T465): that half alone when the table is split on
 * the card's day, a half with nobody at it free; else the card as it is, so a half the table is not
 * split into that day (an old link, a day changed) shows the whole table.
 */
export function shownParts(card: TableCard, half: PickedHalf | null): TableCard {
  const part = half ? card.halves.find((h) => h.side === half) : undefined;
  return part ? { ...card, halves: [part] } : card;
}
