/**
 * Tables in groups (T422, the QC walk of 2026-11-16, item 15): Row of tables and Fill an area may
 * stand their tables in groups of so many, with a wider spacer between one group and the next. One
 * choice serves both tools, kept while the app is open. A row's march puts the spacer before each
 * table that starts a group, the groups restarting at each run and each row, and a spread row
 * widens every gap alike (D10); a fill sends the grouping to the placement. A group field that
 * holds no usable number says its sentence, and no row is shown or filled meanwhile (D9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { FloorplanObject, SectionObject } from '@/assets/types/datatypes';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutToolCard from '@/components/layout/LayoutToolCard.vue';
import {
  placeAlongRuns,
  placeRows,
  separation,
  tableCorners,
  type PathPose,
  type RowOptions,
} from '@/components/layout/layoutGeometry';
import { fillRequest, type FillAnswer } from '@/components/layout/layoutFill';
import {
  GROUP_CHOICES_AT_FIRST,
  MAX_GROUP_SIZE,
  groupChoices,
  groupFieldErrors,
  groupRefusal,
  groupingOf,
} from '@/components/layout/layoutGroups';
import {
  ROW_CHOICES_AT_FIRST,
  rowChoices,
  strokeOptions,
  useRowTool,
} from '@/components/layout/layoutRow';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';

const SIX_FOOT = { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 };
const TYPES = [SIX_FOOT];
const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const SECTIONS: SectionObject[] = [
  { id: 'gold', name: 'Gold row', location: UPPER, tier: null, count: 40 },
];
const p = (xMm: number, yMm: number) => ({ xMm, yMm });
const SIZE_SAID = 'Type how many tables to a group, 1 to 50.';
const SPACER_SAID = "Type the spacer's width in centimetres, 0 to 1,000.";

/** A hall 30 m by 22.5 m. */
function aLayout(): FloorplanObject {
  return {
    id: 'fp-1',
    locationId: UPPER.id,
    revision: 3,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables: [],
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  };
}

function anEditor() {
  const editor = useLayoutEditor({
    save: (layout: FloorplanObject): Promise<SavedLayout> =>
      Promise.resolve({ floorplan: { ...layout, revision: layout.revision + 1 }, sections: [] }),
    tableTypes: () => TYPES,
  });
  editor.adopt(aLayout());
  return editor;
}

/** Where each table of a straight row across the page starts and ends, along it. */
const spans = (poses: readonly PathPose[]) =>
  poses.map((pose) => [pose.xMm - SIX_FOOT.widthMm / 2, pose.xMm + SIX_FOOT.widthMm / 2]);
/** The floor between each table and the next, along a straight row across the page. */
const gapsOf = (poses: readonly PathPose[]) => {
  const along = spans(poses);
  return along.slice(1).map(([start], i) => start - along[i][1]);
};

const TABLE: RowOptions = { ...SIX_FOOT, gapMm: 0, side: 'right' };
const PAIRS = { size: 2, spacerMm: 1200 };

beforeEach(() => {
  Object.assign(groupChoices, GROUP_CHOICES_AT_FIRST);
  Object.assign(rowChoices, ROW_CHOICES_AT_FIRST);
});

describe('the grouping asked', () => {
  it('is off at first, two to a group with 120 cm between groups once ticked', () => {
    expect(groupingOf()).toBeNull();
    groupChoices.grouped = true;
    expect(groupingOf()).toEqual({ size: 2, spacerMm: 1200 });
  });

  it.each([
    ['1', '0', { size: 1, spacerMm: 0 }],
    ['50', '1000', { size: 50, spacerMm: 10_000 }],
    [' 3 ', '2,5', { size: 3, spacerMm: 25 }],
  ])('reads %j to a group and a %j cm spacer', (size, spacerCm, grouping) => {
    Object.assign(groupChoices, { grouped: true, size, spacerCm });
    expect(groupingOf()).toEqual(grouping);
    expect(groupFieldErrors()).toEqual({ size: '', spacer: '' });
    expect(groupRefusal()).toBe('');
  });

  it.each(['0', '51', '2.5', '-2', 'two', '', '1e1', '0x2'])(
    'says how many a group holds for %j, and is no grouping',
    (size) => {
      Object.assign(groupChoices, { grouped: true, size });
      expect(groupingOf()).toBeNull();
      expect(groupFieldErrors().size).toBe(SIZE_SAID);
      expect(groupRefusal()).toBe(SIZE_SAID);
    },
  );

  it.each(['-1', '1001', 'wide', ''])('says what a spacer takes for %j', (spacerCm) => {
    Object.assign(groupChoices, { grouped: true, spacerCm });
    expect(groupingOf()).toBeNull();
    expect(groupFieldErrors().spacer).toBe(SPACER_SAID);
    expect(groupRefusal()).toBe(SPACER_SAID);
  });

  it('says nothing of a field while grouping is off, whatever it holds', () => {
    Object.assign(groupChoices, { grouped: false, size: 'none', spacerCm: 'none' });
    expect(groupFieldErrors()).toEqual({ size: '', spacer: '' });
    expect(groupRefusal()).toBe('');
    expect(groupingOf()).toBeNull();
  });

  it('takes at most 50 to a group, as the placement does', () => {
    expect(MAX_GROUP_SIZE).toBe(50);
  });
});

describe("a row's march", () => {
  const line = [[p(0, 3000), p(12_000, 3000)]];

  it('stands the tables in pairs, the spacer before each that starts a group', () => {
    const poses = placeAlongRuns(line, { ...TABLE, group: PAIRS });
    expect(poses.map((pose) => pose.xMm)).toEqual(
      [915, 2745, 5775, 7605, 10_635].map((x) => expect.closeTo(x, 0)),
    );
    expect(gapsOf(poses).map(Math.round)).toEqual([0, 1200, 0, 1200]);
  });

  it('keeps the gap typed within a group, and the spacer alone between groups', () => {
    const poses = placeAlongRuns(line, { ...TABLE, gapMm: 300, group: { size: 3, spacerMm: 900 } });
    expect(gapsOf(poses).map(Math.round)).toEqual([300, 300, 900, 300]);
  });

  it('marches end to end with no grouping', () => {
    const poses = placeAlongRuns(line, TABLE);
    expect(gapsOf(poses).map(Math.round)).toEqual([0, 0, 0, 0, 0]);
  });

  it("starts each run's first group afresh", () => {
    const runs = [
      [p(0, 3000), p(7000, 3000)],
      [p(0, 9000), p(7000, 9000)],
    ];
    const poses = placeAlongRuns(runs, { ...TABLE, group: PAIRS });
    const first = poses.filter((pose) => pose.yMm < 6000).map((pose) => Math.round(pose.xMm));
    const second = poses.filter((pose) => pose.yMm > 6000).map((pose) => Math.round(pose.xMm));
    expect(first).toEqual([915, 2745, 5775]);
    expect(second).toEqual(first);
  });

  it('starts each row of several with a group of its own', () => {
    const [front, back] = placeRows(line, {
      ...TABLE,
      group: PAIRS,
      rows: 2,
      aisleMm: 1200,
    });
    expect(gapsOf(front).map(Math.round)).toEqual([0, 1200, 0, 1200]);
    expect(back.map((pose) => Math.round(pose.xMm))).toEqual(
      front.map((pose) => Math.round(pose.xMm)),
    );
  });

  it('spread to the ends, widens every gap alike, the spacers by as much as the rest', () => {
    const [row] = placeRows(line, { ...TABLE, group: PAIRS, rows: 1, aisleMm: 0, spread: true });
    const gaps = gapsOf(row);
    expect(gaps).toHaveLength(4);
    // Five tables, two gaps of g within pairs and two of g + 1200 between them, end at 12 m.
    expect(gaps[0]).toBeCloseTo(112.5, 0);
    expect(gaps[2]).toBeCloseTo(gaps[0], 0);
    expect(gaps[1] - gaps[0]).toBeCloseTo(1200, 0);
    expect(gaps[3] - gaps[2]).toBeCloseTo(1200, 0);
    expect(spans(row).at(-1)![1]).toBeCloseTo(12_000, -1);
  });
});

describe('Row of tables', () => {
  function aRow() {
    const editor = anEditor();
    const row = useRowTool({
      editor,
      tableTypes: () => TYPES,
      sectionId: () => 'gold',
      tableTypeId: () => 'six-foot',
    });
    row.strokeTo([p(0, 3000), p(12_000, 3000)], strokeOptions(0.04, false));
    return row;
  }

  it('shows the row in groups once grouping is ticked', () => {
    const row = aRow();
    expect(row.poses.value).toHaveLength(6);
    groupChoices.grouped = true;
    expect(row.poses.value).toHaveLength(5);
    expect(gapsOf(row.poses.value).map(Math.round)).toEqual([0, 1200, 0, 1200]);
  });

  it('keeps the spacer round a closed shape, at its seam as between every other two groups', () => {
    const editor = anEditor();
    const row = useRowTool({
      editor,
      tableTypes: () => TYPES,
      sectionId: () => 'gold',
      tableTypeId: () => 'six-foot',
    });
    groupChoices.grouped = true;
    for (let i = 0; i < 8; i += 1) {
      const turn = (i * Math.PI) / 4;
      row.addPoint(p(15_000 + 4300 * Math.cos(turn), 11_000 + 4300 * Math.sin(turn)));
    }
    row.close();
    const ring = row.poses.value;
    expect(ring.length).toBeGreaterThan(6);
    // The floor from each table to the next round the ring, the last to the first at the seam.
    const gaps = ring.map((pose, i) =>
      separation(tableCorners(pose, SIX_FOOT), tableCorners(ring[(i + 1) % ring.length], SIX_FOOT)),
    );
    // Before each table that starts a pair, the first's at the seam among them, is a spacer.
    const spacers = gaps.filter((_, i) => ((i + 1) % ring.length) % 2 === 0);
    const within = gaps.filter((_, i) => ((i + 1) % ring.length) % 2 !== 0);
    expect(Math.max(...spacers) - Math.min(...spacers)).toBeLessThan(1);
    expect(Math.max(...within) - Math.min(...within)).toBeLessThan(1);
    expect(spacers[0] - within[0]).toBeCloseTo(1200, 0);
  });

  it('shows no row while a group field holds no usable number, and says why', () => {
    const row = aRow();
    Object.assign(groupChoices, { grouped: true, size: '0' });
    expect(row.refusal.value).toBe(SIZE_SAID);
    expect(row.poses.value).toEqual([]);
    expect(row.place()).toEqual([]);
    groupChoices.size = '2';
    expect(row.refusal.value).toBe('');
    expect(row.poses.value).toHaveLength(5);
  });
});

describe('Fill an area', () => {
  const area = { kind: 'box', box: { left: 0, top: 0, right: 12_000, bottom: 800 } } as const;
  const choice = { count: 30, direction: 'across', aisleMm: 1200 } as const;

  it('sends the grouping as so many to a group and the spacer in millimetres', () => {
    const request = fillRequest(aLayout(), TYPES, 'six-foot', area, choice, PAIRS);
    expect(request.grouping).toEqual({ size: 2, spacer_mm: 1200 });
  });

  it('sends no grouping where none is asked', () => {
    expect(fillRequest(aLayout(), TYPES, 'six-foot', area, choice)).not.toHaveProperty('grouping');
    expect(fillRequest(aLayout(), TYPES, 'six-foot', area, choice, null)).not.toHaveProperty(
      'grouping',
    );
  });
});

describe("the editor's fill", () => {
  let wrapper: VueWrapper | null = null;
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  async function fillTheView(fill: (request: unknown) => Promise<FillAnswer>) {
    wrapper = mount(LayoutEditor, {
      attachTo: document.body,
      props: {
        editor: anEditor(),
        locationName: 'Upper Hall',
        sections: SECTIONS,
        tableTypes: TYPES,
        fill,
      },
    });
    await flushPromises();
    byTestId('layout-tool-fill')!.click();
    await flushPromises();
    (wrapper.vm as unknown as { fillInView: () => void }).fillInView();
    await flushPromises();
    byTestId('layout-fill-submit-button')!.closest('form')!.dispatchEvent(new Event('submit'));
    await flushPromises();
  }

  it('asks the placement for the tables in groups', async () => {
    Object.assign(groupChoices, { grouped: true, size: '3', spacerCm: '90' });
    const fill = vi.fn<(request: unknown) => Promise<FillAnswer>>(() =>
      Promise.resolve({ placed_tables: [], timed_out: false }),
    );
    await fillTheView(fill);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill.mock.calls[0][0]).toMatchObject({ grouping: { size: 3, spacer_mm: 900 } });
  });

  it('asks nothing while a group field holds no usable number, and says why in the dialog', async () => {
    Object.assign(groupChoices, { grouped: true, spacerCm: 'wide' });
    const fill = vi.fn(() => Promise.resolve({ placed_tables: [], timed_out: false }));
    await fillTheView(fill);
    expect(fill).not.toHaveBeenCalled();
    expect(byTestId('layout-fill-error')!.textContent).toBe(SPACER_SAID);
  });
});

describe('the tool card', () => {
  const card = (tool: 'add' | 'row' | 'fill') =>
    mount(LayoutToolCard, {
      props: { tool, sections: SECTIONS, tableTypes: TYPES, sectionId: 'gold', typeId: 'six-foot' },
    });

  it.each(['row', 'fill'] as const)('offers Group tables in %s, unticked', (tool) => {
    const w = card(tool);
    const tick = w.get<HTMLInputElement>('[data-testid="layout-group"]');
    expect(tick.element.checked).toBe(false);
    expect(tick.element.closest('label')!.textContent!.trim()).toBe('Group tables');
    expect(w.find('[data-testid="layout-group-size"]').exists()).toBe(false);
  });

  it('offers no grouping to Add table, which places one table', () => {
    expect(card('add').find('[data-testid="layout-group"]').exists()).toBe(false);
  });

  it.each(['row', 'fill'] as const)(
    'asks how many to a group and the spacer once ticked, in %s',
    async (tool) => {
      const w = card(tool);
      await w.get('[data-testid="layout-group"]').setValue(true);
      const size = w.get<HTMLInputElement>('[data-testid="layout-group-size"]');
      const spacer = w.get<HTMLInputElement>('[data-testid="layout-group-spacer"]');
      expect(size.element.value).toBe('2');
      expect(spacer.element.value).toBe('120');
      expect(w.get(`label[for="${size.attributes('id')}"]`).text()).toBe('Per group');
      expect(w.get(`label[for="${spacer.attributes('id')}"]`).text()).toBe('Spacer');
      expect(size.element.parentElement!.textContent!.trim()).toBe('tables');
      expect(spacer.element.parentElement!.textContent!.trim()).toBe('cm between groups');
      expect(w.find('[data-testid="layout-group-size-error"]').exists()).toBe(false);
    },
  );

  it.each(['row', 'fill'] as const)(
    'says under the card what a group field takes, tied to the field, in %s',
    async (tool) => {
      const w = card(tool);
      await w.get('[data-testid="layout-group"]').setValue(true);
      await w.get('[data-testid="layout-group-size"]').setValue('0');
      await w.get('[data-testid="layout-group-spacer"]').setValue('wide');

      const size = w.get('[data-testid="layout-group-size"]');
      const sizeError = w.get('[data-testid="layout-group-size-error"]');
      expect(sizeError.text()).toBe(SIZE_SAID);
      expect(sizeError.attributes('role')).toBe('alert');
      expect(size.attributes('aria-invalid')).toBe('true');
      expect(size.attributes('aria-describedby')).toBe(sizeError.attributes('id'));

      const spacer = w.get('[data-testid="layout-group-spacer"]');
      const spacerError = w.get('[data-testid="layout-group-spacer-error"]');
      expect(spacerError.text()).toBe(SPACER_SAID);
      expect(spacer.attributes('aria-describedby')).toBe(spacerError.attributes('id'));

      await w.get('[data-testid="layout-group-size"]').setValue('4');
      expect(w.find('[data-testid="layout-group-size-error"]').exists()).toBe(false);
      expect(w.get('[data-testid="layout-group-size"]').attributes('aria-invalid')).toBe('false');
    },
  );

  it('keeps the choice from one tool to the other', async () => {
    const row = card('row');
    await row.get('[data-testid="layout-group"]').setValue(true);
    await row.get('[data-testid="layout-group-size"]').setValue('4');
    const fill = card('fill');
    expect(fill.get<HTMLInputElement>('[data-testid="layout-group"]').element.checked).toBe(true);
    expect(fill.get<HTMLInputElement>('[data-testid="layout-group-size"]').element.value).toBe('4');
  });
});
