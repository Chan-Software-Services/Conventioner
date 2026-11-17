/**
 * The arrow keys move the selection (T422, the QC walk of 2026-11-16, item 18): under Select, with
 * tables selected and the focus on the map, an arrow moves them 10 cm, or 1 m with Shift, with no
 * Enter first. A key held down is one change, which one undo takes back, and stops counting at the
 * floorplan's edge (D12). Alt and an arrow moves the focus to the nearest table instead, as the
 * plain arrows do with nothing selected. The move is said once, as the key is let go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject, FloorplanTable, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import { AT_THE_EDGE } from '@/components/layout/layoutAnnouncements';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 4 },
];

function table(id: string, x: number, y: number): FloorplanTable {
  return {
    id,
    sectionId: 'gold',
    number: null,
    tableTypeId: 'six-foot',
    xMm: x,
    yMm: y,
    rotation: 0,
  };
}

/** A hall 30 m by 22.5 m. */
function aLayout(tables: FloorplanTable[]): FloorplanObject {
  return {
    id: 'fp-1',
    locationId: UPPER.id,
    revision: 3,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables: tables.map((one, index) => ({ ...one, number: index + 1 })),
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  };
}

let wrapper: VueWrapper | null = null;

function anEditor(tables: FloorplanTable[]) {
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
  editor.adopt(aLayout(tables));
  const outside = document.createElement('button');
  outside.textContent = 'Outside the map';
  document.body.append(outside);
  wrapper = mount(LayoutEditor, {
    props: { editor, locationName: 'Upper Hall', sections: SECTIONS, tableTypes: [SIX_FOOT] },
    attachTo: document.body,
  });
  const w = wrapper;
  const at = (id: string) => {
    const found = editor.layout.value!.tables.find((one) => one.id === id)!;
    return [found.xMm, found.yMm];
  };
  const tableEl = (id: string) => w.get(`[data-table-id="${id}"]`).element as SVGElement;
  const said = () => (w.emitted<[string]>('announce') ?? []).map(([words]) => words);
  return { w, editor, at, tableEl, outside, said };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A key pressed where the focus is. */
async function down(key: string, init: KeyboardEventInit = {}) {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
  await nextTick();
}

async function up(key: string, init: KeyboardEventInit = {}) {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }),
  );
  await nextTick();
}

async function tap(key: string, init: KeyboardEventInit = {}) {
  await down(key, init);
  await up(key, init);
}

const focusedId = () => document.activeElement?.getAttribute('data-table-id') ?? null;

describe('an arrow with tables selected', () => {
  it('moves them 10 cm, or 1 m with Shift, with no Enter first', async () => {
    const { editor, at, tableEl } = anEditor([table('a', 9000, 6000), table('b', 15_000, 6000)]);
    editor.select(['a', 'b']);
    tableEl('a').focus();
    await tap('ArrowRight');
    expect(at('a')).toEqual([9100, 6000]);
    expect(at('b')).toEqual([15_100, 6000]);
    await tap('ArrowDown', { shiftKey: true });
    expect(at('a')).toEqual([9100, 7000]);
    expect(at('b')).toEqual([15_100, 7000]);
    // Nothing is picked up, and the focus stays on the table it was on.
    expect(editor.pickedUp.value).toEqual([]);
    expect(focusedId()).toBe('a');
    // Each tap is a change of its own.
    editor.undo();
    expect(at('a')).toEqual([9100, 6000]);
    editor.undo();
    expect(at('a')).toEqual([9000, 6000]);
  });

  it('held down is one change, which one undo takes back, said once as it is let go', async () => {
    const { editor, at, tableEl, said } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    tableEl('a').focus();
    await down('ArrowLeft');
    await down('ArrowLeft', { repeat: true });
    await down('ArrowLeft', { repeat: true });
    expect(at('a')).toEqual([8700, 6000]);
    expect(said()).toEqual([]);
    await up('ArrowLeft');
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain('Gold row 1');
    expect(said()[0]).toContain('8.7');
    editor.undo();
    expect(at('a')).toEqual([9000, 6000]);
    expect(editor.canUndo.value).toBe(false);
  });

  it("stops counting at the floorplan's edge, so a press back moves at once (D12)", async () => {
    const { editor, at, tableEl, said } = anEditor([table('a', 29_800, 6000)]);
    editor.select(['a']);
    tableEl('a').focus();
    await down('ArrowRight');
    await down('ArrowRight', { repeat: true });
    await down('ArrowRight', { repeat: true });
    await down('ArrowRight', { repeat: true });
    await up('ArrowRight');
    expect(at('a')).toEqual([30_000, 6000]);
    await tap('ArrowLeft');
    expect(at('a')).toEqual([29_900, 6000]);
    // A press that cannot move says so.
    await tap('ArrowRight', { shiftKey: true });
    await tap('ArrowRight');
    expect(at('a')).toEqual([30_000, 6000]);
    expect(said().at(-1)).toBe(AT_THE_EDGE);
  });

  it('is ended as one change when the focus leaves the map with the key still down', async () => {
    const { editor, at, tableEl, outside } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    tableEl('a').focus();
    await down('ArrowDown');
    await down('ArrowDown', { repeat: true });
    outside.focus();
    await nextTick();
    expect(editor.canUndo.value).toBe(true);
    tableEl('a').focus();
    await tap('ArrowDown');
    expect(at('a')).toEqual([9000, 6300]);
    editor.undo();
    expect(at('a')).toEqual([9000, 6200]);
    editor.undo();
    expect(at('a')).toEqual([9000, 6000]);
  });

  it('with Alt moves the focus to the nearest table that way, and moves no table', async () => {
    const { editor, at, tableEl } = anEditor([table('a', 9000, 6000), table('b', 15_000, 6000)]);
    editor.select(['a']);
    tableEl('a').focus();
    await tap('ArrowRight', { altKey: true });
    expect(focusedId()).toBe('b');
    expect(at('a')).toEqual([9000, 6000]);
    expect(editor.canUndo.value).toBe(false);
    // The selection is kept, and the plain arrow moves it from where the focus now is.
    expect(editor.selection.value).toEqual(['a']);
    await tap('ArrowLeft');
    expect(at('a')).toEqual([8900, 6000]);
  });

  it('with nothing selected moves the focus between tables, as before', async () => {
    const { editor, at, tableEl } = anEditor([table('a', 9000, 6000), table('b', 15_000, 6000)]);
    tableEl('a').focus();
    await tap('ArrowRight');
    expect(focusedId()).toBe('b');
    expect(at('a')).toEqual([9000, 6000]);
    expect(at('b')).toEqual([15_000, 6000]);
    expect(editor.canUndo.value).toBe(false);
  });

  it('moves nothing with another tool on', async () => {
    const { w, editor, at, tableEl } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await nextTick();
    expect(w.emitted<[string]>('tool')!.at(-1)![0]).toBe('zone');
    tableEl('a').focus();
    await tap('ArrowRight');
    expect(at('a')).toEqual([9000, 6000]);
  });
});

describe("the editor's focus for the selection", () => {
  it('gives the focus to a selected table, so the arrows work straight after (D13)', async () => {
    const { w, editor, at, outside } = anEditor([table('a', 9000, 6000), table('b', 15_000, 6000)]);
    outside.focus();
    editor.select(['b']);
    await (w.vm as unknown as { focusSelection: () => Promise<void> }).focusSelection();
    expect(focusedId()).toBe('b');
    await tap('ArrowUp');
    expect(at('b')).toEqual([15_000, 5900]);
  });
});
