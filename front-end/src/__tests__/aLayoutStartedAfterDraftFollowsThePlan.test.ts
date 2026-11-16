/**
 * A layout started after Draft follows the plan (T422 ticket 03, D21, D22): the model's seat
 * commands work in three ways. Open, on a layout started in Draft while the market is in Draft:
 * the layout decides, as before, a removal closing its section's gaps. Following, on a layout that
 * follows the plan, in any phase: a table's number is its seat's and stays put, a new table takes
 * its section's lowest free number, and no section holds more tables than its count in the plan.
 * Settled, past Draft on a layout started in Draft: no seat changes
 * (`aLayoutAfterDraftKeepsItsSeats.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { enableAutoUnmount, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { FloorplanObject, FloorplanTable } from '@/assets/types/datatypes';
import FloorplanUploader from '@/components/layout/FloorplanUploader.vue';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutPanelSections from '@/components/layout/LayoutPanelSections.vue';
import LayoutPanelSelection from '@/components/layout/LayoutPanelSelection.vue';
import LayoutPanelTypes from '@/components/layout/LayoutPanelTypes.vue';
import LayoutView from '@/components/layout/LayoutView.vue';
import type { SavedLayout } from '@/components/layout/layoutSave';
import { saidHeldBack, useLayoutEditor } from '@/components/layout/useLayoutEditor';
import { MARKET_ID, marketRouter } from './support/marketScreen';
import { answersRefusing } from './support/servedAnswers';

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

function table(id: string, sectionId: string | null, number: number | null, x: number) {
  return {
    id,
    sectionId,
    number,
    tableTypeId: 'six-foot',
    xMm: x,
    yMm: 5000,
    rotation: 0,
  } satisfies FloorplanTable;
}

function aLayout(followsPlan: boolean, tables: FloorplanTable[]): FloorplanObject {
  return {
    id: 'fp-1',
    locationId: 'loc-upper',
    revision: 3,
    imageGridfsId: 'image-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables,
    zones: [],
    sectionStyles: [],
    startingCounts: [],
    followsPlan,
  };
}

const GOLD_1_3_5 = () => [
  table('g1', 'gold', 1, 4000),
  table('g3', 'gold', 3, 9000),
  table('g5', 'gold', 5, 14_000),
];

/** An editor over a layout: Gold row's count in the plan is 6, Silver aisle's 2. */
function anEditor({
  followsPlan = true,
  draft = false,
  tables = GOLD_1_3_5(),
}: { followsPlan?: boolean; draft?: boolean; tables?: FloorplanTable[] } = {}) {
  let ids = 0;
  const editor = useLayoutEditor({
    save: async (layout): Promise<SavedLayout> => ({
      floorplan: { ...layout, revision: layout.revision + 1 },
    }),
    draft: () => draft,
    tableTypes: () => [
      { id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 },
      { id: 'square', name: 'Square 4 ft', widthMm: 1220, depthMm: 1220 },
    ],
    sectionIds: () => ['gold', 'silver'],
    counts: () =>
      new Map([
        ['gold', 6],
        ['silver', 2],
      ]),
    newId: () => `new-${++ids}`,
  });
  editor.adopt(aLayout(followsPlan, tables));
  const seats = () =>
    editor.layout.value!.tables.map((t) => `${t.id}:${t.sectionId ?? 'none'}:${t.number}`);
  return { editor, seats };
}

const gold = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sectionId: 'gold',
    tableTypeId: 'six-foot',
    xMm: 2000 + 2000 * i,
    yMm: 10_000,
  }));

describe('open: a layout started in Draft, in Draft, decides its tables as before', () => {
  it('closes the gap a removal leaves and numbers a new table after the highest', () => {
    const { editor, seats } = anEditor({ followsPlan: false, draft: true });
    editor.removeTables(['g3']);
    expect(seats()).toEqual(['g1:gold:1', 'g5:gold:2']);
    editor.addTables(gold(6));
    expect(editor.layout.value!.tables.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(editor.heldBack.value).toBe(null);
  });

  it('sets no number by hand', () => {
    const { editor, seats } = anEditor({ followsPlan: false, draft: true });
    expect(editor.setNumber('g1', 2)).toBe(false);
    expect(seats()).toEqual(['g1:gold:1', 'g3:gold:3', 'g5:gold:5']);
  });
});

describe('following: a number is its seat, past Draft and in it', () => {
  for (const draft of [false, true]) {
    const where = draft ? 'in Draft' : 'past Draft';

    it(`leaves the other numbers alone on a removal, ${where}`, () => {
      const { editor, seats } = anEditor({ draft });
      editor.removeTables(['g3']);
      expect(seats()).toEqual(['g1:gold:1', 'g5:gold:5']);
      expect(editor.canUndo.value).toBe(true);
    });

    it(`gives a new table its section's lowest free number, ${where}`, () => {
      const { editor, seats } = anEditor({ draft });
      editor.addTables(gold(1));
      expect(seats().at(-1)).toBe('new-1:gold:2');
    });
  }

  it('places what fits in the order drawn, and says what it held back', () => {
    const { editor, seats } = anEditor();

    const ids = editor.addTables(gold(4));

    expect(ids).toEqual(['new-1', 'new-2', 'new-3']);
    expect(seats().slice(3)).toEqual(['new-1:gold:2', 'new-2:gold:4', 'new-3:gold:6']);
    expect(editor.heldBack.value).toEqual({ sectionId: 'gold', count: 6, placed: 3 });
    expect(saidHeldBack(editor.heldBack.value!, 'Gold row')).toBe(
      'Gold row has 6 tables in the plan; 3 were placed.',
    );
  });

  it('places none with none left, and says so', () => {
    const { editor, seats } = anEditor();
    editor.addTables(gold(3));
    const before = seats();

    expect(editor.addTables(gold(2))).toEqual([]);

    expect(seats()).toEqual(before);
    expect(editor.heldBack.value).toEqual({ sectionId: 'gold', count: 6, placed: 0 });
    expect(saidHeldBack(editor.heldBack.value!, 'Gold row')).toBe(
      "Gold row's 6 tables are all on the layout.",
    );
  });

  it('says a section with no table in the plan has none, rather than all of none placed', () => {
    expect(saidHeldBack({ sectionId: 'gold', count: 0, placed: 0 }, 'Gold row')).toBe(
      'Gold row has no tables in the plan.',
    );
  });

  it('forgets what it held back once an add fits', () => {
    const { editor } = anEditor();
    editor.addTables(gold(4));
    editor.removeTables(['g1']);
    editor.addTables(gold(1));
    expect(editor.heldBack.value).toBe(null);
  });

  it('places a table of no section, numberless, whatever the counts', () => {
    const { editor, seats } = anEditor();
    editor.addTables([{ sectionId: null, tableTypeId: 'six-foot', xMm: 2000, yMm: 2000 }]);
    expect(seats().at(-1)).toBe('new-1:none:null');
  });

  it('duplicates into the free numbers, as many as fit', () => {
    const { editor, seats } = anEditor({
      tables: [...GOLD_1_3_5(), table('g2', 'gold', 2, 19_000)],
    });

    const copies = editor.duplicate(['g1', 'g3', 'g5']);

    expect(copies).toHaveLength(2);
    expect(seats().slice(4)).toEqual(['new-1:gold:4', 'new-2:gold:6']);
    expect(editor.heldBack.value).toEqual({ sectionId: 'gold', count: 6, placed: 2 });
  });

  it('moves tables to another section in the order of their numbers, as many as fit', () => {
    const { editor, seats } = anEditor();

    editor.setSection(['g5', 'g1', 'g3'], 'silver');

    expect(seats()).toEqual(['g1:silver:1', 'g3:silver:2', 'g5:gold:5']);
    expect(editor.heldBack.value).toEqual({ sectionId: 'silver', count: 2, placed: 2 });
  });

  it('takes a table out of every section, numberless, the others keeping theirs', () => {
    const { editor, seats } = anEditor();
    editor.setSection(['g1'], null);
    expect(seats()).toEqual(['g1:none:null', 'g3:gold:3', 'g5:gold:5']);
  });

  it('renumbers a section by where its tables stand', () => {
    const { editor, seats } = anEditor({
      tables: [
        table('g1', 'gold', 1, 14_000),
        table('g3', 'gold', 3, 4000),
        table('g5', 'gold', 5, 9000),
      ],
    });
    editor.renumber('gold');
    expect(seats()).toEqual(['g1:gold:3', 'g3:gold:1', 'g5:gold:2']);
  });

  it('gives a table types past Draft as the market settled them, and in Draft another', () => {
    const past = anEditor();
    past.editor.setType(['g1'], 'square');
    expect(past.editor.layout.value!.tables[0].tableTypeId).toBe('six-foot');

    const draft = anEditor({ draft: true });
    draft.editor.setType(['g1'], 'square');
    expect(draft.editor.layout.value!.tables[0].tableTypeId).toBe('square');
  });
});

describe("following: one table's number set by hand", () => {
  it('takes a free number', () => {
    const { editor, seats } = anEditor();
    expect(editor.setNumber('g3', 6)).toBe(true);
    expect(seats()).toEqual(['g1:gold:1', 'g3:gold:6', 'g5:gold:5']);
  });

  it('swaps with the table holding it, as one step of undo', () => {
    const { editor, seats } = anEditor();

    expect(editor.setNumber('g1', 5)).toBe(true);
    expect(seats()).toEqual(['g1:gold:5', 'g3:gold:3', 'g5:gold:1']);

    editor.undo();
    expect(seats()).toEqual(['g1:gold:1', 'g3:gold:3', 'g5:gold:5']);
    expect(editor.canUndo.value).toBe(false);
  });

  it.each([0, 7, 2.5, -1, Number.NaN])('refuses %s, changing nothing', (number) => {
    const { editor, seats } = anEditor();
    expect(editor.setNumber('g1', number)).toBe(false);
    expect(seats()).toEqual(['g1:gold:1', 'g3:gold:3', 'g5:gold:5']);
    expect(editor.canUndo.value).toBe(false);
  });

  it('sets none on a table of no section', () => {
    const { editor } = anEditor({ tables: [table('loose', null, null, 4000)] });
    expect(editor.setNumber('loose', 1)).toBe(false);
  });

  it('is no change to the number it has', () => {
    const { editor } = anEditor();
    expect(editor.setNumber('g3', 3)).toBe(true);
    expect(editor.canUndo.value).toBe(false);
  });
});

describe('settled: past Draft, a layout started in Draft keeps its seats', () => {
  it('adds, removes and numbers nothing', () => {
    const { editor, seats } = anEditor({ followsPlan: false });
    expect(editor.addTables(gold(1))).toEqual([]);
    editor.removeTables(['g3']);
    expect(editor.setNumber('g1', 2)).toBe(false);
    expect(seats()).toEqual(['g1:gold:1', 'g3:gold:3', 'g5:gold:5']);
    expect(editor.heldBack.value).toBe(null);
  });
});

describe('a layout that starts following the plan as the server answers its start', () => {
  it('follows it from the answer on', async () => {
    const editor = useLayoutEditor({
      save: async (layout): Promise<SavedLayout> => ({
        floorplan: { ...layout, revision: 1, followsPlan: true },
      }),
      draft: () => false,
      sectionIds: () => ['gold'],
      counts: () => new Map([['gold', 2]]),
      newId: () => 'new',
    });

    await editor.write({ ...aLayout(false, []), revision: 0, followsPlan: undefined });

    expect(editor.layout.value!.followsPlan).toBe(true);
    expect(editor.addTables(gold(1))).toEqual(['new']);
  });
});

describe('a copy never shares an id with its source (D45)', () => {
  it("gives every duplicated table an id of its own, with the app's own id maker", () => {
    const editor = useLayoutEditor({
      save: async (layout): Promise<SavedLayout> => ({
        floorplan: { ...layout, revision: layout.revision + 1 },
      }),
      draft: () => true,
      sectionIds: () => ['gold'],
      counts: () => new Map([['gold', 12]]),
    });
    editor.adopt(aLayout(true, GOLD_1_3_5()));
    const source = new Set(editor.layout.value!.tables.map((table) => table.id));

    const copies = editor.duplicate([...source]);

    expect(copies).toHaveLength(3);
    expect(copies.filter((id) => source.has(id))).toEqual([]);
    expect(new Set(editor.layout.value!.tables.map((table) => table.id)).size).toBe(6);
  });
});

describe('the layout page past Draft', () => {
  const SETTLED = 'The setup is settled: it cannot change once applications have opened.';
  const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
  let market: Record<string, unknown>;

  function served(floorplans: FloorplanObject[]) {
    return {
      id: MARKET_ID,
      name: 'Riverside',
      phase: 'applications',
      setupLockReason: SETTLED,
      actionRefusals: answersRefusing(),
      setupObject: {
        priority: [],
        marketDates: [{ date: '2099-08-01' }],
        tiers: [],
        locations: [UPPER],
        sections: [{ id: 'gold', name: 'Gold row', count: 6, location: UPPER }],
        assignmentOptions: {},
        tableTypes: [{ id: 'six-foot', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
        floorplans,
      },
    };
  }

  async function mountPage() {
    const wrapper = shallowMount(LayoutView, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          MarketFrame: { name: 'MarketFrame', props: ['market'], template: '<div><slot /></div>' },
          // Layout settings shows its body while open, as the dialog does.
          AppDialog: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    return wrapper;
  }

  enableAutoUnmount(afterEach);
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    routing.router = marketRouter();
    routing.route = reactive({
      name: 'market-layout',
      params: { marketId: 'market-1', locationId: UPPER.id },
      query: {},
      matched: [],
    });
    api.get.mockReset();
    api.get.mockImplementation((url: string) =>
      url === `/markets/${MARKET_ID}`
        ? Promise.resolve({ data: { market } })
        : Promise.resolve({ data: new Blob() }),
    );
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => vi.useRealTimers());

  it('offers the upload to a location with no layout', async () => {
    market = served([]);
    const wrapper = await mountPage();

    expect(wrapper.findComponent(FloorplanUploader).exists()).toBe(true);
    expect(wrapper.get('[data-testid="layout-panel-start"]').text()).toBe(
      "Upload the venue's floorplan for Upper Hall to start.",
    );
    // The layout it starts will follow the plan, which the page says in place of the setup's
    // settled sentence over an upload it offers.
    expect(wrapper.find('[data-testid="layout-follows-plan"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="layout-setup-settled"]').exists()).toBe(false);
  });

  it('says a layout that follows the plan follows it, and opens its seats but not its types', async () => {
    market = served([aLayout(true, GOLD_1_3_5())]);
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="layout-follows-plan"]').text()).toBe(
      "This layout follows the plan: place each section's tables, up to its count. The seats " +
        'themselves are settled.',
    );
    expect(wrapper.find('[data-testid="layout-setup-settled"]').exists()).toBe(false);
    expect(wrapper.getComponent(LayoutEditor).props('settled')).toBe(false);
    const selection = wrapper.getComponent(LayoutPanelSelection);
    expect(selection.props()).toMatchObject({
      settled: false,
      typesSettled: true,
      followsPlan: true,
    });
    expect(wrapper.getComponent(LayoutPanelSections).props()).toMatchObject({
      settled: false,
      followsPlan: true,
    });
    await wrapper.get('[data-testid="layout-settings-open"]').trigger('click');
    expect(wrapper.getComponent(LayoutPanelTypes).props('settled')).toBe(true);
  });

  it('keeps a layout started in Draft settled, under the setup-settled sentence', async () => {
    market = served([aLayout(false, GOLD_1_3_5())]);
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="layout-setup-settled"]').text()).toBe(SETTLED);
    expect(wrapper.find('[data-testid="layout-follows-plan"]').exists()).toBe(false);
    expect(wrapper.getComponent(LayoutEditor).props('settled')).toBe(true);
    expect(wrapper.getComponent(LayoutPanelSelection).props('settled')).toBe(true);
    expect(wrapper.getComponent(LayoutPanelSections).props('followsPlan')).toBe(false);
  });

  it("numbers the selected table from the card's Number field, as one change", async () => {
    market = served([aLayout(true, GOLD_1_3_5())]);
    const wrapper = await mountPage();
    const editor = wrapper.getComponent(LayoutEditor).props('editor') as ReturnType<
      typeof useLayoutEditor
    >;
    editor.select(['g1']);
    await vi.advanceTimersByTimeAsync(0);

    wrapper.getComponent(LayoutPanelSelection).vm.$emit('number', 3);
    await vi.advanceTimersByTimeAsync(0);

    expect(editor.layout.value!.tables.map((table) => table.number)).toEqual([3, 1, 5]);
    expect(wrapper.get('[data-testid="layout-announcement"]').text()).toBe('Numbered Gold row 3');
  });

  it("starts a layout of its own id and no table, sharing no id with another location's", async () => {
    const LOWER = { id: 'loc-lower', name: 'Lower Hall' };
    const lowerLayout = { ...aLayout(true, GOLD_1_3_5()), id: 'fp-lower', locationId: LOWER.id };
    market = served([lowerLayout]);
    (market.setupObject as { locations: unknown[] }).locations.push(LOWER);
    api.post.mockReset();
    api.post.mockImplementation(async (_url: string, body: { floorplan: FloorplanObject }) => ({
      data: { floorplan: { ...body.floorplan, revision: 1, followsPlan: true }, sections: [] },
    }));
    const wrapper = await mountPage();

    wrapper.getComponent(FloorplanUploader).vm.$emit('uploaded', {
      gridfs_id: 'img-upper',
      width: 800,
      height: 600,
    });
    await vi.advanceTimersByTimeAsync(700);

    const started = api.post.mock.calls[0][1].floorplan as FloorplanObject;
    expect(started.locationId).toBe(UPPER.id);
    expect(started.id).not.toBe(lowerLayout.id);
    expect(started.tables).toEqual([]);
  });

  it('says on the status line what an add held back', async () => {
    market = served([aLayout(true, GOLD_1_3_5())]);
    const wrapper = await mountPage();
    const editor = wrapper.getComponent(LayoutEditor).props('editor') as ReturnType<
      typeof useLayoutEditor
    >;
    editor.addTables(gold(3));
    editor.select(['g1']);
    await vi.advanceTimersByTimeAsync(0);

    wrapper.getComponent(LayoutPanelSelection).vm.$emit('duplicate');
    await vi.advanceTimersByTimeAsync(0);

    expect(wrapper.get('[data-testid="layout-status"]').text()).toBe(
      "Gold row's 6 tables are all on the layout.",
    );
  });
});
