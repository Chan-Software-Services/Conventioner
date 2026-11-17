/**
 * Where the public map's speech bubble stands against the table it speaks for (T465), pure: up and
 * to the right of the table by default, to the left when the right-opening box would pass the
 * hall's right edge, under the table when the room over it is too short and less than the room
 * under it; always held inside the hall, with its tail moved along to stay on the table, and not
 * shown while the table is wholly out of view. Every box is in pixels from the hall's top-left.
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

/** The bubble's place in the `area` (the hall) for a `target` (the table's box) and its size. */
export function placeBubble(area: Size, target: Edges, bubble: Size): BubblePlace {
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
  return {
    left,
    top,
    tailX: clamp(x - left, TAIL_EDGE, bubble.width - TAIL_EDGE),
    side,
    vert,
    shown: inView(area, target),
  };
}
