/**
 * `LayoutMap` given a day's seats (T422 ticket 02): a table drawn filled, outlined or free by who
 * holds it, a shared table drawn as two halves each pressed on its own, a press saying which seat
 * it was, seats and tables marked, a turned zone, the image in its own colours, and the outline
 * that hugs a table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type {
  FloorplanObject,
  FloorplanTable,
  SectionObject,
  TableTypeObject,
} from '@/assets/types/datatypes';
import LayoutMap from '@/components/layout/LayoutMap.vue';
import type { MapSeat } from '@/components/layout/layoutDrawing';
import { OUTLINE_OUT_PX, OUTLINE_WIDTH_PX } from '@/components/layout/layoutGeometry';

const UPPER = { id: 'loc-upper', name: 'Upper Hall' };

const SECTIONS: SectionObject[] = [
  { id: 'sec-gold', name: 'Gold row', location: UPPER, tier: null, count: 0 },
  { id: 'sec-silver', name: 'Silver aisle', location: UPPER, tier: null, count: 0 },
];

const TYPES: TableTypeObject[] = [
  { id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 },
];

function table(
  id: string,
  sectionId: string | null,
  number: number | null,
  xMm: number,
  yMm: number,
  rotation = 0,
): FloorplanTable {
  return { id, sectionId, number, tableTypeId: 'type-6ft', xMm, yMm, rotation };
}

/** A hall 30 m by 22.5 m: Gold row of four along the top, Silver aisle's one turned a half. */
function layout(changes: Partial<FloorplanObject> = {}): FloorplanObject {
  return {
    id: 'fp-1',
    locationId: UPPER.id,
    revision: 1,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables: [
      table('g1', 'sec-gold', 1, 5000, 3000),
      table('g2', 'sec-gold', 2, 7000, 3000),
      table('g3', 'sec-gold', 3, 9000, 3000),
      table('g4', 'sec-gold', 4, 11_000, 3000),
      table('s1', 'sec-silver', 1, 5000, 8000, 180),
    ],
    zones: [{ id: 'z1', label: 'Stage', xMm: 12_000, yMm: 10_000, widthMm: 8000, depthMm: 3000 }],
    sectionStyles: [],
    startingCounts: [],
    ...changes,
  };
}

/** Gold row 1 whole and here; 2 shared, left here and right expected; 3's left half alone,
 *  expected; 4 free; Silver aisle 1 shared, turned a half. */
const SEATS: MapSeat[] = [
  { key: 'acme', tableId: 'g1', half: 'whole', tone: 'filled', name: 'Acme Ceramics' },
  { key: 'bee', tableId: 'g2', half: 'left', tone: 'filled', name: 'Bee Candles' },
  { key: 'cog', tableId: 'g2', half: 'right', tone: 'outlined', name: 'Cog Prints' },
  { key: 'dot', tableId: 'g3', half: 'left', tone: 'outlined', name: 'Dot Knits' },
  { key: 'elm', tableId: 's1', half: 'left', tone: 'filled', name: 'Elm Soaps' },
  { key: 'fig', tableId: 's1', half: 'right', tone: 'filled', name: 'Fig Jams' },
  // A seat at a table of another layout draws nothing here.
  { key: 'gone', tableId: 'elsewhere', half: 'whole', tone: 'filled', name: 'Gone Away' },
];

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

/** Draw the map in a box measured at 1 px to 25 mm of the view it shows. */
function draw(props: Record<string, unknown> = {}, floorplan = layout(), pxPerMm = 0.04) {
  const measured = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-testid') !== 'layout-map') return measured.call(this);
    const [, , widthMm, heightMm] = (this.getAttribute('viewBox') ?? '0 0 0 0')
      .split(' ')
      .map(Number);
    return new DOMRect(0, 0, widthMm * pxPerMm, heightMm * pxPerMm);
  });
  wrapper = mount(LayoutMap, {
    attachTo: document.body,
    props: {
      layout: floorplan,
      locationName: UPPER.name,
      sections: SECTIONS,
      tableTypes: TYPES,
      mode: 'read',
      imageUrl: 'blob:fixture',
      seats: SEATS,
      ...props,
    },
  });
  return wrapper;
}

const tableById = (map: VueWrapper, id: string) => map.get(`[data-table-id="${id}"]`);
const buttons = (map: VueWrapper) => map.findAll('[role="button"]');
const topOf = (map: VueWrapper, id: string) =>
  tableById(map, id).get('[data-testid="layout-table-top"]');
const halfOf = (map: VueWrapper, id: string, side: 'left' | 'right') =>
  tableById(map, id).get(`[data-half="${side}"]`);
/** A half's label, which stands beside its button, never in it. */
const labelOf = (map: VueWrapper, id: string, side: 'left' | 'right') =>
  tableById(map, id).get(`[data-label-of="${side}"]`);
const paintOf = (shape: { attributes: (name: string) => string | undefined }) => [
  shape.attributes('fill'),
  shape.attributes('stroke'),
  shape.attributes('stroke-dasharray'),
];

describe('a table by who holds it', () => {
  it("draws a whole seat's table in its tone and names it with the seat's name", () => {
    const map = draw();
    const acme = tableById(map, 'g1');
    expect(acme.attributes('role')).toBe('button');
    expect(acme.attributes('aria-label')).toBe('Gold row 1, Standard 6 ft, Acme Ceramics');
    expect(acme.attributes('data-seat-key')).toBe('acme');
    expect(paintOf(topOf(map, 'g1'))).toEqual([
      'var(--layout-section-1-fill)',
      'var(--layout-section-1-edge)',
      undefined,
    ]);
    expect(acme.get('[data-testid="layout-table-number"]').attributes('fill')).toBe(
      'var(--mm-black)',
    );
  });

  it("draws an outlined seat white, edged in its section's colour", () => {
    const map = draw({
      seats: [{ key: 'acme', tableId: 'g1', half: 'whole', tone: 'outlined', name: 'Acme' }],
    });
    expect(paintOf(topOf(map, 'g1'))).toEqual(['white', 'var(--layout-section-1-edge)', undefined]);
    expect(tableById(map, 'g1').get('[data-testid="layout-table-number"]').attributes('fill')).toBe(
      'var(--mm-black)',
    );
  });

  it("draws a checked-out seat in its section's out shade, edged in its colour, a whole table and a half (T501)", () => {
    const map = draw({
      seats: [
        { key: 'acme', tableId: 'g1', half: 'whole', tone: 'checkedOut', name: 'Acme' },
        { key: 'elm', tableId: 's1', half: 'left', tone: 'checkedOut', name: 'Elm' },
      ],
    });
    expect(paintOf(topOf(map, 'g1'))).toEqual([
      'var(--layout-section-1-out)',
      'var(--layout-section-1-edge)',
      undefined,
    ]);
    expect(tableById(map, 'g1').get('[data-testid="layout-table-number"]').attributes('fill')).toBe(
      'var(--mm-black)',
    );
    expect(paintOf(halfOf(map, 's1', 'left').get('path'))).toEqual([
      'var(--layout-section-2-out)',
      'var(--layout-section-2-edge)',
      undefined,
    ]);
  });

  it('draws a table with no seat free, on the floor with a dashed grey edge, a button named so', () => {
    const map = draw();
    const free = tableById(map, 'g4');
    expect(free.attributes('role')).toBe('button');
    expect(free.attributes('aria-label')).toBe('Gold row 4, Standard 6 ft, no vendor');
    expect(free.attributes('data-seat-key')).toBeUndefined();
    expect(paintOf(topOf(map, 'g4'))).toEqual([
      'var(--layout-floor)',
      'var(--layout-no-section-edge)',
      '4 3',
    ]);
    expect(free.get('[data-testid="layout-table-number"]').text()).toBe('4');
  });

  it('draws as on dev with no seats given', () => {
    const map = draw({ seats: null });
    expect(tableById(map, 'g4').attributes('aria-label')).toBe('Gold row 4, Standard 6 ft');
    expect(tableById(map, 'g2').find('[data-half]').exists()).toBe(false);
    expect(paintOf(topOf(map, 'g4'))[0]).toBe('var(--layout-section-1-fill)');
  });
});

describe('a shared table', () => {
  it('is two halves, each seated half a button of its own, left before right', () => {
    const map = draw();
    const shared = tableById(map, 'g2');
    expect(shared.attributes('role')).toBeUndefined();
    expect(shared.attributes('aria-label')).toBeUndefined();
    expect(shared.find('[data-testid="layout-table-top"]').exists()).toBe(false);
    const halves = shared.findAll('[role="button"]');
    expect(halves.map((half) => half.attributes('aria-label'))).toEqual([
      'Gold row 2, Standard 6 ft, left half, Bee Candles',
      'Gold row 2, Standard 6 ft, right half, Cog Prints',
    ]);
    expect(halves.map((half) => half.attributes('data-seat-key'))).toEqual(['bee', 'cog']);
    expect(paintOf(halfOf(map, 'g2', 'left').get('path'))).toEqual([
      'var(--layout-section-1-fill)',
      'var(--layout-section-1-edge)',
      undefined,
    ]);
    expect(paintOf(halfOf(map, 'g2', 'right').get('path'))[0]).toBe('white');
  });

  it('splits across its longer side, each half labelled with its number and side', () => {
    const map = draw();
    const left = halfOf(map, 'g2', 'left');
    expect(left.get('path').attributes('d')).toMatch(/^M -875 -380 H 0 V 380 H -875/);
    const labels = tableById(map, 'g2').findAll('[data-testid="layout-table-number"]');
    expect(labels.map((label) => label.text())).toEqual(['2L', '2R']);
    expect(Number(labels[0].attributes('x'))).toBeCloseTo(-457.5);
  });

  it("keeps left on the reader's left of a table turned a half, its labels upright", () => {
    const map = draw();
    // Turned 180°, the table's own right end is on the reader's left.
    expect(halfOf(map, 's1', 'left').get('path').attributes('d')).toMatch(/^M 0 -380 H 875/);
    const label = labelOf(map, 's1', 'left');
    expect(label.attributes('transform')).toBe('rotate(180 457.5 0)');
  });

  it('draws a half with no seat free, and no button', () => {
    const map = draw();
    const shared = tableById(map, 'g3');
    expect(shared.findAll('[role="button"]').map((b) => b.attributes('aria-label'))).toEqual([
      'Gold row 3, Standard 6 ft, left half, Dot Knits',
    ]);
    const free = halfOf(map, 'g3', 'right');
    expect(free.attributes('role')).toBeUndefined();
    expect(free.attributes('tabindex')).toBeUndefined();
    expect(paintOf(free.get('path'))).toEqual([
      'var(--layout-floor)',
      'var(--layout-no-section-edge)',
      '4 3',
    ]);
    expect(labelOf(map, 'g3', 'right').text()).toBe('3R');
    // A button says its half in words; the label is drawn beside it, not in it.
    expect(halfOf(map, 'g3', 'left').find('text').exists()).toBe(false);
  });

  it('leaves the half labels out where a half is too small to carry one', async () => {
    const map = draw({}, layout(), 0.004);
    await nextTick();
    expect(map.findAll('[data-testid="layout-table-number"]')).toHaveLength(0);
    expect(buttons(map)).toHaveLength(7);
  });
});

describe('a press says which seat', () => {
  it('emits activateSeat with the key and activate with the table, by pointer, Enter and Space', async () => {
    const map = draw();
    await halfOf(map, 'g2', 'right').get('path').trigger('click');
    await halfOf(map, 'g2', 'left').trigger('keydown', { key: 'Enter' });
    await tableById(map, 'g1').trigger('keydown', { key: ' ' });
    expect(map.emitted('activateSeat')).toEqual([['cog'], ['bee'], ['acme']]);
    expect(map.emitted('activate')).toEqual([['g2'], ['g2'], ['g1']]);
  });

  it('emits activate alone for a free table or a free half', async () => {
    const map = draw();
    await topOf(map, 'g4').trigger('click');
    await halfOf(map, 'g3', 'right').get('path').trigger('click');
    expect(map.emitted('activate')).toEqual([['g4'], ['g3']]);
    expect(map.emitted('activateSeat')).toBeUndefined();
  });

  it('reads a tap on a half as its seat', async () => {
    const map = draw();
    const half = halfOf(map, 'g2', 'left').element;
    for (const type of ['pointerdown', 'pointerup'] as const) {
      half.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, pointerType: 'touch', bubbles: true }),
      );
    }
    expect(map.emitted('activateSeat')).toEqual([['bee']]);
    expect(map.emitted('activate')).toEqual([['g2']]);
  });

  it('reads a tap just beside a shared table as the half it falls by', async () => {
    const map = draw();
    // g2's top edge is at 2620 mm, 104.8 px down; 7500 mm, 300 px in, is over its right half.
    map
      .get('.layout-map__floor')
      .element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 100 }),
      );
    expect(map.emitted('activateSeat')).toEqual([['cog']]);
    expect(map.emitted('activate')).toEqual([['g2']]);
  });
});

describe('the one Tab stop among seats', () => {
  const stops = (map: VueWrapper) => buttons(map).filter((b) => b.attributes('tabindex') === '0');

  it('is one button of all of them, the halves among the tables', () => {
    const map = draw();
    expect(stops(map)).toHaveLength(1);
    expect(buttons(map).filter((b) => b.attributes('tabindex') === '-1')).toHaveLength(6);
  });

  it('moves by the arrows from a table to a half and from half to half', async () => {
    const map = draw();
    (tableById(map, 'g1').element as SVGGElement).focus();
    await tableById(map, 'g1').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-seat-key')).toBe('bee');
    await halfOf(map, 'g2', 'left').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-seat-key')).toBe('cog');
    await nextTick();
    expect(stops(map).map((b) => b.attributes('data-seat-key'))).toEqual(['cog']);
    expect(map.emitted('focused')).toEqual([['g1'], ['g2'], ['g2']]);
  });
});

describe('marked', () => {
  it('outlines a seat, a half and a table as the selection is outlined', async () => {
    const map = draw({ marked: ['acme', 'cog', 'g4'] });
    await nextTick();
    const marks = map.findAll('[data-testid="layout-map-read"]');
    expect(marks).toHaveLength(3);
    expect(marks.map((mark) => mark.attributes('transform'))).toEqual([
      'translate(5000 3000) rotate(0)',
      'translate(7000 3000) rotate(0)',
      'translate(11000 3000) rotate(0)',
    ]);
    // The half's outline is the half's shape, grown by the outline's distance.
    const out = OUTLINE_OUT_PX * 25;
    const [x, y] = /^M (\S+) (\S+) /.exec(marks[1].get('path').attributes('d')!)!.slice(1);
    expect(Number(x)).toBeCloseTo(-out);
    expect(Number(y)).toBeCloseTo(-380 - out);
    expect(marks[1].get('path').attributes('stroke-width')).toBe(String(OUTLINE_WIDTH_PX));
    expect(Number(marks[0].get('rect').attributes('width'))).toBeCloseTo(1830 + 2 * out);
  });

  it('marks the selection as before beside what is marked', () => {
    const map = draw({ selection: ['g1'], marked: ['bee'] });
    expect(map.findAll('[data-testid="layout-map-read"]')).toHaveLength(2);
  });
});

describe('the outline hugs the table', () => {
  it('is 1.5 px, flush on the edge, in the editor and on the read map', async () => {
    const out = OUTLINE_OUT_PX * 25;
    const edit = draw({ mode: 'edit', selection: ['g1'], seats: null });
    await nextTick();
    const outline = edit.get('[data-testid="layout-table-selected"]');
    expect(outline.attributes('stroke-width')).toBe('1.5');
    expect(Number(outline.attributes('width'))).toBeCloseTo(1830 + 2 * out);
    edit.unmount();
    const read = draw({ selection: ['g1'], seats: null });
    expect(read.get('[data-testid="layout-map-read"] rect').attributes('stroke-width')).toBe('1.5');
  });
});

describe('the zones and the image', () => {
  it('draws a turned zone turned about its centre, its label upright', () => {
    const map = draw(
      {},
      layout({
        zones: [
          {
            id: 'z1',
            label: 'Stage',
            xMm: 12_000,
            yMm: 10_000,
            widthMm: 8000,
            depthMm: 3000,
            rotation: 30,
          },
        ],
      }),
    );
    const zone = map.get('[data-testid="layout-map-zone"]');
    expect(zone.attributes('transform')).toBe('rotate(30 16000 11500)');
    expect(zone.get('[data-testid="layout-map-zone-label"]').attributes('transform')).toBe(
      'rotate(-30 16000 11500)',
    );
  });

  it('draws a zone square to the page with no turn', () => {
    const zone = draw().get('[data-testid="layout-map-zone"]');
    expect(zone.attributes('transform')).toBeUndefined();
    expect(zone.get('[data-testid="layout-map-zone-label"]').attributes('transform')).toBe(
      undefined,
    );
  });

  it('draws the image in grey and faded unless told, and in its colours at full strength when told', () => {
    const grey = draw().get('[data-testid="layout-map-image"]');
    expect(grey.classes()).not.toContain('layout-map__image--colour');
    expect(grey.attributes('opacity')).toBe('0.5');
    wrapper?.unmount();
    const whole = draw({ imageInGrey: false, imageFaded: false }).get(
      '[data-testid="layout-map-image"]',
    );
    expect(whole.classes()).toContain('layout-map__image--colour');
    expect(whole.attributes('opacity')).toBeUndefined();
  });
});

describe('seats in print', () => {
  it('draws the tones and halves, with no button', () => {
    const map = draw({ mode: 'print' });
    expect(buttons(map)).toHaveLength(0);
    expect(map.findAll('[tabindex]')).toHaveLength(0);
    expect(paintOf(topOf(map, 'g4'))[2]).toBe('4 3');
    expect(tableById(map, 'g2').findAll('[data-half]')).toHaveLength(2);
  });

  it('draws no seat in edit', () => {
    const map = draw({ mode: 'edit' });
    expect(tableById(map, 'g2').find('[data-half]').exists()).toBe(false);
    expect(tableById(map, 'g4').attributes('aria-label')).toBe('Gold row 4, Standard 6 ft');
  });
});

describe('what the map tells and offers a caller who stands something over it (T465)', () => {
  /** The map's `ResizeObserver`s, so a test can say its box was resized. */
  const observers: (() => void)[] = [];
  class FakeResizeObserver {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  /** The screen boxes a test gives a table's group or a half's, by table id and side. */
  function boxes(of: Record<string, DOMRect>) {
    const before = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const half = this.getAttribute('data-half');
      const tableId = (half ? this.parentElement : this)?.getAttribute('data-table-id');
      const key = half ? `${tableId}#${half}` : tableId;
      return (key && of[key]) || before.call(this);
    });
  }

  it('emits viewed when a zoom changes the part of the hall it shows', async () => {
    const map = draw();
    await nextTick();
    const before = map.emitted('viewed')?.length ?? 0;
    (map.vm as unknown as { zoomIn: () => void }).zoomIn();
    await nextTick();
    expect(map.emitted('viewed')?.length).toBe(before + 1);
    (map.vm as unknown as { fit: () => void }).fit();
    await nextTick();
    expect(map.emitted('viewed')?.length).toBe(before + 2);
  });

  it('emits viewed when its box is measured at another size, and not at the same size', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    let width = 1200;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this.getAttribute('data-testid') === 'layout-map'
        ? new DOMRect(0, 0, width, 900)
        : new DOMRect(0, 0, 0, 0);
    });
    wrapper = mount(LayoutMap, {
      attachTo: document.body,
      props: {
        layout: layout(),
        locationName: UPPER.name,
        sections: SECTIONS,
        tableTypes: TYPES,
        mode: 'read',
        seats: SEATS,
      },
    });
    await nextTick();
    const before = wrapper.emitted('viewed')?.length ?? 0;
    observers.forEach((resized) => resized());
    await nextTick();
    expect(wrapper.emitted('viewed')?.length ?? 0).toBe(before);
    width = 800;
    observers.forEach((resized) => resized());
    await nextTick();
    expect(wrapper.emitted('viewed')?.length).toBe(before + 1);
  });

  it("gives the screen box of a table's group, or of a half's, and none for a table not drawn", () => {
    const map = draw();
    const g1 = new DOMRect(100, 50, 40, 20);
    const g2 = new DOMRect(200, 50, 40, 20);
    const g2Right = new DOMRect(220, 50, 20, 20);
    boxes({ g1, g2, 'g2#right': g2Right });
    const exposed = map.vm as unknown as {
      targetRect: (tableId: string, half: string) => DOMRect | null;
    };
    expect(exposed.targetRect('g1', 'whole')).toEqual(g1);
    expect(exposed.targetRect('g2', 'right')).toEqual(g2Right);
    expect(exposed.targetRect('g2', 'whole')).toEqual(g2);
    // A half of a table not split that day is the whole table.
    expect(exposed.targetRect('g1', 'left')).toEqual(g1);
    expect(exposed.targetRect('nope', 'whole')).toBeNull();
  });

  it("focuses a table's button, or a half's, and says when there was no button to focus", () => {
    const map = draw();
    const exposed = map.vm as unknown as {
      focusTarget: (tableId: string, half: string) => boolean;
    };
    expect(exposed.focusTarget('g1', 'whole')).toBe(true);
    expect(document.activeElement).toBe(tableById(map, 'g1').element);
    expect(exposed.focusTarget('g2', 'right')).toBe(true);
    expect(document.activeElement).toBe(halfOf(map, 'g2', 'right').element);
    // A free table is a button too.
    expect(exposed.focusTarget('g4', 'whole')).toBe(true);
    expect(document.activeElement).toBe(tableById(map, 'g4').element);
    // Gold row 3's right half is free, so no button; nor is a shared table's own group.
    expect(exposed.focusTarget('g3', 'right')).toBe(false);
    expect(exposed.focusTarget('g2', 'whole')).toBe(false);
    expect(exposed.focusTarget('nope', 'whole')).toBe(false);
    expect(document.activeElement).toBe(tableById(map, 'g4').element);
  });
});
