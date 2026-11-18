import { nextTick } from 'vue';
import type { VueWrapper } from '@vue/test-utils';
import type { ReviewViewTools } from '@/components/application/reviewViewTools';

/**
 * What a review view exposes for the tab's toolbar (T466): its read state, Refresh and Export, as
 * the toolbar reads and presses them, for a test that mounts the view alone.
 */
export const toolsOf = (wrapper: VueWrapper) => wrapper.vm as unknown as ReviewViewTools;

/** Refresh, as the toolbar's button asks it, then the tick a click would wait for. */
export async function pressRefresh(wrapper: VueWrapper): Promise<void> {
  toolsOf(wrapper).refresh();
  await nextTick();
}
