/**
 * The Layout page loads its floorplans in step (T501): each location's image is read through the
 * one loader of a map's images (`useFloorplanImages`), the open location's first and the others
 * behind it, so a move between two locations' layouts never draws the new tables over the old
 * image, a location opened before is drawn at once with no request, and the image a replacement
 * brings is held by a loader of its own until the layout takes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { enableAutoUnmount, mount, shallowMount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import LayoutView from '@/components/layout/LayoutView.vue';
import LayoutEditor from '@/components/layout/LayoutEditor.vue';
import LayoutMap from '@/components/layout/LayoutMap.vue';
import { useLayoutEditor } from '@/components/layout/useLayoutEditor';
import type { SavedLayout } from '@/components/layout/layoutSave';
import type { FloorplanObject } from '@/assets/types/datatypes';
import { ROW_CHOICES_AT_FIRST, rowChoices } from '@/components/layout/layoutRow';
import { MARKET_ID, marketRouter } from './support/marketScreen';
import { VIEWER_ANSWERS, answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
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

const UPPER = { id: 'loc-upper', name: 'Upper Hall' };
const LOWER = { id: 'loc-lower', name: 'Lower Hall' };

function table(id: string, sectionId: string, number: number, xMm: number) {
  return { id, sectionId, number, tableTypeId: 'tt-six', xMm, yMm: 2000, rotation: 0 };
}

function layoutOf(location: { id: string }, image: string, tableId: string): FloorplanObject {
  return {
    id: `fp-${location.id}`,
    locationId: location.id,
    revision: 3,
    imageGridfsId: image,
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    referenceLineStart: [0, 300],
    referenceLineEnd: [800, 300],
    referenceLineLengthMm: 30_000,
    tables: [table(tableId, location === UPPER ? 'sec-gold' : 'sec-bronze', 1, 4000)],
    zones: [],
    sectionStyles: [],
    startingCounts: [],
  };
}

const UPPER_LAYOUT = layoutOf(UPPER, 'img-upper', 'upper-1');
const LOWER_LAYOUT = layoutOf(LOWER, 'img-lower', 'lower-1');

function served(
  overrides: Record<string, unknown> = {},
  floorplans = [UPPER_LAYOUT, LOWER_LAYOUT],
) {
  return {
    id: MARKET_ID,
    name: 'Riverside',
    phase: 'draft',
    actionRefusals: answersRefusing(),
    setupObject: {
      priority: [],
      marketDates: [{ date: '2099-08-01' }],
      tiers: [],
      locations: [UPPER, LOWER],
      sections: [
        { id: 'sec-gold', name: 'Gold row', count: 1, location: UPPER },
        { id: 'sec-bronze', name: 'Bronze corner', count: 1, location: LOWER },
      ],
      assignmentOptions: {},
      tableTypes: [{ id: 'tt-six', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
      floorplans,
    },
    ...overrides,
  };
}

let market: Record<string, unknown> = served();

// ── A fake network of images, each held until the test lets it land ─────────

/** An image request the test answers: its gridfs id, and how to land or fail it. */
interface Asked {
  id: string;
  land: () => void;
  fail: () => void;
}
let asked: Asked[];
/** The ids whose requests are held until landed by hand; any other lands at once. */
let held: Set<string>;
/** The ids whose requests fail. */
let failing: Set<string>;
/** Which image each blob is, and each object URL made. */
const imageOf = new WeakMap<Blob, string>();
let made: { url: string; id: string }[];
let revoked: string[];

function askForImage(id: string): Promise<{ data: Blob }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([id], { type: 'image/png' });
    imageOf.set(blob, id);
    const land = () => resolve({ data: blob });
    const fail = () => reject(new Error('Network Error'));
    asked.push({ id, land, fail });
    if (failing.has(id)) fail();
    else if (!held.has(id)) land();
  });
}

/** The requests for one image's bytes so far. */
const askedFor = (id: string) => asked.filter((each) => each.id === id).length;
/** The image an object URL was made of, '' for none. */
const imageAt = (url: string) => made.find((each) => each.url === url)?.id ?? '';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

async function mountPage(): Promise<VueWrapper> {
  const wrapper = shallowMount(LayoutView, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        AppDialog: {
          name: 'AppDialog',
          props: ['open', 'testid'],
          template: '<div v-if="open" :data-testid="testid"><slot /></div>',
        },
        MarketFrame: {
          name: 'MarketFrame',
          props: ['market', 'beforeTransition'],
          template: '<div><slot /></div>',
        },
      },
    },
  });
  await settle();
  return wrapper;
}

/** The map the page draws, the editor's or the read one: the image it is given, and whether its
 *  tables wait for it. */
function drawn(wrapper: VueWrapper) {
  const editor = wrapper.findComponent(LayoutEditor);
  if (editor.exists()) {
    return {
      image: imageAt(editor.props('imageUrl') ?? ''),
      pending: editor.props('imagePending'),
      layout: editor.props('editor').layout.value?.locationId,
    };
  }
  const map = wrapper.findComponent(LayoutMap);
  expect(map.exists()).toBe(true);
  return {
    image: imageAt(map.props('imageUrl') ?? ''),
    pending: map.props('imagePending'),
    layout: map.props('layout').locationId,
  };
}

async function moveTo(location: { id: string }) {
  (routing.route as { params: Record<string, string> }).params.locationId = location.id;
  await settle();
}

enableAutoUnmount(afterEach);

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
  market = served();
  asked = [];
  held = new Set();
  failing = new Set();
  made = [];
  revoked = [];
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.delete.mockResolvedValue({ data: {} });
  api.get.mockImplementation((url: string) => {
    if (url === `/markets/${MARKET_ID}`) return Promise.resolve({ data: { market } });
    const image = /^\/floorplans\/([^/]+)$/.exec(url);
    if (image) return askForImage(decodeURIComponent(image[1]));
    return Promise.resolve({ data: {} });
  });
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:image-${(n += 1)}`;
    made.push({ url, id: imageOf.get(blob) ?? '?' });
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(rowChoices, ROW_CHOICES_AT_FIRST);
});

describe("a move between two locations' layouts", () => {
  it.each([
    ['in the editor', answersRefusing()],
    ['where the layout is read', VIEWER_ANSWERS],
  ])("never gives the map the old location's image, %s", async (_where, answers) => {
    market = served({ actionRefusals: answers });
    held.add('img-lower');
    const wrapper = await mountPage();
    expect(drawn(wrapper)).toEqual({ image: 'img-upper', pending: false, layout: UPPER.id });

    await moveTo(LOWER);
    // Lower Hall's tables wait on the floor, with no image, while its image is on its way.
    expect(drawn(wrapper)).toEqual({ image: '', pending: true, layout: LOWER.id });

    asked.find((each) => each.id === 'img-lower')!.land();
    await settle();
    expect(drawn(wrapper)).toEqual({ image: 'img-lower', pending: false, layout: LOWER.id });
  });

  it('draws a location opened before at once, with no request', async () => {
    const wrapper = await mountPage();
    // The open location's image first, then the other's with no move.
    expect(asked.map(({ id }) => id)).toEqual(['img-upper', 'img-lower']);

    await moveTo(LOWER);
    expect(drawn(wrapper)).toEqual({ image: 'img-lower', pending: false, layout: LOWER.id });
    await moveTo(UPPER);
    expect(drawn(wrapper)).toEqual({ image: 'img-upper', pending: false, layout: UPPER.id });
    expect(asked.map(({ id }) => id)).toEqual(['img-upper', 'img-lower']);
  });
});

describe('with "Show the floorplan" unticked', () => {
  beforeEach(() => localStorage.setItem('conventioner.layout.showImage', '0'));
  afterEach(() => localStorage.removeItem('conventioner.layout.showImage'));

  it.each([
    ['in the editor', answersRefusing()],
    ['where the layout is read', VIEWER_ANSWERS],
  ])('draws the tables at once while the image loads, %s', async (_where, answers) => {
    market = served({ actionRefusals: answers });
    held.add('img-upper');
    held.add('img-lower');
    const wrapper = await mountPage();
    expect(drawn(wrapper)).toEqual({ image: '', pending: false, layout: UPPER.id });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drawn(wrapper)).toEqual({ image: '', pending: false, layout: UPPER.id });

    await moveTo(LOWER);
    expect(drawn(wrapper)).toEqual({ image: '', pending: false, layout: LOWER.id });
  });
});

describe("a location's image that cannot be loaded", () => {
  it("says the page's line, and draws the tables on the floor", async () => {
    failing.add('img-upper');
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="layout-image-failed"]').text()).toBe(
      "The floorplan's image could not be shown. Reload the page to try again.",
    );
    expect(drawn(wrapper)).toEqual({ image: '', pending: false, layout: UPPER.id });
  });
});

describe("a replaced floorplan's image", () => {
  const NEW_IMAGE = { gridfs_id: 'img-new', width: 800, height: 600 };

  async function replaceTheImage(wrapper: VueWrapper) {
    await wrapper.get('[data-testid="layout-settings-open"]').trigger('click');
    await settle();
    await wrapper.get('[data-testid="layout-replace-image"]').trigger('click');
    await settle();
    wrapper.findComponent({ name: 'FloorplanUploader' }).vm.$emit('uploaded', NEW_IMAGE);
    await settle();
  }

  it("is held apart from the layout's, and once saved draws the new image and lets the old one go", async () => {
    api.post.mockImplementation(async (_url: string, body: { floorplan: FloorplanObject }) => {
      const floorplan = { ...body.floorplan, revision: body.floorplan.revision + 1 };
      market = served({}, [floorplan, LOWER_LAYOUT]);
      return { data: { floorplan, sections: [] } };
    });
    const wrapper = await mountPage();
    const upperUrl = made.find((each) => each.id === 'img-upper')!.url;

    await replaceTheImage(wrapper);
    const calibration = wrapper.findComponent({ name: 'LayoutCalibration' });
    expect(imageAt(calibration.props('imageUrl') as string)).toBe('img-new');
    // The layout's own image is still the page's, for the layout to go back to.
    expect(revoked).not.toContain(upperUrl);

    calibration.vm.$emit('set', { start: [0, 300], end: [800, 300], lengthMm: 30_000 });
    await settle();
    await settle();

    expect(drawn(wrapper)).toEqual({ image: 'img-new', pending: false, layout: UPPER.id });
    expect(revoked).toContain(upperUrl);
    // The replacement's bytes are drawn as they came: the new image is asked for once.
    expect(askedFor('img-new')).toBe(1);
    // The URL drawn is live: only the replacement's own was let go, never the one now drawn.
    const drawnUrl = wrapper.findComponent(LayoutEditor).props('imageUrl') as string;
    expect(revoked).not.toContain(drawnUrl);
  });

  it("given up, lets the new image go and keeps the layout's", async () => {
    const wrapper = await mountPage();
    const upperUrl = made.find((each) => each.id === 'img-upper')!.url;
    await replaceTheImage(wrapper);
    const newUrl = made.find((each) => each.id === 'img-new')!.url;

    // "Keep the current image", the calibration's own way out.
    wrapper.findComponent({ name: 'LayoutCalibration' }).vm.$emit('cancel');
    await settle();

    expect(revoked).toContain(newUrl);
    expect(revoked).not.toContain(upperUrl);
    expect(drawn(wrapper)).toEqual({ image: 'img-upper', pending: false, layout: UPPER.id });
  });
});

describe("the editor's map while its image is on its way", () => {
  function anEditor() {
    const editor = useLayoutEditor({
      save: (layout: FloorplanObject): Promise<SavedLayout> =>
        Promise.resolve({ floorplan: layout }),
      tableTypes: () => [{ id: 'tt-six', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
    });
    editor.adopt(UPPER_LAYOUT);
    return editor;
  }

  it('draws no table and no image until the image is ready', async () => {
    const props = {
      editor: anEditor(),
      locationName: 'Upper Hall',
      sections: [],
      tableTypes: [{ id: 'tt-six', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
    };
    const waiting = mount(LayoutEditor, { props: { ...props, imagePending: true } });
    await settle();
    expect(waiting.findComponent(LayoutMap).props('imagePending')).toBe(true);
    expect(waiting.find('[data-testid="layout-table"]').exists()).toBe(false);
    expect(waiting.find('[data-testid="layout-map-image"]').exists()).toBe(false);

    const ready = mount(LayoutEditor, { props: { ...props, imageUrl: 'blob:upper' } });
    await settle();
    expect(ready.findComponent(LayoutMap).props('imagePending')).toBe(false);
    expect(ready.find('[data-testid="layout-table"]').exists()).toBe(true);
    expect(ready.find('[data-testid="layout-map-image"]').exists()).toBe(true);
  });
});
