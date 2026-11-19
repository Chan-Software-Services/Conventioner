/**
 * Attendance's map offers the Layout page's floorplan choices (T501, Q6, Daniel: (a)): under its
 * legend one line of three ticks, "Show the floorplan", "Greyscale" and "Faded", in a group named
 * "Floorplan", each kept in the browser under the Layout page's own names, so a choice made on
 * either page holds on the other. They change the image as the Layout page's do, and show only
 * when the open location's layout has an image. `DayMap` given none of them draws as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import type { LocationQuery } from 'vue-router';

import AttendanceMap from '@/components/attendance/AttendanceMap.vue';
import DayMap from '@/components/daymap/DayMap.vue';
import { choiceKey } from '@/components/layout/layoutViewChoices';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const route = reactive<{ query: LocationQuery }>({ query: {} });

vi.mock('vue-router', () => ({ useRoute: () => route }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

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

/** North Wing laid out on an image, South Wing with none. */
function market(): Market {
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
        floorplan('fp-south', SOUTH.id, null, 'south-1'),
      ],
    },
  } as unknown as Market;
}

beforeEach(() => {
  localStorage.clear();
  route.query = {};
  api.get.mockReset();
  api.get.mockResolvedValue({ data: new Blob(['image']) });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:north');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => vi.restoreAllMocks());
enableAutoUnmount(afterEach);

async function aMap() {
  const map = mount(AttendanceMap, {
    props: {
      market: market(),
      rows: [],
      date: '2099-08-01',
      openVendor: null,
      notHere: 'Not yet',
      hereWithoutSeat: 0,
    },
    global: { stubs: { RouterLink: true } },
  });
  await flushPromises();
  return map;
}

const tick = (map: VueWrapper, id: string) => map.get(`[data-testid="attendance-map-${id}"]`);
const ticked = (map: VueWrapper, id: string) => (tick(map, id).element as HTMLInputElement).checked;
const image = (map: VueWrapper) => map.find('[data-testid="layout-map-image"]');

async function untick(map: VueWrapper, id: string) {
  await tick(map, id).setValue(false);
  await nextTick();
}

describe("the attendance map's floorplan choices", () => {
  it('are three ticks in a group named Floorplan, under the legend, all ticked on a first visit', async () => {
    const map = await aMap();
    const group = map.get('[data-testid="attendance-map-floorplan"]');
    expect(group.attributes()).toMatchObject({ role: 'group', 'aria-label': 'Floorplan' });
    expect(group.findAll('label').map((label) => label.text())).toEqual([
      'Show the floorplan',
      'Greyscale',
      'Faded',
    ]);
    expect(['show-image', 'image-grey', 'image-faded'].map((id) => ticked(map, id))).toEqual([
      true,
      true,
      true,
    ]);
    const legend = map.get('[data-testid="day-map-legend"]').element;
    expect(
      legend.compareDocumentPosition(group.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Ticked, the image is drawn in grey and at half strength, as the map draws it today.
    expect(image(map).classes()).not.toContain('layout-map__image--colour');
    expect(image(map).attributes('opacity')).toBe('0.5');
  });

  it('draws no image unticked Show, and disables the other two', async () => {
    const map = await aMap();
    await untick(map, 'show-image');
    expect(image(map).exists()).toBe(false);
    expect(tick(map, 'image-grey').attributes()).toHaveProperty('disabled');
    expect(tick(map, 'image-faded').attributes()).toHaveProperty('disabled');
    expect(map.findAll('[data-testid="layout-table"]')).toHaveLength(1);
  });

  it('draws the image in its colours unticked Greyscale, and at full strength unticked Faded', async () => {
    const map = await aMap();
    await untick(map, 'image-grey');
    expect(image(map).classes()).toContain('layout-map__image--colour');
    expect(image(map).attributes('opacity')).toBe('0.5');

    await untick(map, 'image-faded');
    expect(image(map).classes()).toContain('layout-map__image--colour');
    expect(image(map).attributes('opacity')).toBeUndefined();
  });

  it("keeps each choice under the Layout page's own name, and reads it back", async () => {
    const first = await aMap();
    await untick(first, 'image-faded');
    expect(localStorage.getItem(choiceKey('imageFaded'))).toBe('0');
    expect(choiceKey('imageFaded')).toBe('conventioner.layout.imageFaded');
    first.unmount();

    localStorage.setItem('conventioner.layout.showImage', '0');
    const second = await aMap();
    expect(ticked(second, 'image-faded')).toBe(false);
    expect(ticked(second, 'show-image')).toBe(false);
    expect(ticked(second, 'image-grey')).toBe(true);
    expect(image(second).exists()).toBe(false);
  });

  it('holds a choice for the page where the browser keeps nothing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'SecurityError');
    });
    const map = await aMap();
    expect(ticked(map, 'image-grey')).toBe(true);
    await untick(map, 'image-grey');
    expect(ticked(map, 'image-grey')).toBe(false);
    expect(image(map).classes()).toContain('layout-map__image--colour');
  });

  it("shows only when the open location's layout has an image", async () => {
    const map = await aMap();
    expect(map.find('[data-testid="attendance-map-floorplan"]').exists()).toBe(true);
    route.query = { location: SOUTH.id };
    await nextTick();
    expect(map.find('[data-testid="attendance-map-floorplan"]').exists()).toBe(false);
  });
});

describe('the day map given no floorplan choice', () => {
  it("draws the image as before: shown, grey and faded, as LayoutMap's own defaults", () => {
    const location = {
      ...NORTH,
      layout: floorplan('fp-north', NORTH.id, 'img-north', 'north-1'),
      sections: [],
      imageUrl: 'blob:north',
    };
    const props = {
      locations: [location],
      tableTypes: [{ id: 'type-6ft', name: 'Standard 6 ft', widthMm: 1830, depthMm: 760 }],
      seats: [],
      picked: null,
      legend: [],
      locationId: NORTH.id,
    };
    const plain = mount(DayMap, { props } as never);
    const told = mount(DayMap, {
      props: { ...props, showImage: true, imageInGrey: true, imageFaded: true },
    } as never);
    const drawn = (wrapper: VueWrapper) => wrapper.get('[data-testid="layout-map-image"]');
    expect(drawn(plain).classes()).not.toContain('layout-map__image--colour');
    expect(drawn(plain).attributes('opacity')).toBe('0.5');
    expect(drawn(plain).html()).toBe(drawn(told).html());

    const original = mount(DayMap, {
      props: { ...props, imageInGrey: false, imageFaded: false },
    } as never);
    expect(drawn(original).classes()).toContain('layout-map__image--colour');
    expect(drawn(original).attributes('opacity')).toBeUndefined();
  });
});
