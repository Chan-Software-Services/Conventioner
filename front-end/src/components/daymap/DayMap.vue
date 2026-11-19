<script setup lang="ts">
/**
 * The day map (T422): a location's layout drawn on one market date, each table by who holds it
 * that day, for the public map and for Attendance. It draws the location switch (for two locations
 * or more), the one drawing of the layout in `read` with the day's seats, Zoom out, Zoom in and
 * Fit on the map's bottom-right corner as the editor's zoom stands, and the legend under the map
 * naming each tone as the page words it. In a box a phone's width the zoom stands under the map, at
 * the legend's end, where it covers none of a small map; a phone keeps the buttons, the one-finger
 * way to zoom that a pinch needs beside it. A page may give a short `note` for the legend row's
 * end, and may leave the switch out (`locationSwitch`) where it draws its own.
 *
 * It holds no market state and reads no store and no API: the page hands it its locations, seats
 * and legend (`dayMap.ts` turns the public answer and the roster into them), keeps the open
 * location (`v-model:locationId`) and what is picked, and hears `pick` with the table pressed and
 * the seat pressed on it, or null for a table or half with no vendor.
 */
import { computed, ref } from 'vue';
import type { TableTypeObject } from '@/assets/types/datatypes';
import FilterToggles from '@/components/FilterToggles.vue';
import LayoutMap from '@/components/layout/LayoutMap.vue';
import {
  layoutSections,
  paintValue,
  sectionPaint,
  seatPaint,
  type MapSeat,
  type SeatHalf,
} from '@/components/layout/layoutDrawing';
import { hallOf } from '@/components/layout/layoutGeometry';
import type { DayMapLegendItem, DayMapLocation } from './dayMap';

const props = withDefaults(
  defineProps<{
    locations: readonly DayMapLocation[];
    tableTypes: readonly TableTypeObject[];
    /** The day's seats, at any of the locations. */
    seats: readonly MapSeat[];
    /** The map takes its box whole, as the public map's hall: no shape of its own, no edge, no
     *  location switch and no legend list (the caller draws the choice and fills the `legend`
     *  slot), and the zoom a floating pill (T465). False unless given, as Vue casts an absent
     *  boolean. */
    fills?: boolean;
    /** The seat's key or the table's id picked, outlined on the map. */
    picked: string | null;
    /** More seats or tables outlined, as a search marks the vendors it finds. */
    marked?: readonly string[];
    legend: readonly DayMapLegendItem[];
    /** A short line at the legend row's end, under the map's right, as Attendance's read time. */
    note?: string;
    /** Whether to draw the location switch; off for a page that draws its own. */
    locationSwitch?: boolean;
    /** True while the page waits for the open location's image: the map draws the floor alone,
     *  as `LayoutMap` does (T501). False unless given. */
    imagePending?: boolean;
  }>(),
  { marked: () => [], note: '', locationSwitch: true },
);

const locationId = defineModel<string>('locationId', { required: true });

const emit = defineEmits<{
  /** A table pressed, and the seat pressed on it, or null where it has no vendor. */
  pick: [tableId: string, seatKey: string | null];
  /** The part of the hall shown changed, or the map's box did (T465). */
  viewed: [];
}>();

/** The open location: the one asked for, else the first. */
const open = computed(
  () => props.locations.find((location) => location.id === locationId.value) ?? props.locations[0],
);

const switches = computed(() =>
  props.locations.map((location) => ({ id: location.id, label: location.name })),
);

const map = ref<InstanceType<typeof LayoutMap> | null>(null);

/** The seat the press now landing was on: the map tells the seat just before its table. */
let pressedSeat: string | null = null;

function onActivate(tableId: string) {
  emit('pick', tableId, pressedSeat);
  pressedSeat = null;
}

const zoom = ref<HTMLElement | null>(null);
const legendSlot = ref<HTMLElement | null>(null);

/** Where what stands over the map is drawn on the screen now: the zoom, and the legend's slot when
 *  the map fills its box. */
function floatingRects(): DOMRect[] {
  return [zoom.value, legendSlot.value].flatMap((el) => (el ? [el.getBoundingClientRect()] : []));
}

// What a caller stands over a table (the public map's bubble) reads where the table is drawn, gives
// it the focus back, shows the whole hall again, and keeps clear of the zoom and the legend (T465).
defineExpose({
  targetRect: (tableId: string, half: SeatHalf) => map.value?.targetRect(tableId, half) ?? null,
  focusTarget: (tableId: string, half: SeatHalf) => map.value?.focusTarget(tableId, half) ?? false,
  fit: () => map.value?.fit(),
  floatingRects,
});

const marks = computed(() => [...(props.picked ? [props.picked] : []), ...props.marked]);

/** The frame takes the hall's shape, so the map fills it at the whole hall. */
const shape = computed(() => {
  const hall = open.value ? hallOf(open.value.layout) : null;
  return hall ? `${hall.widthMm} / ${hall.heightMm}` : '3 / 2';
});

/** The legend's swatches, in the open location's first section's colours. */
const swatches = computed(() => {
  const first = open.value
    ? layoutSections(open.value.layout, open.value.sections).find(({ tables }) => tables.length)
    : undefined;
  const section = first?.paint ?? sectionPaint(1);
  return props.legend.map((item) => ({ ...item, paint: seatPaint(item.tone, section) }));
});
</script>

<template>
  <div class="day-map" :class="{ 'day-map--fills': fills }" data-testid="day-map">
    <FilterToggles
      v-if="locationSwitch && locations.length > 1 && open && !fills"
      class="day-map__locations"
      :options="switches"
      label="Location"
      testid="day-map-locations"
      :modelValue="open.id"
      :rest="open.id"
      @update:modelValue="locationId = $event as string"
    />
    <div class="day-map__grid">
      <div
        v-if="open"
        class="day-map__frame"
        data-testid="day-map-frame"
        :style="fills ? undefined : { aspectRatio: shape }"
      >
        <LayoutMap
          ref="map"
          :layout="open.layout"
          :locationName="open.name"
          :sections="open.sections"
          :tableTypes="tableTypes"
          :imageUrl="open.imageUrl"
          :imagePending="imagePending"
          :seats="seats"
          :marked="marks"
          mode="read"
          @activateSeat="pressedSeat = $event"
          @activate="onActivate"
          @viewed="emit('viewed')"
        />
      </div>
      <div
        v-if="open"
        ref="zoom"
        class="day-map__zoom"
        role="group"
        aria-label="Zoom"
        data-testid="day-map-zoom"
      >
        <button
          type="button"
          class="btn btn--secondary btn--compact day-map__zoom-button"
          data-testid="day-map-zoom-out"
          @click="map?.zoomOut()"
        >
          <span aria-hidden="true">-</span><span class="visually-hidden">Zoom out</span>
        </button>
        <button
          type="button"
          class="btn btn--secondary btn--compact day-map__zoom-button"
          data-testid="day-map-zoom-in"
          @click="map?.zoomIn()"
        >
          <span aria-hidden="true">+</span><span class="visually-hidden">Zoom in</span>
        </button>
        <button
          type="button"
          class="btn btn--secondary btn--compact day-map__zoom-button"
          data-testid="day-map-fit"
          @click="map?.fit()"
        >
          Fit
        </button>
      </div>

      <div
        v-if="fills"
        ref="legendSlot"
        class="day-map__legend-slot"
        data-testid="day-map-legend-slot"
      >
        <slot name="legend" />
      </div>
      <ul v-else class="day-map__legend" aria-label="Legend" data-testid="day-map-legend">
        <li
          v-for="item in swatches"
          :key="item.tone"
          class="day-map__legend-item"
          :data-tone="item.tone"
          data-testid="day-map-legend-item"
        >
          <svg class="day-map__swatch" viewBox="0 0 24 14" aria-hidden="true">
            <rect
              x="0.75"
              y="0.75"
              width="22.5"
              height="12.5"
              rx="2"
              :fill="paintValue(item.paint.fill)"
              :stroke="paintValue(item.paint.edge)"
              stroke-width="1.5"
              :stroke-dasharray="item.paint.dashes"
            />
          </svg>
          <span>{{ item.label }}</span>
        </li>
      </ul>
      <p v-if="note" class="day-map__note" data-testid="day-map-note">{{ note }}</p>
    </div>
  </div>
</template>

<style scoped>
/* The switch over the grid, then the map and the legend stack; the zoom stands over the map's
   bottom-right corner, placed in the map's cell (an absolute grid item takes its area as its box),
   until the box is a phone's width, where it moves under the map. */
.day-map {
  container-type: inline-size;
  min-width: 0;
}

.day-map__grid {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'map map'
    'legend legend';
  gap: var(--space-3);
}

/* A note takes the legend row's end, so a map with none keeps the legend the whole width. */
.day-map__grid:has(> .day-map__note) {
  grid-template-areas:
    'map map'
    'legend note';
}

/* Over the grid rather than a row of it, so a map with no switch has no empty row and no gap over
   it (T466): the grid's gap is the switch's own margin. */
.day-map__locations {
  margin-block-end: var(--space-3);
}

/* The map's box: the hall's shape across the width it is given, no taller than most of the
   window, so a long hall on a phone still leaves the page under it in reach. A caller with more
   above the map caps the frame at the room it leaves, as Attendance does. */
.day-map__frame {
  grid-area: map;
  width: 100%;
  max-height: 70dvh;
  overflow: hidden;
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: var(--layout-floor);
}

/* The zoom stands on the map's bottom-right corner, as the editor's does. */
.day-map__zoom {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  grid-area: map;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  background: white;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.day-map__zoom-button {
  min-width: var(--target-min);
  justify-content: center;
}

/* Filling its box (T465), as the public map's hall: the map takes the whole box, with no shape,
   edge or corner of its own, so the drawing's own `preserveAspectRatio` centres the hall in it; the
   caller's legend stands over the map's bottom-left corner and the zoom, a floating pill, over its
   bottom-right, each `--space-3` in, the legend leaving the zoom its room. */
.day-map--fills,
.day-map--fills .day-map__grid {
  height: 100%;
}

.day-map--fills .day-map__grid {
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'map map';
  gap: 0;
}

.day-map--fills .day-map__frame {
  height: 100%;
  max-height: none;
  border: none;
  border-radius: 0;
  background: transparent;
}

.day-map--fills .day-map__zoom {
  z-index: 1;
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-float);
}

.day-map--fills .day-map__zoom-button {
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
}

.day-map--fills .day-map__zoom-button:hover {
  background: var(--layout-floor);
}

.day-map__legend-slot {
  position: absolute;
  bottom: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  grid-area: map;
  max-width: calc(100% - 10rem);
}

/* A box a phone's width: the map takes the box less one row under it, which holds the legend at
   its start and the zoom at its end, so neither covers the small hall. */
@container (width < 30rem) {
  .day-map--fills .day-map__grid {
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'map map'
      'legend zoom';
    column-gap: var(--space-2);
    padding-bottom: var(--space-3);
  }

  /* Their feet on one line, so a legend that wraps grows upward and the zoom never moves. */
  .day-map--fills .day-map__legend-slot,
  .day-map--fills .day-map__zoom {
    position: static;
    align-self: end;
    margin-top: var(--space-3);
  }

  .day-map--fills .day-map__legend-slot {
    grid-area: legend;
    max-width: none;
    margin-inline-start: var(--space-3);
  }

  .day-map--fills .day-map__zoom {
    grid-area: zoom;
    margin-inline-end: var(--space-3);
    padding: var(--space-1);
    box-shadow: var(--shadow-float);
  }
}

.day-map__legend {
  grid-area: legend;
  align-self: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.day-map__legend-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.day-map__swatch {
  flex: none;
  width: 24px;
  height: 14px;
}

/* The note at the legend row's end, 4px under the map: the grid's 12px gap less 8px. */
.day-map__note {
  grid-area: note;
  align-self: start;
  margin: calc(-1 * var(--space-2)) 0 0;
  text-align: end;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

/* A phone's width: the zoom under the map, at the legend's end, covering none of it. */
@container (width < 30rem) {
  .day-map__grid {
    grid-template-areas:
      'map map'
      'legend zoom';
  }

  .day-map__grid:has(> .day-map__note) {
    grid-template-areas:
      'map map'
      'legend zoom'
      'note note';
  }

  .day-map__zoom {
    position: static;
    grid-area: zoom;
    align-self: start;
    padding: 0;
    box-shadow: none;
  }
}
</style>
