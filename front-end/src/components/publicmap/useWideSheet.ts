/**
 * Whether the public map's sheet stands in its two columns, the map beside the vendor panel (T465):
 * the window 1000px wide or wider, as the sheet's own media query says. The page stands the card of
 * the table picked in the speech bubble then, and at the vendor panel's top when not, so one card
 * is ever in the page. A window with no `matchMedia` (a test's) is wide.
 */
import { onScopeDispose, readonly, ref, type Ref } from 'vue';

/** The sheet's two columns: `PublicMapView.vue`'s `@media (width >= 1000px)`. */
export const WIDE_SHEET = '(width >= 1000px)';

export function useWideSheet(): Readonly<Ref<boolean>> {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_SHEET) : null;
  const wide = ref(query ? query.matches : true);
  if (query) {
    const heard = (event: MediaQueryListEvent) => {
      wide.value = event.matches;
    };
    query.addEventListener('change', heard);
    onScopeDispose(() => query.removeEventListener('change', heard));
  }
  return readonly(wide);
}
