// @vitest-environment happy-dom
/**
 * The public map's speech bubble at a desk (T465), mounted alone in a hall 1,000 by 600 px: it
 * stands where `placeBubble` puts it against the table it is given, says where it opened, places
 * itself again on its anchor, on `moved` and on a resize of the hall or of itself, with no
 * animation-frame loop, keeps clear of what floats over the hall where it can, hides while its table is out of view, keeps a press and a wheel to itself,
 * and leaves no observer behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PublicMapBubble from '@/components/publicmap/PublicMapBubble.vue';
import { INSET, TAIL } from '@/components/publicmap/bubblePlacement';

/** Every `ResizeObserver` the bubble made, what each observes, and whether it was let go. */
const observers: { callback: () => void; observed: Element[]; disconnected: boolean }[] = [];
class FakeResizeObserver {
  private readonly record: (typeof observers)[number];
  constructor(callback: () => void) {
    this.record = { callback, observed: [], disconnected: false };
    observers.push(this.record);
  }
  observe(element: Element) {
    this.record.observed.push(element);
  }
  unobserve(element: Element) {
    this.record.observed = this.record.observed.filter((el) => el !== element);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

/** The hall's box on the screen, and the bubble's size. */
const HALL = new DOMRect(100, 50, 1000, 600);
let bubbleSize = { width: 288, height: 200 };

/** Where each table is drawn on the screen, by id. */
let tables: Record<string, DOMRect> = {};
const locate = vi.fn((tableId: string) => tables[tableId] ?? null);

/** What floats over the hall on the screen (its zoom, its legend), which the bubble keeps clear of. */
let floating: DOMRect[] = [];
const clearOf = () => floating;

/** A table 40 by 20 px whose centre is (x, y) in the hall. */
const inHall = (x: number, y: number) => new DOMRect(HALL.x + x - 20, HALL.y + y - 10, 40, 20);

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  bubbleSize = { width: 288, height: 200 };
  floating = [];
  tables = { a: inHall(400, 400), b: inHall(400, 250), corner: inHall(950, 40) };
  locate.mockClear();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-testid');
    if (id === 'public-map-bubble-layer') return HALL;
    if (id === 'public-map-bubble') return new DOMRect(0, 0, bubbleSize.width, bubbleSize.height);
    return new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function bubbleAt(tableId: string | null, moved = 0) {
  wrapper = mount(PublicMapBubble, {
    attachTo: document.body,
    props: { anchor: tableId ? { tableId, half: 'whole' } : null, locate, clearOf, moved },
    slots: { default: '<p data-testid="said">Kiln & Co</p>' },
  });
  await flushPromises();
  return wrapper;
}

const bubble = () => wrapper!.get('[data-testid="public-map-bubble"]');
const styleOf = (prop: string) =>
  (bubble().element as HTMLElement).style.getPropertyValue(prop).trim();

describe('the bubble', () => {
  it('stands up and to the right of its table, its tail on it, saying so', async () => {
    await bubbleAt('a');
    expect(bubble().get('[data-testid="said"]').text()).toBe('Kiln & Co');
    expect(locate).toHaveBeenLastCalledWith('a', 'whole');
    expect(bubble().attributes('data-side')).toBe('right');
    expect(bubble().attributes('data-vert')).toBe('up');
    expect(styleOf('left')).toBe(`${400 - INSET}px`);
    expect(styleOf('top')).toBe(`${390 - TAIL - 200}px`);
    expect(styleOf('--tail-x')).toBe(`${INSET}px`);
    expect(bubble().classes()).not.toContain('public-map-bubble--hidden');
  });

  it('opens to the left and under a table in the top-right corner', async () => {
    await bubbleAt('corner');
    expect(bubble().attributes('data-side')).toBe('left');
    expect(bubble().attributes('data-vert')).toBe('down');
  });

  it('is drawn nowhere with no anchor, and the live layer stays', async () => {
    const layer = await bubbleAt(null);
    expect(layer.find('[data-testid="public-map-bubble"]').exists()).toBe(false);
    expect(layer.get('[data-testid="public-map-bubble-layer"]').attributes('aria-live')).toBe(
      'polite',
    );
    await layer.setProps({ anchor: { tableId: 'a', half: 'whole' } });
    await flushPromises();
    expect(bubble().attributes('data-side')).toBe('right');
  });

  it('places itself again on a new anchor, and when moved is bumped', async () => {
    const at = await bubbleAt('a');
    await at.setProps({ anchor: { tableId: 'corner', half: 'whole' } });
    await flushPromises();
    expect(bubble().attributes('data-side')).toBe('left');
    // The map zoomed: the same table now drawn elsewhere, heard as `moved`.
    tables.corner = inHall(300, 400);
    await at.setProps({ moved: 1 });
    await flushPromises();
    expect(bubble().attributes('data-side')).toBe('right');
    expect(styleOf('left')).toBe(`${300 - INSET}px`);
  });

  it('keeps clear of what floats over the hall, its tail on its table', async () => {
    // A tall card under a table near the top, which would reach down over the zoom.
    bubbleSize = { width: 288, height: 500 };
    tables.top = inHall(700, 40);
    floating = [new DOMRect(HALL.x + 880, HALL.y + 548, 108, 40)];
    await bubbleAt('top');
    expect(bubble().attributes('data-vert')).toBe('down');
    expect(styleOf('left')).toBe(`${880 - 8 - 288}px`);
    expect(styleOf('--tail-x')).toBe(`${700 - (880 - 8 - 288)}px`);
  });

  it('places itself again when the hall or the bubble is resized', async () => {
    await bubbleAt('b');
    expect(bubble().attributes('data-vert')).toBe('up');
    const observed = observers.flatMap((o) => o.observed);
    expect(observed.map((el) => el.getAttribute('data-testid')).sort()).toEqual([
      'public-map-bubble',
      'public-map-bubble-layer',
    ]);
    // The bubble grew taller than the room over its table, which is less than under it.
    bubbleSize = { width: 288, height: 260 };
    observers.forEach((o) => o.callback());
    await flushPromises();
    expect(bubble().attributes('data-vert')).toBe('down');
  });

  it('hides while its table is out of view, and comes back with it', async () => {
    const at = await bubbleAt('a');
    tables.a = inHall(400, -40);
    await at.setProps({ moved: 1 });
    await flushPromises();
    expect(bubble().classes()).toContain('public-map-bubble--hidden');
    tables.a = inHall(400, 400);
    await at.setProps({ moved: 2 });
    await flushPromises();
    expect(bubble().classes()).not.toContain('public-map-bubble--hidden');
  });

  it('hides when its table is not drawn at all', async () => {
    await bubbleAt('gone');
    expect(bubble().classes()).toContain('public-map-bubble--hidden');
  });

  it('keeps a press and a wheel on it to itself, so the map never pans under it', async () => {
    await bubbleAt('a');
    const heard = vi.fn();
    document.body.addEventListener('pointerdown', heard);
    document.body.addEventListener('wheel', heard);
    bubble().element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    bubble().element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(heard).not.toHaveBeenCalled();
    document.body.removeEventListener('pointerdown', heard);
    document.body.removeEventListener('wheel', heard);
  });

  it('runs no animation-frame loop, and lets every observer go on unmount', async () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const at = await bubbleAt('a');
    expect(frame).not.toHaveBeenCalled();
    at.unmount();
    wrapper = null;
    expect(observers.length).toBeGreaterThan(0);
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  it('places itself on its anchor and on moved alone with no ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const at = await bubbleAt('a');
    expect(bubble().attributes('data-side')).toBe('right');
    tables.a = inHall(950, 40);
    await at.setProps({ moved: 1 });
    await flushPromises();
    expect(bubble().attributes('data-side')).toBe('left');
  });
});
