/**
 * A map's floorplan loads in step with its tables (T501): one loader of a page's floorplan images,
 * `useFloorplanImages`, fetches the open location's image first, then each other one in the
 * background one at a time, and never twice; it gives the open key's object URL only once that
 * image is decoded, never another key's, holds the map's tables back (`pending`) for at most two
 * seconds and then lets them stand on the floor (`slow`) until the image lands. A failed image is
 * forgotten and fetched again when its key opens; every object URL is revoked when its key leaves
 * the sources and when the page goes, and an answer landing after that is dropped.
 *
 * `LayoutMap` given `imagePending` draws the hall's floor alone, at its own size; Attendance's map
 * holds its tables back while the open image loads, says "Loading the floorplan..." once the wait
 * ran out and says when the image could not be loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { effectScope, nextTick, reactive, ref, type EffectScope, type Ref } from 'vue';
import type { LocationQuery } from 'vue-router';

import AttendanceMap from '@/components/attendance/AttendanceMap.vue';
import LayoutMap from '@/components/layout/LayoutMap.vue';
import { useFloorplanImages, type FloorplanImageSource } from '@/components/layout/floorplanImages';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const route = reactive<{ query: LocationQuery }>({ query: {} });

vi.mock('vue-router', () => ({ useRoute: () => route }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

// ── A fake network and a fake decoder ────────────────────────────────────────

interface Held {
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
}

/** Every fetch asked for, by key, each held until a test lands or fails it. */
let asked: Map<string, Held[]>;
/** The blob each object URL was made of, by the key whose image it is. */
let blobKeys: Map<Blob, string>;
let made: string[];
let revoked: string[];
/** Decodes held by object URL; a URL not held decodes at once, unless it is to fail. */
let heldDecodes: Map<string, Held[]>;
let failingDecodes: Set<string>;
let decoded: string[];

function source(key: string): FloorplanImageSource {
  return {
    key,
    fetch: () =>
      new Promise<Blob>((resolve, reject) => {
        asked.set(key, [...(asked.get(key) ?? []), { resolve, reject }]);
      }),
  };
}

function fetchesOf(key: string): number {
  return asked.get(key)?.length ?? 0;
}

/** The key's last fetch answers with its image. */
async function land(key: string) {
  const blob = new Blob([`image of ${key}`]);
  blobKeys.set(blob, key);
  asked.get(key)!.at(-1)!.resolve(blob);
  await settle();
}

async function fail(key: string) {
  asked.get(key)!.at(-1)!.reject(new Error('Network Error'));
  await settle();
}

/** Lets every answer and decode due run, under real timers or fake ones. */
async function settle() {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await flushPromises();
}

const keyOf = (url: string) => url.replace(/^blob:(.*)#\d+$/, '$1');

beforeEach(() => {
  asked = new Map();
  blobKeys = new Map();
  made = [];
  revoked = [];
  heldDecodes = new Map();
  failingDecodes = new Set();
  decoded = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:${blobKeys.get(blob as Blob) ?? 'other'}#${made.length + 1}`;
    made.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    const url = this.getAttribute('src') ?? '';
    decoded.push(url);
    if (failingDecodes.has(keyOf(url))) return Promise.reject(new Error('EncodingError'));
    const holds = heldDecodes.get(keyOf(url));
    if (!holds) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      holds.push({ resolve: () => resolve(), reject });
    });
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

enableAutoUnmount(afterEach);

let scope: EffectScope | null = null;

function loader(keys: string[], open: string | null) {
  const sources = ref<FloorplanImageSource[]>(keys.map(source)) as Ref<FloorplanImageSource[]>;
  const openKey = ref<string | null>(open);
  scope = effectScope();
  const images = scope.run(() => useFloorplanImages(sources, openKey))!;
  return { sources, openKey, ...images };
}

afterEach(() => {
  scope?.stop();
  scope = null;
});

// ── The loader ───────────────────────────────────────────────────────────────

describe('useFloorplanImages', () => {
  it('fetches the open key first, then each other one in order, one at a time', async () => {
    const { open } = loader(['north', 'south', 'east'], 'south');
    await flushPromises();
    expect([...asked.keys()]).toEqual(['south']);
    expect(open.value).toEqual({ url: '', pending: true, slow: false, failed: false });

    await land('south');
    expect(keyOf(open.value.url)).toBe('south');
    expect(open.value.pending).toBe(false);
    expect([...asked.keys()]).toEqual(['south', 'north']);

    await land('north');
    expect([...asked.keys()]).toEqual(['south', 'north', 'east']);
    await land('east');
    expect(fetchesOf('north') + fetchesOf('south') + fetchesOf('east')).toBe(3);
  });

  it('decodes only the open image, and gives its URL once decoded', async () => {
    heldDecodes.set('north', []);
    const { open } = loader(['north', 'south'], 'north');
    await land('north');
    expect(open.value.url).toBe('');
    expect(open.value.pending).toBe(true);

    heldDecodes.get('north')![0]!.resolve(new Blob());
    await flushPromises();
    expect(keyOf(open.value.url)).toBe('north');

    await land('south');
    expect(decoded.map(keyOf)).toEqual(['north']);
  });

  it('opens a key already fetched and decoded at once, with no fetch', async () => {
    const { open, openKey } = loader(['north', 'south'], 'north');
    await land('north');
    await land('south');

    openKey.value = 'south';
    await flushPromises();
    expect(keyOf(open.value.url)).toBe('south');

    openKey.value = 'north';
    await nextTick();
    expect(keyOf(open.value.url)).toBe('north');
    expect(open.value.pending).toBe(false);
    expect(fetchesOf('north')).toBe(1);
    expect(fetchesOf('south')).toBe(1);
  });

  it('waits for a background fetch in flight when its key opens, with no second fetch', async () => {
    const { open, openKey } = loader(['north', 'south'], 'north');
    await land('north');
    expect(fetchesOf('south')).toBe(1);

    openKey.value = 'south';
    await flushPromises();
    expect(open.value).toEqual({ url: '', pending: true, slow: false, failed: false });
    expect(fetchesOf('south')).toBe(1);

    await land('south');
    expect(keyOf(open.value.url)).toBe('south');
    expect(fetchesOf('south')).toBe(1);
  });

  it("never gives the old key's URL for the new one when the open key changes mid-fetch", async () => {
    const { open, openKey } = loader(['north', 'south'], 'north');
    await flushPromises();

    openKey.value = 'south';
    await nextTick();
    expect(open.value.url).toBe('');
    expect(fetchesOf('south')).toBe(1);

    await land('north');
    expect(open.value.url).toBe('');
    expect(open.value.pending).toBe(true);

    await land('south');
    expect(keyOf(open.value.url)).toBe('south');

    // North's bytes were kept: it opens with no fetch, once decoded.
    openKey.value = 'north';
    await nextTick();
    expect(open.value.url).toBe('');
    await flushPromises();
    expect(keyOf(open.value.url)).toBe('north');
    expect(fetchesOf('north')).toBe(1);
  });

  it('opens the old key at once, never showing the new one, when switched back before it lands', async () => {
    const { open, openKey } = loader(['north', 'south'], 'north');
    await land('north');
    openKey.value = 'south';
    await nextTick();
    expect(open.value.url).toBe('');
    openKey.value = 'north';
    await nextTick();
    expect(keyOf(open.value.url)).toBe('north');
  });

  it('forgets a failed background fetch and fetches it again when its key opens', async () => {
    const { open, openKey } = loader(['north', 'south', 'east'], 'north');
    await land('north');
    await fail('south');
    expect(open.value.failed).toBe(false);
    expect(fetchesOf('east')).toBe(1);
    await land('east');
    expect(fetchesOf('south')).toBe(1);

    openKey.value = 'south';
    await flushPromises();
    expect(fetchesOf('south')).toBe(2);
    expect(open.value).toEqual({ url: '', pending: true, slow: false, failed: false });
    await land('south');
    expect(keyOf(open.value.url)).toBe('south');
  });

  it('sets failed when the open fetch fails, then fetches the others, and tries it again on a reopen', async () => {
    const { open, openKey } = loader(['north', 'south'], 'north');
    await fail('north');
    expect(open.value).toEqual({ url: '', pending: false, slow: false, failed: true });
    expect(fetchesOf('south')).toBe(1);
    await land('south');

    openKey.value = 'south';
    await flushPromises();
    expect(open.value.failed).toBe(false);
    expect(fetchesOf('north')).toBe(1);

    openKey.value = 'north';
    await flushPromises();
    expect(fetchesOf('north')).toBe(2);
    expect(open.value.failed).toBe(false);
    await land('north');
    expect(keyOf(open.value.url)).toBe('north');
  });

  it('sets failed when the open image fails to decode, and drops its bytes', async () => {
    failingDecodes.add('north');
    const { open } = loader(['north'], 'north');
    await land('north');
    expect(open.value).toEqual({ url: '', pending: false, slow: false, failed: true });
    expect(revoked.map(keyOf)).toEqual(['north']);
  });

  it('draws the floor alone for a key with no source, or none open', async () => {
    const { open, openKey } = loader(['north'], 'south');
    await flushPromises();
    expect(open.value).toEqual({ url: '', pending: false, slow: false, failed: false });
    expect(fetchesOf('south')).toBe(0);
    // The others are fetched once the open key is settled, and it has nothing to wait for.
    expect(fetchesOf('north')).toBe(1);

    openKey.value = null;
    await flushPromises();
    expect(open.value).toEqual({ url: '', pending: false, slow: false, failed: false });
  });

  it('fetches every image behind the floor when none is open', async () => {
    loader(['north', 'south'], null);
    await flushPromises();
    expect([...asked.keys()]).toEqual(['north']);
    await land('north');
    expect([...asked.keys()]).toEqual(['north', 'south']);
  });

  it('holds the tables for at most two seconds, then is slow until the image lands', async () => {
    vi.useFakeTimers();
    const { open, openKey } = loader(['north', 'south'], 'north');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1999);
    expect(open.value).toEqual({ url: '', pending: true, slow: false, failed: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(open.value).toEqual({ url: '', pending: false, slow: true, failed: false });

    await land('north');
    expect(open.value.slow).toBe(false);
    expect(keyOf(open.value.url)).toBe('north');

    // A new opening waits its own two seconds.
    openKey.value = 'south';
    await nextTick();
    expect(open.value).toEqual({ url: '', pending: true, slow: false, failed: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(open.value.slow).toBe(true);
  });

  it('a slow image that fails is failed, no longer slow', async () => {
    vi.useFakeTimers();
    const { open } = loader(['north'], 'north');
    await vi.advanceTimersByTimeAsync(2000);
    expect(open.value.slow).toBe(true);
    await fail('north');
    expect(open.value).toEqual({ url: '', pending: false, slow: false, failed: true });
  });

  it("revokes a key's URL when it leaves the sources, and drops its late answer", async () => {
    const { open, sources, openKey } = loader(['north', 'south', 'east'], 'north');
    await land('north');
    expect(fetchesOf('south')).toBe(1);

    // North replaced by a new image, and south gone while its fetch is in flight.
    sources.value = [source('north-2'), source('east')];
    openKey.value = 'north-2';
    await nextTick();
    expect(revoked.map(keyOf)).toEqual(['north']);
    expect(open.value.url).toBe('');

    await land('south');
    expect(made.map(keyOf)).not.toContain('south');

    await land('north-2');
    expect(keyOf(open.value.url)).toBe('north-2');
  });

  it('revokes every URL on unmount, and drops an answer landing after it', async () => {
    const { open } = loader(['north', 'south', 'east'], 'north');
    await land('north');
    await land('south');
    expect(fetchesOf('east')).toBe(1);
    expect(keyOf(open.value.url)).toBe('north');

    scope!.stop();
    expect(revoked.map(keyOf).sort()).toEqual(['north', 'south']);

    await land('east');
    expect(made.map(keyOf)).toEqual(['north', 'south']);
  });

  it("urlOf gives a decoded key's URL, and '' for any other", async () => {
    const { urlOf } = loader(['north', 'south'], 'north');
    await land('north');
    await land('south');
    expect(keyOf(urlOf('north'))).toBe('north');
    expect(urlOf('south')).toBe('');
    expect(urlOf('east')).toBe('');
  });
});

// ── LayoutMap's imagePending ─────────────────────────────────────────────────

describe('LayoutMap with imagePending', () => {
  const LAYOUT = {
    id: 'fp-1',
    locationId: 'loc-1',
    revision: 1,
    imageGridfsId: 'img-1',
    imageWidth: 800,
    imageHeight: 600,
    scalePxPerUnit: 800 / 30_000,
    tables: [
      {
        id: 't1',
        sectionId: 'sec-a',
        number: 1,
        tableTypeId: 'type-6ft',
        xMm: 4000,
        yMm: 3000,
        rotation: 0,
      },
    ],
    zones: [
      {
        id: 'z1',
        label: 'Stage',
        xMm: 10_000,
        yMm: 10_000,
        widthMm: 4000,
        depthMm: 2000,
        rotation: 0,
      },
    ],
    sectionStyles: [],
    startingCounts: [],
  };
  const SECTIONS = [
    {
      id: 'sec-a',
      name: 'Aisle A',
      location: { id: 'loc-1', name: 'Hall' },
      tier: null,
      count: 1,
    },
  ];
  const TYPES = [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }];

  function drawn(imagePending: boolean) {
    return mount(LayoutMap, {
      props: {
        layout: LAYOUT as never,
        locationName: 'Hall',
        sections: SECTIONS as never,
        tableTypes: TYPES,
        mode: 'read',
        imageUrl: 'blob:hall',
        imagePending,
      },
    });
  }

  it('draws the floor alone: no image, table, zone or section name', () => {
    const map = drawn(true);
    expect(map.find('.layout-map__floor').exists()).toBe(true);
    for (const id of ['layout-map-image', 'layout-table', 'layout-map-zone', 'layout-map-label']) {
      expect(map.find(`[data-testid="${id}"]`).exists(), id).toBe(false);
    }
    expect(map.findAll('[role="button"]')).toHaveLength(0);
  });

  it('keeps the size it has without it', async () => {
    const pending = drawn(true);
    const ready = drawn(false);
    expect(ready.find('[data-testid="layout-map-image"]').exists()).toBe(true);
    expect(ready.findAll('[role="button"]').length).toBeGreaterThan(0);
    expect(pending.attributes('viewBox')).toBe(ready.attributes('viewBox'));
    expect(pending.find('.layout-map__floor').attributes()).toEqual(
      ready.find('.layout-map__floor').attributes(),
    );

    await pending.setProps({ imagePending: false });
    expect(pending.find('[data-testid="layout-map-image"]').exists()).toBe(true);
    expect(pending.findAll('[role="button"]').length).toBeGreaterThan(0);
  });
});

// ── Attendance's map ─────────────────────────────────────────────────────────

describe("Attendance's map draws its floorplan in step", () => {
  const NORTH = { id: 'loc-north', name: 'North Wing' };
  const SOUTH = { id: 'loc-south', name: 'South Wing' };

  function floorplan(id: string, locationId: string, image: string | null, tableId: string) {
    return {
      id,
      locationId,
      revision: 1,
      imageGridfsId: image,
      imageWidth: 800,
      imageHeight: 600,
      scalePxPerUnit: 800 / 30_000,
      tables: [
        {
          id: tableId,
          sectionId: `sec-${locationId}`,
          number: 1,
          tableTypeId: 'type-6ft',
          xMm: 4000,
          yMm: 3000,
          rotation: 0,
        },
      ],
      zones: [],
      sectionStyles: [],
      startingCounts: [],
    };
  }

  function market(southImage: string | null = 'img-south'): Market {
    return {
      id: 'market-1',
      name: 'Spring Market',
      phase: MarketPhase.MarketDays,
      actionRefusals: answersRefusing(),
      setupObject: {
        locations: [NORTH, SOUTH],
        sections: [
          { id: `sec-${NORTH.id}`, name: 'Aisle A', location: NORTH, tier: null, count: 1 },
          { id: `sec-${SOUTH.id}`, name: 'Aisle B', location: SOUTH, tier: null, count: 1 },
        ],
        tableTypes: [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
        floorplans: [
          floorplan('fp-north', NORTH.id, 'img-north', 'north-1'),
          floorplan('fp-south', SOUTH.id, southImage, 'south-1'),
        ],
      },
    } as unknown as Market;
  }

  /** Each image read answers through the fake network, by its gridfs id. */
  beforeEach(() => {
    route.query = {};
    api.get.mockReset();
    api.get.mockImplementation((path: string) => {
      const id = decodeURIComponent(path.replace('/floorplans/', ''));
      return source(id)
        .fetch()
        .then((data) => ({ data }));
    });
  });

  function mapOf(given: Market = market()) {
    return mount(AttendanceMap, {
      props: {
        market: given,
        rows: [],
        date: '2099-08-01',
        openVendor: null,
        hereWithoutSeat: 0,
      },
      global: { stubs: { RouterLink: true } },
    });
  }

  const tables = (map: ReturnType<typeof mapOf>) => map.findAll('[data-testid="layout-table"]');
  const image = (map: ReturnType<typeof mapOf>) => map.find('[data-testid="layout-map-image"]');

  it('draws the tables and the image together, then fetches the other image', async () => {
    const map = mapOf();
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/floorplans/img-north', { responseType: 'blob' });
    expect(tables(map)).toHaveLength(0);
    expect(image(map).exists()).toBe(false);

    await land('img-north');
    expect(tables(map)).toHaveLength(1);
    expect(keyOf(image(map).attributes('href')!)).toBe('img-north');
    expect(fetchesOf('img-south')).toBe(1);
  });

  it('never draws the new tables over the old image on a switch, and opens a second time with no fetch', async () => {
    const map = mapOf();
    await land('img-north');

    route.query = { location: SOUTH.id };
    await nextTick();
    expect(tables(map)).toHaveLength(0);
    expect(image(map).exists()).toBe(false);

    await land('img-south');
    expect(tables(map).map((table) => table.attributes('data-table-id'))).toEqual(['south-1']);
    expect(keyOf(image(map).attributes('href')!)).toBe('img-south');

    route.query = { location: NORTH.id };
    await nextTick();
    expect(keyOf(image(map).attributes('href')!)).toBe('img-north');
    expect(tables(map).map((table) => table.attributes('data-table-id'))).toEqual(['north-1']);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('draws the tables on the floor with "Loading the floorplan..." once the wait ran out', async () => {
    vi.useFakeTimers();
    const map = mapOf();
    await vi.advanceTimersByTimeAsync(2000);
    expect(tables(map)).toHaveLength(1);
    expect(image(map).exists()).toBe(false);
    const loading = map.find('[data-testid="attendance-map-image-loading"]');
    expect(loading.text()).toBe('Loading the floorplan...');
    expect(loading.attributes('aria-live')).toBe('polite');

    await land('img-north');
    expect(image(map).exists()).toBe(true);
    expect(map.find('[data-testid="attendance-map-image-loading"]').exists()).toBe(false);
  });

  it('says so under the map when the open image could not be loaded, the tables on the floor', async () => {
    const map = mapOf();
    await fail('img-north');
    expect(tables(map)).toHaveLength(1);
    expect(image(map).exists()).toBe(false);
    const failed = map.find('[data-testid="attendance-map-image-failed"]');
    expect(failed.text()).toBe(
      'The floorplan could not be loaded. The tables are drawn without it.',
    );
    expect(failed.attributes('aria-live')).toBe('polite');
  });

  it('draws a location with no image on the floor at once', async () => {
    route.query = { location: SOUTH.id };
    const map = mapOf(market(null));
    await nextTick();
    expect(tables(map)).toHaveLength(1);
    expect(image(map).exists()).toBe(false);
    expect(map.find('[data-testid="attendance-map-image-loading"]').exists()).toBe(false);
    await flushPromises();
    expect(fetchesOf('img-north')).toBe(1);
  });
});
