/**
 * A right-click on the layout's map (T422, the QC walk of 2026-11-16, items 6 and 19): the
 * browser's menu never opens over the drawing; a right-click drops what is in hand and keeps the
 * tool (a drag under way, a row's path, a line drawn and waiting, an area's corners), and with
 * nothing in hand it puts Select back on. The tool card and the shortcuts say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject, FloorplanTable, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import { ROW_DROPPED } from '@/components/layout/layoutAnnouncements';
import { AREA_DROPPED } from '@/components/layout/layoutFill';
import { ROW_CHOICES_AT_FIRST, rowChoices } from '@/components/layout/layoutRow';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { ZONE_DROPPED } from '@/components/layout/layoutZoneDraft';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 40 },
];
/** The stage is 800 by 600 px and shows the 30 m by 22.5 m hall whole: 37.5 mm to the pixel. */
const MM_PER_PX = 37.5;
const p = (xMm: number, yMm: number) => ({ xMm, yMm });
type Tool = 'select' | 'add' | 'row' | 'fill' | 'zone';

function table(id: string, x: number, y: number): FloorplanTable {
  return { id, sectionId: 'gold', number: 1, tableTypeId: 'six-foot', xMm: x, yMm: y, rotation: 0 };
}

let wrapper: VueWrapper | null = null;

async function anEditor(tool: Tool, tables: FloorplanTable[] = []) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-testid');
    if (id !== 'layout-stage' && id !== 'layout-map') return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, 0, 800, 600);
  });
  const editor = useLayoutEditor({
    save: (layout: FloorplanObject): Promise<SavedLayout> =>
      Promise.resolve({ floorplan: { ...layout, revision: layout.revision + 1 }, sections: [] }),
    tableTypes: () => [SIX_FOOT],
  });
  editor.adopt({
    id: 'fp-1',
    locationId: UPPER.id,
    revision: 3,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables,
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  });
  wrapper = mount(LayoutEditor, {
    props: { editor, locationName: 'Upper Hall', sections: SECTIONS, tableTypes: [SIX_FOOT] },
    attachTo: document.body,
  });
  await nextTick();
  wrapper.get(`[data-testid="layout-tool-${tool}"]`).element.dispatchEvent(new MouseEvent('click'));
  await nextTick();
  const stage = wrapper.get('[data-testid="layout-stage"]').element;
  stage.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  await nextTick();
  const w = wrapper;
  /** The tool on, as its toolbar button says. */
  const toolOn = () =>
    w.get('[aria-pressed="true"][data-testid^="layout-tool-"]').attributes('data-testid');
  return { w, editor, stage, toolOn, tables: () => editor.layout.value!.tables };
}

beforeEach(() => Object.assign(rowChoices, ROW_CHOICES_AT_FIRST));
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  at: { xMm: number; yMm: number },
  on: Element,
  init: PointerEventInit = {},
) {
  on.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: at.xMm / MM_PER_PX,
      clientY: at.yMm / MM_PER_PX,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await nextTick();
}

async function click(at: { xMm: number; yMm: number }, on: Element) {
  await pointer('pointerdown', at, on);
  await pointer('pointerup', at, on);
}

/** A right-click on the map: the browser's menu asked for; whether it was refused. */
async function rightClick(on: Element, at = p(15_000, 11_000)): Promise<boolean> {
  const menu = new MouseEvent('contextmenu', {
    button: 2,
    clientX: at.xMm / MM_PER_PX,
    clientY: at.yMm / MM_PER_PX,
    bubbles: true,
    cancelable: true,
  });
  on.dispatchEvent(menu);
  await nextTick();
  return menu.defaultPrevented;
}

describe('a right-click on the map', () => {
  it.each(['select', 'add', 'row', 'fill', 'zone'] as const)(
    'opens no browser menu with %s on',
    async (tool) => {
      const { stage } = await anEditor(tool);
      expect(await rightClick(stage)).toBe(true);
    },
  );

  it.each(['add', 'row', 'fill', 'zone'] as const)(
    'puts Select back on from %s, with nothing in hand',
    async (tool) => {
      const { stage, toolOn } = await anEditor(tool);
      expect(toolOn()).toBe(`layout-tool-${tool}`);
      await rightClick(stage);
      expect(toolOn()).toBe('layout-tool-select');
    },
  );

  it('leaves Select on, and the selection as it was', async () => {
    const { stage, toolOn, editor } = await anEditor('select', [table('a', 5000, 5000)]);
    editor.select(['a']);
    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-select');
    expect(editor.selection.value).toEqual(['a']);
  });
});

describe('with a row in hand', () => {
  it('drops its points and keeps Row of tables on, then a second goes to Select', async () => {
    const { w, stage, toolOn, tables } = await anEditor('row');
    await click(p(2000, 3000), stage);
    await click(p(9000, 3000), stage);
    expect(w.findAll('[data-testid="layout-row-point"]')).toHaveLength(2);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-row');
    expect(w.find('[data-testid="layout-row-preview"]').exists()).toBe(false);
    expect(w.emitted('announce')!.at(-1)).toEqual([ROW_DROPPED]);
    expect(tables()).toEqual([]);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-select');
  });

  it('drops a straight line drawn and waiting for Enter, placing nothing', async () => {
    const { w, stage, toolOn, tables } = await anEditor('row');
    await pointer('pointerdown', p(2000, 3000), stage);
    await pointer('pointermove', p(8000, 3000), stage);
    await pointer('pointermove', p(22_000, 3000), stage);
    await pointer('pointerup', p(22_000, 3000), stage);
    expect(w.findAll('[data-testid="layout-row-table"]')).toHaveLength(10);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-row');
    expect(w.find('[data-testid="layout-row-preview"]').exists()).toBe(false);
    expect(tables()).toEqual([]);
  });

  it('puts back a point being dragged, the path kept, the tool kept', async () => {
    const { w, stage, toolOn } = await anEditor('row');
    await click(p(2000, 3000), stage);
    await click(p(9000, 3000), stage);
    await pointer('pointerdown', p(9000, 3000), stage);
    await pointer('pointermove', p(9000, 6000), stage);
    await pointer('pointermove', p(9000, 9000), stage);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-row');
    // The drag is over: the pointer's release lays nothing and moves nothing further.
    await pointer('pointerup', p(9000, 12_000), stage);
    expect(w.findAll('[data-testid="layout-row-point"]')).toHaveLength(2);
  });

  it('drops the path at a press that has not moved, as a Control and click on a Mac sends', async () => {
    const { w, stage, toolOn } = await anEditor('row');
    await click(p(2000, 3000), stage);
    await click(p(9000, 3000), stage);
    await pointer('pointerdown', p(15_000, 3000), stage, { ctrlKey: true });
    await rightClick(stage, p(15_000, 3000));
    await pointer('pointerup', p(15_000, 3000), stage, { ctrlKey: true });
    expect(toolOn()).toBe('layout-tool-row');
    expect(w.find('[data-testid="layout-row-preview"]').exists()).toBe(false);
  });
});

describe('with an area in hand', () => {
  it('drops its corners and keeps Fill an area on, then a second goes to Select', async () => {
    const { w, stage, toolOn } = await anEditor('fill');
    await click(p(2000, 3000), stage);
    await click(p(9000, 3000), stage);
    expect(w.find('[data-testid="layout-fill-preview"]').exists()).toBe(true);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-fill');
    expect(w.find('[data-testid="layout-fill-preview"]').exists()).toBe(false);
    expect(w.emitted('status')!.at(-1)).toEqual([AREA_DROPPED]);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-select');
  });

  it('drops a box being dragged, and keeps Fill an area on', async () => {
    const { w, stage, toolOn } = await anEditor('fill');
    await pointer('pointerdown', p(2000, 3000), stage);
    await pointer('pointermove', p(5000, 5000), stage);
    await pointer('pointermove', p(9000, 9000), stage);
    expect(w.find('[data-testid="layout-fill-preview"]').exists()).toBe(true);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-fill');
    await pointer('pointerup', p(9000, 9000), stage);
    expect(w.find('[data-testid="layout-fill-window"]').exists()).toBe(false);
    expect(w.find('[data-testid="layout-fill-preview"]').exists()).toBe(false);
  });
});

describe('with a no-table zone drawn and not added', () => {
  async function drawn() {
    const made = await anEditor('zone');
    await pointer('pointerdown', p(8000, 7000), made.stage);
    await pointer('pointermove', p(10_000, 8000), made.stage);
    await pointer('pointermove', p(12_000, 9000), made.stage);
    await pointer('pointerup', p(12_000, 9000), made.stage);
    const draft = () => made.w.find('[data-testid="layout-zone-draft"]');
    expect(draft().exists()).toBe(true);
    return { ...made, draft };
  }

  it('drops the draft and keeps No-table zone on, then a second goes to Select', async () => {
    const { w, stage, toolOn, draft, editor } = await drawn();

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-zone');
    expect(draft().exists()).toBe(false);
    expect(w.emitted('status')!.at(-1)).toEqual([ZONE_DROPPED]);
    expect(editor.layout.value!.zones).toEqual([]);

    await rightClick(stage);
    expect(toolOn()).toBe('layout-tool-select');
  });

  it('puts back a draft being moved, the draft and the tool kept', async () => {
    const { w, stage, toolOn, draft } = await drawn();
    const before = draft().attributes('transform');
    const body = w.get('[data-testid="layout-zone-draft-body"]').element;
    await pointer('pointerdown', p(10_000, 8000), body);
    await pointer('pointermove', p(12_000, 8000), stage);
    await pointer('pointermove', p(14_000, 8000), stage);
    expect(draft().attributes('transform')).not.toBe(before);

    await rightClick(stage, p(14_000, 8000));
    expect(toolOn()).toBe('layout-tool-zone');
    expect(draft().attributes('transform')).toBe(before);
    await pointer('pointerup', p(16_000, 8000), stage);
    expect(draft().attributes('transform')).toBe(before);
  });

  it('drops a box being dragged, and keeps No-table zone on with no draft', async () => {
    const { stage, toolOn, w } = await anEditor('zone');
    await pointer('pointerdown', p(8000, 7000), stage);
    await pointer('pointermove', p(10_000, 8000), stage);
    await pointer('pointermove', p(12_000, 9000), stage);
    expect(w.find('[data-testid="layout-zone-box"]').exists()).toBe(true);

    await rightClick(stage, p(12_000, 9000));
    expect(toolOn()).toBe('layout-tool-zone');
    await pointer('pointerup', p(12_000, 9000), stage);
    expect(w.find('[data-testid="layout-zone-box"]').exists()).toBe(false);
    expect(w.find('[data-testid="layout-zone-draft"]').exists()).toBe(false);
  });
});

describe('what the page says of it', () => {
  it('names the right-click in the hint of a line waiting for Enter', async () => {
    const { w, stage } = await anEditor('row');
    await pointer('pointerdown', p(2000, 3000), stage);
    await pointer('pointermove', p(8000, 3000), stage);
    await pointer('pointerup', p(22_000, 3000), stage);
    expect(w.get('[data-testid="layout-hint"]').text()).toContain(
      'Escape or a right-click drops it',
    );
  });
});
