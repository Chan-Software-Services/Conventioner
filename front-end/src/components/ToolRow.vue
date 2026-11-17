<script setup lang="ts">
/**
 * One row of a screen's toolbar (T466, release walk F5 and F7): its controls the compact height,
 * 12px over and under them, set off by a rule that runs edge to edge, since the row is as wide as
 * the card it stands in.
 *
 * The default slot is the row's start, which grows to take the room left, so a search in it can
 * fill the row. The `end` slot, drawn only when given, stands at the row's inline end and moves
 * under the start whole when the row is too narrow; on a phone it starts its own line at the start
 * edge and wraps. No height is written: the row is its controls' height and its padding.
 */
defineProps<{ testid: string }>();
</script>

<template>
  <div class="tool-row" :data-testid="testid">
    <div class="tool-row__start"><slot /></div>
    <div v-if="$slots.end" class="tool-row__end"><slot name="end" /></div>
  </div>
</template>

<style scoped>
.tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-6);
  border-block-end: 1px solid var(--mm-border);
  background: white;
}

.tool-row__start {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  min-width: 0;
}

.tool-row__end {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-3);
  margin-inline-start: auto;
}

/* A phone's gutter, and the end on its own lines from the start edge, as the start's are. */
@media (width <= 640px) {
  .tool-row {
    padding-inline: var(--space-4);
  }

  .tool-row__end {
    flex-basis: 100%;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-inline-start: 0;
  }
}
</style>
