/**
 * The public map's vendor search, "Find a vendor" (T465): each named vendor of the day as an entry
 * of public fields alone, and what a visitor's words find among them.
 *
 * The browser holds only what the server's allowlist sends (D26), and the server's own test is the
 * first guard. This is the second: an entry is built by naming each field it copies, never by
 * spreading a seat, so a key a server fault let through is never copied, and never searched by. A
 * vendor's email address, full name and preferred name never find them here.
 */
import { publicSeatKey, type PublicMapAnswer } from '@/components/daymap/dayMap';
import { instagramLink, mapListing, websiteLink } from '@/utils/publicMap';

/** A named vendor of the day, as the search knows them: exactly these nine public fields. */
export interface PublicVendorEntry {
  /** The seat's key (`publicSeatKey`), one seat each on a day. */
  key: string;
  /** The public name. */
  name: string;
  tableId: string;
  /** The table's code, "A 13". */
  code: string;
  locationId: string;
  locationName: string;
  /** The table's section, as the organizer named it; null for a table in none. */
  sectionName: string | null;
  /** The website's host, as the card shows it; null with no website, or none the card would link. */
  website: string | null;
  /** The Instagram handle, without its "@"; null with none, or none the card would link. */
  instagram: string | null;
}

/** Each named vendor of the day, at every location, by name, as `mapListing` lists them. */
export function publicVendorEntries(
  map: Pick<PublicMapAnswer, 'locations' | 'seats'>,
  date: string,
): PublicVendorEntry[] {
  const seats = new Map(
    map.seats.filter((seat) => seat.date === date).map((seat) => [publicSeatKey(seat), seat]),
  );
  const sections = new Map<string, string>();
  for (const location of map.locations) {
    const names = new Map(location.sections.map((section) => [section.id, section.name]));
    for (const table of location.layout.tables) {
      const name = names.get(table.sectionId);
      if (name !== undefined && !sections.has(table.id)) sections.set(table.id, name);
    }
  }
  return mapListing(map, date).map((vendor) => {
    const seat = seats.get(vendor.key);
    const instagram = instagramLink(seat?.instagram ?? null) ? seat!.instagram : null;
    return {
      key: vendor.key,
      name: vendor.name,
      tableId: vendor.tableId,
      code: vendor.code,
      locationId: vendor.locationId,
      locationName: vendor.locationName,
      sectionName: sections.get(vendor.tableId) ?? null,
      website: websiteLink(seat?.website ?? null)?.text ?? null,
      instagram,
    };
  });
}

/** Words as the search compares them, the field's as the visitor's: trimmed, lower-cased, each run
 *  of spaces made one. */
const plain = (words: string) => words.trim().toLowerCase().replace(/\s+/g, ' ');
const spaceless = (words: string) => words.replace(/\s/g, '');

/**
 * Whether the words find a vendor: no words find every vendor; else they are inside the public
 * name, the website's host, the handle (a leading "@" dropped from the words), the table code
 * (also with the spaces of both taken out, so "a13" finds "A 13"), or the section name.
 */
export function findsVendor(entry: PublicVendorEntry, words: string): boolean {
  const asked = plain(words);
  if (!asked) return true;
  const inside = (field: string | null, what = asked) =>
    Boolean(field) && Boolean(what) && plain(field!).includes(what);
  return (
    inside(entry.name) ||
    inside(entry.website) ||
    inside(entry.instagram, asked.replace(/^@/, '')) ||
    inside(entry.code) ||
    inside(spaceless(entry.code), spaceless(asked)) ||
    inside(entry.sectionName)
  );
}
