/**
 * Where the public map's speech bubble stands against the table it speaks for (T465), pure: up and
 * to the right of the table by default, to the left when the right-opening box would pass the
 * hall's right edge, under the table when the room over it is too short and less than the room
 * under it; always held inside the hall, with its tail moved along to stay on the table, and not
 * shown while the table is wholly out of view. What floats over the hall (its zoom and its legend)
 * is kept clear of, a gap away, by sliding the bubble along while its tail stays on the table, where
 * the hall has room for that; where it has none, the bubble stands where it would with nothing to
 * keep clear of. Every box is in pixels from the hall's top-left.
 */

/** The bubble's least distance from the hall's edges, `--space-2`. */
export const GAP = 8;
/** The tail's depth, between the table and the bubble, `--space-3`. */
export const TAIL = 12;
/** The tail's distance in from the bubble's near corner, when nothing holds it in. */
export const INSET = 28;
/** The tail's least distance from either corner of the bubble, so it never meets a round corner. */
const TAIL_EDGE = 20;

export interface Size {
  width: number;
  height: number;
}

/** A box's edges, in pixels from the hall's top-left. */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BubblePlace {
  left: number;
  top: number;
  /** The tail's point, in pixels from the bubble's left. */
  tailX: number;
  side: 'right' | 'left';
  vert: 'up' | 'down';
  /** Whether any of the table is in the hall. */
  shown: boolean;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** A box on the screen as edges from the top-left of an `area` on the screen. */
export function edgesIn(area: DOMRectReadOnly, box: DOMRectReadOnly): Edges {
  return {
    left: box.left - area.left,
    top: box.top - area.top,
    right: box.right - area.left,
    bottom: box.bottom - area.top,
  };
}

/** Whether any of a `target` box is in the `area`. */
export function inView(area: Size, target: Edges): boolean {
  return (
    target.right > 0 && target.left < area.width && target.bottom > 0 && target.top < area.height
  );
}

/** Whether a box comes within the gap of another. */
const crowds = (box: Edges, other: Edges) =>
  box.left < other.right + GAP &&
  other.left - GAP < box.right &&
  box.top < other.bottom + GAP &&
  other.top - GAP < box.bottom;

/** The bubble's place in the `area` (the hall) for a `target` (the table's box) and its size,
 *  kept clear of each box in `clearOf` where the area has room. */
export function placeBubble(
  area: Size,
  target: Edges,
  bubble: Size,
  clearOf: readonly Edges[] = [],
): BubblePlace {
  const x = (target.left + target.right) / 2;
  const roomUp = target.top - GAP - TAIL;
  const roomDown = area.height - target.bottom - GAP - TAIL;
  const vert = roomUp >= bubble.height || roomUp >= roomDown ? 'up' : 'down';
  const side = x - INSET + bubble.width > area.width - GAP ? 'left' : 'right';
  const opened = side === 'right' ? x - INSET : x - bubble.width + INSET;
  // The low bound is applied last, so it wins when the bubble is larger than the area.
  const left = Math.max(GAP, Math.min(opened, area.width - bubble.width - GAP));
  const rising = vert === 'up' ? target.top - TAIL - bubble.height : target.bottom + TAIL;
  const top = Math.max(GAP, Math.min(rising, area.height - bubble.height - GAP));
  const placed = (at: number, saying: 'right' | 'left'): BubblePlace => ({
    left: at,
    top,
    tailX: clamp(x - at, TAIL_EDGE, bubble.width - TAIL_EDGE),
    side: saying,
    vert,
    shown: inView(area, target),
  });
  const clear = (at: number) =>
    !clearOf.some((box) =>
      crowds({ left: at, top, right: at + bubble.width, bottom: top + bubble.height }, box),
    );
  if (clear(left)) return placed(left, side);

  // Slid along, the tail still on the table and the bubble still in the area: just past one side
  // or the other of what it would cover, the nearest of those that clears everything.
  const low = Math.max(GAP, x - bubble.width + TAIL_EDGE);
  const high = Math.min(area.width - bubble.width - GAP, x - TAIL_EDGE);
  const slid = clearOf
    .flatMap((box) => [box.left - GAP - bubble.width, box.right + GAP])
    .filter((at) => at >= low && at <= high && clear(at))
    .sort((a, b) => Math.abs(a - left) - Math.abs(b - left))[0];
  if (slid === undefined) return placed(left, side);
  // It says the way it opened by where its tail now stands: near its left corner, it opened right.
  return placed(slid, x - slid <= bubble.width / 2 ? 'right' : 'left');
}
