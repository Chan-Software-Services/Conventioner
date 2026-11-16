/**
 * A section's colours open in a bubble (T422, the QC walk's item 13, D6): it closes on a colour, on
 * Escape and on a press anywhere else, the focus back on the swatch unless the press put it
 * somewhere; near the window's foot it hangs above the swatch instead. That the card keeps its
 * height with it open is measured by a browser (`the-layout-page-holds-still.spec.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { SectionObject } from '@/assets/types/datatypes';
import LayoutPanelSections from '@/components/layout/LayoutPanelSections.vue';
import { layoutSections } from '@/components/layout/layoutDrawing';

const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'sec-gold', name: 'Gold row', location: UPPER, tier: null, count: 0 },
  { id: 'sec-silver', name: 'Silver aisle', location: UPPER, tier: null, count: 0 },
];
const LAYOUT = {
  locationId: UPPER.id,
  tables: [],
  sectionStyles: [],
};

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function card() {
  wrapper = mount(LayoutPanelSections, {
    props: {
      locationName: 'Upper Hall',
      sections: layoutSections(LAYOUT, SECTIONS),
      editable: true,
    },
    attachTo: document.body,
  });
  return wrapper;
}

const bubble = () => document.querySelector<HTMLElement>('[data-testid="layout-panel-palette"]');
const swatch = (w: VueWrapper, at = 0) =>
  w.findAll('[data-testid="layout-panel-section-colour"]')[at].element as HTMLButtonElement;

/** A press as a pointer makes one: down, then up, on the element. */
function press(on: Element) {
  on.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  on.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

describe("a section's colour bubble", () => {
  it('closes on a press outside it, the focus back on its swatch when the press took none', async () => {
    const w = card();
    swatch(w).focus();
    await w.findAll('[data-testid="layout-panel-section-colour"]')[0].trigger('click');
    await vi.waitFor(() => expect(bubble()!.contains(document.activeElement)).toBe(true));

    // A press on the card's title, which takes no focus: the focus it leaves falls to the page.
    const title = w.get('h2').element;
    (document.activeElement as HTMLElement).blur();
    press(title);
    await w.vm.$nextTick();

    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(swatch(w));
    expect(w.emitted('color')).toBeUndefined();
  });

  it('leaves the focus where a press outside it put it', async () => {
    const w = card();
    const outside = document.createElement('button');
    document.body.append(outside);
    swatch(w).focus();
    await w.findAll('[data-testid="layout-panel-section-colour"]')[0].trigger('click');

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    outside.focus();
    outside.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await w.vm.$nextTick();

    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('stays open through a press inside it, and through one on its own swatch', async () => {
    const w = card();
    await w.findAll('[data-testid="layout-panel-section-colour"]')[0].trigger('click');

    press(bubble()!.querySelector('button')!);
    await w.vm.$nextTick();
    expect(bubble()).not.toBeNull();
  });

  it('keeps Escape its own, so nothing under the card takes it too', async () => {
    const w = card();
    const below = vi.fn();
    window.addEventListener('keydown', below);
    try {
      await w.findAll('[data-testid="layout-panel-section-colour"]')[0].trigger('click');
      const choice = bubble()!.querySelector('button')!;
      choice.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(swatch(w)));
      expect(bubble()).toBeNull();
      expect(below).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', below);
    }
  });

  it("hangs above its swatch where under it it would run past the window's foot", async () => {
    const w = card();
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('[data-palette]')) {
        return { top: 850, bottom: window.innerHeight + 40, left: 0, right: 120 } as DOMRect;
      }
      return real.call(this);
    });

    await w.findAll('[data-testid="layout-panel-section-colour"]')[1].trigger('click');
    await w.vm.$nextTick();

    expect(bubble()!.classList.contains('sections-palette--above')).toBe(true);
  });

  it('hangs under its swatch again when opened where there is room', async () => {
    const w = card();
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockReturnValue({ top: 850, bottom: window.innerHeight + 40 } as DOMRect);
    await w.findAll('[data-testid="layout-panel-section-colour"]')[1].trigger('click');
    await w.vm.$nextTick();
    expect(bubble()!.classList.contains('sections-palette--above')).toBe(true);
    await w.findAll('[data-testid="layout-panel-section-colour"]')[1].trigger('click');

    spy.mockReturnValue({ top: 100, bottom: 200 } as DOMRect);
    await w.findAll('[data-testid="layout-panel-section-colour"]')[0].trigger('click');
    await w.vm.$nextTick();
    expect(bubble()!.classList.contains('sections-palette--above')).toBe(false);
  });
});
