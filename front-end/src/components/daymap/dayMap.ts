/**
 * A day map's data (T422): the public map's answer as the server serves it
 * (`GET /public/markets/:slug/map`), the locations and seats `DayMap.vue` draws, and the helpers
 * that turn the public answer, and Attendance's roster rows, into them. Pure: no store, no API.
 */
import type {
  FloorplanObject,
  SectionObject,
  SectionStyle,
  TableTypeObject,
} from '@/assets/types/datatypes';
import {
  tableCode,
  type DrawnTone,
  type MapSeat,
  type SeatHalf,
  type SeatTone,
} from '@/components/layout/layoutDrawing';
import { HALF_TABLE_LEFT, HALF_TABLE_RIGHT } from '@/utils/placementChange';

// ── The public answer ────────────────────────────────────────────────────────

/** A table of the public map: only a table in a section of its location, with a number. */
export interface PublicMapTable {
  id: string;
  sectionId: string;
  number: number;
  tableTypeId: string;
  xMm: number;
  yMm: number;
  rotation: number;
}

export interface PublicMapZone {
  id: string;
  label: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  rotation: number;
}

export interface PublicMapLayout {
  id: string;
  locationId: string;
  imageWidth: number | null;
  imageHeight: number | null;
  scalePxPerUnit: number | null;
  /** Whether the public image route has an image to serve for the location. */
  hasImage: boolean;
  tables: PublicMapTable[];
  zones: PublicMapZone[];
  sectionStyles: SectionStyle[];
}

export interface PublicMapLocation {
  id: string;
  name: string;
  /** The location's sections, in the plan's order. */
  sections: { id: string; name: string }[];
  layout: PublicMapLayout;
}

/** One vendor's seat on one market date, with only the answers the organizer chose to publish,
 *  each cleaned by the server or null. */
export interface PublicMapSeat {
  date: string;
  tableId: string;
  half: SeatHalf;
  name: string | null;
  website: string | null;
  instagram: string | null;
}

/** The public map's answer, exactly the keys the server sends (its allowlist, D26). */
export interface PublicMapAnswer {
  marketName: string;
  /** The market dates, ISO days, in calendar order. */
  dates: string[];
  tableTypes: TableTypeObject[];
  locations: PublicMapLocation[];
  seats: PublicMapSeat[];
}

// ── What the day map draws ───────────────────────────────────────────────────

/** A location as the day map draws it: its layout, the plan's sections of it, and the address of
 *  its floorplan image, or none. */
export interface DayMapLocation {
  id: string;
  name: string;
  layout: FloorplanObject;
  sections: SectionObject[];
  imageUrl: string;
}

/** One line of the legend under the map: a tone and what it means on this page. */
export interface DayMapLegendItem {
  tone: DrawnTone;
  label: string;
}

/** The public answer's locations as the day map draws them, each image at the address
 *  `imageUrl` gives for its location. */
export function publicDayLocations(
  answer: Pick<PublicMapAnswer, 'locations'>,
  imageUrl: (locationId: string) => string,
): DayMapLocation[] {
  return answer.locations.map((location) => {
    const { layout } = location;
    const place = { id: location.id, name: location.name };
    return {
      id: location.id,
      name: location.name,
      layout: {
        id: layout.id,
        locationId: layout.locationId,
        revision: 0,
        imageWidth: layout.imageWidth,
        imageHeight: layout.imageHeight,
        scalePxPerUnit: layout.scalePxPerUnit,
        tables: layout.tables,
        zones: layout.zones,
        sectionStyles: layout.sectionStyles,
        startingCounts: [],
      },
      sections: location.sections.map((section) => ({
        id: section.id,
        name: section.name,
        location: place,
        tier: null,
        count: 0,
      })),
      imageUrl: layout.hasImage ? imageUrl(location.id) : '',
    };
  });
}

/** What a seat is called to a screen reader where its vendor gave no public name (D27). */
export const UNNAMED_SEAT = 'vendor not listed';

/** The key of a public seat: its table and its half, one seat each on a day. */
export const publicSeatKey = (seat: Pick<PublicMapSeat, 'tableId' | 'half'>) =>
  `${seat.tableId}:${seat.half}`;

/** The public answer's seats of one date, as the map draws them: each taken, filled. */
export function publicSeats(seats: readonly PublicMapSeat[], date: string): MapSeat[] {
  return seats
    .filter((seat) => seat.date === date)
    .map((seat) => ({
      key: publicSeatKey(seat),
      tableId: seat.tableId,
      half: seat.half,
      tone: 'filled',
      name: seat.name ?? UNNAMED_SEAT,
    }));
}

// ── Attendance's roster ──────────────────────────────────────────────────────

/** The fields of an Attendance roster row (`GET /markets/:id/attendance`) the map reads. */
export interface RosterSeatRow {
  date: string;
  vendorEmail: string;
  vendorName: string;
  /** The seat held that day, "Gold row 5"; null for a check-in with no seat. */
  tableCode: string | null;
  /** "Full Table", "Half Table (Left)" or "Half Table (Right)". */
  tableChoice: string | null;
  state: 'expected' | 'here' | 'here_elsewhere' | 'here_without_seat';
  /** When they were checked out that day, or none (T496); a record from before the check-out has
   *  no such key. */
  checkedOutAt?: string | null;
}

/** The half a roster row's seat holds, from the assignment's own spelling. */
function halfOf(tableChoice: string | null): SeatHalf {
  if (tableChoice === HALF_TABLE_LEFT) return 'left';
  if (tableChoice === HALF_TABLE_RIGHT) return 'right';
  return 'whole';
}

/** A roster row's seat tone (D40, T501): checked in and out `checkedOut`, checked in alone, at
 *  their seat or another, `filled`, not checked in `outlined`. */
export function rosterTone(row: Pick<RosterSeatRow, 'state' | 'checkedOutAt'>): SeatTone {
  if (row.state === 'expected') return 'outlined';
  return row.checkedOutAt ? 'checkedOut' : 'filled';
}

/**
 * The roster's seats of one date as the map draws them, each in its `rosterTone`, keyed by the
 * vendor's email, named by their name. A row is
 * matched to a table by the table's code, its section's name and its number, as the server names
 * it (`table_code_for`); a row whose table is on no layout is returned in `notOnALayout`, and a
 * check-in with no seat that day is neither.
 */
export function rosterSeats<Row extends RosterSeatRow>(
  rows: readonly Row[],
  date: string,
  locations: readonly Pick<DayMapLocation, 'layout' | 'sections'>[],
): { seats: MapSeat[]; notOnALayout: Row[] } {
  const tableByCode = new Map<string, string>();
  for (const { layout, sections } of locations) {
    const byId = new Map(sections.map((section) => [section.id, section]));
    for (const table of layout.tables) {
      const code = tableCode(table, table.sectionId ? byId.get(table.sectionId) : null);
      if (code) tableByCode.set(code, table.id);
    }
  }
  const seats: MapSeat[] = [];
  const notOnALayout: Row[] = [];
  for (const row of rows) {
    if (row.date !== date || !row.tableCode || row.state === 'here_without_seat') continue;
    const tableId = tableByCode.get(row.tableCode);
    if (!tableId) {
      notOnALayout.push(row);
      continue;
    }
    seats.push({
      key: row.vendorEmail,
      tableId,
      half: halfOf(row.tableChoice),
      tone: rosterTone(row),
      name: row.vendorName,
    });
  }
  return { seats, notOnALayout };
}
