<script lang="ts">
/**
 * How often the roster reads itself again while the page is in view (T318): the door's question is
 * "who is here now", so more often than the review lists' half minute. At the real size, about 200
 * seats across a market's days, a read is about 55 KB.
 */
export const REREAD_MS = 15_000;
</script>

<script setup lang="ts">
/**
 * The door on market day (E29/F01): one market date at a time, every vendor the assignment places
 * that day, who has come and who has not - and, for an editor, a check-in of their own.
 *
 * It listed only the vendors who had checked in, by email, with a column per date someone did, so
 * on a day of 80 vendors the organizer at the door could not say who was missing (known gap 3).
 * The roster is served off the stored assignment, the same rows check-in records against.
 *
 * Laptop first, and it must work on a phone: the door is sometimes a person standing up.
 *
 * In Market Days, whoever may check vendors in opens the door code here, full screen, for the
 * device that stands at the entrance or a printed poster (ADR 0022).
 *
 * The roster stays fresh by itself (T318): a vendor who scans themselves in, or a second
 * organizer's check-in, shows within `REREAD_MS` with no tap, and at once when the tab comes back
 * into view or the browser comes back online.
 *
 * Each row says where its vendor stands (T318), as the server serves it: expected, here, here at
 * another table than the one they hold now, or here with no table that day, listed under the
 * day's seats so a free never hides an arrival. The tally and the toggles count seats only, as the
 * Stats tab does. Check in is offered on today and past days, never on a day to come.
 *
 * A vendor checked in is checked out on the same row, and that undone (T496): the row keeps its
 * status and says beside it when they were checked out and by whom. Nothing else on the page reads
 * a check-out, so a vendor who left still came.
 *
 * A paper roster is the door's fallback when the venue's network or the back end fails (T318):
 * "Print roster" prints every vendor of the chosen date by table, whatever the filters on screen
 * say (`DoorRosterPrint`).
 *
 * Its tools are one toolbar and a count row, pinned under the market's frame at a desk (T466,
 * release walk F5): the date and, on the map, the location as selects, List and Map, the paper
 * tools and Refresh last, in the markup's order, which is the Tab order; then the count, the list's
 * filters and the search. When the roster was read stands over the list, or under the map.
 *
 * On the map the search finds one vendor of the day and picking them opens their drawer, so the
 * map outlines their seat, on their location when it is the other one (T466, release walk F3);
 * typing alone outlines nothing. On the list the search filters the rows.
 */
import { MarketAction, mayTake } from '@/utils/marketActions';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, getApiErrorMessage } from '@/utils/api';
import { MarketPhase } from '@/assets/types/datatypes';
import { getShortDate, getTimestampTime } from '@/utils/utils';
import { tableInWords } from '@/utils/placementChange';
import { vendorMatches, type VendorNames } from '@/utils/vendorIdentity';
import MarketFrame from '@/components/MarketFrame.vue';
import SearchPicker, { type PickerGroup, type PickerOption } from '@/components/SearchPicker.vue';
import VendorDrawer from '@/components/VendorDrawer.vue';
import AttendanceMap from '@/components/attendance/AttendanceMap.vue';
import { laidOutLocations, openLocationId } from '@/components/attendance/laidOutLocations';
import { rosterSeats } from '@/components/daymap/dayMap';
import { PEOPLE_CAP } from '@/utils/personChoice';
import PinnedTools from '@/components/PinnedTools.vue';
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue';
import ToolGroup from '@/components/ToolGroup.vue';
import ToolRow from '@/components/ToolRow.vue';
import VendorNameButton from '@/components/VendorNameButton.vue';
import VendorNotes from '@/components/VendorNotes.vue';
import ListFreshness from '@/components/ListFreshness.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import DoorCodeScreen from '@/components/DoorCodeScreen.vue';
import DoorRosterPrint, { type PrintedRow } from '@/components/DoorRosterPrint.vue';
import { offersDoorCode } from '@/utils/doorCode';
import { useVendorDetails } from '@/utils/vendorDetails';
import { useVendorDrawer } from '@/utils/vendorDrawer';
import { useVendorNotes } from '@/utils/vendorNotes';
import { calendarToday } from '@/utils/marketGuide';
import { useOpenMarket } from '@/utils/openMarket';
import { signedInEmail } from '@/utils/signedIn';
import { withoutQueryKey } from '@/utils/routeQuery';
import { useServerRead } from '@/utils/useServerRead';
import { useUpdatedWords } from '@/utils/useUpdatedWords';

/**
 * Where a vendor stands at the door on a date: a seat and no check-in (`expected`), a check-in made
 * at the seat they hold (`here`), one made at another table (`here_elsewhere`), or a check-in and no
 * seat that day (`here_without_seat`).
 */
type RosterState = 'expected' | 'here' | 'here_elsewhere' | 'here_without_seat';

interface RosterRow {
  date: string;
  vendorEmail: string;
  vendorName: string;
  /** The name on their identification, which both searches find as well (T466). */
  vendorFullName?: string;
  /** The seat held that day; null on a `here_without_seat` row. */
  tableCode: string | null;
  tableChoice: string | null;
  section: string | null;
  location: string | null;
  state: RosterState;
  /** The table the check-in was made at, or null with none. */
  checkedInTableCode: string | null;
  checkedInAt: string | null;
  checkedInBy: string | null;
  /** How a vendor checked themselves in: `door_code`, on their vendor page (ADR 0022). */
  checkedInVia?: string | null;
  /** When they were checked out, by which organizer (null for the vendor's own) and, for the
   *  vendor's own, how: `door_code`. A record from before the check-out has none (T496). */
  checkedOutAt?: string | null;
  checkedOutBy?: string | null;
  checkedOutVia?: string | null;
}

/** The door's four writes, each on a row: a check-in, a check-out, and the undo of either. */
type DoorWrite = 'check-in' | 'undo-check-in' | 'check-out' | 'undo-check-out';

/** What a write the server refused says when the server gave no sentence of its own. */
const NOT_WRITTEN: Record<DoorWrite, string> = {
  'check-in': 'That check-in was not recorded.',
  'undo-check-in': 'That check-in was not undone.',
  'check-out': 'That check-out was not recorded.',
  'undo-check-out': 'That check-out was not undone.',
};

type Show = 'all' | 'not-yet' | 'here';

interface Roster {
  dates: string[];
  roster: RosterRow[];
}

const route = useRoute();
const router = useRouter();

const marketId = computed(() => String(route.params.marketId ?? ''));
const { market } = useOpenMarket(marketId);

/**
 * The roster of the market open, read through one keyed read (T277 ticket 11): moved to another
 * market, the page says it is loading at once, never the last market's rows, and nothing the last
 * market's reads or writes answer lands. Before the first read lands, a failure is the page that
 * could not be read, with Try again (E38/F11/S01); after it, a failure keeps the rows and says they
 * are old, and goes on saying so while the next re-read is out.
 */
const rosterRead = useServerRead<string, Roster>(
  () => marketId.value || null,
  (id) =>
    api
      .get<Partial<Roster>>(`/markets/${encodeURIComponent(id)}/attendance`, {
        timeout: REREAD_MS,
      })
      .then(({ data }) => ({ dates: data.dates ?? [], roster: data.roster ?? [] })),
  {
    failure: 'Attendance could not be loaded.',
    refreshFailure: 'Could not update. The roster is as it was last read.',
  },
);
const dates = computed(() => rosterRead.data.value?.dates ?? []);
const roster = computed(() => rosterRead.data.value?.roster ?? []);
/** When the roster was last read from the server, in milliseconds, or null before the first. */
const readAt = rosterRead.readAt;
/** "Updated just now", ageing: over the list, or under the map as its note. */
const updatedWords = useUpdatedWords(readAt);
const wasRead = computed(() => rosterRead.data.value !== null);
/** The open market's failed first read, kept through the clock's quiet re-reads until one lands. */
const firstFailure = ref<{ key: string; sentence: string } | null>(null);
watch(
  [rosterRead.phase, rosterRead.sentence],
  ([phase, sentence]) => {
    if (phase === 'failed' && rosterRead.key.value)
      firstFailure.value = { key: rosterRead.key.value, sentence };
    else if (phase !== 'loading') firstFailure.value = null;
  },
  { flush: 'sync' },
);
/** The first read failed: the page that could not be read, with Try again. */
const readError = computed(() => {
  if (rosterRead.phase.value === 'failed') return rosterRead.sentence.value;
  const kept = firstFailure.value;
  return rosterRead.phase.value === 'loading' && kept?.key === rosterRead.key.value
    ? kept.sentence
    : '';
});
const isLoading = computed(() => rosterRead.phase.value === 'loading' && !readError.value);
/** A roster with dates to show, under the pinned tools. */
const hasRoster = computed(() => !isLoading.value && dates.value.length > 0);
/** A Refresh, or the clock's re-read, in flight, so Refresh cannot be pressed twice. */
const refreshing = computed(() => rosterRead.phase.value === 'refreshing');
/** A re-read that failed: the rows stay, and this says they are old. */
const refreshError = computed(() =>
  rosterRead.phase.value === 'refresh_failed' || rosterRead.phase.value === 'refreshing'
    ? rosterRead.sentence.value
    : '',
);
/** The last write's refusal, with the market it was made on: said only while that market is open. */
const refusal = ref<{ key: string; sentence: string } | null>(null);
const errorMessage = computed(() =>
  refusal.value && refusal.value.key === rosterRead.key.value ? refusal.value.sentence : '',
);
// Moved to another market, the refusal is forgotten, so coming back to the market it was made on
// never says it again. A reset of what the page shows, never a read: the roster's read is keyed.
watch(
  rosterRead.key,
  () => {
    refusal.value = null;
    firstFailure.value = null;
  },
  { flush: 'sync' },
);
const show = ref<Show>('all');
const search = ref('');
/**
 * The rows whose write is in flight, each held busy on its own, so a queue at the door moves: taps
 * on several rows all go through. Each is held by the market it was made on as well as its date
 * and vendor, so a write still out on the last market holds no row of this one. Replaced on each
 * change, so Vue sees it.
 */
const busyRows = ref<ReadonlySet<string>>(new Set());

/**
 * The date the page opens on: today when it is a market date, else the next one, else the last -
 * the door means today, and before the market the first day is the one being prepared for.
 */
const selectedDate = computed(() => {
  const asked = String(route.query.date ?? '');
  if (dates.value.includes(asked)) return asked;
  const today = calendarToday();
  return dates.value.find((d) => d >= today) ?? dates.value[dates.value.length - 1] ?? '';
});

function chooseDate(date: string) {
  void router.replace({ query: { ...route.query, date } });
}

/** The locations the map can draw, by the rule the map reads, so the select offers no other. */
const laidOut = computed(() => laidOutLocations(market.value?.setupObject));
/** The map's open location: the address's, else the first laid out. */
const locationId = computed(() =>
  openLocationId(laidOut.value, String(route.query.location ?? '')),
);

function chooseLocation(location: string) {
  void router.replace({ query: { ...route.query, location } });
}

/**
 * The roster as a list, today's page, or as a map of the open day (T422, D38): the page's own
 * state, in the address as `view=map`, replaced, so a change of day and a reload keep it.
 */
type View = 'list' | 'map';
const VIEWS: readonly SegmentedOption[] = [
  { id: 'list', label: 'List' },
  { id: 'map', label: 'Map' },
];
const view = computed<View>(() => (route.query.view === 'map' ? 'map' : 'list'));

function chooseView(next: View) {
  const query = withoutQueryKey(route.query, 'view');
  void router.replace({ query: next === 'map' ? { ...query, view: 'map' } : query });
}

/** The map's "Show in the list": the list with every vendor the map counted under it shown, so
 *  the Show toggle, hidden on Map, hides none of them. */
function showListFromMap() {
  show.value = 'all';
  chooseView('list');
}

const signedInAs = computed(() => (signedInEmail() ?? '').toLowerCase());

const names = computed<VendorNames>(() => {
  const out: Record<string, string> = {};
  for (const row of roster.value) if (row.vendorName) out[row.vendorEmail] = row.vendorName;
  return out;
});
/** The name on each vendor's identification, which a search finds too, as on Vendors (T466). */
const fullNames = computed<VendorNames>(() => {
  const out: Record<string, string> = {};
  for (const row of roster.value) if (row.vendorFullName) out[row.vendorEmail] = row.vendorFullName;
  return out;
});

/** Whoever the table lets check vendors in may, while the market is running; the server is the
 *  authority. */
const canCheckIn = computed(
  () =>
    market.value?.phase === MarketPhase.MarketDays && mayTake(market.value, MarketAction.CheckIn),
);

/** The door code's screen, offered on the same answer as a check-in. */
const offersTheDoorCode = computed(() => offersDoorCode(market.value));
const showingDoorCode = ref(false);

function hasSeat(row: RosterRow): boolean {
  return row.state !== 'here_without_seat';
}

/** The chosen date's seats, and those checked in: a vendor here with no table that day is not
 *  counted. */
const today = computed(() => {
  const day = roster.value.filter((row) => row.date === selectedDate.value && hasSeat(row));
  return { expected: day.length, here: day.filter((row) => row.checkedInAt).length };
});

/**
 * Whether the chosen day is over: it has passed, or the market is archived. A vendor who never
 * checked in then did not come, and "Not yet" said otherwise of every one of them (E30/F01/S02).
 */
const dayIsOver = computed(
  () =>
    market.value?.phase === MarketPhase.Archived ||
    (!!selectedDate.value && selectedDate.value < calendarToday()),
);
const notHere = computed(() => (dayIsOver.value ? 'Did not come' : 'Not yet'));

/** Check in is offered on today and past days: a mis-tapped day to come is not an arrival. */
const checkInOpen = computed(() => !!selectedDate.value && selectedDate.value <= calendarToday());

const shownToday = computed(() => {
  const term = search.value.trim().toLowerCase();
  return roster.value.filter((row) => {
    if (row.date !== selectedDate.value) return false;
    if (show.value === 'not-yet' && row.checkedInAt) return false;
    if (show.value === 'here' && !row.checkedInAt) return false;
    if (!term) return true;
    if ((row.tableCode ?? '').toLowerCase().includes(term)) return true;
    return vendorMatches(term, row.vendorEmail, names.value, fullNames.value);
  });
});
const shown = computed(() => shownToday.value.filter(hasSeat));
/** Checked in on the chosen date with no table that day, under the seats, by the same filters. */
const shownWithoutSeat = computed(() => shownToday.value.filter((row) => !hasSeat(row)));
const withoutSeatToday = computed(
  () => roster.value.filter((row) => row.date === selectedDate.value && !hasSeat(row)).length,
);
const unseatedHeading = computed(
  () => `Checked in, with no table on this date (${withoutSeatToday.value})`,
);

/** The seats, then who is here with none, under a heading of its own. */
const lists = computed(() =>
  [
    { key: 'seated', heading: '', rows: shown.value },
    { key: 'unseated', heading: unseatedHeading.value, rows: shownWithoutSeat.value },
  ].filter((list) => list.rows.length > 0),
);

/**
 * The chosen date's every row for the printed roster, whatever the Show toggle and the search say:
 * paper with a filter on would leave the door without the vendors it hid.
 */
function printedRow(row: RosterRow): PrintedRow {
  return {
    key: rowKey(row),
    email: row.vendorEmail,
    name: row.vendorName,
    table: whereTheySit(row),
    here: row.checkedInAt ? status(row) : null,
  };
}
/** The chosen date's every row: seated, and here with no table. */
const dayRows = computed(() => roster.value.filter((row) => row.date === selectedDate.value));
const printedSeated = computed(() => dayRows.value.filter(hasSeat).map(printedRow));
const printedUnseated = computed(() =>
  dayRows.value.filter((row) => !hasSeat(row)).map(printedRow),
);

/**
 * The map's search (T466, release walk F3): every vendor of the chosen date, one row each, named as
 * their row is and saying where they sit, so two like names are told apart.
 */
const mapSearchGroups = computed<PickerGroup[]>(() => [
  {
    options: dayRows.value.map((row) => ({
      value: row.vendorEmail,
      label: row.vendorName || row.vendorEmail,
      address: !row.vendorName,
      detail: whereTheySit(row),
    })),
  },
]);
const dayRowByEmail = computed(() => new Map(dayRows.value.map((row) => [row.vendorEmail, row])));

/**
 * The list search's own terms: the table, the name they go by, the one on their identification and
 * their address.
 */
function findsOnMap(option: PickerOption, words: string): boolean {
  const term = words.toLowerCase();
  const tableCode = dayRowByEmail.value.get(option.value)?.tableCode ?? '';
  return (
    tableCode.toLowerCase().includes(term) ||
    vendorMatches(term, option.value, names.value, fullNames.value)
  );
}

/**
 * A vendor picked on the map opens their drawer, as a press on their table does, so the map
 * outlines their seat. A seat on the other laid-out location moves the map there first, replacing
 * the address's location before the drawer takes its own step, so Back closes the drawer and leaves
 * the map where the vendor sits. A vendor with no seat the map draws opens with nothing outlined.
 */
async function pickOnMap(email: string): Promise<void> {
  if (!email) return;
  const seat = rosterSeats(roster.value, selectedDate.value, laidOut.value).seats.find(
    (each) => each.key === email,
  );
  const location = seat
    ? laidOut.value.find((each) => each.layout.tables.some((one) => one.id === seat.tableId))?.id
    : undefined;
  if (location && location !== locationId.value) {
    await router.replace({ query: { ...route.query, location } });
  }
  drawer.open(email);
}

function printRoster(): void {
  window.print();
}

function status(row: RosterRow): string {
  if (!row.checkedInAt) return notHere.value;
  const at = getTimestampTime(row.checkedInAt);
  const arrived = arrival(row, at);
  // Here, but at a table they no longer hold: say which, so they are sent to their new one. The
  // table is one unbreakable run ("table Hall B 12"), so a narrow chip or the paper's column never
  // leaves its last word on a line alone.
  if (row.state === 'here_elsewhere') {
    return `${arrived}, at ${`table ${row.checkedInTableCode}`.replaceAll(' ', '\u00a0')}`;
  }
  return arrived;
}

function arrival(row: RosterRow, at: string): string {
  // The vendor's own, with the door code they scanned or typed at the entrance.
  if (row.checkedInVia === 'door_code') return `Scanned in at ${at}`;
  if (!row.checkedInBy) return at;
  return `${at} by ${byWhom(row.checkedInBy)}`;
}

/** The organizer who made a check-in or a check-out: "you" to themselves. */
function byWhom(organizer: string): string {
  return organizer.toLowerCase() === signedInAs.value ? 'you' : organizer;
}

/** When a checked-out vendor was checked out and by whom, in a chip of its own after the status. */
function departure(row: RosterRow): string {
  if (!row.checkedOutAt) return '';
  const at = getTimestampTime(row.checkedOutAt);
  // The vendor's own, with the door code, on their vendor page.
  if (row.checkedOutVia === 'door_code') return `Scanned out at ${at}`;
  return row.checkedOutBy ? `Out ${at} by ${byWhom(row.checkedOutBy)}` : `Out ${at}`;
}

/** Here at the seat they hold reads positive; anything else asks the door's attention. */
function statusTone(row: RosterRow): string {
  return row.state === 'here' ? 'chip--positive' : 'chip--attention';
}

function whereTheySit(row: RosterRow): string {
  return row.tableCode ? `Table ${tableInWords(row.tableCode, row.tableChoice ?? '')}` : 'No table';
}

function rowKey(row: RosterRow): string {
  return `${row.date}|${row.vendorEmail}`;
}

function whoFor(row: RosterRow): string {
  return row.vendorName || row.vendorEmail;
}

/** Try again after the first read failed, and Refresh: a read at once, which keeps the rows if it
 *  fails once they were read. */
function retry(): void {
  firstFailure.value = null;
  void rosterRead.reread();
}

/**
 * Read again every `REREAD_MS` while the page is in view, and at once when it comes back into view
 * or the browser comes back online, so "who is missing" is true when it is asked. Hidden, it reads
 * nothing: a phone in a pocket spends no battery or data on it.
 */
let rereading: ReturnType<typeof setInterval> | null = null;
function tick(): void {
  if (document.visibilityState !== 'visible') return;
  if (rosterRead.phase.value === 'loading' || refreshing.value) return;
  void rosterRead.reread();
}
function backInView(): void {
  if (document.visibilityState === 'visible') void rosterRead.reread();
}
onMounted(() => {
  rereading = setInterval(tick, REREAD_MS);
  document.addEventListener('visibilitychange', backInView);
  window.addEventListener('online', backInView);
});
onUnmounted(() => {
  if (rereading) clearInterval(rereading);
  document.removeEventListener('visibilitychange', backInView);
  window.removeEventListener('online', backInView);
});

function busyKey(forMarket: string, row: RosterRow): string {
  return `${forMarket}|${rowKey(row)}`;
}

function isBusy(row: RosterRow): boolean {
  return busyRows.value.has(busyKey(marketId.value, row));
}

function holdBusy(key: string, busy: boolean): void {
  const rows = new Set(busyRows.value);
  if (busy) rows.add(key);
  else rows.delete(key);
  busyRows.value = rows;
}

/**
 * The row shows the server's answer at once, and a re-read follows: a slow re-read never leaves
 * the organizer wondering whether it worked. The write is held on the market whose roster the row
 * came from, and posts there only: no read asked before it lands, so none undoes it, and an answer
 * after the organizer moved to another market says nothing there. A check-in is here at the seat
 * the row holds; an undo leaves a seat expected, and a row with no seat has nothing left to show.
 * A check-out is the signed-in organizer's at the time the server answered, and its undo clears
 * it, the row otherwise as it was (T496).
 */
async function write(row: RosterRow, what: DoorWrite) {
  const forMarket = rosterRead.key.value;
  if (!forMarket) return;
  const busy = busyKey(forMarket, row);
  holdBusy(busy, true);
  refusal.value = null;
  const key = rowKey(row);
  const body = { vendorEmail: row.vendorEmail, date: row.date };
  const outcome = await rosterRead.holdWhile(async (id) => {
    const checkIn = `/markets/${encodeURIComponent(id)}/attendance`;
    const checkOut = `${checkIn}/check-out`;
    let answered: Partial<RosterRow>;
    if (what === 'check-in') {
      const { data } = await api.post<{ checkedInAt: string }>(checkIn, body);
      answered = {
        state: 'here',
        checkedInTableCode: row.tableCode,
        checkedInAt: data.checkedInAt,
        checkedInBy: signedInEmail(),
        checkedInVia: null,
      };
    } else if (what === 'undo-check-in') {
      await api.delete(checkIn, { data: body });
      answered = {
        state: 'expected',
        checkedInTableCode: null,
        checkedInAt: null,
        checkedInBy: null,
        checkedInVia: null,
      };
    } else if (what === 'check-out') {
      const { data } = await api.post<{ checkedOutAt: string }>(checkOut, body);
      answered = {
        checkedOutAt: data.checkedOutAt,
        checkedOutBy: signedInEmail(),
        checkedOutVia: null,
      };
    } else {
      await api.delete(checkOut, { data: body });
      answered = { checkedOutAt: null, checkedOutBy: null, checkedOutVia: null };
    }
    // Taken while the write still holds the market, so the re-read its end asks is the only one.
    rosterRead.adopt(id, (held) => ({
      ...held,
      roster: held.roster.flatMap((one) => {
        if (rowKey(one) !== key) return [one];
        if (!hasSeat(one) && what === 'undo-check-in') return [];
        return [{ ...one, ...answered }];
      }),
    }));
  });
  holdBusy(busy, false);
  if (outcome.kind === 'failed') {
    refusal.value = {
      key: forMarket,
      sentence: getApiErrorMessage(outcome.error, NOT_WRITTEN[what]),
    };
  }
}

/** What each vendor asked for and what the organizers noted, for the door (E31/F04/S04). */
const { load: loadNotes, entryFor } = useVendorNotes(marketId);
/** Whoever the table lets write notes writes them; anyone with a role reads them. */
const canWriteNotes = computed(() => mayTake(market.value, MarketAction.WriteVendorNotes));

/**
 * A vendor's name opens their drawer (E35/F01/S02): who they are, what they asked for, where else
 * they sit. It never checks anyone in. A row shows notes only once there are some, so a first note
 * is written there, and the row reads it back when the drawer says one changed.
 */
const details = useVendorDetails(marketId, market);
const drawer = useVendorDrawer();
</script>

<template>
  <MarketFrame :market="market" @retry="retry">
    <!-- Once the roster has dates, its tools pin under the frame at a desk and the roster passes
         under them; before, the page says why there is no roster, with nothing to pin. -->
    <PinnedTools v-if="hasRoster" testid="attendance-tools">
      <template #tools>
        <ToolRow testid="attendance-toolbar">
          <label>
            <span class="visually-hidden">Market date</span>
            <select
              class="field field--select field--compact door-select"
              name="attendance-date-select"
              data-testid="attendance-date-select"
              :value="selectedDate"
              @change="chooseDate(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="date in dates" :key="date" :value="date">
                {{ getShortDate(date) }}
              </option>
            </select>
          </label>
          <label v-if="view === 'map' && laidOut.length > 1">
            <span class="visually-hidden">Location</span>
            <select
              class="field field--select field--compact door-select"
              name="attendance-location-select"
              data-testid="attendance-location-select"
              :value="locationId"
              @change="chooseLocation(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="location in laidOut" :key="location.id" :value="location.id">
                {{ location.name }}
              </option>
            </select>
          </label>
          <template #end>
            <!-- The groups, then a failed refresh's line under them, right-aligned: Refresh is the
                 last control in the markup, so the last the Tab key reaches. -->
            <div class="door-end">
              <ToolGroup>
                <SegmentedControl
                  :options="VIEWS"
                  label="Show as"
                  testid="attendance-view"
                  :modelValue="view"
                  @update:modelValue="chooseView($event as View)"
                />
              </ToolGroup>
              <ToolGroup>
                <button
                  type="button"
                  class="btn btn--secondary btn--compact"
                  data-testid="attendance-print"
                  @click="printRoster"
                >
                  Print roster
                </button>
                <button
                  v-if="offersTheDoorCode"
                  type="button"
                  class="btn btn--secondary btn--compact"
                  data-testid="attendance-door-code"
                  @click="showingDoorCode = true"
                >
                  Door code
                </button>
              </ToolGroup>
              <ToolGroup>
                <ListFreshness
                  testid="attendance"
                  :readAt="readAt"
                  :refreshing="refreshing"
                  failed=""
                  :showTime="false"
                  @refresh="retry"
                />
              </ToolGroup>
              <p
                v-if="refreshError"
                class="door-refresh-error"
                role="alert"
                data-testid="attendance-refresh-error"
              >
                {{ refreshError }}
              </p>
            </div>
          </template>
        </ToolRow>
        <ToolRow testid="attendance-bar">
          <h2 class="door-summary" data-testid="attendance-summary">
            {{ today.here }} of {{ today.expected }} checked in
          </h2>
          <div v-if="view === 'list'" class="door-show" role="group" aria-label="Show">
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              :aria-pressed="show === 'all'"
              data-testid="attendance-show-all"
              @click="show = 'all'"
            >
              All {{ today.expected }}
            </button>
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              :aria-pressed="show === 'not-yet'"
              data-testid="attendance-show-not-yet"
              @click="show = 'not-yet'"
            >
              {{ notHere }} {{ today.expected - today.here }}
            </button>
            <button
              type="button"
              class="btn btn--secondary btn--compact"
              :aria-pressed="show === 'here'"
              data-testid="attendance-show-here"
              @click="show = 'here'"
            >
              Checked in {{ today.here }}
            </button>
          </div>
          <SearchPicker
            v-if="view === 'map'"
            class="door-search"
            label="Find a vendor"
            hideLabel
            placeholder="Name, email or table"
            testid="attendance-map-search"
            compact
            listOver
            clearsOnChoice
            :cap="PEOPLE_CAP"
            :groups="mapSearchGroups"
            :finds="findsOnMap"
            modelValue=""
            @update:modelValue="pickOnMap($event as string)"
          />
          <input
            v-else
            v-model="search"
            type="search"
            name="attendance-search"
            class="field field--compact door-search"
            aria-label="Find a vendor"
            placeholder="Name, email or table"
            data-testid="attendance-search"
          />
        </ToolRow>
      </template>

      <div class="door">
        <p v-if="errorMessage" class="door-error" role="alert">{{ errorMessage }}</p>
        <AttendanceMap
          v-if="view === 'map'"
          :market="market"
          :rows="roster"
          :date="selectedDate"
          :openVendor="drawer.email.value"
          :hereWithoutSeat="withoutSeatToday"
          :updated="updatedWords"
          @open="drawer.open($event)"
          @showList="showListFromMap"
        />
        <template v-else>
          <p v-if="updatedWords" class="door-updated" data-testid="attendance-updated">
            {{ updatedWords }}
          </p>
          <p v-if="today.expected === 0 && withoutSeatToday === 0" class="door-note">
            Nobody is assigned on this date.
          </p>
          <p v-else-if="lists.length === 0" class="door-note">Nobody here matches.</p>
          <template v-for="list in lists" :key="list.key">
            <h3 v-if="list.heading" class="door-heading" data-testid="attendance-unseated-heading">
              {{ list.heading }}
            </h3>
            <ul class="door-list" :data-testid="`attendance-list-${list.key}`">
              <li
                v-for="row in list.rows"
                :key="rowKey(row)"
                class="door-row"
                :class="{ 'door-row--read': !canCheckIn }"
                data-testid="attendance-row"
                :data-vendor="row.vendorEmail"
              >
                <!-- The vendor and the action: one line on a phone, the action at its end, and cells
                     of the row at a desk. -->
                <span class="door-top">
                  <span class="door-who">
                    <VendorNameButton
                      :email="row.vendorEmail"
                      :names="names"
                      testid="attendance-vendor"
                      @open="drawer.open(row.vendorEmail)"
                    />
                  </span>
                  <!-- At most one button, of one width whichever it is: the undo of either write is
                       the "Undo?" beside the chip it undoes, below. -->
                  <span v-if="canCheckIn" class="door-action">
                    <button
                      v-if="!row.checkedInAt && checkInOpen"
                      type="button"
                      class="btn btn--primary btn--compact"
                      :disabled="isBusy(row)"
                      :aria-label="`Check in ${whoFor(row)}`"
                      data-testid="attendance-check-in"
                      @click="write(row, 'check-in')"
                    >
                      Check in
                    </button>
                    <button
                      v-else-if="row.checkedInAt && !row.checkedOutAt"
                      type="button"
                      class="btn btn--primary btn--compact"
                      :disabled="isBusy(row)"
                      :aria-label="`Check out ${whoFor(row)}`"
                      data-testid="attendance-check-out"
                      @click="write(row, 'check-out')"
                    >
                      Check out
                    </button>
                  </span>
                </span>
                <!-- Where they sit and whether they came, one line under the vendor's on a phone, so
                   neither widens the column the action stands in (E38/F15/S04). -->
                <span class="door-place">
                  <span class="door-table" data-testid="attendance-row-table">{{
                    whereTheySit(row)
                  }}</span>
                  <!-- Whether they came, then, once checked out, when and by whom (T496). -->
                  <span class="door-chips">
                    <span class="door-line">
                      <!-- Checked out, the check-in's undo is refused until the check-out's is made,
                           so a row checked out has its one Undo beside its departure. -->
                      <button
                        v-if="canCheckIn && row.checkedInAt && !row.checkedOutAt"
                        type="button"
                        class="door-undo"
                        :disabled="isBusy(row)"
                        :aria-label="`Undo ${whoFor(row)}'s check-in`"
                        data-testid="attendance-undo"
                        @click="write(row, 'undo-check-in')"
                      >
                        Undo?
                      </button>
                      <span
                        class="chip door-status"
                        :class="statusTone(row)"
                        data-testid="attendance-row-status"
                        >{{ status(row) }}</span
                      >
                    </span>
                    <span v-if="row.checkedOutAt" class="door-line">
                      <button
                        v-if="canCheckIn"
                        type="button"
                        class="door-undo"
                        :disabled="isBusy(row)"
                        :aria-label="`Undo ${whoFor(row)}'s check-out`"
                        data-testid="attendance-undo-check-out"
                        @click="write(row, 'undo-check-out')"
                      >
                        Undo?
                      </button>
                      <span class="chip chip--neutral door-out" data-testid="attendance-row-out">{{
                        departure(row)
                      }}</span>
                    </span>
                  </span>
                </span>
                <VendorNotes
                  class="door-notes"
                  :marketId="marketId"
                  :email="row.vendorEmail"
                  :entry="entryFor(row.vendorEmail)"
                  :canWrite="canWriteNotes"
                  onlyWhenNoted
                  :testid="`attendance-notes-${row.vendorEmail}`"
                  @changed="loadNotes"
                />
              </li>
            </ul>
          </template>
        </template>
      </div>
    </PinnedTools>
    <div v-else class="door">
      <ReadFailed v-if="readError" name="attendance" :message="readError" @retry="retry" />
      <p v-if="isLoading" class="door-note">Loading…</p>
      <!-- Said of a roster that was read: under a failed read there is nothing to say it of. -->
      <p v-else-if="wasRead && dates.length === 0" class="door-note">
        This market has no dates yet.
      </p>
    </div>
    <VendorDrawer
      :market="market"
      :details="details"
      :email="drawer.email.value"
      :tab="drawer.tab.value"
      @close="drawer.close()"
      @update:tab="drawer.setTab"
      @notesChanged="loadNotes"
    />
    <DoorRosterPrint
      v-if="dates.length && market"
      :marketName="market.name"
      :date="selectedDate"
      :expected="today.expected"
      :seated="printedSeated"
      :unseated="printedUnseated"
      :unseatedHeading="unseatedHeading"
    />
    <DoorCodeScreen
      v-if="showingDoorCode && market"
      :marketId="marketId"
      :marketName="market.name"
      @close="showingDoorCode = false"
    />
  </MarketFrame>
</template>

<style scoped>
.door {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  color: var(--mm-black);
}

/* The day and the location, each as wide as its longest option, its figures in columns. */
.door-select {
  width: auto;
  font-variant-numeric: tabular-nums;
}

/* The toolbar's end: its groups, a rule between each, and a failed refresh's line under them at
   their end. The line adds nothing to the end's width (`contain: inline-size`), so it wraps inside
   the groups' width and never moves Print roster or Door code to a line of their own. */
.door-end {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2) var(--space-3);
}

.door-refresh-error {
  flex-basis: 100%;
  contain: inline-size;
  margin: 0;
  color: var(--mm-red);
  font-size: var(--text-xs);
  text-align: end;
}

.door-show {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.door-summary {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* The search takes the count row's room. */
.door-search {
  flex: 1 1 240px;
  min-width: 0;
}

/* The map search's list lies over the map from the field's start, as wide as a row reads rather
   than the row's whole room, so a vendor and where they sit stand close; a phone's field is less. */
.door-search :deep(.search-picker-list) {
  right: auto;
  width: min(100%, 32rem);
}

/* On the list, when it was read, over the list's right edge, 4px over its first row. */
.door-updated {
  margin: 0 0 calc(-1 * var(--space-3));
  color: var(--mm-text-muted);
  font-size: var(--text-xs);
  text-align: end;
}

.door-heading {
  margin: var(--space-2) 0 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.door-list {
  container: door-list / inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.door-row {
  display: grid;
  grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
}

/* Someone offered no check-in has no action column, so their status ends the row: an empty column
   left each chip standing short of the edge with nothing beside it (E38/F15/S04). */
.door-row--read {
  grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) auto;
}

/* Under the row, the width of it: notes are read standing at the door, not squeezed into a cell. */
.door-notes {
  grid-column: 1 / -1;
  grid-row: 2;
}

/* At a desk the table and the status are cells of the row, the table first: the vendor and the
   action come first in the markup, for a phone, so each cell is placed. */
.door-top,
.door-place {
  display: contents;
}

.door-table {
  grid-column: 1;
  grid-row: 1;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.door-who {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  min-width: 0;
}

/* The status, and under it when they were checked out, each ending at the column's end: side by
   side, two long chips ("9:44 AM by" an address, twice) took the vendor's column (T496). */
.door-chips {
  grid-column: 3;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
}

.door-status,
.door-out {
  white-space: nowrap;
}

/* A line of the chips: the "Undo?" of what the chip says, if any, then the chip. */
.door-line {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

/* The undo of a check-in or a check-out: quiet, muted and underlined, beside the chip it undoes,
   so the row's one button is the next step. Its tap area is `--target-min` tall and wide, the
   chip's line grown to it, a thumb's 44px on a phone. */
.door-undo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--target-min);
  min-height: var(--target-min);
  padding: 0 var(--space-1);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: var(--mm-text-muted);
  font: inherit;
  font-size: var(--text-xs);
  text-decoration: underline;
  white-space: nowrap;
  cursor: pointer;
}

.door-undo:hover:not(:disabled) {
  color: var(--mm-black);
}

.door-undo:disabled {
  text-decoration: none;
  cursor: not-allowed;
}

/* One button's width, whichever the row holds, or none: "Check out", the wider of the two labels,
   drawn unseen in the button's place and type, sizes the cell, and the button fills it. So Check in
   and Check out are one width, and at a desk every row's chips end at one edge, a row with no
   button among them. */
.door-action {
  grid-column: 4;
  grid-row: 1;
  display: grid;
}

.door-action::before {
  content: 'Check out';
  grid-area: 1 / 1;
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
  visibility: hidden;
}

.door-action > .btn {
  grid-area: 1 / 1;
  width: 100%;
}

.door-note {
  margin: 0;
  color: var(--mm-text-muted);
  font-size: var(--text-sm);
}

.door-error {
  margin: 0;
  color: var(--mm-red);
  font-size: var(--text-sm);
}

/* The gutter narrows on a phone but stays on both sides: without it the rows ran to the card's
   edges. */
@media (width <= 640px) {
  .door {
    padding: var(--space-4);
  }

  /* On a phone the end starts its own lines at the start edge, as the toolbar's start does. */
  .door-end {
    justify-content: flex-start;
    gap: var(--space-2);
  }

  .door-refresh-error {
    text-align: start;
  }
}

/* A row too narrow for the desk's four columns, a phone's or a tablet's: the vendor on top, where
   they sit and whether they came beneath, and the button within a thumb's reach on the right. The
   vendor has the line the button leaves, so where a piece of their name or address (an address's
   half before its "@", say) is wider than that, the button goes under the vendor, at
   the line's end, and the address is not broken inside the piece (T496). Where
   they sit and whether they came share a line of their own, the status at its end, or under it when
   both do not fit: in the action's column a wide status ("9:44 AM by ...") squeezed the vendor's
   line and broke the address mid-word. By the list's width, not the window's: at 768px the desk's
   columns left the vendor's a third of the row, and the address broke inside its domain (T318).
   64rem is the table's 14rem, room for an address's longer half, a check-in's status with its
   table, the action's 11rem, when it held Check out and Undo, and the gaps: its one button now
   leaves the desk's columns room to spare at the break. */
@container door-list (width < 64rem) {
  .door-row,
  .door-row--read {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'top'
      'place'
      'notes';
    gap: var(--space-2) var(--space-3);
  }

  .door-top {
    grid-area: top;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  /* As narrow as the vendor's widest piece before the button leaves their line, and the rest of
     the line's width. */
  .door-who {
    flex: 1 1 min-content;
  }

  /* A break inside a piece is the last resort still, and no longer counts toward how narrow the
     vendor may be drawn: `anywhere` made that one character. */
  .door-who :deep(.vendor-identity-name),
  .door-who :deep(.vendor-identity-email),
  .door-who :deep(.email-address) {
    overflow-wrap: break-word;
  }

  .door-place {
    grid-area: place;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .door-table {
    min-width: 0;
  }

  /* At the line's end, side by side, the second under the first when both do not fit. */
  .door-chips {
    flex-flow: row wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-inline-start: auto;
  }

  /* For whoever may undo, one over the other as at a desk: side by side, an "Undo?" between the
     two chips read as the undo of either. */
  .door-row:not(.door-row--read) .door-chips {
    flex-flow: column;
    gap: var(--space-1);
    max-width: 100%;
  }

  /* A chip too wide to share its line, "by" another organizer's address, keeps the row's width,
     and its "Undo?" goes under it, at the line's end, still after the chip it undoes. */
  .door-line {
    flex-wrap: wrap-reverse;
  }

  .door-action {
    margin-inline-start: auto;
  }

  /* A row with no button keeps no room for one on the vendor's line. */
  .door-action:empty {
    display: none;
  }

  .door-notes {
    grid-area: notes;
  }
}
</style>
