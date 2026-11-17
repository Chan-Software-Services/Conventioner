<script setup lang="ts">
/**
 * The day's vendors on the public map (T422, T465): every vendor with a public name seated on the
 * day, at every location, by name, each with their table and location; the find field narrows them
 * by name, and pressing one asks the page to open their table. The page never scrolls, so the part
 * scrolls its own list in the box the page gives it (T465).
 */
import { computed } from 'vue';
import ListFrame from '@/components/ListFrame.vue';
import ScrollBox from '@/components/ScrollBox.vue';
import type { PublicMapAnswer } from '@/components/daymap/dayMap';
import { NO_VENDORS_LISTED, mapListing, type ListedVendor } from '@/utils/publicMap';
import type { TablePaint } from './publicMapPaint';

const props = defineProps<{
  map: PublicMapAnswer;
  /** The open day, `YYYY-MM-DD`. */
  date: string;
  /** The table picked, whose vendors' rows are marked current. */
  pickedTableId: string | null;
  /** The seat picked alone, a half's (`publicSeatKey`), or null while the page passes none. */
  pickedSeatKey: string | null;
  /** Each table's section colours, by table id; empty while the page passes none. */
  paints: ReadonlyMap<string, TablePaint>;
}>();

const emit = defineEmits<{ open: [vendor: ListedVendor] }>();

const listed = computed(() => mapListing(props.map, props.date));
const finds = (vendor: ListedVendor, words: string) =>
  vendor.name.toLowerCase().includes(words.toLowerCase());
</script>

<template>
  <ScrollBox fieldsLeaveTheStop testid="public-map-vendors-list">
    <ListFrame
      class="public-map-vendors__frame"
      :items="listed"
      :finds="finds"
      :findFrom="0"
      findKey="find"
      findLabel="Find a vendor"
      :filterKey="date"
      :itemKey="(vendor) => vendor.key"
      :noun="{ one: 'vendor', many: 'vendors' }"
      testid="public-map-vendors"
    >
      <template #row="{ item }">
        <button
          type="button"
          class="public-map-vendors__vendor"
          :aria-current="item.tableId === pickedTableId ? 'true' : undefined"
          data-testid="public-map-vendor"
          @click="emit('open', item)"
        >
          <span class="public-map-vendors__name">{{ item.name }}</span>
          <span class="public-map-vendors__seat"
            >Table {{ item.code }}, {{ item.locationName }}</span
          >
        </button>
      </template>
      <template #empty>
        <p>{{ NO_VENDORS_LISTED }}</p>
      </template>
    </ListFrame>
  </ScrollBox>
</template>

<style scoped>
/* The panel's inset, inside the scroller, so a row's focus halo is never cut at its edge. */
.public-map-vendors__frame {
  padding: var(--space-4);
}

/* A vendor of the list: their name over their table, the whole row the button. */
.public-map-vendors__vendor {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-hairline);
  width: 100%;
  min-height: var(--target-min);
  /* The card's own inset, so a vendor's name stands on the card's text above it. */
  padding: var(--space-2) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: none;
  color: var(--mm-black);
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}

/* An edge, not a tint: the muted table line would fall under AA on a hover's grey. The picked
   vendor's edge is the map's own mark, black. */
.public-map-vendors__vendor:hover {
  border-color: var(--mm-border);
}

.public-map-vendors__vendor[aria-current='true'] {
  border-color: var(--mm-black);
}

.public-map-vendors__name {
  font-weight: 600;
}

.public-map-vendors__seat {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

@media (width <= 640px) {
  .public-map-vendors__vendor {
    min-height: 44px;
  }
}
</style>
