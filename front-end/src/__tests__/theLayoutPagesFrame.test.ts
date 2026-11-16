/**
 * The layout page's frame (T422, the QC walk of 2026-11-16, items 7, 9 and 10): the toolbar is one
 * line of tools, each with its key, and the history; the tool's options stand in a card the page
 * renders at the panel's head, never over the map, so the map holds still; Escape goes back to
 * Select; the zoom stands on the map's corner; and the keyboard button and `?` show the shortcuts,
 * beside the page where the window has room, remembered in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { mount, shallowMount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LayoutView from '@/components/layout/LayoutView.vue';
import { MARKET_ID, marketRouter } from './support/marketScreen';
import { answersRefusing } from './support/servedAnswers';
import type { FloorplanObject, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutToolCard from '@/components/layout/LayoutToolCard.vue';
import { ROW_CHOICES_AT_FIRST, rowChoices } from '@/components/layout/layoutRow';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { besideTheFrameQuery } from '@/components/layout/layoutViewChoices';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
const routing = vi.hoisted(() => ({ router: null as unknown, route: null as unknown }));
vi.mock('vue-router', () => ({
  useRouter: () => routing.router,
  useRoute: () => routing.route,
  onBeforeRouteLeave: () => {},
  onBeforeRouteUpdate: () => {},
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const SQUARE = { id: 'square', name: 'Square 4 ft', widthMm: 1220, depthMm: 1220 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 4 },
  { id: 'silver', name: 'Silver aisle', location: UPPER, tier: null, count: 4 },
];

function aLayout(): FloorplanObject {
  return {
    id: 'fp-1',
    locationId: UPPER.id,
    revision: 3,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables: [
      {
        id: 't-1',
        sectionId: 'gold',
        number: 1,
        tableTypeId: 'six-foot',
        xMm: 5000,
        yMm: 5000,
        rotation: 0,
      },
    ],
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  };
}

let wrapper: VueWrapper | null = null;

function anEditor(props: Record<string, unknown> = {}) {
  const editor = useLayoutEditor({
    save: (layout: FloorplanObject): Promise<SavedLayout> =>
      Promise.resolve({ floorplan: { ...layout, revision: layout.revision + 1 }, sections: [] }),
    tableTypes: () => [SIX_FOOT, SQUARE],
  });
  editor.adopt(aLayout());
  wrapper = mount(LayoutEditor, {
    props: {
      editor,
      locationName: 'Upper Hall',
      sections: SECTIONS,
      tableTypes: [SIX_FOOT, SQUARE],
      ...props,
    },
    attachTo: document.body,
  });
  return wrapper;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
const toolOn = (w: VueWrapper) => w.emitted<[string]>('tool')!.at(-1)![0];
const tool = (w: VueWrapper, name: string) => w.get(`[data-testid="layout-tool-${name}"]`);

beforeEach(() => {
  localStorage.clear();
  Object.assign(rowChoices, ROW_CHOICES_AT_FIRST);
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe("the layout editor's tools", () => {
  it.each([
    ['select', 'Select', 'V'],
    ['add', 'Add table', 'T'],
    ['row', 'Row of tables', 'W'],
    ['fill', 'Fill an area', 'A'],
    ['zone', 'No-table zone', 'Z'],
  ])('%s carries its key on its button, in its tooltip and as its shortcut', (id, name, key) => {
    const w = anEditor();
    const button = tool(w, id);
    expect(button.get('kbd').text()).toBe(key);
    expect(button.attributes('title')).toBe(`${name} (${key})`);
    expect(button.attributes('aria-keyshortcuts')).toBe(key);
  });

  it('switches to each tool by its key, and the pressed one is the tool on', async () => {
    const w = anEditor();
    expect(toolOn(w)).toBe('select');
    for (const [key, id] of [
      ['t', 'add'],
      ['w', 'row'],
      ['a', 'fill'],
      ['z', 'zone'],
      ['v', 'select'],
    ]) {
      press(key);
      await w.vm.$nextTick();
      expect(toolOn(w), key).toBe(id);
      expect(tool(w, id).attributes('aria-pressed'), key).toBe('true');
    }
  });

  it('takes no tool key with Ctrl, in a field, or held down', async () => {
    const w = anEditor();
    press('t', { ctrlKey: true });
    press('t', { repeat: true });
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    await w.vm.$nextTick();
    expect(toolOn(w)).toBe('select');
  });

  it('keeps the adding tools off by their keys too, where the seats are settled', async () => {
    const w = anEditor({ settled: true });
    for (const key of ['t', 'w', 'a']) press(key);
    await w.vm.$nextTick();
    expect(toolOn(w)).toBe('select');
    press('z');
    await w.vm.$nextTick();
    expect(toolOn(w)).toBe('zone');
  });

  it('goes back to Select on Escape, with nothing being drawn', async () => {
    const w = anEditor();
    press('w');
    await w.vm.$nextTick();
    expect(toolOn(w)).toBe('row');
    press('Escape');
    await w.vm.$nextTick();
    expect(toolOn(w)).toBe('select');
  });

  it('keeps the tool options out of the editor and the zoom on the map, not the toolbar', () => {
    const w = anEditor();
    expect(w.find('[data-testid="layout-add-options"]').exists()).toBe(false);
    const toolbar = w.get('[data-testid="layout-toolbar"]');
    expect(toolbar.find('[data-testid="layout-zoom-in"]').exists()).toBe(false);
    const zoom = w.get('[data-testid="layout-zoom-controls"]');
    expect(zoom.element.closest('.layout-stage-frame')).not.toBeNull();
    expect(zoom.attributes('role')).toBe('group');
    expect(
      zoom
        .findAll('button')
        .map((button) =>
          (button.find('.visually-hidden').exists()
            ? button.find('.visually-hidden')
            : button
          ).text(),
        ),
    ).toEqual(['Floorplan', 'Zoom out', 'Zoom in', 'Fit']);
  });
});

describe('the tool card', () => {
  const card = (props: Record<string, unknown> = {}) =>
    mount(LayoutToolCard, {
      props: {
        tool: 'row',
        sections: SECTIONS,
        tableTypes: [SIX_FOOT, SQUARE],
        sectionId: 'gold',
        typeId: 'six-foot',
        ...props,
      },
    });

  it('names its tool, and sets the section and the type the page holds for every adding tool', async () => {
    const w = card({ tool: 'add' });
    expect(w.get('h2').text()).toBe('Add table');
    await w.get('[data-testid="layout-add-section"]').setValue('silver');
    await w.get('[data-testid="layout-add-type"]').setValue('square');
    expect(w.emitted('update:sectionId')).toEqual([['silver']]);
    expect(w.emitted('update:typeId')).toEqual([['square']]);
    expect(w.text()).toContain('Press Escape for Select.');
  });

  it('gives Row of tables its choices: Flip side only beside the line, Aisle only for rows', async () => {
    rowChoices.centred = false;
    const w = card();
    const stand = w.get('[data-testid="layout-row-stand"]');
    expect(stand.attributes('role')).toBe('radiogroup');
    expect(stand.findAll('input[type="radio"]')).toHaveLength(2);
    await w.get('[data-testid="layout-row-flip"]').trigger('click');
    expect(w.emitted('flip')).toHaveLength(1);
    expect(w.find('[data-testid="layout-row-aisle"]').exists()).toBe(false);

    rowChoices.centred = true;
    rowChoices.rows = '2';
    await w.vm.$nextTick();
    expect(w.find('[data-testid="layout-row-flip"]').exists()).toBe(false);
    expect(w.find('[data-testid="layout-row-aisle"]').exists()).toBe(true);
  });

  it('disables Spread evenly for a closed shape, and fills what is in view for Fill an area', async () => {
    expect(
      (
        card({ rowClosed: true }).get('[data-testid="layout-row-spread"]')
          .element as HTMLInputElement
      ).disabled,
    ).toBe(true);
    const fill = card({ tool: 'fill' });
    expect(fill.find('[data-testid="layout-row-gap"]').exists()).toBe(false);
    await fill.get('[data-testid="layout-fill-view"]').trigger('click');
    expect(fill.emitted('fillInView')).toHaveLength(1);
  });
});

describe('the keyboard shortcuts', () => {
  const toggle = (w: VueWrapper) => w.get('[data-testid="layout-shortcuts-toggle"]');
  const shown = (w: VueWrapper) => w.find('[data-testid="layout-shortcuts"]').exists();

  it('stand after the No-table zone tool, shown and hidden by the button and by ?', async () => {
    const w = anEditor();
    const buttons = w.findAll('[data-testid="layout-toolbar"] button');
    const at = buttons.findIndex((b) => b.attributes('data-testid') === 'layout-shortcuts-toggle');
    expect(buttons[at - 1].attributes('data-testid')).toBe('layout-tool-zone');
    expect(toggle(w).attributes('aria-label')).toBe('Keyboard shortcuts');
    expect(toggle(w).attributes('aria-pressed')).toBe('false');
    expect(shown(w)).toBe(false);

    await toggle(w).trigger('click');
    expect(shown(w)).toBe(true);
    expect(toggle(w).attributes('aria-pressed')).toBe('true');
    const list = w.get('[data-testid="layout-shortcuts"]');
    expect(list.findAll('h3').map((group) => group.text())[0]).toBe('Tools');
    expect(list.text()).toContain('Show or hide these shortcuts');

    press('?', { shiftKey: true });
    await w.vm.$nextTick();
    expect(shown(w)).toBe(false);
    press('?', { shiftKey: true });
    await w.vm.$nextTick();
    expect(shown(w)).toBe(true);
    await w.get('[data-testid="layout-shortcuts-close"]').trigger('click');
    expect(shown(w)).toBe(false);
  });

  it('are shown again on the next visit, as the person left them', async () => {
    const first = anEditor();
    await toggle(first).trigger('click');
    expect(localStorage.getItem('conventioner.layout.shortcutsShown')).toBe('1');
    first.unmount();
    wrapper = null;

    const next = anEditor();
    expect(shown(next)).toBe(true);
  });

  it('stand beside the frame where the window has room for them, from the frame token', async () => {
    expect(besideTheFrameQuery('1440px', '16px')).toBe(
      '(min-width: calc(1440px + 2 * (24rem + 2 * 16px)))',
    );
    document.documentElement.style.setProperty('--workspace-max', '1440px');
    document.documentElement.style.setProperty('--space-4', '16px');
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.startsWith('(min-width: calc(1440px'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    localStorage.setItem('conventioner.layout.shortcutsShown', '1');
    const w = anEditor();
    await w.vm.$nextTick();
    const asked = vi.mocked(window.matchMedia).mock.calls.map(([query]) => query);
    expect(asked).toContain('(min-width: calc(1440px + 2 * (24rem + 2 * 16px)))');
    expect(w.get('[data-testid="layout-shortcuts"]').classes()).toContain(
      'layout-shortcuts--beside',
    );
  });

  it('stand over the map where the window has no room beside the frame', async () => {
    localStorage.setItem('conventioner.layout.shortcutsShown', '1');
    const w = anEditor();
    await w.vm.$nextTick();
    const panel = w.get('[data-testid="layout-shortcuts"]');
    expect(panel.classes()).not.toContain('layout-shortcuts--beside');
    expect(panel.element.closest('.layout-stage-frame')).not.toBeNull();
  });
});

describe("the layout page's panel", () => {
  function served() {
    return {
      id: MARKET_ID,
      name: 'Riverside',
      phase: 'draft',
      actionRefusals: answersRefusing(),
      setupObject: {
        priority: [],
        marketDates: [{ date: '2099-08-01' }],
        tiers: [],
        locations: [UPPER],
        sections: SECTIONS,
        assignmentOptions: {},
        tableTypes: [SIX_FOOT, SQUARE],
        floorplans: [aLayout()],
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    routing.router = marketRouter();
    routing.route = reactive({
      name: 'market-layout',
      params: { marketId: MARKET_ID, locationId: UPPER.id },
      query: {},
      matched: [],
    });
    api.get.mockImplementation((url: string) =>
      url === `/markets/${MARKET_ID}`
        ? Promise.resolve({ data: { market: served() } })
        : Promise.resolve({ data: new Blob() }),
    );
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
  });
  afterEach(() => vi.useRealTimers());

  async function aPage() {
    wrapper = shallowMount(LayoutView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          MarketFrame: { name: 'MarketFrame', props: ['market'], template: '<div><slot /></div>' },
          AppDialog: {
            name: 'AppDialog',
            props: ['open', 'testid', 'title', 'size', 'scroll'],
            template: '<div v-if="open" :data-testid="testid"><slot /></div>',
          },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    return wrapper;
  }
  /** The panel's cards in their order, each by its component or its test id. */
  const cards = (w: VueWrapper) =>
    [...w.get('aside').element.children].map(
      (card) =>
        card.getAttribute('data-testid') ?? card.tagName.toLowerCase().replace(/-stub$/, ''),
    );
  async function toolIs(w: VueWrapper, tool: string) {
    w.findComponent(LayoutEditor).vm.$emit('tool', tool);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('holds the sections first, flat as information, then the selection card with Select on', async () => {
    const w = await aPage();
    expect(cards(w)).toEqual(['layout-panel-sections', 'layout-panel-selection']);
    expect(w.findComponent({ name: 'LayoutPanelSections' }).classes()).toContain(
      'layout-card--info',
    );
  });

  it("renders the tool's card in the selection's place, with the section and type the editor adds", async () => {
    const w = await aPage();
    const editor = w.findComponent(LayoutEditor);
    editor.vm.$emit('update:sectionId', 'silver');
    editor.vm.$emit('update:typeId', 'square');
    await toolIs(w, 'row');

    expect(cards(w)).toEqual(['layout-panel-sections', 'layout-tool-card']);
    const card = w.findComponent(LayoutToolCard);
    expect(card.props()).toMatchObject({ tool: 'row', sectionId: 'silver', typeId: 'square' });
    expect(card.props('sections').map((section: SectionObject) => section.id)).toEqual([
      'gold',
      'silver',
    ]);
    // A choice on the card is the editor's too, and carries to the next adding tool.
    card.vm.$emit('update:sectionId', 'gold');
    await toolIs(w, 'fill');
    expect(w.findComponent(LayoutToolCard).props()).toMatchObject({
      tool: 'fill',
      sectionId: 'gold',
    });
    expect(editor.props('sectionId')).toBe('gold');
  });

  it('holds the zones card alone under the sections with No-table zone on', async () => {
    const w = await aPage();
    await toolIs(w, 'zone');
    expect(cards(w)).toEqual(['layout-panel-sections', 'layout-panel-zones']);
    await toolIs(w, 'select');
    expect(w.findComponent({ name: 'LayoutPanelZones' }).exists()).toBe(false);
  });

  it('keeps the table types and the image out of the panel, in Layout settings', async () => {
    const w = await aPage();
    expect(w.find('[data-testid="layout-settings"]').exists()).toBe(false);
    expect(w.findComponent({ name: 'LayoutPanelTypes' }).exists()).toBe(false);
    expect(w.find('[data-testid="layout-panel-floorplan"]').exists()).toBe(false);

    await w.get('[data-testid="layout-settings-open"]').trigger('click');
    const settings = w.get('[data-testid="layout-settings"]');
    expect(settings.findComponent({ name: 'LayoutPanelTypes' }).exists()).toBe(true);
    expect(settings.get('[data-testid="layout-panel-floorplan"] h2').text()).toBe(
      'Floorplan image',
    );
    const dialog = w.findComponent({ name: 'AppDialog' });
    expect(dialog.props()).toMatchObject({ title: 'Layout settings', scroll: 'body' });

    // Replace the image and Recalibrate close the dialog for the map column's work.
    await settings.get('[data-testid="layout-recalibrate"]').trigger('click');
    expect(w.find('[data-testid="layout-settings"]').exists()).toBe(false);
    expect(w.findComponent({ name: 'LayoutCalibration' }).exists()).toBe(true);
  });
});
