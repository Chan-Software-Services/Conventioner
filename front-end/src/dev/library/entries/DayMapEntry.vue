<script setup lang="ts">
/**
 * The day map (T422): `DayMap`, a location's layout drawn on one market day, on the library's
 * fixture halls with their seats dealt from a seeded draw (`marketDay`): Upper Hall and Lower Hall,
 * every tone, Attendance's three (checked in, checked out and not checked in) among them, a shared table with both halves held, one with a half free, and a seat marked as a
 * search marks it. Attendance's day, the public map's, and the same at a phone's width; then the
 * map filling a box of its own, as the public map's hall draws it (T465), with a two-item legend in
 * its slot, at a desk and at a phone's width. Every map here is the real component; the lines under
 * each read out what it holds and what was pressed.
 */
import { ref } from 'vue';
import DayMap from '@/components/daymap/DayMap.vue';
import type { DayMapLegendItem } from '@/components/daymap/dayMap';
import {
  layoutSections,
  paintValue,
  seatPaint,
  tableName,
  type MapSeat,
} from '@/components/layout/layoutDrawing';
import ChoicesForYou from '../parts/ChoicesForYou.vue';
import LibraryPanel from '../parts/LibraryPanel.vue';
import LibrarySection from '../parts/LibrarySection.vue';
import ReadOut from '../parts/ReadOut.vue';
import { marketDay } from '../layoutFixture';

const day = marketDay(422);
/** The same day as the public map draws it: every seat taken. */
const taken: MapSeat[] = day.seats.map((seat) => ({ ...seat, tone: 'filled' }));

const AT_THE_DOOR: DayMapLegendItem[] = [
  { tone: 'filled', label: 'Checked in' },
  { tone: 'checkedOut', label: 'Checked out' },
  { tone: 'outlined', label: 'Not checked in' },
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
  `${counts.checkedOut} in the out shade`,
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

// ── Filling its box ──────────────────────────────────────────────────────────

/** The two boxes a filling map is shown in: a desk's and a phone's, each with its own press. */
const FILL_BOXES = [
  {
    key: 'desk',
    label: 'At a desk: the legend and the zoom over the map',
    testid: 'library-day-map-fills',
  },
  {
    key: 'phone',
    label: "At a phone's width, 390 px: the legend and the zoom under the map",
    testid: 'library-day-map-fills-phone',
  },
] as const;
const fillsLocation = ref('loc-upper');
const fillsPicked = ref<Record<string, string | null>>({ desk: null, phone: null });
const fillsPress = ref<Record<string, string>>({ desk: '', phone: '' });
function pickFilling(box: string, tableId: string, seatKey: string | null) {
  fillsPicked.value[box] = seatKey ?? tableId;
  fillsPress.value[box] = pickedWords(tableId, seatKey);
}

/** The caller's legend, as the public map fills the slot: Upper Hall's first section in its own
 *  colours, and a free table. */
const upper = day.locations.find((l) => l.id === 'loc-upper')!;
const firstSection = layoutSections(upper.layout, upper.sections).find((s) => s.tables.length)!;
const FILLS_LEGEND = [
  {
    label: firstSection.section.name,
    paint: seatPaint('filled', firstSection.paint),
  },
  { label: 'Free table', paint: seatPaint('free', firstSection.paint) },
];
</script>

<template>
  <LibrarySection
    title="A market day"
    about="One component draws a location's layout on a market day for the public map and for Attendance. Upper Hall and Lower Hall here hold their seats dealt from a seeded draw; the page hands the map its seats and its legend's words."
  >
    <LibraryPanel
      class="library-wide"
      label="Attendance's day: checked in filled, checked out darker, not checked in outlined, no vendor free; a press read out"
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

  <LibrarySection
    title="Filling its box, as the public map draws it"
    about="With fills, the map takes the box it is given whole: no shape of the hall, no edge, no location switch and no legend list of its own. The caller draws the choice of hall, fills the legend slot, here with a two-item legend, and the zoom floats as a pill. In a box 30rem and wider the legend and the zoom stand over the map's bottom corners; narrower, in one row under it."
  >
    <LibraryPanel
      v-for="box in FILL_BOXES"
      :key="box.key"
      :class="{ 'library-wide': box.key === 'desk' }"
      :label="box.label"
    >
      <div
        class="library-demo"
        :class="{ 'library-phone': box.key === 'phone' }"
        :data-testid="box.testid"
      >
        <div class="library-fills-box" :class="`library-fills-box--${box.key}`">
          <DayMap
            v-model:locationId="fillsLocation"
            fills
            :locations="day.locations"
            :tableTypes="day.tableTypes"
            :seats="taken"
            :picked="fillsPicked[box.key]"
            :legend="[]"
            @pick="(tableId, seatKey) => pickFilling(box.key, tableId, seatKey)"
          >
            <template #legend>
              <ul class="library-fills-legend" aria-label="Legend">
                <li v-for="item in FILLS_LEGEND" :key="item.label">
                  <svg class="library-fills-swatch" viewBox="0 0 14 14" aria-hidden="true">
                    <rect
                      x="0.75"
                      y="0.75"
                      width="12.5"
                      height="12.5"
                      rx="3"
                      :fill="paintValue(item.paint.fill)"
                      :stroke="paintValue(item.paint.edge)"
                      stroke-width="1.5"
                      :stroke-dasharray="item.paint.dashes"
                    />
                  </svg>
                  {{ item.label }}
                </li>
              </ul>
            </template>
          </DayMap>
        </div>
        <ReadOut label="Pressed" :value="fillsPress[box.key]" />
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
    <li>
      <strong>Filling its box:</strong> the public map's hall is the box the sheet leaves it under
      its title, whatever shape the hall is, so the map takes that box and the drawing centres the
      hall in it, rather than the box taking the hall's shape. On a phone's width the legend and the
      zoom leave the map for a row under it, since over it the two pills covered the small hall's
      bottom third.
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

/* The box a filling map takes, as the public map's hall gives it one: its height is the caller's. */
.library-fills-box {
  overflow: hidden;
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-card);
  background: white;
}

.library-fills-box--desk {
  height: 28rem;
}

.library-fills-box--phone {
  height: 24rem;
}

/* A two-item legend, as a caller fills the slot: a white pill floating over the map. */
.library-fills-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  background: white;
  box-shadow: var(--shadow-float);
  list-style: none;
  font-size: var(--text-xs);
}

.library-fills-legend li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.library-fills-swatch {
  flex: none;
  width: 14px;
  height: 14px;
}
</style>
