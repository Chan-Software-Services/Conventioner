/**
 * How the floorplan is drawn under a layout's tables (T422, the QC walk's item 8, D5 and D8): Show
 * the floorplan, Greyscale and Faded, all ticked on a first visit, are the person's choices, kept
 * in their browser for every layout, so a reload keeps them; where the browser keeps nothing they
 * hold for the page's life. The editor's are in the Floorplan menu on the map's zoom bar, a menu
 * with menu roles that Escape and a press outside close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { choiceKey, rememberedChoice } from '@/components/layout/layoutViewChoices';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };

/** A choice as a page holds it, made in a component's setup. */
function aChoice(name: string, fallback: boolean) {
  let choice!: ReturnType<typeof rememberedChoice>;
  const page = mount(
    defineComponent({
      setup() {
        choice = rememberedChoice(name, fallback);
        return () => h('div');
      },
    }),
  );
  return { choice, page };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe("a choice of the floorplan's view", () => {
  it('starts at its default on a first visit', () => {
    expect(aChoice('imageFaded', true).choice.value).toBe(true);
    expect(aChoice('shortcutsShown', false).choice.value).toBe(false);
  });

  it('is kept in the browser as it changes, and read back after a reload', async () => {
    const first = aChoice('imageFaded', true);
    first.choice.value = false;
    await nextTick();
    expect(localStorage.getItem(choiceKey('imageFaded'))).toBe('0');
    expect(choiceKey('imageFaded')).toBe('conventioner.layout.imageFaded');
    first.page.unmount();

    expect(aChoice('imageFaded', true).choice.value).toBe(false);
    // One choice for every layout: another of the names is its own.
    expect(aChoice('imageInGrey', true).choice.value).toBe(true);
  });

  it('reads anything but what it writes as its default', () => {
    localStorage.setItem(choiceKey('showImage'), 'false');
    expect(aChoice('showImage', true).choice.value).toBe(true);
  });

  it('holds for the page where the browser keeps nothing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    const { choice } = aChoice('imageInGrey', true);
    expect(choice.value).toBe(true);
    choice.value = false;
    await nextTick();
    expect(choice.value).toBe(false);
  });
});

describe("the map's Floorplan menu", () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  function anEditor(
    view: { showImage?: boolean; imageInGrey?: boolean; imageFaded?: boolean } = {},
  ) {
    const editor = useLayoutEditor({
      save: (layout: FloorplanObject): Promise<SavedLayout> =>
        Promise.resolve({ floorplan: { ...layout, revision: layout.revision + 1 }, sections: [] }),
      tableTypes: () => [SIX_FOOT],
    });
    editor.adopt({
      id: 'fp-1',
      locationId: 'loc-upper',
      revision: 3,
      imageGridfsId: 'image-1',
      imageWidth: 800,
      imageHeight: 600,
      scalePxPerUnit: 800 / 30_000,
      tables: [],
      zones: [],
      sectionStyles: [],
      startingCounts: [],
    });
    wrapper = mount(LayoutEditor, {
      props: {
        editor,
        locationName: 'Upper Hall',
        sections: [],
        tableTypes: [SIX_FOOT],
        imageUrl: 'blob:floorplan',
        showImage: true,
        imageInGrey: true,
        imageFaded: true,
        ...view,
      },
      attachTo: document.body,
    });
    return wrapper;
  }
  const button = (w: VueWrapper) => w.get('[data-testid="layout-view-menu-button"]');
  const item = (w: VueWrapper, id: string) => w.get(`[data-testid="layout-view-menu-${id}"]`);
  const menu = (w: VueWrapper) => w.find('[data-testid="layout-view-menu"]');

  it('is a menu of three ticks, all ticked, opened from the zoom bar', async () => {
    const w = anEditor();
    expect(button(w).text()).toBe('Floorplan');
    expect(button(w).attributes()).toMatchObject({
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    expect(button(w).element.closest('[data-testid="layout-zoom-controls"]')).not.toBeNull();

    await button(w).trigger('click');
    expect(menu(w).attributes('role')).toBe('menu');
    const items = menu(w).findAll('button');
    expect(
      items.map((one) => [one.text(), one.attributes('role'), one.attributes('aria-checked')]),
    ).toEqual([
      ['Show the floorplan', 'menuitemcheckbox', 'true'],
      ['Greyscale', 'menuitemcheckbox', 'true'],
      ['Faded', 'menuitemcheckbox', 'true'],
    ]);
  });

  it('asks the page for each choice and stays open for the next', async () => {
    const w = anEditor();
    await button(w).trigger('click');
    await item(w, 'image-faded').trigger('click');
    expect(w.emitted('update:imageFaded')).toEqual([[false]]);
    await item(w, 'image-grey').trigger('click');
    expect(w.emitted('update:imageInGrey')).toEqual([[false]]);
    await item(w, 'show-image').trigger('click');
    expect(w.emitted('update:showImage')).toEqual([[false]]);
    expect(menu(w).exists()).toBe(true);
  });

  it('disables Greyscale and Faded while the floorplan is hidden', async () => {
    const w = anEditor({ showImage: false });
    await button(w).trigger('click');
    expect(item(w, 'show-image').attributes('aria-checked')).toBe('false');
    for (const id of ['image-grey', 'image-faded']) {
      expect(item(w, id).attributes('aria-disabled'), id).toBe('true');
      await item(w, id).trigger('click');
    }
    expect(w.emitted('update:imageInGrey')).toBeUndefined();
    expect(w.emitted('update:imageFaded')).toBeUndefined();
  });

  it('closes on Escape with the focus on its button, the tool and the selection left as they were', async () => {
    const w = anEditor();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    await nextTick();
    expect(w.emitted<[string]>('tool')!.at(-1)).toEqual(['row']);
    (button(w).element as HTMLButtonElement).focus();
    await button(w).trigger('click');
    await vi.waitFor(() => expect(document.activeElement).toBe(item(w, 'show-image').element));

    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(button(w).element));
    expect(menu(w).exists()).toBe(false);
    expect(w.emitted<[string]>('tool')!.at(-1)).toEqual(['row']);
  });

  it('closes on a press outside it', async () => {
    const w = anEditor();
    await button(w).trigger('click');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(menu(w).exists()).toBe(false);
  });

  it('walks its items by the arrow keys, the disabled ones too', async () => {
    const w = anEditor({ showImage: false });
    await button(w).trigger('click');
    await vi.waitFor(() => expect(document.activeElement).toBe(item(w, 'show-image').element));
    await menu(w).trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item(w, 'image-grey').element);
    await menu(w).trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(item(w, 'image-faded').element);
  });
});
