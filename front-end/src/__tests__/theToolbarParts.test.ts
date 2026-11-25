/**
 * The toolbar's shared parts (T466, release walk F5 and F7): `ToolRow`, `ToolGroup`,
 * `SegmentedControl` and `PinnedTools`, which Attendance's and Applications' toolbars are built
 * from.
 *
 * Behaviour is driven through the mounted component, as a person would press it; the look is read
 * from the stylesheets that ship, as `primitives.test.ts` reads its own, since happy-dom applies
 * none, so a mounted component would assert nothing of a border or a breakpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import type postcss from 'postcss';
import SegmentedControl from '@/components/SegmentedControl.vue';
import ToolRow from '@/components/ToolRow.vue';
import ToolGroup from '@/components/ToolGroup.vue';
import PinnedTools from '@/components/PinnedTools.vue';
import { stylesOf, valueOf } from './support/sfcStyles';

/** Every declaration in a file's styles, as `property: value`. */
function everyDeclaration(root: postcss.Root): string[] {
  const found: string[] = [];
  root.walkDecls((decl) => {
    found.push(`${decl.prop}: ${decl.value}`);
  });
  return found;
}

const PHONE = '(width <= 640px)';
const DESK = '(width > 640px)';

describe('SegmentedControl', () => {
  const OPTIONS = [
    { id: 'list', label: 'List' },
    { id: 'map', label: 'Map' },
  ];

  function mountControl(props: Record<string, unknown> = {}) {
    const wrapper = mount(SegmentedControl, {
      props: {
        options: OPTIONS,
        modelValue: 'list',
        label: 'Show as',
        testid: 'view',
        ...props,
        'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
      },
    });
    const emitted = () => (wrapper.emitted('update:modelValue') ?? []).map(([value]) => value);
    const pressed = () =>
      wrapper
        .findAll('button')
        .filter((button) => button.attributes('aria-pressed') === 'true')
        .map((button) => button.text());
    return { wrapper, emitted, pressed };
  }

  it('is one group named by its label, each option a compact secondary button', () => {
    const { wrapper } = mountControl();
    const group = wrapper.get('[data-testid="view"]');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-label')).toBe('Show as');
    expect(group.attributes('aria-describedby')).toBeUndefined();

    const buttons = wrapper.findAll('button');
    expect(buttons.map((button) => button.text())).toEqual(['List', 'Map']);
    expect(buttons.map((button) => button.attributes('data-testid'))).toEqual([
      'view-list',
      'view-map',
    ]);
    for (const button of buttons) {
      expect(button.attributes('type')).toBe('button');
      expect(button.classes()).toEqual(
        expect.arrayContaining(['btn', 'btn--secondary', 'btn--compact']),
      );
    }
  });

  it('is described by the words it is given', () => {
    const { wrapper } = mountControl({ describedBy: 'views-hint' });
    expect(wrapper.get('[data-testid="view"]').attributes('aria-describedby')).toBe('views-hint');
  });

  it('presses the chosen option, and a press chooses another', async () => {
    const { wrapper, emitted, pressed } = mountControl();
    expect(pressed()).toEqual(['List']);
    expect(wrapper.get('[data-testid="view-map"]').attributes('aria-pressed')).toBe('false');

    await wrapper.get('[data-testid="view-map"]').trigger('click');
    expect(emitted()).toEqual(['map']);
    expect(pressed()).toEqual(['Map']);
  });

  it('emits nothing when the pressed option is pressed again: one is always on', async () => {
    const { wrapper, emitted, pressed } = mountControl();
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    expect(emitted()).toEqual([]);
    expect(pressed()).toEqual(['List']);
  });

  it('wraps on a phone only when asked', () => {
    expect(mountControl().wrapper.get('[data-testid="view"]').classes()).not.toContain(
      'segmented--wraps',
    );
    expect(
      mountControl({ wrapsOnAPhone: true }).wrapper.get('[data-testid="view"]').classes(),
    ).toContain('segmented--wraps');
  });

  describe('its look', () => {
    const styles = stylesOf('SegmentedControl.vue');

    it('joins the options into one box: no gap, no overlap, square inner corners', () => {
      expect(valueOf(styles, '.segmented', 'display')).toBe('flex');
      expect(valueOf(styles, '.segmented', 'gap')).toBeNull();
      expect(valueOf(styles, '.segmented__option', 'border-radius')).toBe('0');
      expect(valueOf(styles, '.segmented__option', 'white-space')).toBe('nowrap');
      expect(valueOf(styles, '.segmented__option', 'min-width')).toBe('var(--target-min)');
      // Each keeps its own border; the one after the first gives up its start edge rather than
      // being pulled over its neighbour by a negative margin.
      expect(
        valueOf(styles, '.segmented__option + .segmented__option', 'border-inline-start-width'),
      ).toBe('0');
      expect(everyDeclaration(styles).filter((decl) => /^margin/.test(decl))).toEqual([]);
      for (const corner of ['border-start-start-radius', 'border-end-start-radius']) {
        expect(valueOf(styles, '.segmented__option:first-child', corner)).toBe(
          'var(--radius-control)',
        );
      }
      for (const corner of ['border-start-end-radius', 'border-end-end-radius']) {
        expect(valueOf(styles, '.segmented__option:last-child', corner)).toBe(
          'var(--radius-control)',
        );
      }
    });

    it("draws the pressed option's start edge green through the option before it", () => {
      expect(
        valueOf(
          styles,
          ".segmented__option:has(+ [aria-pressed='true'])",
          'border-inline-end-color',
        ),
      ).toBe('var(--mm-green)');
    });

    it('on a phone, with wrapsOnAPhone, wraps a small step apart, each option whole and round', () => {
      expect(valueOf(styles, '.segmented--wraps', 'flex-wrap', PHONE)).toBe('wrap');
      expect(valueOf(styles, '.segmented--wraps', 'gap', PHONE)).toBe('var(--space-1)');
      expect(valueOf(styles, '.segmented--wraps .segmented__option', 'border-width', PHONE)).toBe(
        '1px',
      );
      expect(valueOf(styles, '.segmented--wraps .segmented__option', 'border-radius', PHONE)).toBe(
        'var(--radius-control)',
      );
      // The phone rule outranks the joined box's, which is the point of repeating the class.
      expect(
        valueOf(
          styles,
          ".segmented--wraps .segmented__option:has(+ [aria-pressed='true'])",
          'border-inline-end-color',
          PHONE,
        ),
      ).toBe('var(--mm-border)');
      // Without it nothing wraps: no phone rule touches the plain box.
      expect(valueOf(styles, '.segmented', 'flex-wrap', PHONE)).toBeNull();
    });
  });
});

describe('ToolRow', () => {
  it('holds its start, and an end only when one is given', () => {
    const plain = mount(ToolRow, {
      props: { testid: 'toolbar' },
      slots: { default: () => h('span', { 'data-testid': 'start-item' }, 'Date') },
    });
    const row = plain.get('[data-testid="toolbar"]');
    expect(row.get('.tool-row__start').find('[data-testid="start-item"]').exists()).toBe(true);
    expect(row.find('.tool-row__end').exists()).toBe(false);

    const both = mount(ToolRow, {
      props: { testid: 'toolbar' },
      slots: {
        default: () => h('span', 'Date'),
        end: () => h('button', { 'data-testid': 'end-item' }, 'Refresh'),
      },
    });
    const end = both.get('.tool-row__end');
    expect(end.find('[data-testid="end-item"]').exists()).toBe(true);
    // The start comes first in the markup, so the Tab order follows the row as drawn.
    const parts = both.get('[data-testid="toolbar"]').element.children;
    expect([...parts].map((part) => part.className)).toEqual(['tool-row__start', 'tool-row__end']);
  });

  describe('its look', () => {
    const styles = stylesOf('ToolRow.vue');

    it('pads 12px over and under, the gutter on the sides, and draws its bottom rule', () => {
      expect(valueOf(styles, '.tool-row', 'padding')).toBe('var(--space-3) var(--space-6)');
      expect(valueOf(styles, '.tool-row', 'padding-inline', PHONE)).toBe('var(--space-4)');
      expect(valueOf(styles, '.tool-row', 'border-block-end')).toBe('1px solid var(--mm-border)');
      expect(valueOf(styles, '.tool-row', 'background')).toBe('white');
      expect(valueOf(styles, '.tool-row', 'flex-wrap')).toBe('wrap');
      expect(valueOf(styles, '.tool-row', 'align-items')).toBe('center');
      expect(valueOf(styles, '.tool-row', 'gap')).toBe('var(--space-2) var(--space-3)');
    });

    it('writes no height anywhere: the row is its controls and its padding', () => {
      expect(
        everyDeclaration(styles).filter((decl) => /^(min-|max-)?(height|block-size)/.test(decl)),
      ).toEqual([]);
    });

    it('lets the start grow, and keeps the end whole at its inline end above a phone', () => {
      expect(valueOf(styles, '.tool-row__start', 'flex')).toBe('1 1 auto');
      expect(valueOf(styles, '.tool-row__start', 'min-width')).toBe('0');
      expect(valueOf(styles, '.tool-row__start', 'flex-wrap')).toBe('wrap');
      expect(valueOf(styles, '.tool-row__end', 'margin-inline-start')).toBe('auto');
      expect(valueOf(styles, '.tool-row__end', 'gap')).toBe('var(--space-3)');
      expect(valueOf(styles, '.tool-row__end', 'flex-wrap')).toBe('nowrap');
    });

    it('on a phone, wraps the end on its own line from the start edge', () => {
      expect(valueOf(styles, '.tool-row__end', 'flex-wrap', PHONE)).toBe('wrap');
      expect(valueOf(styles, '.tool-row__end', 'gap', PHONE)).toBe('var(--space-2)');
      expect(valueOf(styles, '.tool-row__end', 'margin-inline-start', PHONE)).toBe('0');
      expect(valueOf(styles, '.tool-row__end', 'flex-basis', PHONE)).toBe('100%');
    });
  });
});

describe('ToolGroup', () => {
  it('holds what it is given', () => {
    const wrapper = mount(ToolGroup, { slots: { default: () => h('button', 'Print roster') } });
    expect(wrapper.classes()).toContain('tool-group');
    expect(wrapper.text()).toBe('Print roster');
  });

  it('draws a rule between two groups above a phone, and none on a phone', () => {
    const styles = stylesOf('ToolGroup.vue');
    expect(valueOf(styles, '.tool-group', 'display')).toBe('flex');
    expect(valueOf(styles, '.tool-group', 'gap')).toBe('var(--space-2)');
    expect(valueOf(styles, '.tool-group + .tool-group', 'border-inline-start', DESK)).toBe(
      '1px solid var(--mm-border)',
    );
    expect(valueOf(styles, '.tool-group + .tool-group', 'padding-inline-start', DESK)).toBe(
      'var(--space-3)',
    );
    // On a phone a group's items wrap as the row's own, so no rule is left at a line's start.
    expect(valueOf(styles, '.tool-group + .tool-group', 'border-inline-start')).toBeNull();
    expect(valueOf(styles, '.tool-group', 'display', PHONE)).toBe('contents');
  });
});

describe('PinnedTools', () => {
  /** A stand-in for the browser's observer, so a test says when the block was measured again. */
  class FakeResizeObserver {
    static live: FakeResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.live.push(this);
    }
    observe(element: Element): void {
      this.observed.push(element);
    }
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
    fire(): void {
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    FakeResizeObserver.live = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.unstubAllGlobals();
  });

  function mountPinned() {
    wrapper = mount(PinnedTools, {
      attachTo: document.body,
      props: { testid: 'tools' },
      slots: {
        tools: () => h('div', { 'data-testid': 'a-tool-row' }, 'The toolbar'),
        default: () => h('ul', { 'data-testid': 'the-rows' }, 'Rows'),
      },
    });
    const block = wrapper.get('[data-testid="tools"]').element as HTMLElement;
    const setHeight = (px: number) =>
      Object.defineProperty(block, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 800, px),
      });
    const published = () =>
      (wrapper!.element as HTMLElement).style.getPropertyValue('--pinned-tools-h');
    return { block, setHeight, published };
  }

  it('holds the tools in its block and the screen after it, both inside its root', () => {
    const { block } = mountPinned();
    const root = wrapper!.element as HTMLElement;
    expect(block.parentElement).toBe(root);
    expect(block.querySelector('[data-testid="a-tool-row"]')).not.toBeNull();
    const rows = root.querySelector('[data-testid="the-rows"]')!;
    expect(block.contains(rows)).toBe(false);
    expect(root.children[0]).toBe(block);
    expect(rows.parentElement).toBe(root);
  });

  it("publishes the block's measured height unrounded, and follows it as it grows", async () => {
    const { block, setHeight, published } = mountPinned();
    const [observer] = FakeResizeObserver.live;
    expect(observer!.observed).toEqual([block]);

    // Rounded to 53px, a second sticky row under the block would rise 0.2px as it pinned.
    setHeight(53.2);
    observer!.fire();
    await nextTick();
    expect(published()).toBe('53.2px');

    // A failed refresh's line, or a row wrapping, grows the block.
    setHeight(71.4);
    observer!.fire();
    await nextTick();
    expect(published()).toBe('71.4px');
  });

  it('says 0px before the first measure', async () => {
    const { published } = mountPinned();
    await flushPromises();
    expect(published()).toBe('0px');
  });

  it('stays at 0px and throws nothing with no observer', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { setHeight, published } = mountPinned();
    setHeight(53);
    await flushPromises();
    expect(published()).toBe('0px');
  });

  it('lets the observer go when it unmounts', () => {
    mountPinned();
    const [observer] = FakeResizeObserver.live;
    wrapper!.unmount();
    wrapper = null;
    expect(observer!.disconnected).toBe(true);
  });

  describe('its look', () => {
    const styles = stylesOf('PinnedTools.vue');
    const WIDE = '(width >= 1024px)';

    it('sticks under the market frame from 1024px, over the rows and under the frame', () => {
      expect(valueOf(styles, '.pinned-tools__block', 'position', WIDE)).toBe('sticky');
      expect(valueOf(styles, '.pinned-tools__block', 'top', WIDE)).toBe(
        'calc(var(--banner-h) + var(--market-frame-h))',
      );
      expect(valueOf(styles, '.pinned-tools__block', 'z-index', WIDE)).toBe('10');
      expect(valueOf(styles, '.pinned-tools__block', 'background', WIDE)).toBe('white');
    });

    it('stays in the flow under 1024px, and draws no rule of its own', () => {
      expect(valueOf(styles, '.pinned-tools__block', 'position')).toBeNull();
      expect(everyDeclaration(styles).filter((decl) => /^border/.test(decl))).toEqual([]);
    });
  });
});
