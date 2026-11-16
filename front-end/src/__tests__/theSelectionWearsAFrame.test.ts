/**
 * The selection's frame (T422, the QC walk of 2026-11-16, items 2 and 16): one table's frame hugs
 * it and turns with it, several stand in a frame square to the page, and a round knob on each of
 * the frame's four corners turns the selection. The knobs never move to another side. While a
 * knob is dragged the frame is frozen as it stood and turns whole, so the knob held stays under
 * the pointer; a turn holds to 15° steps, by the whole degree with Shift, and Alt frees it no more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject, FloorplanTable, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutPanelKeyboard from '@/components/layout/LayoutPanelKeyboard.vue';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 4 },
];
/** The stage is 800 by 600 px and shows the 30 m by 22.5 m hall whole: 37.5 mm to the pixel, the
 *  hall's top-left corner at the stage's. */
const MM_PER_PX = 37.5;
/** The frame stands 6 px outside the tables' edges. */
const OUT_MM = 6 * MM_PER_PX;

function table(id: string, x: number, y: number, rotation = 0): FloorplanTable {
  return { id, sectionId: 'gold', number: null, tableTypeId: 'six-foot', xMm: x, yMm: y, rotation };
}

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
  wrapper = mount(LayoutEditor, {
    props: { editor, locationName: 'Upper Hall', sections: SECTIONS, tableTypes: [SIX_FOOT] },
    attachTo: document.body,
  });
  const at = (id: string) => editor.layout.value!.tables.find((one) => one.id === id)!;
  return { w: wrapper, editor, at };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface DrawnFrame {
  xMm: number;
  yMm: number;
  rotation: number;
  widthMm: number;
  depthMm: number;
}

/** The frame as drawn: its middle and turn from its transform, its size from its rectangle. */
function frameOf(w: VueWrapper): DrawnFrame | null {
  const g = w.find('[data-testid="layout-selection-frame"]');
  if (!g.exists()) return null;
  const [, x, y, rotation] = /translate\(([-\d.e]+) ([-\d.e]+)\) rotate\(([-\d.e]+)\)/
    .exec(g.attributes('transform')!)!
    .map(Number);
  const rect = g.get('rect');
  return {
    xMm: x,
    yMm: y,
    rotation,
    widthMm: Number(rect.attributes('width')),
    depthMm: Number(rect.attributes('height')),
  };
}

/** Where each knob stands on the floorplan, the frame's turn applied. */
function knobsOf(w: VueWrapper) {
  const frame = frameOf(w)!;
  const turn = (frame.rotation * Math.PI) / 180;
  return w.findAll('[data-testid="layout-turn-knob"]').map((knob) => {
    const kx = Number(knob.attributes('cx'));
    const ky = Number(knob.attributes('cy'));
    return {
      el: knob.element,
      xMm: frame.xMm + kx * Math.cos(turn) - ky * Math.sin(turn),
      yMm: frame.yMm + kx * Math.sin(turn) + ky * Math.cos(turn),
    };
  });
}

async function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  xMm: number,
  yMm: number,
  on: Element,
  init: PointerEventInit = {},
) {
  on.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: xMm / MM_PER_PX,
      clientY: yMm / MM_PER_PX,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await nextTick();
}

/** A point `by` degrees on from `from` about `centre`. */
function turnedPoint(
  from: { xMm: number; yMm: number },
  centre: { xMm: number; yMm: number },
  by: number,
) {
  const turn = (by * Math.PI) / 180;
  const dx = from.xMm - centre.xMm;
  const dy = from.yMm - centre.yMm;
  return {
    xMm: centre.xMm + dx * Math.cos(turn) - dy * Math.sin(turn),
    yMm: centre.yMm + dx * Math.sin(turn) + dy * Math.cos(turn),
  };
}

describe("the selection's frame", () => {
  it('hugs one table and turns with it, a knob on each of its four corners', async () => {
    const { w, editor } = anEditor([table('a', 9000, 6000, 30), table('b', 20_000, 6000)]);
    expect(frameOf(w)).toBeNull();
    editor.select(['a']);
    await nextTick();
    const frame = frameOf(w)!;
    expect(frame.xMm).toBe(9000);
    expect(frame.yMm).toBe(6000);
    expect(frame.rotation).toBe(30);
    expect(frame.widthMm).toBeCloseTo(1830 + 2 * OUT_MM);
    expect(frame.depthMm).toBeCloseTo(760 + 2 * OUT_MM);
    const knobs = w.findAll('[data-testid="layout-turn-knob"]');
    expect(knobs).toHaveLength(4);
    expect(
      knobs.map((knob) => [Number(knob.attributes('cx')), Number(knob.attributes('cy'))]),
    ).toEqual([
      [-(915 + OUT_MM), -(380 + OUT_MM)],
      [915 + OUT_MM, -(380 + OUT_MM)],
      [915 + OUT_MM, 380 + OUT_MM],
      [-(915 + OUT_MM), 380 + OUT_MM],
    ]);
    // Each knob a thumb's reach wide, and the frame and its knobs hidden from a screen reader.
    for (const reach of w.findAll('[data-turn-handle] circle[fill="transparent"]')) {
      expect(Number(reach.attributes('r'))).toBeCloseTo(14 * MM_PER_PX);
    }
    expect(w.get('[data-testid="layout-selection-frame"]').attributes('aria-hidden')).toBe('true');
  });

  it('stands square to the page round several, and the knobs stay on its corners as a neighbour comes near', async () => {
    const { w, editor } = anEditor([
      table('a', 9000, 6000, 90),
      table('b', 14_000, 8000),
      table('c', 9000, 3000),
    ]);
    editor.select(['a', 'b']);
    await nextTick();
    const frame = frameOf(w)!;
    expect(frame.rotation).toBe(0);
    // a, turned a quarter, stands 760 wide and 1830 deep; b lies flat.
    const box = { left: 9000 - 380, right: 14_000 + 915, top: 6000 - 915, bottom: 8000 + 380 };
    expect(frame.xMm).toBeCloseTo((box.left + box.right) / 2);
    expect(frame.yMm).toBeCloseTo((box.top + box.bottom) / 2);
    expect(frame.widthMm).toBeCloseTo(box.right - box.left + 2 * OUT_MM);
    expect(frame.depthMm).toBeCloseTo(box.bottom - box.top + 2 * OUT_MM);
    const before = knobsOf(w).map(({ xMm, yMm }) => [xMm, yMm]);
    // A table moved in over the frame's top does not send a knob elsewhere.
    editor.begin();
    editor.moveTables(['c'], 0, 1500);
    editor.end();
    await nextTick();
    expect(knobsOf(w).map(({ xMm, yMm }) => [xMm, yMm])).toEqual(before);
  });

  it('is drawn only under Select', async () => {
    const { w, editor } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    await nextTick();
    expect(frameOf(w)).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    await nextTick();
    expect(frameOf(w)).toBeNull();
  });
});

describe('a turn by a knob', () => {
  it('turns in 15° steps, the frame turning whole with the knob held under the pointer', async () => {
    const { w, editor, at } = anEditor([table('a', 9000, 6000, 10), table('b', 20_000, 6000)]);
    editor.select(['a']);
    await nextTick();
    const centre = { xMm: 9000, yMm: 6000 };
    const [knob] = knobsOf(w);
    await pointer('pointerdown', knob.xMm, knob.yMm, knob.el);
    // 40° on is held to 45°, the next 15° step.
    await pointer('pointermove', ...xy(turnedPoint(knob, centre, 40)), stageOf(w));
    expect(at('a').rotation).toBe(55);
    expect(frameOf(w)!.rotation).toBe(55);
    // Exactly 30° on: the knob turned with the frame stands where the pointer is.
    const pointerAt = turnedPoint(knob, centre, 30);
    await pointer('pointermove', ...xy(pointerAt), stageOf(w));
    expect(at('a').rotation).toBe(40);
    const held = knobsOf(w)[0];
    expect(held.xMm).toBeCloseTo(pointerAt.xMm, 6);
    expect(held.yMm).toBeCloseTo(pointerAt.yMm, 6);
    await pointer('pointerup', ...xy(pointerAt), stageOf(w));
    expect(at('a').rotation).toBe(40);
    // One change, which one undo takes back.
    editor.undo();
    expect(at('a').rotation).toBe(10);
  });

  it('turns by the whole degree with Shift, and Alt no longer frees it', async () => {
    const { w, editor, at } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    await nextTick();
    const centre = { xMm: 9000, yMm: 6000 };
    const [knob] = knobsOf(w);
    await pointer('pointerdown', knob.xMm, knob.yMm, knob.el);
    await pointer('pointermove', ...xy(turnedPoint(knob, centre, 23.4)), stageOf(w), {
      shiftKey: true,
    });
    expect(at('a').rotation).toBe(23);
    await pointer('pointermove', ...xy(turnedPoint(knob, centre, 23.4)), stageOf(w), {
      altKey: true,
    });
    expect(at('a').rotation).toBe(30);
    await pointer('pointerup', ...xy(turnedPoint(knob, centre, 23.4)), stageOf(w));
  });

  it('turns again as Shift is pressed or let go, with no move of the pointer (D11)', async () => {
    const { w, editor, at } = anEditor([table('a', 9000, 6000)]);
    editor.select(['a']);
    await nextTick();
    const centre = { xMm: 9000, yMm: 6000 };
    const [knob] = knobsOf(w);
    await pointer('pointerdown', knob.xMm, knob.yMm, knob.el);
    await pointer('pointermove', ...xy(turnedPoint(knob, centre, 23.4)), stageOf(w));
    expect(at('a').rotation).toBe(30);
    const shift = (type: 'keydown' | 'keyup') =>
      window.dispatchEvent(
        new KeyboardEvent(type, { key: 'Shift', shiftKey: type === 'keydown', bubbles: true }),
      );
    shift('keydown');
    await nextTick();
    expect(at('a').rotation).toBe(23);
    expect(frameOf(w)!.rotation).toBe(23);
    shift('keyup');
    await nextTick();
    expect(at('a').rotation).toBe(30);
    await pointer('pointerup', ...xy(turnedPoint(knob, centre, 23.4)), stageOf(w));
    editor.undo();
    expect(at('a').rotation).toBe(0);
  });

  it('keeps the frame of several as it stood while the drag lasts, and stands it square again after', async () => {
    const { w, editor, at } = anEditor([table('a', 9000, 6000), table('b', 13_000, 6000)]);
    editor.select(['a', 'b']);
    await nextTick();
    const start = frameOf(w)!;
    const centre = { xMm: start.xMm, yMm: start.yMm };
    const corner = knobsOf(w)[2];
    await pointer('pointerdown', corner.xMm, corner.yMm, corner.el);
    const to = turnedPoint(corner, centre, 90);
    await pointer('pointermove', ...xy(to), stageOf(w));
    expect(at('a').rotation).toBe(90);
    const turning = frameOf(w)!;
    expect(turning).toMatchObject({ xMm: start.xMm, yMm: start.yMm, rotation: 90 });
    expect(turning.widthMm).toBeCloseTo(start.widthMm);
    expect(turning.depthMm).toBeCloseTo(start.depthMm);
    expect(knobsOf(w)[2].xMm).toBeCloseTo(to.xMm, 6);
    expect(knobsOf(w)[2].yMm).toBeCloseTo(to.yMm, 6);
    await pointer('pointerup', ...xy(to), stageOf(w));
    const after = frameOf(w)!;
    expect(after.rotation).toBe(0);
    // The two now stand one over the other, each turned a quarter: a frame tall and narrow.
    expect(after.widthMm).toBeCloseTo(760 + 2 * OUT_MM);
  });

  it('puts the selection and the frame back as they were on Escape before it is let go', async () => {
    const { w, editor, at } = anEditor([table('a', 9000, 6000, 10)]);
    editor.select(['a']);
    await nextTick();
    const [knob] = knobsOf(w);
    await pointer('pointerdown', knob.xMm, knob.yMm, knob.el);
    await pointer(
      'pointermove',
      ...xy(turnedPoint(knob, { xMm: 9000, yMm: 6000 }, 45)),
      stageOf(w),
    );
    expect(at('a').rotation).toBe(55);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(at('a').rotation).toBe(10);
    expect(frameOf(w)!.rotation).toBe(10);
  });
});

describe('what the page says of a turn', () => {
  it('says under the map that a corner turns the selection in 15° steps, by the degree with Shift', async () => {
    const { w } = anEditor([table('a', 9000, 6000)]);
    expect(w.get('[data-testid="layout-hint"]').text()).toContain(
      'Drag a corner of the selection to turn it in 15° steps, with Shift by the degree, or press R.',
    );
  });

  it('lists a corner dragged with Shift among the selection’s shortcuts, and no Alt for a turn', () => {
    const keys = mount(LayoutPanelKeyboard, { props: { settled: false } });
    const rows = keys
      .findAll('dt')
      .map((dt) => [dt.text(), (dt.element.nextElementSibling as HTMLElement).textContent]);
    expect(rows).toContainEqual(['Shift+drag a corner', 'Turn it by the degree, not in 15° steps']);
    expect(rows.filter(([key, does]) => key.includes('Alt') && /turn/i.test(does!))).toEqual([]);
    keys.unmount();
  });
});

function xy(point: { xMm: number; yMm: number }): [number, number] {
  return [point.xMm, point.yMm];
}

/** The stage, which hears the pointer's moves while a knob is held, as its capture does. */
function stageOf(w: VueWrapper): Element {
  return w.get('[data-testid="layout-stage"]').element;
}
