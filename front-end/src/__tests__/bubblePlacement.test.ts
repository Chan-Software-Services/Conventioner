/**
 * Where the public map's speech bubble stands against the table it speaks for (T465): up and to
 * the right of the table by default, to the left near the hall's right edge, under it near the
 * hall's top, always inside the hall, its tail on the table, and hidden while the table is out of
 * view. The hall is 1,000 by 600 px and the bubble 288 by 200 px unless a case says otherwise.
 */
import { describe, expect, it } from 'vitest';
import { GAP, INSET, TAIL, placeBubble } from '@/components/publicmap/bubblePlacement';

const AREA = { width: 1000, height: 600 };
const BUBBLE = { width: 288, height: 200 };

/** A table's box in the hall, 40 by 20 px, centred at (x, y). */
const tableAt = (x: number, y: number) => ({
  left: x - 20,
  top: y - 10,
  right: x + 20,
  bottom: y + 10,
});

describe("the bubble's constants", () => {
  it('are the design scale: an 8px gap, a 12px tail, the tail 28px in from the near corner', () => {
    expect([GAP, TAIL, INSET]).toEqual([8, 12, 28]);
  });
});

describe('a bubble at a table in the middle of the hall', () => {
  it('opens up and to the right, its tail over the table', () => {
    const placed = placeBubble(AREA, tableAt(400, 400), BUBBLE);
    expect(placed).toEqual({
      left: 400 - INSET,
      top: 390 - TAIL - 200,
      tailX: INSET,
      side: 'right',
      vert: 'up',
      shown: true,
    });
    // The tail's point is the table's centre across.
    expect(placed.left + placed.tailX).toBe(400);
  });
});

describe('a bubble at a table near the right edge', () => {
  it('opens to the left, its tail still over the table', () => {
    const placed = placeBubble(AREA, tableAt(900, 400), BUBBLE);
    expect(placed.side).toBe('left');
    expect(placed.vert).toBe('up');
    expect(placed.left).toBe(900 - 288 + INSET);
    expect(placed.left + placed.tailX).toBe(900);
    expect(placed.left + BUBBLE.width).toBeLessThanOrEqual(AREA.width - GAP);
  });

  it('opens to the right while the right-opening box still ends inside the gap', () => {
    // 1000 - 8 - 288 + 28 = 732: the last centre that opens right.
    expect(placeBubble(AREA, tableAt(732, 400), BUBBLE).side).toBe('right');
    expect(placeBubble(AREA, tableAt(733, 400), BUBBLE).side).toBe('left');
  });
});

describe('a bubble at a table near the top', () => {
  it('opens under the table, when there is more room under it', () => {
    const placed = placeBubble(AREA, tableAt(400, 60), BUBBLE);
    expect(placed.vert).toBe('down');
    expect(placed.side).toBe('right');
    expect(placed.top).toBe(70 + TAIL);
  });

  it('opens up when the room over the table holds the bubble, however much is under it', () => {
    // roomUp = 230 - 10 - 8 - 12 = 200, the bubble's height exactly.
    expect(placeBubble(AREA, tableAt(400, 230), BUBBLE).vert).toBe('up');
    expect(placeBubble(AREA, tableAt(400, 229), BUBBLE).vert).toBe('down');
  });

  it('opens up when neither way holds it but up has as much room as down', () => {
    const short = { width: 1000, height: 300 };
    expect(placeBubble(short, tableAt(400, 150), BUBBLE).vert).toBe('up');
    expect(placeBubble(short, tableAt(400, 149), BUBBLE).vert).toBe('down');
  });
});

describe('a bubble at a table in the top-right corner', () => {
  it('opens to the left and under the table', () => {
    const placed = placeBubble(AREA, tableAt(950, 40), BUBBLE);
    expect(placed.side).toBe('left');
    expect(placed.vert).toBe('down');
    expect(placed.top).toBe(50 + TAIL);
    expect(placed.left + BUBBLE.width).toBeLessThanOrEqual(AREA.width - GAP);
    expect(placed.left + placed.tailX).toBe(950);
  });
});

describe('a bubble at a table at the left edge', () => {
  it('is held inside the hall, its tail moved along to stay on the table', () => {
    const placed = placeBubble(AREA, tableAt(30, 400), BUBBLE);
    expect(placed.side).toBe('right');
    expect(placed.left).toBe(GAP);
    expect(placed.left + placed.tailX).toBe(30);
  });

  it('keeps its tail 20px in from its corner when the table is nearer the edge than that', () => {
    const placed = placeBubble(AREA, tableAt(10, 400), BUBBLE);
    expect(placed.left).toBe(GAP);
    expect(placed.tailX).toBe(20);
  });
});

describe("the tail's clamp", () => {
  it('holds the tail at least 20px in from either corner of the bubble', () => {
    // A table at the right edge: the bubble held in, the tail at its far corner, 20px in.
    const placed = placeBubble(AREA, tableAt(998, 400), BUBBLE);
    expect(placed.left).toBe(AREA.width - BUBBLE.width - GAP);
    expect(placed.tailX).toBe(BUBBLE.width - 20);
  });
});

describe('a bubble larger than the hall', () => {
  it('is held at the hall’s top-left inset, the low bound winning', () => {
    const small = { width: 200, height: 150 };
    const placed = placeBubble(small, tableAt(100, 75), BUBBLE);
    expect(placed.left).toBe(GAP);
    expect(placed.top).toBe(GAP);
    expect(placed.shown).toBe(true);
  });
});

describe('a bubble whose table is out of view', () => {
  it('is not shown while the table is wholly outside the hall, on any side', () => {
    for (const table of [
      tableAt(-30, 300),
      tableAt(1030, 300),
      tableAt(400, -20),
      tableAt(400, 620),
    ]) {
      expect(placeBubble(AREA, table, BUBBLE).shown).toBe(false);
    }
  });

  it('is shown while any of the table is inside the hall', () => {
    expect(placeBubble(AREA, tableAt(-10, 300), BUBBLE).shown).toBe(true);
    expect(placeBubble(AREA, tableAt(400, 605), BUBBLE).shown).toBe(true);
  });
});

// What floats over the hall (the zoom at its bottom right, the legend at its bottom left) is never
// under the bubble where the hall has room, so nothing but a table lies under it to take the focus.
describe('a bubble kept clear of what floats over the hall', () => {
  const ZOOM = { left: 880, top: 548, right: 988, bottom: 588 };
  const LEGEND = { left: 12, top: 548, right: 400, bottom: 588 };
  const TALL = { width: 288, height: 500 };

  it('stands where it would when nothing it would cover floats there', () => {
    expect(placeBubble(AREA, tableAt(400, 400), BUBBLE, [ZOOM, LEGEND])).toEqual(
      placeBubble(AREA, tableAt(400, 400), BUBBLE),
    );
  });

  it('slides along clear of the zoom, a gap from it, its tail kept on the table', () => {
    // Under a table near the top it would reach down over the zoom, from 672 to 960 across.
    expect(placeBubble(AREA, tableAt(700, 40), TALL).left).toBe(672);
    const placed = placeBubble(AREA, tableAt(700, 40), TALL, [ZOOM, LEGEND]);
    expect(placed.vert).toBe('down');
    expect(placed.top).toBe(50 + TAIL);
    expect(placed.left + TALL.width).toBe(ZOOM.left - GAP);
    expect(placed.left + placed.tailX).toBe(700);
    expect(placed.side).toBe('right');
  });

  it('slides along clear of the legend the other way', () => {
    const wideLegend = { left: 12, top: 548, right: 570, bottom: 588 };
    // Opening right from 572 it would come within the gap of the legend's end; it slides right.
    const placed = placeBubble(AREA, tableAt(600, 40), TALL, [wideLegend]);
    expect(placed.left).toBe(wideLegend.right + GAP);
    expect(placed.left + placed.tailX).toBe(600);
    expect(placed.side).toBe('right');
  });

  it('says it opened left when the slide leaves the table past its middle', () => {
    const placed = placeBubble(AREA, tableAt(500, 40), TALL, [
      { left: 600, top: 548, right: 988, bottom: 588 },
    ]);
    expect(placed.left + TALL.width).toBe(600 - GAP);
    expect(placed.left + placed.tailX).toBe(500);
    expect(placed.side).toBe('left');
  });

  it('keeps its place when no slide that keeps the tail on the table clears it', () => {
    // A table right over the zoom: every place with the tail on it covers the zoom.
    expect(placeBubble(AREA, tableAt(930, 40), TALL, [ZOOM])).toEqual(
      placeBubble(AREA, tableAt(930, 40), TALL),
    );
  });
});
