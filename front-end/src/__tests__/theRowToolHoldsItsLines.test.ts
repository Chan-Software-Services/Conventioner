/**
 * Row of tables in the editor (T422, the QC walk of 2026-11-16, items 16 and 17): a point laid by a
 * click after the first holds its line from the last point to 15° steps, a table's snap kept only
 * where it lies on a step; Shift lays it at any angle, every snap kept, and the preview redraws as
 * Shift is pressed or let go with no pointer move (D11); Alt lays it freely. The row ends at its
 * last point: the stretch to the pointer is drawn as ghosts and counted "3 tables (7 with a point
 * here)", never placed, and one point alone places nothing. A straight drag waits, its two ends to
 * drag, for Enter, as a curve does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject, FloorplanTable, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutPanelKeyboard from '@/components/layout/LayoutPanelKeyboard.vue';
import { ANGLE_STEP, angleFrom } from '@/components/layout/layoutGeometry';
import { GROUP_CHOICES_AT_FIRST, groupChoices } from '@/components/layout/layoutGroups';
import {
  ROW_ANGLE_HELD,
  ROW_CHOICES_AT_FIRST,
  heldToTheSteps,
  rowChoices,
} from '@/components/layout/layoutRow';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 40 },
];
/** The stage is 800 by 600 px and shows the 30 m by 22.5 m hall whole: 37.5 mm to the pixel. */
const MM_PER_PX = 37.5;
const p = (xMm: number, yMm: number) => ({ xMm, yMm });

function aLayout(tables: FloorplanTable[] = []): FloorplanObject {
  return {
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
  };
}

let wrapper: VueWrapper | null = null;

async function anEditor(tables: FloorplanTable[] = []) {
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
  await nextTick();
  wrapper.get('[data-testid="layout-tool-row"]').element.dispatchEvent(new MouseEvent('click'));
  await nextTick();
  const stage = wrapper.get('[data-testid="layout-stage"]').element;
  // The pointer is over the map, so the keys are the map's, as they are for a person drawing.
  stage.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  await nextTick();
  return { w: wrapper, editor, stage, tables: () => editor.layout.value!.tables };
}

beforeEach(() => {
  Object.assign(rowChoices, ROW_CHOICES_AT_FIRST);
  Object.assign(groupChoices, GROUP_CHOICES_AT_FIRST);
});
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

/** A click at a place: a press and its release, with no move between. */
async function click(at: { xMm: number; yMm: number }, on: Element, init: PointerEventInit = {}) {
  await pointer('pointerdown', at, on, init);
  await pointer('pointerup', at, on, init);
}

/** The pointer resting over the map with no button down. */
const hover = (at: { xMm: number; yMm: number }, on: Element, init: PointerEventInit = {}) =>
  pointer('pointermove', at, on, { buttons: 0, ...init });

async function key(type: 'keydown' | 'keyup', name: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }),
  );
  await nextTick();
}

/** The places of the row's line as drawn, the pointer's last where it carries the path. */
function linePoints(w: VueWrapper) {
  const line = w.find('[data-testid="layout-row-line"]');
  if (!line.exists()) return [];
  return line
    .attributes('points')!
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return p(x, y);
    });
}

const FIRST = p(3000, 3000);
/** 100 px right of the first point and 20 px down: 11.3° off the page's axis, 3,824 mm away. */
const OFF_THE_STEP = p(3000 + 100 * MM_PER_PX, 3000 + 20 * MM_PER_PX);
const OFF_ANGLE = (Math.atan2(20, 100) * 180) / Math.PI;
const OFF_LENGTH = Math.hypot(100, 20) * MM_PER_PX;

describe("a point-to-point row's line", () => {
  it('holds a point after the first to 15° steps, at the pointer’s distance', async () => {
    const { w, stage } = await anEditor();
    await click(FIRST, stage);
    await hover(OFF_THE_STEP, stage);
    const line = linePoints(w);
    expect(line[0].xMm).toBeCloseTo(FIRST.xMm, 6);
    expect(line[0].yMm).toBeCloseTo(FIRST.yMm, 6);
    const to = line.at(-1)!;
    expect(angleFrom(FIRST, to)).toBeCloseTo(15, 6);
    expect(Math.hypot(to.xMm - FIRST.xMm, to.yMm - FIRST.yMm)).toBeCloseTo(OFF_LENGTH, 3);
  });

  it('lays the point a click puts down where the line was shown, and places along it', async () => {
    const { stage, tables } = await anEditor();
    await click(FIRST, stage);
    await hover(OFF_THE_STEP, stage);
    await click(OFF_THE_STEP, stage);
    await key('keydown', 'Enter');
    expect(tables().length).toBeGreaterThan(0);
    for (const table of tables()) expect(table.rotation).toBeCloseTo(15, 3);
  });

  it('takes any angle with Shift, and redraws as Shift is pressed and let go with no move', async () => {
    const { w, stage } = await anEditor();
    await click(FIRST, stage);
    await hover(OFF_THE_STEP, stage, { shiftKey: true });
    expect(angleFrom(FIRST, linePoints(w).at(-1)!)).toBeCloseTo(OFF_ANGLE, 6);

    await key('keyup', 'Shift');
    expect(angleFrom(FIRST, linePoints(w).at(-1)!)).toBeCloseTo(15, 6);
    await key('keydown', 'Shift', { shiftKey: true });
    expect(angleFrom(FIRST, linePoints(w).at(-1)!)).toBeCloseTo(OFF_ANGLE, 6);
  });

  it('lays a Shift and click point at any angle', async () => {
    const { stage, tables } = await anEditor();
    await click(FIRST, stage);
    await hover(OFF_THE_STEP, stage, { shiftKey: true });
    await click(OFF_THE_STEP, stage, { shiftKey: true });
    await key('keydown', 'Enter');
    expect(tables().length).toBeGreaterThan(0);
    for (const table of tables()) expect(table.rotation).toBeCloseTo(OFF_ANGLE, 1);
  });

  it('lays a point freely with Alt', async () => {
    const { w, stage } = await anEditor();
    await click(FIRST, stage);
    await hover(OFF_THE_STEP, stage, { altKey: true });
    expect(angleFrom(FIRST, linePoints(w).at(-1)!)).toBeCloseTo(OFF_ANGLE, 6);
  });

  it('lays a point carried by a drag where the line was shown, held to the steps', async () => {
    const { stage, tables } = await anEditor();
    await click(FIRST, stage);
    await pointer('pointerdown', p(9000, 9000), stage);
    await pointer('pointermove', p(8000, 6000), stage);
    await pointer('pointermove', OFF_THE_STEP, stage);
    await pointer('pointerup', OFF_THE_STEP, stage);
    await key('keydown', 'Enter');
    expect(tables().length).toBeGreaterThan(0);
    for (const table of tables()) expect(table.rotation).toBeCloseTo(15, 3);
  });

  it('leaves the first point where the pointer is, and a drag’s line as it is drawn', async () => {
    const { w, stage, tables } = await anEditor();
    // A drag with no point laid draws the row's line by hand: never held to the steps.
    await pointer('pointerdown', FIRST, stage);
    await pointer('pointermove', p(4000, 3200), stage);
    await pointer('pointermove', OFF_THE_STEP, stage);
    await pointer('pointerup', OFF_THE_STEP, stage);
    const [from, to] = [linePoints(w)[0], linePoints(w).at(-1)!];
    expect(from.xMm).toBeCloseTo(FIRST.xMm, 6);
    expect(from.yMm).toBeCloseTo(FIRST.yMm, 6);
    expect(angleFrom(from, to)).toBeCloseTo(OFF_ANGLE, 0);
    expect(tables()).toEqual([]);
  });
});

describe('the steps and a table’s snap', () => {
  const last = p(0, 0);

  it('holds the pointer’s place to the nearest step at its distance', () => {
    const held = heldToTheSteps(last, p(1000, 200), p(1000, 200));
    expect(angleFrom(last, held)).toBeCloseTo(15, 9);
    expect(Math.hypot(held.xMm, held.yMm)).toBeCloseTo(Math.hypot(1000, 200), 9);
    expect(ANGLE_STEP).toBe(15);
  });

  it('keeps a snap that lies on a step, and none that lies off it', () => {
    const turn = (degrees: number, length: number) =>
      p(length * Math.cos((degrees * Math.PI) / 180), length * Math.sin((degrees * Math.PI) / 180));
    const at = turn(28, 2000);
    // A table's corner at 29.7°, within half a degree of 30°: kept as it is.
    const onTheStep = turn(30 - ROW_ANGLE_HELD * 0.6, 2100);
    expect(heldToTheSteps(last, at, onTheStep)).toEqual(onTheStep);
    // One at 29°, a degree off: the step wins, at the pointer's distance.
    const offTheStep = turn(29, 2100);
    const held = heldToTheSteps(last, at, offTheStep);
    expect(angleFrom(last, held)).toBeCloseTo(30, 9);
    expect(Math.hypot(held.xMm, held.yMm)).toBeCloseTo(2000, 9);
  });

  it('holds the angle the other way round and across the axis', () => {
    expect(angleFrom(last, heldToTheSteps(last, p(-1000, -260), p(-1000, -260)))).toBeCloseTo(
      -165,
      9,
    );
    expect(angleFrom(last, heldToTheSteps(last, p(1000, -40), p(1000, -40)))).toBeCloseTo(0, 9);
  });
});

describe('the row ends at its last point', () => {
  it('draws the stretch to the pointer as ghosts, counts them, and places only the points’ row', async () => {
    const { w, stage, tables } = await anEditor();
    await click(p(2000, 3000), stage);
    await hover(p(7600, 3000), stage);
    // One point: ghosts to the pointer, no row.
    expect(w.findAll('[data-testid="layout-row-table"]')).toHaveLength(0);
    expect(w.findAll('[data-testid="layout-row-ghost"]')).toHaveLength(3);
    expect(w.get('[data-testid="layout-row-count"]').text()).toBe('0 tables (3 with a point here)');
    // Enter waits for a second point, and says nothing: no "no table fits" of a row not yet drawn.
    const said = w.emitted('announce')?.length ?? 0;
    await key('keydown', 'Enter');
    expect(tables()).toEqual([]);
    expect(w.emitted('announce')?.length ?? 0).toBe(said);
    expect(w.find('[data-testid="layout-row-preview"]').exists()).toBe(true);

    await click(p(7600, 3000), stage);
    await hover(p(15_000, 3000), stage);
    expect(w.findAll('[data-testid="layout-row-table"]')).toHaveLength(3);
    expect(w.findAll('[data-testid="layout-row-ghost"]')).toHaveLength(4);
    expect(w.get('[data-testid="layout-row-count"]').text()).toBe('3 tables (7 with a point here)');
    await key('keydown', 'Enter');
    expect(tables()).toHaveLength(3);
    expect(Math.max(...tables().map((table) => table.xMm))).toBeLessThan(7600);
  });

  it('counts the row alone once the pointer rests on its last point', async () => {
    const { w, stage } = await anEditor();
    await click(p(2000, 3000), stage);
    await click(p(7600, 3000), stage);
    await hover(p(7600, 3000), stage);
    expect(w.findAll('[data-testid="layout-row-ghost"]')).toHaveLength(0);
    expect(w.get('[data-testid="layout-row-count"]').text()).toBe('3 tables');
  });

  it('draws its ghosts faint and dashed, unfilled, past the row’s tables', async () => {
    const { w, stage } = await anEditor();
    await click(p(2000, 3000), stage);
    await click(p(7600, 3000), stage);
    await hover(p(15_000, 3000), stage);
    const ghost = w.get('[data-testid="layout-row-ghost"]');
    expect(ghost.attributes('fill')).toBe('none');
    expect(ghost.attributes('stroke-dasharray')).toBe('3 3');
    expect(ghost.attributes('stroke-opacity')).toBe('0.6');
  });
});

describe('a straight drag', () => {
  async function dragAStraightLine(stage: Element) {
    await pointer('pointerdown', p(2000, 3000), stage);
    await pointer('pointermove', p(8000, 3000), stage);
    await pointer('pointermove', p(22_000, 3000), stage);
    await pointer('pointerup', p(22_000, 3000), stage);
  }

  it('waits on letting go, its line and its two ends drawn, and says Enter places it', async () => {
    const { w, stage, tables } = await anEditor();
    await dragAStraightLine(stage);
    expect(tables()).toEqual([]);
    expect(w.findAll('[data-testid="layout-row-table"]')).toHaveLength(10);
    expect(w.findAll('[data-testid="layout-row-point"]')).toHaveLength(2);
    expect(w.findAll('[data-testid="layout-row-ghost"]')).toHaveLength(0);
    expect(w.emitted('announce')!.at(-1)).toEqual(['Line drawn. 10 tables. Enter places it.']);
    expect(w.get('[data-testid="layout-hint"]').text()).toBe(
      'Drag a point to adjust the line. Enter places the row; Escape or a right-click drops it, ' +
        'and Backspace takes its last point back.',
    );
    await key('keydown', 'Enter');
    expect(tables()).toHaveLength(10);
    // Centred on the line, the default.
    for (const table of tables()) expect(table.yMm).toBeCloseTo(3000, 3);
  });

  it('is shortened by dragging an end, and placed as it then stands', async () => {
    const { stage, tables } = await anEditor();
    await dragAStraightLine(stage);
    await pointer('pointerdown', p(22_000, 3000), stage);
    await pointer('pointermove', p(18_000, 3000), stage);
    await pointer('pointermove', p(12_000, 3000), stage);
    await pointer('pointerup', p(12_000, 3000), stage);
    expect(tables()).toEqual([]);
    await key('keydown', 'Enter');
    expect(tables()).toHaveLength(5);
  });
});

describe('what the page says of a row', () => {
  it('says how to draw one, and that its lines hold to steps once a point is laid', async () => {
    const { w, stage } = await anEditor();
    await hover(p(1000, 1000), stage);
    expect(w.get('[data-testid="layout-hint"]').text()).toBe(
      "Click along a wall. A sharp turn makes a corner. Or drag to draw the row's line, " +
        'straight or curved, to adjust; Enter places it.',
    );
    await click(FIRST, stage);
    expect(w.get('[data-testid="layout-hint"]').text()).toBe(
      'Click along a wall: each line holds to 15° steps, any angle with Shift. Double-click or ' +
        'press Enter to place the row, or click the first point to close a shape.',
    );
  });

  it('lists Shift and a click, and a right-click with Escape, among the shortcuts', () => {
    const text = mount(LayoutPanelKeyboard).text();
    expect(text).toContain(
      'Shift+clickLay a point at any angle; a click holds the line to 15° steps',
    );
    expect(text).toContain('Escape or Right-clickBack to Select, with nothing being drawn');
  });
});
