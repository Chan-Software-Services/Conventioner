<script setup lang="ts">
/**
 * The day map (T422): `DayMap`, a location's layout drawn on one market day, on the library's
 * fixture halls with their seats dealt from a seeded draw (`marketDay`): Upper Hall and Lower Hall,
 * every tone, a shared table with both halves held, one with a half free, and a seat marked as a
 * search marks it. Attendance's day, the public map's, and the same at a phone's width. Every map
 * here is the real component; the lines under each read out what it holds and what was pressed.
 */
import { ref } from 'vue';
import DayMap from '@/components/daymap/DayMap.vue';
import type { DayMapLegendItem } from '@/components/daymap/dayMap';
import { tableName, type MapSeat } from '@/components/layout/layoutDrawing';
import ChoicesForYou from '../parts/ChoicesForYou.vue';
import LibraryPanel from '../parts/LibraryPanel.vue';
import LibrarySection from '../parts/LibrarySection.vue';
import ReadOut from '../parts/ReadOut.vue';
import { marketDay } from '../layoutFixture';

const day = marketDay(422);
/** The same day as the public map draws it: every seat taken. */
const taken: MapSeat[] = day.seats.map((seat) => ({ ...seat, tone: 'filled' }));

const AT_THE_DOOR: DayMapLegendItem[] = [
  { tone: 'filled', label: 'Here' },
  { tone: 'outlined', label: 'Expected' },
  { tone: 'free', label: 'No vendor' },
];
const IN_PUBLIC: DayMapLegendItem[] = [
  { tone: 'filled', label: 'Taken' },
  { tone: 'free', label: 'Free' },
];

const { counts } = day;
const dealt = [
  `${counts.tables} tables`,
  `${counts.filled} seats filled`,
  `${counts.outlined} outlined`,
  `${counts.free} tables free`,
  `${counts.shared} shared, ${counts.halfFree} of them with a half free`,
];

/** What a press picked, in words: the table's name, and its half and vendor or "no vendor". */
function pickedWords(tableId: string, seatKey: string | null): string {
  for (const location of day.locations) {
    const table = location.layout.tables.find((t) => t.id === tableId);
    if (!table) continue;
    const name = tableName(
      table,
      location.sections.find((s) => s.id === table.sectionId),
      day.tableTypes.find((t) => t.id === table.tableTypeId),
    );
    const seat = day.seats.find((s) => s.key === seatKey);
    if (!seat) return `${name}, no vendor`;
    return seat.half === 'whole'
      ? `${name}, ${seat.name}`
      : `${name}, ${seat.half} half, ${seat.name}`;
  }
  return tableId;
}

const nameOfLocation = (id: string) => day.locations.find((l) => l.id === id)?.name ?? id;

// ── At the door ──────────────────────────────────────────────────────────────

const doorLocation = ref('loc-upper');
const doorPicked = ref<string | null>(null);
const doorPress = ref('');
function pickAtTheDoor(tableId: string, seatKey: string | null) {
  doorPicked.value = seatKey ?? tableId;
  doorPress.value = pickedWords(tableId, seatKey);
}

/** A search, as Attendance's field marks the vendors it finds: Gold row 3's right half. */
const searched = day.seats.find((seat) => seat.tableId === 'sec-gold-3' && seat.half === 'right')!;
const searchLocation = ref('loc-upper');

// ── In public ────────────────────────────────────────────────────────────────

const publicLocation = ref('loc-upper');
const publicPicked = ref<string | null>(null);
const publicPress = ref('');
function pickInPublic(tableId: string, seatKey: string | null) {
  publicPicked.value = seatKey ?? tableId;
  publicPress.value = pickedWords(tableId, seatKey);
}

const phoneLocation = ref('loc-upper');
const phonePress = ref('');
</script>

<template>
  <LibrarySection
    title="A market day"
    about="One component draws a location's layout on a market day for the public map and for Attendance. Upper Hall and Lower Hall here hold their seats dealt from a seeded draw; the page hands the map its seats and its legend's words."
  >
    <LibraryPanel
      class="library-wide"
      label="Attendance's day: here filled, expected outlined, no vendor free; a press read out"
    >
      <div class="library-demo" data-testid="library-day-map-door">
        <DayMap
          v-model:locationId="doorLocation"
          :locations="day.locations"
          :tableTypes="day.tableTypes"
          :seats="day.seats"
          :picked="doorPicked"
          :legend="AT_THE_DOOR"
          @pick="pickAtTheDoor"
        />
        <ReadOut label="Location" :value="nameOfLocation(doorLocation)" />
        <ReadOut label="Pressed" :value="doorPress" />
        <ReadOut label="Dealt" :value="dealt" />
      </div>
    </LibraryPanel>

    <LibraryPanel
      class="library-wide"
      label="A search marks a vendor's seat: Gold row 3's right half"
    >
      <div class="library-demo" data-testid="library-day-map-marked">
        <DayMap
          v-model:locationId="searchLocation"
          :locations="day.locations"
          :tableTypes="day.tableTypes"
          :seats="day.seats"
          :picked="null"
          :marked="[searched.key]"
          :legend="AT_THE_DOOR"
        />
        <ReadOut label="Marked" :value="pickedWords(searched.tableId, searched.key)" />
      </div>
    </LibraryPanel>

    <LibraryPanel class="library-wide" label="The public map's day: taken and free">
      <div class="library-demo" data-testid="library-day-map-public">
        <DayMap
          v-model:locationId="publicLocation"
          :locations="day.locations"
          :tableTypes="day.tableTypes"
          :seats="taken"
          :picked="publicPicked"
          :legend="IN_PUBLIC"
          @pick="pickInPublic"
        />
        <ReadOut label="Pressed" :value="publicPress" />
      </div>
    </LibraryPanel>

    <LibraryPanel label="At a phone's width, 390 px">
      <div class="library-demo library-phone" data-testid="library-day-map-phone">
        <DayMap
          v-model:locationId="phoneLocation"
          :locations="day.locations"
          :tableTypes="day.tableTypes"
          :seats="taken"
          :picked="null"
          :legend="IN_PUBLIC"
          @pick="(tableId, seatKey) => (phonePress = pickedWords(tableId, seatKey))"
        />
        <ReadOut label="Pressed" :value="phonePress" />
      </div>
    </LibraryPanel>
  </LibrarySection>

  <ChoicesForYou>
    <li>
      <strong>Every number in black:</strong> a table's number is held to 7:1 on its fill. A
      section's colour on white is as low as 3.83 and the muted grey on the floor 4.40, so an
      outlined or free table numbers in black like a filled one, and its fill and edge say which it
      is.
    </li>
    <li>
      <strong>A free table:</strong> the floor's colour with a dashed edge in the grey of a table in
      no section, which stands at 4.03 on the floor; the lighter border grey would be 1.6.
    </li>
    <li>
      <strong>Which half is left:</strong> the one on your left as the table's number reads, so a
      table turned past a quarter has its own right end as its left half; a table turned a quarter
      reads top to bottom, its left half at the top.
    </li>
    <li>
      <strong>The zoom:</strong> each press of Zoom in or Zoom out is half as much again or a third
      less, about the map's middle; Ctrl and the wheel zoom about the pointer; a plain wheel scrolls
      the page past the map, as a page with a map in it should.
    </li>
    <li>
      <strong>The zoom on a phone:</strong> under the map at the legend's end, since three 44 px
      buttons over a phone's map covered a third of it. A phone keeps them, as the one-finger way to
      zoom that a pinch needs beside it.
    </li>
    <li>
      <strong>The legend's swatches:</strong> drawn in the open location's first section's colour,
      so they look like the tables beside them.
    </li>
    <li>
      <strong>A vendor with no public name:</strong> their table is taken, and a screen reader hears
      "vendor not listed" where the name would be.
    </li>
  </ChoicesForYou>
</template>

<style scoped>
.library-wide {
  grid-column: 1 / -1;
}

.library-demo {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}

/* A phone's width, at a desk too. */
.library-phone {
  max-width: 390px;
}
</style>
