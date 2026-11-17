<script setup lang="ts">
/**
 * The public map's backdrop (T465): a layer fixed to the window under the app bar, a tenth of the
 * window past each edge so its blur never fades at one, painting the near-white paper the sheet
 * stands on. It takes no press and says nothing to a screen reader.
 */
import type { DayMapLocation } from '@/components/daymap/dayMap';

defineProps<{
  /** The market's halls, whose sections' colours the backdrop is dealt from. */
  locations: readonly DayMapLocation[];
}>();
</script>

<template>
  <svg
    class="public-map-backdrop"
    viewBox="0 0 1440 900"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
    data-testid="public-map-backdrop"
  >
    <rect class="public-map-backdrop__paper" width="1440" height="900" />
  </svg>
</template>

<style scoped>
.public-map-backdrop {
  position: fixed;
  top: calc(var(--banner-h) - 10vh);
  left: -10vw;
  z-index: 0;
  width: 120vw;
  height: calc(120vh - var(--banner-h));
  pointer-events: none;
  filter: blur(80px);
}

.public-map-backdrop__paper {
  fill: var(--mm-paper);
}
</style>
