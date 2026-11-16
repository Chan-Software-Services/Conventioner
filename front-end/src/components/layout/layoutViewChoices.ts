/**
 * How the person looks at a layout (T422, D7 and D8): whether the floorplan is drawn under the
 * tables, in grey and faded, and whether the keyboard's shortcuts are shown beside the page. Each
 * is the person's choice, one for every layout and market in their browser, and none is the
 * layout's: Export PNG keeps its own tick.
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/** Where a choice is kept: `conventioner.layout.<name>`, "1" or "0". */
export const choiceKey = (name: string) => `conventioner.layout.${name}`;

/**
 * A choice kept in the browser, so it holds after a reload and on every layout; where the browser
 * keeps nothing (storage refused, as a private window may) it holds for the page's life, from its
 * default.
 */
export function rememberedChoice(name: string, fallback: boolean): Ref<boolean> {
  const key = choiceKey(name);
  let start = fallback;
  try {
    const kept = localStorage.getItem(key);
    if (kept === '1' || kept === '0') start = kept === '1';
  } catch {
    // Nothing kept: the default.
  }
  const choice = ref(start);
  watch(choice, (now) => {
    try {
      localStorage.setItem(key, now ? '1' : '0');
    } catch {
      // Kept for the page's life only.
    }
  });
  return choice;
}

/** The shortcuts panel's width. */
export const SHORTCUTS_WIDTH = '24rem';

/**
 * The window wide enough to stand the shortcuts panel beside the market's frame: the frame's
 * width (`--workspace-max`) and, on each side, the panel with a margin either side of it (D7).
 * Written from the tokens' values, since a media query reads no custom property.
 */
export const besideTheFrameQuery = (frameWidth: string, margin: string) =>
  `(min-width: calc(${frameWidth} + 2 * (${SHORTCUTS_WIDTH} + 2 * ${margin})))`;

/** Whether the window has room for the shortcuts beside the market's frame, as it changes. */
export function useRoomBesideTheFrame(): Ref<boolean> {
  const room = ref(false);
  let query: MediaQueryList | null = null;
  const read = () => {
    room.value = Boolean(query?.matches);
  };
  onMounted(() => {
    const tokens = getComputedStyle(document.documentElement);
    const frame = tokens.getPropertyValue('--workspace-max').trim();
    const margin = tokens.getPropertyValue('--space-4').trim();
    if (!frame || !margin || typeof window.matchMedia !== 'function') return;
    query = window.matchMedia(besideTheFrameQuery(frame, margin));
    query.addEventListener('change', read);
    read();
  });
  onBeforeUnmount(() => query?.removeEventListener('change', read));
  return room;
}
