<script setup lang="ts">
/**
 * The public map's vendor panel (T422, T465): "Find a vendor" pinned at its top, over every vendor
 * of the day.
 *
 * - The search is the app's `SearchPicker`: its dropdown offers the vendors the words find by public
 *   fields alone (`publicMapSearch.ts`), and a pick asks the page to open that vendor, then empties
 *   the field and keeps its focus for the next search.
 * - The words never filter the list under it: the list is for browsing, every named vendor of the
 *   day at every location, by name, with no paging and no count. A day is a few hundred rows at
 *   most, already in memory, and they scroll under the field.
 * - Each row is led by its table's code in a pill of its section's colours, then the name over the
 *   hall; a reader hears "Table <code>, " before the hall rather than the pill. The vendor picked is
 *   ringed in mustard, as the map outlines their table.
 * - Once the list has scrolled, a band under the field blurs and fades the rows passing under it;
 *   at the top it is not drawn, so nothing covers the first vendor.
 *
 * The page never scrolls, so the panel takes the box the page gives it and scrolls its own list.
 */
import { computed, ref } from 'vue';
import ScrollBox from '@/components/ScrollBox.vue';
import SearchPicker, { type PickerGroup, type PickerOption } from '@/components/SearchPicker.vue';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import { NO_VENDORS_LISTED, mapListing, type ListedVendor } from '@/utils/publicMap';
import type { TablePaint } from './publicMapPaint';
import { findsVendor, publicVendorEntries } from './publicMapSearch';

const props = defineProps<{
  map: PublicMapAnswer;
  /** The open day, `YYYY-MM-DD`. */
  date: string;
  /** The table picked; with no seat picked alone, every vendor at it is the one picked. */
  pickedTableId: string | null;
  /** The seat picked alone, a half's (`publicSeatKey`), or null. */
  pickedSeatKey: string | null;
  /** Each table's section colours, by table id; a table in no section has none. */
  paints: ReadonlyMap<string, TablePaint>;
}>();

const emit = defineEmits<{ open: [vendor: ListedVendor] }>();

const listed = computed(() => mapListing(props.map, props.date));
const entries = computed(
  () => new Map(publicVendorEntries(props.map, props.date).map((entry) => [entry.key, entry])),
);

const where = (vendor: ListedVendor) => `Table ${vendor.code}, ${vendor.locationName}`;
const groups = computed<PickerGroup[]>(() => [
  {
    options: listed.value.map((vendor) => ({
      value: vendor.key,
      label: vendor.name,
      detail: where(vendor),
    })),
  },
]);

function finds(option: PickerOption, words: string): boolean {
  const entry = entries.value.get(option.value);
  return entry !== undefined && findsVendor(entry, words);
}

function pick(key: string | string[]) {
  const vendor = listed.value.find((listedVendor) => listedVendor.key === key);
  if (vendor) emit('open', vendor);
}

const isPicked = (vendor: ListedVendor) =>
  props.pickedSeatKey !== null
    ? vendor.key === props.pickedSeatKey
    : vendor.tableId === props.pickedTableId;

function codeStyle(tableId: string): Record<string, string> | undefined {
  const paint = props.paints.get(tableId);
  return paint && { background: paint.fill, borderColor: paint.edge };
}

/** Whether the list has scrolled under the field, which alone draws the fade. */
const scrolled = ref(false);
function onScroll(event: Event) {
  const scroller = event.target as HTMLElement;
  if (scroller.dataset.testid === 'public-map-vendors-list')
    scrolled.value = scroller.scrollTop > 0;
}
</script>

<template>
  <aside class="public-map-vendors" aria-label="Vendors" data-testid="public-map-vendors">
    <div class="public-map-vendors__find">
      <SearchPicker
        class="public-map-vendors__search"
        modelValue=""
        :groups="groups"
        :finds="finds"
        label="Find a vendor"
        placeholder="Name, table, website or Instagram"
        testid="public-map-find"
        :cap="8"
        noneWord="No vendor"
        clearsOnChoice
        listOver
        @update:modelValue="pick"
      />
    </div>

    <div class="public-map-vendors__body" @scroll.capture="onScroll">
      <ScrollBox
        class="public-map-vendors__scroll"
        fieldsLeaveTheStop
        testid="public-map-vendors-list"
      >
        <ul v-if="listed.length" class="public-map-vendors__rows">
          <li v-for="vendor in listed" :key="vendor.key" class="public-map-vendors__row">
            <button
              type="button"
              class="public-map-vendors__vendor"
              :aria-current="isPicked(vendor) ? 'true' : undefined"
              data-testid="public-map-vendor"
              @click="emit('open', vendor)"
            >
              <span
                class="public-map-vendors__code"
                :style="codeStyle(vendor.tableId)"
                aria-hidden="true"
                data-testid="public-map-vendor-code"
                >{{ vendor.code }}</span
              >
              <span class="public-map-vendors__words">
                <span class="public-map-vendors__name">{{ vendor.name }}</span>
                <span class="public-map-vendors__seat"
                  ><span class="visually-hidden">Table {{ vendor.code }}, </span
                  >{{ vendor.locationName }}</span
                >
              </span>
            </button>
          </li>
        </ul>
        <p v-else class="public-map-vendors__empty" data-testid="public-map-vendors-empty">
          {{ NO_VENDORS_LISTED }}
        </p>
      </ScrollBox>
      <div
        v-if="scrolled"
        class="public-map-vendors__fade"
        aria-hidden="true"
        data-testid="public-map-vendors-fade"
      ></div>
    </div>
  </aside>
</template>

<style scoped>
/* A column: the search at the top, which never scrolls, then the list taking the rest. */
.public-map-vendors {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* Over the list and its fade, so the dropdown lies over the rows. */
.public-map-vendors__find {
  position: relative;
  z-index: 2;
  flex: none;
  padding: var(--space-4) var(--space-4) var(--space-2);
}

.public-map-vendors__search :deep(.field-label) {
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-md);
  color: var(--mm-black);
}

/* The field, a white pill. */
.public-map-vendors__search :deep(.field) {
  padding-inline: var(--space-4);
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  background: white;
}

.public-map-vendors__body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.public-map-vendors__scroll {
  flex: 1 1 auto;
}

/* The page's card over the panel's top on a phone reaches this far over the list, so a row the
   focus reaches is scrolled clear below it. */
.public-map-vendors__scroll :deep(.scroll-box__scroller) {
  scroll-padding-top: var(--public-map-card-reach);
}

/* The panel's inset, inside the scroller, so a row's focus halo is never cut at its edge; the
   first row stands --space-3 under the field at rest, the room scrolling away with the rows. */
.public-map-vendors__rows {
  margin: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
  list-style: none;
}

.public-map-vendors__row + .public-map-vendors__row {
  border-block-start: 1px solid var(--layout-floor);
}

.public-map-vendors__empty {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-4);
  color: var(--mm-text-muted);
}

/* A vendor: their table's code, then their name over their hall, the whole row the button. The
   border is kept clear on every row, so the picked one's ring moves nothing. */
.public-map-vendors__vendor {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--target-min);
  padding: var(--space-2);
  border: 2px solid transparent;
  border-radius: var(--radius-card);
  background: none;
  color: var(--mm-black);
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}

/* The vendor picked, ringed in mustard, as the map outlines their table. */
.public-map-vendors__vendor[aria-current='true'] {
  border-color: var(--mm-yellow);
}

.public-map-vendors__vendor:hover .public-map-vendors__name {
  text-decoration: underline;
  text-decoration-color: var(--mm-yellow);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

/* A table's code, a pill in its section's colours, as the map draws the table; the floor's grey
   for a table in no section. */
.public-map-vendors__code {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: calc(var(--space-8) + var(--space-3));
  height: var(--space-6);
  padding-inline: var(--space-2);
  border: 1.5px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  background: var(--layout-floor);
  font-size: var(--text-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.public-map-vendors__words {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  min-width: 0;
}

.public-map-vendors__name {
  font-weight: 600;
}

.public-map-vendors__seat {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

/* The rows blur and fade as they pass under the field, drawn only once the list has scrolled. */
.public-map-vendors__fade {
  position: absolute;
  inset-inline: 0;
  top: 0;
  z-index: 1;
  height: var(--space-8);
  background: linear-gradient(to bottom, white, transparent);
  pointer-events: none;
  backdrop-filter: blur(3px);
  mask-image: linear-gradient(to bottom, black, transparent);
}
</style>
