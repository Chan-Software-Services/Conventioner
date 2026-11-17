/**
 * A page that fills the window under the app bar and never scrolls, the public map (T465): while it
 * is mounted `<html>` carries `fills-the-window`, so `base.css` keeps no gutter for a bar the window
 * never shows. The pages holding the class are counted, so one leaving while another is still
 * mounted (a move between two such pages) leaves the class on.
 */
import { onMounted, onUnmounted } from 'vue';

const FILLS_THE_WINDOW = 'fills-the-window';

let holders = 0;

export function useFillsTheWindow(): void {
  onMounted(() => {
    holders += 1;
    document.documentElement.classList.add(FILLS_THE_WINDOW);
  });
  onUnmounted(() => {
    holders = Math.max(0, holders - 1);
    if (holders === 0) document.documentElement.classList.remove(FILLS_THE_WINDOW);
  });
}
