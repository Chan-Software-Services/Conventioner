<script setup lang="ts">
/**
 * A screen's toolbar rows, pinned under the market's frame (T466, release walk F5 and F7), with the
 * screen under them.
 *
 * The `tools` slot is the block that pins, and the default slot the screen, both inside one root, so
 * the block's sticky containing block is the whole screen and it stays pinned to its end. From
 * 1024px, the frame's own break, the block sticks at `calc(var(--banner-h) +
 * var(--market-frame-h))`, under the frame and over the rows; under it the block scrolls away with
 * the page, as the frame's rail does. It draws no rule: its last row's is the block's bottom rule.
 *
 * Put it where it spans the card's whole width with nothing between it and the frame, so at rest it
 * already stands where it pins; the rows inside pad themselves.
 *
 * The block's height, measured rather than guessed as `MarketFrame` measures its own, is
 * `--pinned-tools-h` on the root (`0px` before the first measure, and with no `ResizeObserver`), so a
 * second sticky row in the screen stands under it at `top: calc(var(--banner-h) +
 * var(--market-frame-h) + var(--pinned-tools-h))`, read only inside its own `width >= 1024px` rule.
 * The block grows (a failed refresh's line, a row wrapping), so a fixed number would be wrong.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{ testid: string }>();

const root = ref<HTMLElement | null>(null);
const block = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;

function publish(px: number): void {
  root.value?.style.setProperty('--pinned-tools-h', `${px}px`);
}

onMounted(() => {
  publish(0);
  if (!block.value || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(() => publish(block.value?.offsetHeight ?? 0));
  observer.observe(block.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="root" class="pinned-tools">
    <div ref="block" class="pinned-tools__block" :data-testid="testid">
      <slot name="tools" />
    </div>
    <slot />
  </div>
</template>

<style scoped>
@media (width >= 1024px) {
  .pinned-tools__block {
    position: sticky;
    top: calc(var(--banner-h) + var(--market-frame-h));
    z-index: 10;
    background: white;
  }
}
</style>
