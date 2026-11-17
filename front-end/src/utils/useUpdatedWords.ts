import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import { updatedAgo } from '@/utils/updatedAgo';

/** Often enough that a minute's turn shows within a few seconds of it. */
const AGEING_MS = 10_000;

/**
 * When a list was last read, in words that age as they sit on screen (E38/F05/S03, T466):
 * "Updated just now", then whole minutes, then hours, `''` before the first read.
 *
 * Its clock turns every 10 seconds and stops with the scope that called it, a component's setup.
 * A read is now: it is said as just now at once, not at the next turn of the clock. `ListFreshness`
 * says it beside Refresh; Attendance says it under its map or over its list, its Refresh having
 * none.
 */
export function useUpdatedWords(readAt: Ref<number | null>): ComputedRef<string> {
  const now = ref(Date.now());
  const ageing = setInterval(() => (now.value = Date.now()), AGEING_MS);
  if (getCurrentScope()) onScopeDispose(() => clearInterval(ageing));

  return computed(() =>
    readAt.value === null ? '' : updatedAgo(readAt.value, Math.max(now.value, readAt.value)),
  );
}
