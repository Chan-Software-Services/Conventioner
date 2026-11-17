<script setup lang="ts">
/**
 * The public map's legend (T465): a white pill over the hall naming its sections in their own
 * colours, and "Free table", dashed, on a day the hall draws one (`hallLegend`). Each swatch is
 * drawn as `DayMap`'s are, an `svg` rect, so a free one is dashed as the map dashes a free table.
 */
import { FREE_DASHES } from '@/components/layout/layoutDrawing';
import type { PublicMapLegendItem } from './publicMapPaint';

defineProps<{ items: readonly PublicMapLegendItem[] }>();
</script>

<template>
  <ul
    v-if="items.length"
    class="public-map-legend"
    aria-label="Legend"
    data-testid="public-map-legend"
  >
    <li
      v-for="item in items"
      :key="`${item.kind}:${item.label}`"
      class="public-map-legend__item"
      :data-kind="item.kind"
      data-testid="public-map-legend-item"
    >
      <svg
        class="public-map-legend__swatch"
        viewBox="0 0 14 14"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="0.75"
          y="0.75"
          width="12.5"
          height="12.5"
          rx="3"
          :fill="item.fill"
          :stroke="item.edge"
          stroke-width="1.5"
          :stroke-dasharray="item.dashed ? FREE_DASHES : undefined"
        />
      </svg>
      <span>{{ item.label }}</span>
    </li>
  </ul>
</template>

<style scoped>
.public-map-legend {
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
  color: var(--mm-black);
}

/* The swatch one line tall, its 14px square centred in it by the view box, beside the label's
   first line, so a name long enough to wrap keeps its swatch where a one-line name has it. */
.public-map-legend__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.public-map-legend__swatch {
  flex: none;
  width: 14px;
  height: 1lh;
}

/* Under a hall a phone's width the legend shares a row with the zoom: its spacing is tighter, so
   two short section names keep one line beside the zoom at 390px, and when longer or more names
   wrap it, a pill's ends would round it into a capsule, so its corners are the bubble's, which
   still round one line whole. */
@container (width < 30rem) {
  .public-map-legend {
    column-gap: var(--space-3);
    padding-inline: var(--space-3);
    border-radius: var(--radius-bubble);
  }

  .public-map-legend__item {
    gap: var(--space-1);
  }
}
</style>
