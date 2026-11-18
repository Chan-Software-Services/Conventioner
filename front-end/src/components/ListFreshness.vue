<script setup lang="ts">
/**
 * When a list was last read, and Refresh: the review's lists (E38/F05/S03) and the door's roster
 * (T318) show it.
 *
 * Others change what a list shows while someone works from it, and the list on screen is what was
 * read, not what is: this says how old it is, ageing as it sits, and reads it again on request. The
 * view owns the read; this only shows it and asks for another. `testid` starts its test ids, so
 * each screen's are its own: `<testid>-updated`, `<testid>-refresh`, `<testid>-refresh-error`.
 * With `showTime` false it draws no time (T466): Attendance says it under its map or over its list.
 */
import { toRef } from 'vue';
import { useUpdatedWords } from '@/utils/useUpdatedWords';

const props = withDefaults(
  defineProps<{
    /** When the list was last read from the server, in milliseconds, or null before the first. */
    readAt: number | null;
    refreshing: boolean;
    /** Why the last refresh failed, in one line; empty when it did not. */
    failed: string;
    testid: string;
    /** `false` draws no time, only Refresh and a failed refresh, for a screen that says it elsewhere. */
    showTime?: boolean;
  }>(),
  { showTime: true },
);
const emit = defineEmits<{ refresh: [] }>();

const words = useUpdatedWords(toRef(props, 'readAt'));
</script>

<template>
  <div class="freshness">
    <span v-if="showTime && words" class="freshness-time" :data-testid="`${testid}-updated`">{{
      words
    }}</span>
    <button
      type="button"
      class="btn btn--secondary btn--compact"
      :disabled="refreshing"
      :data-testid="`${testid}-refresh`"
      @click="emit('refresh')"
    >
      Refresh
    </button>
    <span
      v-if="failed"
      class="freshness-error"
      role="alert"
      :data-testid="`${testid}-refresh-error`"
    >
      {{ failed }}
    </span>
  </div>
</template>

<style scoped>
.freshness {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.freshness-time {
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.freshness-error {
  font-size: var(--text-xs);
  color: var(--mm-red);
}
</style>
