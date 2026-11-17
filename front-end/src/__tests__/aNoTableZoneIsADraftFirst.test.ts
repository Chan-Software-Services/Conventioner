/**
 * A no-table zone is a draft first (T422, the QC walk of 2026-11-16, item 19): a box dragged with
 * the No-table zone tool is drawn as a draft, with four corner handles, four edge handles and a
 * turn knob, and nothing is added to the layout; a drag inside moves it, a corner sizes it with
 * the opposite corner held, an edge sizes one side, both in the zone's own axes, and the knob turns
 * it in 15° steps, by the degree with Shift. Enter adds it turned, as one step of undo; Escape, a
 * right-click and a change of tool drop it. The zones card says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type {
  FloorplanObject,
  FloorplanTable,
  FloorplanZone,
  SectionObject,
} from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutPanelKeyboard from '@/components/layout/LayoutPanelKeyboard.vue';
import LayoutPanelZones from '@/components/layout/LayoutPanelZones.vue';
import { zoneBounds, zoneCorners, type PointMm } from '@/components/layout/layoutGeometry';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';
import {
  MIN_ZONE_SIDE_MM,
  ZONE_DROPPED,
  ZONE_OFF_THE_FLOORPLAN,
  draftOfBox,
  draftOnTheFloorplan,
  handleCursor,
  heldInHall,
  movedDraft,
  shapeOfDraft,
  sizedDraft,
  turnedDraft,
  type ZoneDraft,
} from '@/components/layout/layoutZoneDraft';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 40 },
];
/** The stage is 800 by 600 px and shows the 30 m by 22.5 m hall whole: 37.5 mm to the pixel. */
const MM_PER_PX = 37.5;
const HALL = { widthMm: 30_000, heightMm: 22_500 };
const p = (xMm: number, yMm: number): PointMm => ({ xMm, yMm });

/** A draft 4 m by 2 m about (10 m, 8 m), square to the page. */
const DRAFT: ZoneDraft = { cxMm: 10_000, cyMm: 8000, widthMm: 4000, depthMm: 2000, rotation: 0 };

const near = (a: PointMm, b: PointMm) => {
  expect(a.xMm).toBeCloseTo(b.xMm, 6);
  expect(a.yMm).toBeCloseTo(b.yMm, 6);
};

// ── The draft's geometry ─────────────────────────────────────────────────────

describe("a zone draft's geometry", () => {
  it('starts as the box dragged, square to the page', () => {
    expect(draftOfBox({ left: 8000, top: 7000, right: 12_000, bottom: 9000 })).toEqual(DRAFT);
    expect(shapeOfDraft(DRAFT)).toEqual({
      xMm: 8000,
      yMm: 7000,
      widthMm: 4000,
      depthMm: 2000,
      rotation: 0,
    });
  });

  it('moves by its middle', () => {
    expect(movedDraft(DRAFT, { dxMm: 1500, dyMm: -500 })).toEqual({
      ...DRAFT,
      cxMm: 11_500,
      cyMm: 7500,
    });
  });

  it('sizes by a corner with the opposite corner held', () => {
    const sized = sizedDraft(DRAFT, [1, 1], p(14_000, 10_000));
    expect(sized).toEqual({ ...DRAFT, cxMm: 11_000, cyMm: 8500, widthMm: 6000, depthMm: 3000 });
    // The top-left corner stands where it stood.
    near(zoneCorners(shapeOfDraft(sized))[0], p(8000, 7000));
  });

  it('sizes a turned draft along its own sides, its opposite corner held', () => {
    const turned = { ...DRAFT, rotation: 90 };
    const before = zoneCorners(shapeOfDraft(turned));
    // Turned a quarter, its own bottom-right corner stands at (9 m, 10 m), down and to the left.
    near(before[2], p(9000, 10_000));
    const sized = sizedDraft(turned, [1, 1], p(8000, 12_000));
    expect(sized.widthMm).toBeCloseTo(6000, 6);
    expect(sized.depthMm).toBeCloseTo(3000, 6);
    expect(sized.rotation).toBe(90);
    const after = zoneCorners(shapeOfDraft(sized));
    near(after[0], before[0]);
    near(after[2], p(8000, 12_000));
  });

  it('sizes one side by an edge, the opposite edge held', () => {
    const wider = sizedDraft(DRAFT, [1, 0], p(15_000, 3000));
    expect(wider).toEqual({ ...DRAFT, cxMm: 11_500, widthMm: 7000 });

    const turned = { ...DRAFT, rotation: 30 };
    const deeper = sizedDraft(turned, [0, 1], p(9000, 11_000));
    expect(deeper.widthMm).toBe(4000);
    const top = zoneCorners(shapeOfDraft(turned));
    const now = zoneCorners(shapeOfDraft(deeper));
    // Its own top edge stands still: both of its corners.
    near(now[0], top[0]);
    near(now[1], top[1]);
    expect(deeper.depthMm).toBeGreaterThan(2000);
  });

  it('is sized no smaller than a zone is drawn', () => {
    const crushed = sizedDraft(DRAFT, [1, 1], p(0, 0));
    expect(crushed.widthMm).toBe(MIN_ZONE_SIDE_MM);
    expect(crushed.depthMm).toBe(MIN_ZONE_SIDE_MM);
    near(zoneCorners(shapeOfDraft(crushed))[0], p(8000, 7000));
  });

  it('turns about its centre in 15° steps from the page, or by the degree', () => {
    const above = p(10_000, 5000);
    // 40° clockwise from straight up, seen from its centre.
    const turn = (40 * Math.PI) / 180;
    const at = p(10_000 + 3000 * Math.sin(turn), 8000 - 3000 * Math.cos(turn));
    expect(turnedDraft(DRAFT, above, at, false)).toEqual({ ...DRAFT, rotation: 45 });
    expect(turnedDraft(DRAFT, above, at, true)).toEqual({ ...DRAFT, rotation: 40 });
    // The steps are the page's: a draft turned 7° turned 10° more stands at 15°.
    const ten = (10 * Math.PI) / 180;
    const by10 = p(10_000 + 3000 * Math.sin(ten), 8000 - 3000 * Math.cos(ten));
    expect(turnedDraft({ ...DRAFT, rotation: 7 }, above, by10, false).rotation).toBe(15);
    // Back past the page's axis it reads 0 to 360.
    expect(turnedDraft(DRAFT, above, p(7000, 5000), false).rotation).toBe(315);
  });

  it('shows each handle the resize arrow it sizes by, turned with the zone', () => {
    expect(handleCursor([1, 1], 0)).toBe('nwse-resize');
    expect(handleCursor([1, -1], 0)).toBe('nesw-resize');
    expect(handleCursor([0, 1], 0)).toBe('ns-resize');
    expect(handleCursor([1, 0], 0)).toBe('ew-resize');
    expect(handleCursor([1, 1], 90)).toBe('nesw-resize');
    expect(handleCursor([0, 1], 90)).toBe('ew-resize');
    expect(handleCursor([1, 0], 45)).toBe('nwse-resize');
    expect(handleCursor([-1, 0], 20)).toBe('ew-resize');
    expect(handleCursor([-1, 0], 30)).toBe('nwse-resize');
  });
});

describe('a turned zone held inside the hall', () => {
  const zone = (x: number, y: number, w: number, d: number, rotation: number) => ({
    id: 'z',
    label: '',
    xMm: x,
    yMm: y,
    widthMm: w,
    depthMm: d,
    rotation,
  });

  it('is moved in whole, as it stands turned, its size and turn kept', () => {
    const held = heldInHall(zone(-1000, 5000, 4000, 2000, 45), HALL);
    const round = zoneBounds(held);
    expect(round.left).toBeCloseTo(0, 6);
    expect(held.widthMm).toBe(4000);
    expect(held.depthMm).toBe(2000);
    expect(held.rotation).toBe(45);
    expect(held.yMm).toBe(5000);
  });

  it('is left where it stands inside', () => {
    const inside = zone(10_000, 5000, 4000, 2000, 30);
    expect(heldInHall(inside, HALL)).toEqual(inside);
  });

  it('is made smaller about its centre where it is larger than the hall', () => {
    const held = heldInHall(zone(0, 0, 40_000, 2000, 45), HALL);
    const round = zoneBounds(held);
    expect(round.left).toBeGreaterThanOrEqual(-1e-6);
    expect(round.top).toBeGreaterThanOrEqual(-1e-6);
    expect(round.right).toBeLessThanOrEqual(HALL.widthMm + 1e-6);
    expect(round.bottom).toBeLessThanOrEqual(HALL.heightMm + 1e-6);
    expect(held.widthMm / held.depthMm).toBeCloseTo(20, 6);
  });

  it('is cut at the hall, unturned, as a box always was', () => {
    expect(heldInHall(zone(-2000, 1000, 6000, 3000, 0), HALL)).toEqual(
      zone(0, 1000, 4000, 3000, 0),
    );
  });
});

describe('a zone draft on the floorplan', () => {
  /** DRAFT turned 45°, its centre at `cxMm`: its turned shape reaches 2121.3 mm either side. */
  const turnedAt = (cxMm: number): ZoneDraft => ({ ...DRAFT, cxMm, rotation: 45 });
  /** How far its turned shape's rightmost corner reaches past `cxMm`. */
  const REACH = 3000 * Math.SQRT1_2;

  it('is on while a zone’s least of it stands on, along each of its sides, unturned', () => {
    // 10 cm left on: both sides a zone's least.
    expect(draftOnTheFloorplan({ ...DRAFT, cxMm: -1900 }, HALL)).toBe(true);
    expect(draftOnTheFloorplan({ ...DRAFT, cxMm: -1950 }, HALL)).toBe(false);
    expect(draftOnTheFloorplan(DRAFT, null)).toBe(true);
  });

  it('is off, turned, when none of its turned shape is on the floorplan', () => {
    expect(draftOnTheFloorplan(turnedAt(-3000), HALL)).toBe(false);
  });

  it('is off, turned, when the corner left on is less than a zone’s least along its sides', () => {
    // 50 mm of its corner on: 70.7 mm along each side from that corner.
    expect(draftOnTheFloorplan(turnedAt(50 - REACH), HALL)).toBe(false);
    // 80 mm of it on: 113 mm along each side, a zone's least.
    expect(draftOnTheFloorplan(turnedAt(80 - REACH), HALL)).toBe(true);
  });

  it('is on, turned, wherever enough stands on, at any edge', () => {
    expect(draftOnTheFloorplan(turnedAt(10_000), HALL)).toBe(true);
    expect(draftOnTheFloorplan({ ...turnedAt(15_000), cyMm: 22_500 + REACH - 50 }, HALL)).toBe(
      false,
    );
    expect(draftOnTheFloorplan({ ...turnedAt(15_000), cyMm: 22_500 }, HALL)).toBe(true);
    expect(draftOnTheFloorplan({ ...turnedAt(30_000 + REACH - 50), cyMm: 10_000 }, HALL)).toBe(
      false,
    );
  });
});

// ── The draft on the map ─────────────────────────────────────────────────────

let wrapper: VueWrapper | null = null;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function anEditor(zones: FloorplanZone[] = [], tables: FloorplanTable[] = []) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-testid');
    if (id !== 'layout-stage' && id !== 'layout-map') return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, 0, 800, 600);
  });
  const sent: FloorplanObject[] = [];
  const editor = useLayoutEditor({
    save: (layout: FloorplanObject): Promise<SavedLayout> => {
      sent.push(layout);
      return Promise.resolve({ floorplan: { ...layout, revision: layout.revision + 1 } });
    },
    tableTypes: () => [SIX_FOOT],
    newId: () => 'zone-new',
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
    zones,
    sectionStyles: [],
    startingCounts: [],
  });
  wrapper = mount(LayoutEditor, {
    props: { editor, locationName: 'Upper Hall', sections: SECTIONS, tableTypes: [SIX_FOOT] },
    attachTo: document.body,
  });
  await nextTick();
  const w = wrapper;
  wrapper.get('[data-testid="layout-tool-zone"]').element.dispatchEvent(new MouseEvent('click'));
  await nextTick();
  const stage = wrapper.get('[data-testid="layout-stage"]').element;
  stage.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
  await nextTick();
  const toolOn = () =>
    w.get('[aria-pressed="true"][data-testid^="layout-tool-"]').attributes('data-testid');
  /** The draft as it is drawn: its centre and turn from its frame, its sides from its body, to a
   *  thousandth of a millimetre. */
  const draft = (): ZoneDraft | null => {
    const frame = w.find('[data-testid="layout-zone-draft"]');
    if (!frame.exists()) return null;
    const [, cx, cy, turn] = frame
      .attributes('transform')!
      .match(/translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)/)!
      .map(Number);
    const body = w.get('[data-testid="layout-zone-draft-body"]');
    const r = (n: number) => Math.round(n * 1000) / 1000 + 0;
    return {
      cxMm: r(cx),
      cyMm: r(cy),
      widthMm: r(Number(body.attributes('width'))),
      depthMm: r(Number(body.attributes('height'))),
      rotation: r(turn),
    };
  };
  return { w, editor, stage, sent, toolOn, draft, zones: () => editor.layout.value!.zones };
}

async function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  at: PointMm,
  on: Element,
  init: PointerEventInit = {},
) {
  // Vue hears no event stamped before its listener was attached, and the clock stands still under
  // fake timers: a few milliseconds pass before each.
  vi.advanceTimersByTime(4);
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

/** A drag pressed on an element (the stage, or a handle of the draft) and carried on the stage,
 *  which the press captures. */
async function drag(on: Element, stage: Element, from: PointMm, to: PointMm, init = {}) {
  await pointer('pointerdown', from, on, init);
  await pointer('pointermove', p((from.xMm + to.xMm) / 2, (from.yMm + to.yMm) / 2), stage, init);
  await pointer('pointermove', to, stage, init);
  await pointer('pointerup', to, stage, init);
}

async function key(name: string, init: KeyboardEventInit = {}) {
  vi.advanceTimersByTime(4);
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }),
  );
  await nextTick();
}

/** The box (8 m, 7 m) to (12 m, 9 m) dragged on the floor. */
async function drawADraft(stage: Element) {
  await drag(stage, stage, p(8000, 7000), p(12_000, 9000));
}

describe('a box dragged with No-table zone on', () => {
  it('is a draft with its handles, and adds nothing to the layout or its saves', async () => {
    const { w, stage, editor, sent, draft, zones } = await anEditor();
    await drawADraft(stage);

    expect(draft()).toEqual(DRAFT);
    expect(w.findAll('[data-testid="layout-zone-corner"]')).toHaveLength(4);
    expect(w.findAll('[data-testid="layout-zone-edge-handle"]')).toHaveLength(4);
    expect(w.findAll('[data-testid="layout-zone-edge"]')).toHaveLength(4);
    expect(w.find('[data-testid="layout-zone-turn"]').exists()).toBe(true);
    expect(w.get('[data-testid="layout-zone-draft-body"]').attributes('stroke')).toBe(
      'var(--mm-blue)',
    );
    expect(zones()).toEqual([]);
    expect(editor.canUndo.value).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(w.emitted('zoneAdded')).toBeUndefined();
  });

  it('is no draft when smaller than a zone, and says so', async () => {
    const { w, stage, draft } = await anEditor();
    await drag(stage, stage, p(8000, 7000), p(8100, 9000));
    expect(draft()).toBeNull();
    expect(w.emitted('status')!.at(-1)).toEqual(['Drag a larger box to mark a no-table zone.']);
  });

  it('moves by a drag inside it', async () => {
    const { w, stage, draft } = await anEditor();
    await drawADraft(stage);
    const body = w.get('[data-testid="layout-zone-draft-body"]').element;
    await drag(body, stage, p(10_000, 8000), p(13_000, 12_000));
    expect(draft()).toEqual({ ...DRAFT, cxMm: 13_000, cyMm: 12_000 });
  });

  it('sizes by a corner, the opposite corner held', async () => {
    const { w, stage, draft } = await anEditor();
    await drawADraft(stage);
    const corner = w
      .findAll('[data-testid="layout-zone-corner"]')
      .find((one) => one.attributes('data-handle') === '1,1')!.element;
    await drag(corner, stage, p(12_000, 9000), p(14_000, 10_000));
    expect(draft()).toEqual({ ...DRAFT, cxMm: 11_000, cyMm: 8500, widthMm: 6000, depthMm: 3000 });
  });

  it('sizes one side by an edge, pressed anywhere along it', async () => {
    const { w, stage, draft } = await anEditor();
    await drawADraft(stage);
    const right = w
      .findAll('[data-testid="layout-zone-edge"]')
      .find((one) => one.attributes('data-handle') === '1,0')!.element;
    // Pressed off its middle, near its top.
    await drag(right, stage, p(12_000, 7200), p(15_000, 4000));
    expect(draft()).toEqual({ ...DRAFT, cxMm: 11_500, widthMm: 7000 });

    const bottom = w
      .findAll('[data-testid="layout-zone-edge-handle"]')
      .find((one) => one.attributes('data-handle') === '0,1')!.element;
    await drag(bottom, stage, p(11_500, 9000), p(11_500, 10_000));
    expect(draft()).toEqual({ ...DRAFT, cxMm: 11_500, cyMm: 8500, widthMm: 7000, depthMm: 3000 });
  });

  it('turns by its knob in 15° steps, and by the degree with Shift', async () => {
    const { w, stage, draft } = await anEditor();
    await drawADraft(stage);
    const knob = () => w.get('[data-testid="layout-zone-turn"]').element;
    const turn = (40 * Math.PI) / 180;
    const at40 = p(10_000 + 3000 * Math.sin(turn), 8000 - 3000 * Math.cos(turn));
    await drag(knob(), stage, p(10_000, 5000), at40);
    expect(draft()!.rotation).toBe(45);

    await drag(knob(), stage, p(10_000, 5000), at40, { shiftKey: true });
    // From 45°, 40° more by the degree.
    expect(draft()!.rotation).toBe(85);
    expect(draft()!.cxMm).toBe(10_000);
  });

  it("shows its handles' cursors turned with it", async () => {
    const { w, stage } = await anEditor();
    await drawADraft(stage);
    const cursorOf = (testid: string, handle: string) =>
      w
        .findAll(`[data-testid="${testid}"]`)
        .find((one) => one.attributes('data-handle') === handle)!
        .attributes('style');
    expect(cursorOf('layout-zone-corner', '1,1')).toContain('nwse-resize');
    expect(cursorOf('layout-zone-edge', '0,1')).toContain('ns-resize');
    const knob = w.get('[data-testid="layout-zone-turn"]').element;
    await drag(knob, stage, p(10_000, 5000), p(13_000, 8000));
    expect(cursorOf('layout-zone-corner', '1,1')).toContain('nesw-resize');
    expect(cursorOf('layout-zone-edge', '0,1')).toContain('ew-resize');
  });

  it('is put back where it stood when Escape ends its drag', async () => {
    const { w, stage, draft } = await anEditor();
    await drawADraft(stage);
    const body = w.get('[data-testid="layout-zone-draft-body"]').element;
    await pointer('pointerdown', p(10_000, 8000), body);
    await pointer('pointermove', p(12_000, 8000), stage);
    await pointer('pointermove', p(14_000, 8000), stage);
    expect(draft()!.cxMm).toBe(14_000);
    await key('Escape');
    expect(draft()).toEqual(DRAFT);
    await pointer('pointerup', p(16_000, 8000), stage);
    expect(draft()).toEqual(DRAFT);
  });

  it('gives way to another box dragged beside it', async () => {
    const { stage, draft, zones } = await anEditor();
    await drawADraft(stage);
    await drag(stage, stage, p(20_000, 15_000), p(24_000, 18_000));
    expect(draft()).toEqual({
      cxMm: 22_000,
      cyMm: 16_500,
      widthMm: 4000,
      depthMm: 3000,
      rotation: 0,
    });
    expect(zones()).toEqual([]);
  });
});

describe('Enter, with a zone drawn', () => {
  it('adds it turned, as one step of undo, says its size and asks for its name', async () => {
    const { w, stage, editor, sent, draft, zones } = await anEditor();
    await drawADraft(stage);
    const knob = w.get('[data-testid="layout-zone-turn"]').element;
    await drag(knob, stage, p(10_000, 5000), p(13_000, 8000));
    expect(draft()!.rotation).toBe(90);

    await key('Enter');
    expect(draft()).toBeNull();
    expect(zones()).toEqual([
      {
        id: 'zone-new',
        label: '',
        xMm: 8000,
        yMm: 7000,
        widthMm: 4000,
        depthMm: 2000,
        rotation: 90,
      },
    ]);
    expect(w.emitted('announce')!.at(-1)).toEqual([
      'Added a no-table zone 4.0 m by 2.0 m, turned 90°. Name it in the panel.',
    ]);
    expect(w.emitted('zoneAdded')).toEqual([['zone-new']]);
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(sent.at(-1)!.zones[0].rotation).toBe(90);

    editor.undo();
    expect(zones()).toEqual([]);
    expect(editor.canUndo.value).toBe(false);
  });

  it('adds a draft square to the page with no turn', async () => {
    const { stage, zones } = await anEditor();
    await drawADraft(stage);
    await key('Enter');
    expect(zones()).toEqual([
      { id: 'zone-new', label: '', xMm: 8000, yMm: 7000, widthMm: 4000, depthMm: 2000 },
    ]);
  });

  it('adds it held inside the floorplan as it stands turned', async () => {
    const { w, stage, zones } = await anEditor();
    await drawADraft(stage);
    const knob = () => w.get('[data-testid="layout-zone-turn"]').element;
    await drag(knob(), stage, p(10_000, 5000), p(13_000, 5000));
    const body = w.get('[data-testid="layout-zone-draft-body"]').element;
    // Carried over the hall's left edge.
    await drag(body, stage, p(10_000, 8000), p(500, 8000));
    await key('Enter');
    const [zone] = zones();
    expect(zone.rotation).toBe(45);
    expect(zone.widthMm).toBe(4000);
    expect(zoneBounds(zone).left).toBeGreaterThanOrEqual(-1);
    expect(zoneBounds(zone).left).toBeLessThan(1);
  });

  it('keeps a draft moved mostly off the floorplan, and says to move it back on', async () => {
    const { w, stage, draft, zones } = await anEditor();
    await drawADraft(stage);
    const body = w.get('[data-testid="layout-zone-draft-body"]').element;
    // Carried over the hall's left edge until 5 cm of it is left on the floorplan.
    await drag(body, stage, p(10_000, 8000), p(-1950, 8000));
    await key('Enter');
    expect(zones()).toEqual([]);
    expect(draft()).toEqual({ ...DRAFT, cxMm: -1950 });
    expect(w.emitted('status')!.at(-1)).toEqual([ZONE_OFF_THE_FLOORPLAN]);

    // Carried back on, it is added.
    await drag(
      w.get('[data-testid="layout-zone-draft-body"]').element,
      stage,
      p(-1950, 8000),
      p(10_000, 8000),
    );
    await key('Enter');
    expect(zones()).toEqual([
      { id: 'zone-new', label: '', xMm: 8000, yMm: 7000, widthMm: 4000, depthMm: 2000 },
    ]);
  });

  it('on a table under the focus adds the draft, picking nothing up', async () => {
    const table = {
      id: 'a',
      sectionId: 'gold',
      number: 1,
      tableTypeId: 'six-foot',
      xMm: 20_000,
      yMm: 15_000,
      rotation: 0,
    };
    const { w, stage, editor, zones } = await anEditor([], [table]);
    await drawADraft(stage);
    const onTheMap = w.get('[data-table-id="a"]').element as HTMLElement;
    onTheMap.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(zones()).toHaveLength(1);
    expect(editor.pickedUp.value).toEqual([]);
  });
});

describe('Enter elsewhere on the page, with a zone drawn', () => {
  it("is the focused button's own, adding nothing", async () => {
    const { stage, draft, zones } = await anEditor();
    await drawADraft(stage);
    const outside = document.createElement('button');
    let pressed = 0;
    outside.addEventListener('keydown', (event) => {
      if (!event.defaultPrevented && event.key === 'Enter') pressed += 1;
    });
    document.body.append(outside);
    outside.focus();
    vi.advanceTimersByTime(4);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    outside.dispatchEvent(enter);
    await nextTick();
    expect(enter.defaultPrevented).toBe(false);
    expect(pressed).toBe(1);
    expect(zones()).toEqual([]);
    expect(draft()).toEqual(DRAFT);
  });

  it("is the draft's from the editor's own toolbar, where the tool was chosen", async () => {
    const { w, stage, zones } = await anEditor();
    await drawADraft(stage);
    const button = w.get('[data-testid="layout-tool-zone"]').element as HTMLElement;
    button.focus();
    vi.advanceTimersByTime(4);
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(zones()).toHaveLength(1);
  });
});

describe('a zone drawn and dropped', () => {
  it('goes by Escape, the tool kept, then Escape goes to Select', async () => {
    const { w, stage, draft, toolOn, zones } = await anEditor();
    await drawADraft(stage);
    await key('Escape');
    expect(draft()).toBeNull();
    expect(toolOn()).toBe('layout-tool-zone');
    expect(w.emitted('status')!.at(-1)).toEqual([ZONE_DROPPED]);
    expect(zones()).toEqual([]);
    await key('Escape');
    expect(toolOn()).toBe('layout-tool-select');
  });

  it('goes with a change of location, adding nothing to the next', async () => {
    const { stage, editor, draft, zones } = await anEditor();
    await drawADraft(stage);
    editor.adopt({ ...editor.layout.value!, id: 'fp-2', locationId: 'loc-lower', zones: [] });
    await nextTick();
    expect(draft()).toBeNull();
    await key('Enter');
    expect(zones()).toEqual([]);
  });

  it('goes with a change of tool', async () => {
    const { w, stage, draft, zones } = await anEditor();
    await drawADraft(stage);
    w.get('[data-testid="layout-tool-add"]').element.dispatchEvent(new MouseEvent('click'));
    await nextTick();
    w.get('[data-testid="layout-tool-zone"]').element.dispatchEvent(new MouseEvent('click'));
    await nextTick();
    expect(draft()).toBeNull();
    expect(zones()).toEqual([]);
  });
});

describe('a turned zone, to Add table', () => {
  it("places a table at the view's middle where the box round the zone covers it, but not the zone", async () => {
    // A ramp 10 m by 1 m about (18 m, 8 m), turned 45°: the box round it covers the view's middle
    // at (15 m, 11.25 m), and the ramp itself passes well above and to the right of it.
    const ramp: FloorplanZone = {
      id: 'zone-ramp',
      label: 'Ramp',
      xMm: 13_000,
      yMm: 7500,
      widthMm: 10_000,
      depthMm: 1000,
      rotation: 45,
    };
    const { w, editor } = await anEditor([ramp]);
    w.get('[data-testid="layout-tool-add"]').element.dispatchEvent(new MouseEvent('click'));
    await nextTick();
    w.get('.layout-map').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(editor.layout.value!.tables).toHaveLength(1);
    expect(editor.layout.value!.tables[0]).toMatchObject({ xMm: 15_000, yMm: 11_250 });
  });
});

describe('the hint, with No-table zone on', () => {
  it('says how a box becomes a draft, and how a draft is added and dropped', async () => {
    const { w, stage } = await anEditor();
    const hint = () => w.get('[data-testid="layout-hint"]').text();
    expect(hint()).toContain('Drag a box over a stage, a pillar or an exit');
    await drawADraft(stage);
    expect(hint()).toBe(
      'Drag the zone to move it, an edge or a corner to size it, or its knob to turn it ' +
        '(Shift: by the degree). Enter adds it; Escape or a right-click drops it.',
    );
  });
});

describe('the keyboard shortcuts', () => {
  it.each([false, true])('name the keys of a zone drawn (settled: %s)', (settled) => {
    const list = mount(LayoutPanelKeyboard, { props: { settled } });
    const text = list.text();
    expect(text).toContain('With a no-table zone drawn');
    expect(text).toContain('Add the zone drawn');
    expect(text).toContain('Drop it, and No-table zone stays on');
    expect(text).toContain('While turning it by its knob: by the degree');
  });
});

describe('the No-table zones card', () => {
  it('says, with none yet, to drag a box on the map and press Enter', () => {
    const card = mount(LayoutPanelZones, { props: { zones: [] } });
    const none = card.get('[data-testid="layout-panel-no-zones"]').text();
    expect(none).not.toContain('Draw one with No-table zone');
    expect(none).toContain('Drag a box on the map');
    expect(card.get('[data-testid="layout-panel-zones-hint"]').text()).toBe(
      'A box drawn is a draft to move, size and turn. Enter adds it; Escape or a right-click ' +
        'drops it.',
    );
  });

  it('keeps its hint under the zones it lists', () => {
    const stage: FloorplanZone = {
      id: 'z',
      label: 'Stage',
      xMm: 0,
      yMm: 0,
      widthMm: 4000,
      depthMm: 2000,
      rotation: 30,
    };
    const card = mount(LayoutPanelZones, { props: { zones: [stage] } });
    expect(card.find('[data-testid="layout-panel-zones-hint"]').exists()).toBe(true);
  });
});
