<script setup lang="ts">
/**
 * Attendance's map (T422, D38 to D41): the open day drawn as the venue's layouts, each table by
 * whether its vendor is here (filled), expected (outlined) or absent from the plan (free), from the
 * roster the page already reads and re-reads, so the map is as fresh as the list.
 *
 * A press on a vendor's table, or on their half of a shared one, asks the page to open their drawer,
 * as a press on their row does; the open vendor's seat is the picked one. A press on a table with no
 * vendor says so under the map and opens nothing. The search marks the vendors it finds. The
 * vendors the map cannot draw are counted under it, with the way back to the list: those here with
 * no table, and those whose table is on no layout. The legend names "No vendor" only on a day the
 * open location draws a table or half nobody sits at (`drawsAFreePart`), and the read time the page
 * gives stands under the map as the day map's note.
 *
 * Nothing here writes: check-in, Undo and notes stay on the list (D39). The open location is the
 * page's own state, in the address as `location`, chosen in the page's toolbar (T466), so the day
 * map draws no location switch of its own.
 */
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Market } from '@/assets/types/datatypes';
import { laidOutLocations, openLocationId } from '@/components/attendance/laidOutLocations';
import DayMap from '@/components/daymap/DayMap.vue';
import {
  rosterSeats,
  type DayMapLegendItem,
  type DayMapLocation,
  type RosterSeatRow,
} from '@/components/daymap/dayMap';
import { drawsAFreePart } from '@/components/daymap/freeParts';
import { tableCode } from '@/components/layout/layoutDrawing';
import { useFloorplanImage } from '@/components/layout/useFloorplanImage';
import { layoutPath } from '@/utils/market';
import { MarketAction, mayTake } from '@/utils/marketActions';
import { getShortDate } from '@/utils/utils';

const props = defineProps<{
  market: Market | null;
  /** The roster's rows, every date's; the map draws `date`'s. */
  rows: readonly RosterSeatRow[];
  date: string;
  /** The vendors the search finds on `date`, by email; empty with nothing typed. */
  found: readonly string[];
  /** The vendor whose drawer is open, by email, or null. */
  openVendor: string | null;
  /** What the list calls a vendor not here: "Not yet", or "Did not come" once the day is over. */
  notHere: string;
  /** How many are here on `date` with no table that day. */
  hereWithoutSeat: number;
  /** When the roster was last read, in words, under the map's bottom right. */
  updated?: string;
}>();

const emit = defineEmits<{
  /** A vendor's seat pressed: open their drawer. */
  open: [email: string];
  /** Back to the list, where every vendor the map cannot draw is listed. */
  showList: [];
}>();

const route = useRoute();

/** The locations laid out, by the one rule the page's location select reads too. */
const laidOut = computed(() => laidOutLocations(props.market?.setupObject));

/** The open location: the address's, else the first laid out. */
const openId = computed(() => openLocationId(laidOut.value, String(route.query.location ?? '')));

/** Only the open location's image is read, with the session, as the layout page reads it. */
const { url: imageUrl } = useFloorplanImage(
  computed(() => laidOut.value.find((each) => each.id === openId.value)?.layout.imageGridfsId),
);

const locations = computed<DayMapLocation[]>(() =>
  laidOut.value.map((each) => ({
    ...each,
    imageUrl: each.id === openId.value ? imageUrl.value : '',
  })),
);

const tableTypes = computed(() => props.market?.setupObject?.tableTypes ?? []);

/** Each seat named as the list names its vendor: their name, else their address. */
const drawn = computed(() =>
  rosterSeats(
    props.rows.map((row) => ({ ...row, vendorName: row.vendorName || row.vendorEmail })),
    props.date,
    laidOut.value,
  ),
);
const seats = computed(() => drawn.value.seats);
const offLayout = computed(() => drawn.value.notOnALayout.length);

/** The open location as the map draws it, for what its legend names. */
const openLocation = computed(() => laidOut.value.find((each) => each.id === openId.value));

/** "No vendor" only on a day the open map draws a table or half nobody sits at. */
const legend = computed<DayMapLegendItem[]>(() => [
  { tone: 'filled', label: 'Here' },
  { tone: 'outlined', label: props.notHere === 'Not yet' ? 'Expected' : props.notHere },
  ...(openLocation.value && drawsAFreePart(openLocation.value, seats.value)
    ? [{ tone: 'free' as const, label: 'No vendor' }]
    : []),
]);

/** A table with no vendor pressed, which the note under the map names; none once a vendor opens,
 *  or the search marks what it finds. */
const freeTable = ref<string | null>(null);
watch(
  () => [props.date, openId.value, props.openVendor, props.found.join('\n')],
  () => (freeTable.value = null),
);

const seatKeyOf = (email: string) =>
  seats.value.find((seat) => seat.key.toLowerCase() === email.toLowerCase())?.key ?? null;

const picked = computed(
  () => (props.openVendor ? seatKeyOf(props.openVendor) : null) ?? freeTable.value,
);
const marked = computed(() =>
  props.found.map(seatKeyOf).filter((key): key is string => key !== null),
);

/** "Table Aisle A 4: no vendor on Nov 18, 2026.", for the table pressed with nobody at it, the day
 *  spelled as the page's own date buttons spell it. */
const freeNote = computed(() => {
  if (!freeTable.value) return '';
  for (const { layout, sections } of laidOut.value) {
    const table = layout.tables.find((each) => each.id === freeTable.value);
    if (!table) continue;
    const code = tableCode(
      table,
      sections.find((section) => section.id === table.sectionId),
    );
    return code ? `Table ${code}: no vendor on ${getShortDate(props.date)}.` : '';
  }
  return '';
});

function pick(tableId: string, seatKey: string | null) {
  if (seatKey) {
    emit('open', seatKey);
    return;
  }
  // A free half of a shared table is no button: only a table nobody holds says it is free.
  if (seats.value.some((seat) => seat.tableId === tableId)) return;
  freeTable.value = tableId;
}

const offLayoutWords = computed(() =>
  offLayout.value === 1
    ? '1 vendor is at a table not on a layout.'
    : `${offLayout.value} vendors are at tables not on a layout.`,
);

const mayChangeSetup = computed(() => mayTake(props.market, MarketAction.ChangeSetup));
</script>

<template>
  <section class="door-map" aria-label="Map" data-testid="attendance-map">
    <p v-if="!locations.length" class="door-map__note" data-testid="attendance-map-none">
      No location has a layout yet.
      <RouterLink
        v-if="market && mayChangeSetup"
        :to="layoutPath(market.id)"
        class="door-map__link"
        data-testid="attendance-map-layout-link"
        >Open the layout</RouterLink
      >
    </p>
    <template v-else>
      <DayMap
        :locations="locations"
        :tableTypes="tableTypes"
        :locationId="openId"
        :seats="seats"
        :picked="picked"
        :marked="marked"
        :legend="legend"
        :note="updated"
        :locationSwitch="false"
        @pick="pick"
      />
      <p
        v-if="freeNote"
        class="door-map__note"
        aria-live="polite"
        data-testid="attendance-map-note"
      >
        {{ freeNote }}
      </p>
    </template>
    <p v-if="hereWithoutSeat > 0" class="door-map__count" data-testid="attendance-map-unseated">
      {{ hereWithoutSeat }} here with no table
      <button
        type="button"
        class="btn btn--secondary btn--compact"
        data-testid="attendance-map-unseated-show-list"
        @click="emit('showList')"
      >
        Show in the list
      </button>
    </p>
    <!-- With no location laid out every seated vendor is at a table on no layout, which the line
         above says already. -->
    <p
      v-if="locations.length && offLayout > 0"
      class="door-map__count"
      data-testid="attendance-map-off-layout"
    >
      {{ offLayoutWords }}
      <button
        type="button"
        class="btn btn--secondary btn--compact"
        data-testid="attendance-map-off-layout-show-list"
        @click="emit('showList')"
      >
        Show in the list
      </button>
    </p>
  </section>
</template>

<style scoped>
.door-map {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

/* At a desk the whole map, its zoom and its legend stand in the window under the door's head,
   about 30rem of it, as the layout page's map does; a phone keeps the day map's own height. */
@media (width > 640px) {
  .door-map :deep(.day-map__frame) {
    max-height: max(20rem, calc(100dvh - 30rem));
  }
}

.door-map__note,
.door-map__count {
  margin: 0;
  font-size: var(--text-sm);
}

.door-map__note {
  color: var(--mm-black);
}

.door-map__count {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 var(--space-2);
}

.door-map__link {
  color: var(--mm-text-link);
}
</style>
