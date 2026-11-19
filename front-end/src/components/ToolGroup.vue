<script setup lang="ts">
/**
 * A group of a toolbar's controls (T466, release walk F5): Print roster beside Door code, Refresh
 * on its own. Above a phone a group after another stands a rule apart from it; on a phone a group's
 * controls wrap as the row's own, so no rule is left stranded at a wrapped line's start.
 */
</script>

<template>
  <div class="tool-group"><slot /></div>
</template>

<style scoped>
.tool-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

@media (width > 640px) {
  .tool-group + .tool-group {
    padding-inline-start: var(--space-3);
    border-inline-start: 1px solid var(--mm-border);
  }
}

@media (width <= 640px) {
  .tool-group {
    display: contents;
  }
}
</style>
