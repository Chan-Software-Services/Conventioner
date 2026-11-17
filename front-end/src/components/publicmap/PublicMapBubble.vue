<script setup lang="ts">
/**
 * The public map's speech bubble at a desk (T465): the card of the table picked, standing in the
 * hall at that table, its tail on it, where `placeBubble` puts it (up and to the right by default,
 * to the left near the hall's right edge, under the table near its top, always inside the hall, and
 * clear of what floats over the hall where it has room).
 *
 * Its root is a layer the hall's size, the live region the card is announced in, which stays while
 * the bubble comes and goes; the bubble is drawn only while it has an anchor. It places itself again
 * when its anchor changes, when the page bumps `moved` (on the day map's `viewed`, as the map pans
 * and zooms), and when the hall or the bubble is resized; there is no animation-frame loop. It hides
 * while its table is out of view, and keeps a press and a wheel on it to itself, so pressing it
 * never pans the map under it. It says where it opened by `data-side`, `data-vert` and `--tail-x`.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SeatHalf } from '@/components/layout/layoutDrawing';
import { edgesIn, placeBubble, type BubblePlace } from './bubblePlacement';

const props = defineProps<{
  /** The table, or its half, the bubble speaks for; null draws no bubble. */
  anchor: { tableId: string; half: SeatHalf } | null;
  /** Where a table, or a half of it, is drawn on the screen now; null when it is not drawn. */
  locate: (tableId: string, half: SeatHalf) => DOMRect | null;
  /** Where what floats over the hall (its zoom, its legend) is drawn on the screen now. */
  clearOf: () => readonly DOMRect[];
  /** Bumped by the page whenever the map shows another part of the hall. */
  moved: number;
}>();

const layer = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const placed = ref<BubblePlace | null>(null);

function place() {
  const anchor = props.anchor;
  if (!anchor || !layer.value || !bubble.value) {
    placed.value = null;
    return;
  }
  const target = props.locate(anchor.tableId, anchor.half);
  if (!target) {
    placed.value = null;
    return;
  }
  const area = layer.value.getBoundingClientRect();
  const own = bubble.value.getBoundingClientRect();
  placed.value = placeBubble(
    { width: area.width, height: area.height },
    edgesIn(area, target),
    { width: own.width, height: own.height },
    props.clearOf().map((box) => edgesIn(area, box)),
  );
}

// After the render, so a bubble just drawn, and a table just drawn elsewhere, are measured.
watch(() => [props.anchor?.tableId, props.anchor?.half, props.moved], place, { flush: 'post' });

const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);

onMounted(() => {
  if (layer.value) resized?.observe(layer.value);
  place();
});

// The bubble itself comes and goes with its anchor: its own size is watched while it is drawn.
watch(
  bubble,
  (now, before) => {
    if (before) resized?.unobserve(before);
    if (now) resized?.observe(now);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => resized?.disconnect());
</script>

<template>
  <div
    ref="layer"
    class="public-map-bubble-layer"
    aria-live="polite"
    data-testid="public-map-bubble-layer"
  >
    <div
      v-if="anchor"
      ref="bubble"
      class="public-map-bubble"
      :class="{ 'public-map-bubble--hidden': !placed?.shown }"
      :style="
        placed
          ? { left: `${placed.left}px`, top: `${placed.top}px`, '--tail-x': `${placed.tailX}px` }
          : undefined
      "
      :data-side="placed?.side"
      :data-vert="placed?.vert"
      data-testid="public-map-bubble"
      @pointerdown.stop
      @wheel.stop
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* The hall's box, over the map; only the bubble in it takes a press. */
.public-map-bubble-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.public-map-bubble {
  position: absolute;
  top: 0;
  left: 0;
  width: min(18rem, calc(100% - 2 * var(--space-3)));
  padding: var(--space-4);
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-bubble);
  background: white;
  box-shadow: var(--shadow-float);
  pointer-events: auto;
  animation: public-map-bubble-in 160ms ease-out;
}

.public-map-bubble--hidden {
  visibility: hidden;
}

/* The tail: a square turned a quarter on its corner, its two outer sides edged as the bubble is,
   its point on the table at `--tail-x`; under the bubble when it opens up, over it when down. */
.public-map-bubble::after {
  content: '';
  position: absolute;
  left: calc(var(--tail-x) - 7px);
  width: 14px;
  height: 14px;
  border: 1px solid var(--mm-border-soft);
  border-top-color: transparent;
  border-left-color: transparent;
  background: white;
}

.public-map-bubble[data-vert='up']::after {
  bottom: -8px;
  transform: rotate(45deg);
}

.public-map-bubble[data-vert='down']::after {
  top: -8px;
  transform: rotate(-135deg);
}

@keyframes public-map-bubble-in {
  from {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-map-bubble {
    animation: none;
  }
}
</style>
