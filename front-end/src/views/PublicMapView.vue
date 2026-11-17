<script setup lang="ts">
/**
 * A market's public map, at `/<market-slug>/map` (T422, D31 to D35): anyone, with no sign-in, picks
 * a market day and a location, presses a table or finds a vendor by name, and reads the public
 * name, website and Instagram the organizer chose to publish, and nothing else of them (D26).
 *
 * It reads the map before drawing anything, so a slug is never printed back before the server has
 * said there is a map here. A market whose map is not open answers as a slug naming nothing, and
 * reads "Page not found", the bar falling back as on the vendor page; a request that never answered
 * is neither, and says so with "Try again".
 *
 * The day, the open location and the picked table live in the address (`date`, `location`,
 * `table`), each changed with `router.replace`, so a link or a QR code opens one table on one day;
 * a value the map does not know falls back to the default without an error. The floorplan image
 * is read through the API client as bytes and drawn from an object URL, since the
 * Content-Security-Policy draws images only from the app and from blobs.
 *
 * Nothing a vendor typed is rendered as markup: their three answers, cleaned by the server, are
 * text, and a link is built from them only as an `http`/`https` address or an Instagram handle.
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import DayMap from '@/components/daymap/DayMap.vue';
import ListFrame from '@/components/ListFrame.vue';
import PageNotFound from '@/components/PageNotFound.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import ScrollBox from '@/components/ScrollBox.vue';
import { layoutSections, paintValue } from '@/components/layout/layoutDrawing';
import {
  publicDayLocations,
  publicSeats,
  type DayMapLegendItem,
  type PublicMapAnswer,
} from '@/components/daymap/dayMap';
import { vendorPageAnswered } from '@/utils/currentPlace';
import { calendarToday } from '@/utils/marketGuide';
import {
  DETAILS_NOT_LISTED,
  MAP_COULD_NOT_LOAD,
  NO_VENDORS_LISTED,
  dayInWords,
  fetchPublicMap,
  fetchPublicMapImage,
  freeHalfOn,
  freeTableOn,
  instagramLink,
  mapListing,
  mapPlace,
  tableCard,
  websiteLink,
  type ListedVendor,
  type MapPlace,
} from '@/utils/publicMap';

const route = useRoute();
const router = useRouter();

const marketSlug = computed(() => String(route.params.marketSlug ?? ''));

/** The page has left: nothing read after it is kept. */
let gone = false;

type State = 'loading' | 'not-found' | 'failed' | 'ready';
const state = ref<State>('loading');
const map = ref<PublicMapAnswer | null>(null);

// A "Page not found" here is no vendor's page, so the app bar keeps an organizer's way about on it,
// as on the vendor page: told by the slug the page answered for, kept, since by the page's unmount
// the route is already the next page's.
let answeredFor = marketSlug.value;
watch(state, (now) => {
  answeredFor = marketSlug.value;
  vendorPageAnswered(answeredFor, now === 'not-found');
});

// The browser's title names the market's map while it is open, and is given back on leaving.
const titleBefore = document.title;
watch(map, (now) => {
  document.title = now ? `${now.marketName} map` : titleBefore;
});

/** Each read is numbered, so one answering after the address moved to another market is dropped. */
let reads = 0;

async function load() {
  const read = ++reads;
  state.value = 'loading';
  const answer = await fetchPublicMap(marketSlug.value);
  if (read !== reads || gone) return;
  map.value = answer.map;
  state.value = answer.notFound ? 'not-found' : answer.failed ? 'failed' : 'ready';
}
void load();

const today = calendarToday();

const place = computed<MapPlace>(() =>
  map.value ? mapPlace(map.value, route.query, today) : { date: '', locationId: '', tableId: null },
);

/** Write the place to the address, replacing it, every other key of the query kept. */
function goTo(next: MapPlace) {
  const rest = Object.fromEntries(
    Object.entries(route.query).filter(([key]) => !['date', 'location', 'table'].includes(key)),
  );
  void router.replace({
    query: {
      ...rest,
      date: next.date,
      location: next.locationId,
      ...(next.tableId ? { table: next.tableId } : {}),
    },
  });
}

function chooseDay(date: string) {
  goTo({ ...place.value, date });
}

function chooseLocation(locationId: string) {
  const location = map.value?.locations.find((l) => l.id === locationId);
  const keeps = location?.layout.tables.some((t) => t.id === place.value.tableId);
  goTo({ ...place.value, locationId, tableId: keeps ? place.value.tableId : null });
}

/* Prototype (release walk F6): the backdrop, waves and lumps in the market's own section colours,
   however many sections it has: each colour takes a run of the shapes, and a market with more
   colours than shapes gets a lump for each colour over. Blurred whole by CSS, they blend. */
/** Prototype (release walk F6): the backdrop's shapes, four broad wavy ribbons sweeping down across
 *  the window, from the top left to the bottom right, so a colour's run of them holds a band. */
const BACKDROP_SHAPES: { d: string; opacity: number }[] = [
  {
    d: 'M-200 -100 C 200 100, 500 -50, 900 150 C 1200 300, 1400 200, 1700 350 L 1700 560 C 1400 410, 1200 510, 900 360 C 500 160, 200 310, -200 110 Z',
    opacity: 0.85,
  },
  {
    d: 'M-200 150 C 200 350, 500 200, 900 400 C 1200 550, 1400 450, 1700 600 L 1700 810 C 1400 660, 1200 760, 900 610 C 500 410, 200 560, -200 360 Z',
    opacity: 0.8,
  },
  {
    d: 'M-200 400 C 200 600, 500 450, 900 650 C 1200 800, 1400 700, 1700 850 L 1700 1060 C 1400 910, 1200 1010, 900 860 C 500 660, 200 810, -200 610 Z',
    opacity: 0.8,
  },
  {
    d: 'M-200 650 C 200 850, 500 700, 900 900 C 1200 1050, 1400 950, 1700 1100 L 1700 1310 C 1400 1160, 1200 1260, 900 1110 C 500 910, 200 1060, -200 860 Z',
    opacity: 0.85,
  },
];

/** The market's section colours, each once, in the order its halls draw them. */
const sectionColours = computed(() => {
  const seen = new Set<string>();
  for (const location of locations.value) {
    for (const { paint, tables } of layoutSections(location.layout, location.sections)) {
      // The section's light fill, as its tags wear it, with a breath of its edge, mixed in OKLCH,
      // which keeps the colour clear: light and airy, never darker than the tags.
      if (tables.length) {
        seen.add(`color-mix(in oklch, ${paintValue(paint.edge)} 12%, ${paintValue(paint.fill)})`);
      }
    }
  }
  return seen.size ? [...seen] : ['var(--mm-green)'];
});

const backdrop = computed(() => {
  const colours = sectionColours.value;
  // The shapes run from the top left to the bottom right, and each colour takes a run of them, so
  // a colour holds a region of its own and two colours meet along a band, not greyed all over.
  const set = BACKDROP_SHAPES;
  const shapes = set.map((shape, index) => ({
    ...shape,
    colour: colours[Math.floor((index * colours.length) / set.length) % colours.length]!,
  }));
  // A colour no shape reached gets a lump of its own, spread along the window's middle band.
  for (let index = set.length; index < colours.length; index++) {
    const x = 120 + (((index - set.length) * 520) % 1200);
    const y = 260 + ((index * 170) % 380);
    shapes.push({
      d: `M${x} ${y} c 120 -60, 260 0, 240 110 c -20 110, -170 110, -240 50 c -70 -60, -90 -120, 0 -160 Z`,
      opacity: 0.75,
      colour: colours[index]!,
    });
  }
  return shapes;
});

/* Prototype (release walk F6): the page never scrolls, so the window keeps no gutter for a bar
   the page will never show, and the background reaches the window's right edge. */
const gutterBefore = document.documentElement.style.scrollbarGutter;
document.documentElement.style.scrollbarGutter = 'auto';
onUnmounted(() => {
  document.documentElement.style.scrollbarGutter = gutterBefore;
});

/** Prototype (release walk F6): whether the vendors have scrolled under the find field, which alone
 *  draws the field's fade, so the first vendor's ring shows whole before any scroll. */
const listScrolled = ref(false);
function onListScroll(event: Event) {
  const scroller = event.target as HTMLElement;
  if (scroller.dataset.testid === 'public-map-scroll') listScrolled.value = scroller.scrollTop > 0;
}

/** Prototype (release walk F6): a market day as the dropdown says it, "Nov 19". */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
function monthDay(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${MONTH_NAMES[Number(match[1]) - 1]} ${Number(match[2])}` : date;
}

/** Prototype (release walk F6): the seat pressed, so a half table's half is picked alone. */
const pickedSeat = ref<string | null>(null);

function pick(tableId: string, seatKey: string | null = null) {
  pickedSeat.value = seatKey;
  goTo({ ...place.value, tableId });
}

// ── The floorplan images, one object URL per location, read as each location opens ──
const imageUrls = reactive<Record<string, string>>({});
const asked = new Set<string>();

watch(
  () => [map.value, place.value.locationId] as const,
  async ([answer, locationId]) => {
    const location = answer?.locations.find((l) => l.id === locationId);
    if (!location?.layout.hasImage || asked.has(locationId)) return;
    asked.add(locationId);
    const slug = marketSlug.value;
    try {
      const blob = await fetchPublicMapImage(slug, locationId);
      if (gone || slug !== marketSlug.value) return;
      imageUrls[locationId] = URL.createObjectURL(blob);
    } catch {
      // Drawn on the floor's colour alone: the tables still say where everyone is.
      asked.delete(locationId);
    }
  },
  { immediate: true },
);

/** Forget one market's images, as the page leaves it. */
function forgetImages() {
  for (const url of Object.values(imageUrls)) URL.revokeObjectURL(url);
  for (const id of Object.keys(imageUrls)) delete imageUrls[id];
  asked.clear();
}

// The app's one RouterView is unkeyed, so an in-app move to another market's map keeps this page:
// it reads that market's map afresh, its images with it. A move off the page reads nothing.
watch(marketSlug, (now, before) => {
  if (now === before || route.name !== 'public-map') return;
  forgetImages();
  map.value = null;
  void load();
});

onUnmounted(() => {
  gone = true;
  vendorPageAnswered(answeredFor, false);
  document.title = titleBefore;
  forgetImages();
});

const locations = computed(() =>
  map.value ? publicDayLocations(map.value, (id) => imageUrls[id] ?? '') : [],
);
const seats = computed(() => (map.value ? publicSeats(map.value.seats, place.value.date) : []));
const LEGEND: DayMapLegendItem[] = [
  { tone: 'filled', label: 'Taken' },
  { tone: 'free', label: 'Free' },
];

const day = computed(() => dayInWords(place.value.date));
const card = computed(() =>
  map.value && place.value.tableId
    ? tableCard(map.value, place.value.date, place.value.tableId)
    : null,
);
const HALF_NAMES = { left: 'Left half', right: 'Right half' } as const;

const listed = computed(() => (map.value ? mapListing(map.value, place.value.date) : []));
const finds = (vendor: ListedVendor, words: string) =>
  vendor.name.toLowerCase().includes(words.toLowerCase());

const mapBox = ref<HTMLElement>();

// ── Prototype (release walk F6): the picked table's speech bubble, the section key ──

/** Each laid-out table's section paint, by table id, for the code pills and the key. */
const tablePaint = computed(() => {
  const out = new Map<string, { fill: string; edge: string }>();
  for (const location of locations.value) {
    for (const { paint, tables } of layoutSections(location.layout, location.sections)) {
      for (const table of tables)
        out.set(table.id, { fill: paintValue(paint.fill), edge: paintValue(paint.edge) });
    }
  }
  return out;
});

function codeStyle(tableId: string | null) {
  const paint = tableId ? tablePaint.value.get(tableId) : undefined;
  return paint ? { background: paint.fill, borderColor: paint.edge } : undefined;
}

const openLocation = computed(
  () => locations.value.find((l) => l.id === place.value.locationId) ?? locations.value[0],
);
const hallName = computed(() => openLocation.value?.name ?? '');

/** The open hall's sections, in its colours, as the map draws them. */
const sectionKey = computed(() =>
  openLocation.value
    ? layoutSections(openLocation.value.layout, openLocation.value.sections)
        .filter(({ tables }) => tables.length)
        .map(({ section, paint }) => ({
          name: section.name,
          style: { background: paintValue(paint.fill), borderColor: paintValue(paint.edge) },
        }))
    : [],
);

/** Whether a table of the open hall has nobody at it on the day. */
const hasFree = computed(() => {
  const location = openLocation.value;
  if (!location) return false;
  const taken = new Set(seats.value.map((seat) => seat.tableId));
  return layoutSections(location.layout, location.sections).some(({ tables }) =>
    tables.some((table) => !taken.has(table.id)),
  );
});

type Bubble = { left: number; top: number; tailX: number; vert: 'up' | 'down'; shown: boolean };
const bubble = ref<Bubble | null>(null);
const bubbleEl = ref<HTMLElement>();
const GAP = 8;
const TAIL = 12;
let frame = 0;

/** The picked seat when it is on the picked table, else none. */
const seatHere = computed(() =>
  seats.value.find((seat) => seat.key === pickedSeat.value && seat.tableId === place.value.tableId),
);
/** What the map outlines: the picked half, or the whole table. */
const markedPick = computed(() => seatHere.value?.key ?? place.value.tableId);
/** The card's parts: a picked half's alone, or the whole table's. */
const shownParts = computed(() => {
  const parts = card.value?.halves ?? [];
  const half = seatHere.value?.half;
  return half && half !== 'whole' ? parts.filter((part) => part.side === half) : parts;
});

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** Hold the bubble on its table (or half) as the map pans and zooms: above it and to its right by
 *  default; to its left near the map's right edge; under it near the top; always inside the map,
 *  the tail sliding along the bubble's edge to stay on the table. */
function placeBubble() {
  const box = mapBox.value;
  const id = place.value.tableId;
  const table = box && id ? box.querySelector(`[data-table-id="${CSS.escape(id)}"]`) : null;
  if (!box || !table) {
    bubble.value = null;
    return;
  }
  const key = seatHere.value?.key;
  const target = (key && table.querySelector(`[data-seat-key="${CSS.escape(key)}"]`)) || table;
  const area = box.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  const width = bubbleEl.value?.offsetWidth ?? 288;
  const height = bubbleEl.value?.offsetHeight ?? 150;
  const x = at.left + at.width / 2 - area.left;
  const above = at.top - area.top;
  const below = at.bottom - area.top;
  const roomUp = above - GAP - TAIL;
  const roomDown = area.height - below - GAP - TAIL;
  const vert = roomUp >= height || roomUp >= roomDown ? 'up' : 'down';
  const right = x - 28;
  const left = right + width > area.width - GAP ? x - width + 28 : right;
  const boxLeft = clamp(left, GAP, area.width - width - GAP);
  const boxTop = clamp(
    vert === 'up' ? above - TAIL - height : below + TAIL,
    GAP,
    area.height - height - GAP,
  );
  const shown =
    at.right > area.left && at.left < area.right && at.bottom > area.top && at.top < area.bottom;
  bubble.value = {
    left: boxLeft,
    top: boxTop,
    tailX: clamp(x - boxLeft, 20, width - 20),
    vert,
    shown,
  };
}

function follow() {
  placeBubble();
  frame = requestAnimationFrame(follow);
}

watch(
  () => place.value.tableId,
  (id) => {
    cancelAnimationFrame(frame);
    if (id) frame = requestAnimationFrame(follow);
    else bubble.value = null;
  },
  { immediate: true },
);

function closeBubble() {
  goTo({ ...place.value, tableId: null });
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && place.value.tableId) closeBubble();
}
window.addEventListener('keydown', onKey);
onUnmounted(() => {
  cancelAnimationFrame(frame);
  window.removeEventListener('keydown', onKey);
});

/** A vendor of the list: their location opened, their table picked, and the map in view. */
function openVendor(vendor: ListedVendor) {
  pickedSeat.value = vendor.key;
  goTo({ ...place.value, locationId: vendor.locationId, tableId: vendor.tableId });
  mapBox.value?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <div v-if="state === 'not-found'" data-testid="public-map-not-found">
    <PageNotFound />
  </div>
  <div v-else class="public-map" data-testid="public-map">
    <p v-if="state === 'loading'" class="public-map__loading" data-testid="public-map-loading">
      Loading…
    </p>

    <template v-else-if="state === 'failed'">
      <h1 class="public-map__title">Map</h1>
      <ReadFailed name="public-map" :message="MAP_COULD_NOT_LOAD" @retry="load" />
    </template>

    <template v-else-if="map">
      <svg
        class="public-map__backdrop"
        viewBox="0 0 1440 900"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect width="1440" height="900" class="public-map__backdrop-paper" />
        <path
          v-for="(shape, index) in backdrop"
          :key="index"
          :d="shape.d"
          :style="{ fill: shape.colour, opacity: shape.opacity }"
        />
      </svg>

      <div class="public-map__body">
        <div class="public-map__map" data-testid="public-map-map">
          <div class="public-map__bar">
            <header class="public-map__head">
              <div class="public-map__words">
                <h1 class="public-map__title" data-testid="public-map-heading">
                  {{ map.marketName }}
                </h1>
                <p class="public-map__subtitle" data-testid="public-map-subtitle">
                  <svg class="public-map__subtitle-icon" viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 1.5 Q8.6 7.4 14.5 8 Q8.6 8.6 8 14.5 Q7.4 8.6 1.5 8 Q7.4 7.4 8 1.5 Z"
                    />
                  </svg>
                  Vendor map
                </p>
              </div>
            </header>
            <div class="public-map__pickers">
              <label class="public-map__picker">
                <span class="visually-hidden">Market day</span>
                <select
                  class="field field--select public-map__select"
                  name="public-map-day"
                  :value="place.date"
                  data-testid="public-map-day-select"
                  @change="chooseDay(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="date in map.dates" :key="date" :value="date">
                    {{ monthDay(date) }}
                  </option>
                </select>
              </label>
              <label v-if="locations.length > 1" class="public-map__picker">
                <span class="visually-hidden">Location</span>
                <select
                  class="field field--select public-map__select"
                  name="public-map-location"
                  :value="place.locationId"
                  data-testid="public-map-location-select"
                  @change="chooseLocation(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="location in locations" :key="location.id" :value="location.id">
                    {{ location.name }}
                  </option>
                </select>
              </label>
            </div>
          </div>
          <div ref="mapBox" class="public-map__hall">
            <DayMap
              :locations="locations"
              :tableTypes="map.tableTypes"
              :locationId="place.locationId"
              :seats="seats"
              :picked="markedPick"
              :legend="LEGEND"
              @update:locationId="chooseLocation"
              @pick="pick"
            />
            <div
              v-if="card && bubble"
              ref="bubbleEl"
              class="public-map__bubble"
              :class="`public-map__bubble--${bubble.vert}`"
              :style="{
                left: `${bubble.left}px`,
                top: `${bubble.top}px`,
                '--tail-x': `${bubble.tailX}px`,
                visibility: bubble.shown ? 'visible' : 'hidden',
              }"
              role="dialog"
              :aria-label="`Table ${card.code}`"
              aria-live="polite"
              data-testid="public-map-card"
              @pointerdown.stop
              @wheel.stop
            >
              <button
                type="button"
                class="public-map__bubble-close"
                aria-label="Close"
                data-testid="public-map-card-close"
                @click="closeBubble"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M3 3 L13 13 M13 3 L3 13"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <p class="public-map__bubble-eyebrow">
                <span class="public-map__code" :style="codeStyle(place.tableId)">{{
                  card.code
                }}</span>
                <span>{{ hallName }}</span>
              </p>

              <div
                v-for="part in shownParts"
                :key="part.side"
                class="public-map__part"
                :data-testid="
                  part.side === 'whole' ? 'public-map-card-whole' : 'public-map-card-half'
                "
              >
                <h3 v-if="part.side !== 'whole'" class="public-map__half">
                  {{ HALF_NAMES[part.side] }}
                </h3>
                <p v-if="!part.seat" class="public-map__note">
                  {{ part.side === 'whole' ? freeTableOn(day) : freeHalfOn(day) }}
                </p>
                <p v-else-if="!part.seat.name" class="public-map__note">
                  {{ DETAILS_NOT_LISTED }}
                </p>
                <template v-else>
                  <p class="public-map__name" data-testid="public-map-card-name">
                    {{ part.seat.name }}
                  </p>
                  <dl
                    v-if="websiteLink(part.seat.website) || instagramLink(part.seat.instagram)"
                    class="public-map__links"
                  >
                    <template v-if="websiteLink(part.seat.website)">
                      <dt>Website</dt>
                      <dd>
                        <a
                          :href="websiteLink(part.seat.website)!.href"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="public-map__link"
                          data-testid="public-map-card-website"
                          >{{ websiteLink(part.seat.website)!.text }}</a
                        >
                      </dd>
                    </template>
                    <template v-if="instagramLink(part.seat.instagram)">
                      <dt>Instagram</dt>
                      <dd>
                        <a
                          :href="instagramLink(part.seat.instagram)!.href"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="public-map__link"
                          data-testid="public-map-card-instagram"
                          >{{ instagramLink(part.seat.instagram)!.text }}</a
                        >
                      </dd>
                    </template>
                  </dl>
                </template>
              </div>
            </div>

            <ul class="public-map__legend" aria-label="Legend" data-testid="public-map-legend">
              <li v-for="item in sectionKey" :key="item.name">
                <span class="public-map__swatch" :style="item.style" aria-hidden="true"></span>
                Section {{ item.name }}
              </li>
              <li v-if="hasFree">
                <span class="public-map__swatch public-map__swatch--free" aria-hidden="true"></span>
                Free table
              </li>
            </ul>
          </div>
        </div>

        <aside
          class="public-map__side"
          :class="{ 'public-map__side--scrolled': listScrolled }"
          aria-label="Vendors"
          @scroll.capture="onListScroll"
        >
          <ScrollBox class="public-map__scroll" fieldsLeaveTheStop testid="public-map-scroll">
            <ListFrame
              :items="listed"
              :pageSize="1000"
              :finds="finds"
              :findFrom="0"
              findKey="find"
              findLabel="Find a vendor"
              :filterKey="place.date"
              :itemKey="(vendor) => vendor.key"
              :noun="{ one: 'vendor', many: 'vendors' }"
              testid="public-map-vendors"
            >
              <template #row="{ item }">
                <button
                  type="button"
                  class="public-map__vendor"
                  :aria-current="item.tableId === place.tableId ? 'true' : undefined"
                  data-testid="public-map-vendor"
                  @click="openVendor(item)"
                >
                  <span
                    class="public-map__code"
                    :style="codeStyle(item.tableId)"
                    aria-hidden="true"
                    >{{ item.code }}</span
                  >
                  <span class="public-map__vendor-words">
                    <span class="public-map__vendor-name">{{ item.name }}</span>
                    <span class="public-map__vendor-seat"
                      ><span class="visually-hidden">Table {{ item.code }}, </span
                      >{{ item.locationName }}</span
                    >
                  </span>
                </button>
              </template>
              <template #empty>
                <p>{{ NO_VENDORS_LISTED }}</p>
              </template>
            </ListFrame>
          </ScrollBox>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── Prototype (release walk F6): the public map, designed for visitors ──
   The page fills the window under the app bar and never scrolls; only the vendor list does. Behind
   it a light, blurred backdrop of ribbons in the market's own section colours. In front, one sheet:
   the map on the left, with the market's name over it and the day and hall at its top right, and
   the vendors on the right, as tall as the map. A picked table speaks in a bubble from the map. */
.public-map {
  --pm-paper: #fbfaf8;
  --pm-line: rgb(39 35 35 / 16%);
  --pm-soft-shadow: 0 1px 2px rgb(39 35 35 / 6%), 0 8px 24px rgb(39 35 35 / 8%);

  position: relative;
  /* The window's height under the app bar, not the shell's `flex: 1`, which grows with the list. */
  flex: none;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--workspace-max);
  height: calc(100dvh - var(--banner-h));
  margin: 0 auto;
  padding: var(--space-4) var(--space-4) var(--space-6);
  overflow: hidden;
  color: var(--mm-black);
  background: var(--pm-paper);
  /* The paper and the backdrop reach the window's edges, though the column keeps its width. */
  box-shadow: 0 0 0 100vmax var(--pm-paper);
  clip-path: inset(0 -100vmax);
}

.public-map__loading {
  margin: 0;
  padding: var(--space-12);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

/* ── The backdrop: ribbons in the section colours the script deals, blurred into one another; the
   layer is fixed to the window under the app bar, a tenth of it past each edge, so the blur never
   fades at an edge. ── */
.public-map__backdrop {
  position: fixed;
  top: calc(var(--banner-h) - 10vh);
  left: -10vw;
  z-index: 0;
  width: 120vw;
  height: calc(120vh - var(--banner-h));
  pointer-events: none;
  filter: blur(80px);
}

.public-map__backdrop-paper {
  fill: var(--pm-paper);
}

/* ── The sheet: the map and the vendors side by side at a desk, the map over them on a phone. ── */
.public-map__body {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 3fr) minmax(0, 2fr);
  overflow: hidden;
  border: 1px solid var(--pm-line);
  border-radius: 22px;
  background: white;
  box-shadow: var(--pm-soft-shadow);
}

@media (width >= 1000px) {
  .public-map__body {
    grid-template-columns: minmax(0, 1fr) 21rem;
    grid-template-rows: minmax(0, 1fr);
  }
}

/* ── The map's side: the title bar, then the hall, which the bubble and the legend keep to. ── */
.public-map__map {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--layout-floor);
}

/* As far in from the sheet's edge as its rounded corner, room under "vendor map" for the hall's wall,
   and the dropdowns' width kept clear at the end, so the name wraps short of them. */
.public-map__bar {
  flex: none;
  padding: var(--space-6) calc(var(--space-3) + 17rem) var(--space-4) var(--space-6);
}

.public-map__words {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

/* The name in bold Outfit over a honey stroke, drawn as a thick underline behind the letters so it
   follows each line's words. */
.public-map__title {
  margin: 0;
  font-family: 'Outfit', sans-serif;
  font-size: 1.875rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--mm-black);
  overflow-wrap: anywhere;
  text-decoration: underline;
  text-decoration-color: var(--layout-section-1-fill);
  text-decoration-thickness: 0.4em;
  text-underline-offset: -0.22em;
  text-decoration-skip-ink: none;
}

/* "vendor map" in Merge One, led by a teal sparkle. */
.public-map__subtitle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: 1.25rem;
  line-height: 1.3;
  letter-spacing: 0.01em;
  text-transform: lowercase;
  color: var(--mm-text-muted-on-beige);
}

.public-map__subtitle-icon {
  flex: none;
  width: 18px;
  height: 18px;
  fill: none;
  stroke: var(--layout-section-4-edge);
  stroke-width: 1.5;
  stroke-linejoin: round;
  /* The words are all lower case, so their middle is the x-height's, a little under the line's:
     the star sits on that middle. */
  transform: translateY(0.06em);
}

/* The day and the hall at the map's top right corner, as far in from its edges as the zoom and
   the legend are from theirs. */
.public-map__pickers {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.public-map__select {
  width: auto;
  min-width: 7.5rem;
  height: 38px;
  padding-inline-start: var(--space-4);
  border: 1px solid var(--pm-line);
  border-radius: var(--radius-pill);
  background-color: white;
  box-shadow: var(--pm-soft-shadow);
  font-size: var(--text-sm);
}

.public-map__select:hover {
  border-color: var(--layout-section-1-edge);
}

.public-map__hall {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

/* The map fills the hall, whatever the hall's shape; its own hall buttons and legend give way to the
   page's dropdown and legend. */
.public-map__map :deep(.day-map),
.public-map__map :deep(.day-map__grid) {
  height: 100%;
}

.public-map__map :deep(.day-map__grid) {
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'map map';
  gap: 0;
}

.public-map__map :deep(.day-map__frame) {
  /* The hall's shape is the map's to fit inside the pane, not the pane's to take. */
  aspect-ratio: auto !important;
  height: 100%;
  max-height: none;
  border: none;
  border-radius: 0;
  background: transparent;
}

.public-map__map :deep(.day-map__locations),
.public-map__map :deep(.day-map__legend) {
  display: none;
}

.public-map__map :deep(.day-map__zoom) {
  grid-area: map;
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: 1;
  padding: 4px;
  border: 1px solid var(--pm-line);
  border-radius: var(--radius-pill);
  background: white;
  box-shadow: var(--pm-soft-shadow);
}

.public-map__map :deep(.day-map__zoom-button) {
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
}

.public-map__map :deep(.day-map__zoom-button:hover) {
  background: var(--layout-floor);
}

/* The legend: the open hall's sections in their own colours, and "Free table" on a day with one. */
.public-map__legend {
  position: absolute;
  bottom: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  max-width: calc(100% - 10rem);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--pm-line);
  border-radius: var(--radius-pill);
  background: white;
  box-shadow: var(--pm-soft-shadow);
  list-style: none;
  font-size: var(--text-xs);
}

.public-map__legend li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.public-map__swatch {
  width: 14px;
  height: 14px;
  border: 1.5px solid;
  border-radius: 4px;
}

.public-map__swatch--free {
  border: 1.5px dashed var(--layout-no-section-edge);
  background: var(--layout-floor);
}

/* ── The speech bubble: anchored on the picked table (the script places it, inside the hall),
   its tail on the table at the bubble's edge nearest it. ── */
.public-map__bubble {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(18rem, calc(100% - 2 * var(--space-3)));
  padding: var(--space-4);
  border: 1px solid var(--pm-line);
  border-radius: 18px;
  background: white;
  box-shadow: var(--pm-soft-shadow);
  overflow-wrap: anywhere;
  animation: public-map-pop 160ms ease-out;
}

.public-map__bubble::after {
  content: '';
  position: absolute;
  left: calc(var(--tail-x) - 7px);
  width: 14px;
  height: 14px;
  background: white;
  border: 1px solid var(--pm-line);
  border-top-color: transparent;
  border-left-color: transparent;
}

.public-map__bubble--up::after {
  bottom: -8px;
  transform: rotate(45deg);
}

.public-map__bubble--down::after {
  top: -8px;
  transform: rotate(-135deg);
}

@keyframes public-map-pop {
  from {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-map__bubble {
    animation: none;
  }
}

.public-map__bubble-close {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--mm-text-muted);
  cursor: pointer;
}

.public-map__bubble-close:hover {
  background: var(--layout-floor);
  color: var(--mm-black);
}

.public-map__bubble-eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding-inline-end: var(--space-6);
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.public-map__part {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.public-map__half {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mm-text-muted);
}

.public-map__note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map__name {
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-lg);
  line-height: 1.2;
}

/* The website and the Instagram as soft pills, their labels for a screen reader alone: the
   address and the handle say which is which. */
.public-map__links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
}

.public-map__links dt {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.public-map__links dd {
  margin: 0;
  min-width: 0;
}

.public-map__link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--pm-line);
  border-radius: var(--radius-pill);
  color: var(--mm-black);
  font-size: var(--text-xs);
  text-decoration: none;
}

.public-map__link:hover {
  border-color: var(--layout-section-4-edge);
  background: var(--layout-section-4-fill);
}

/* ── The vendors' side: the find field held at its top, the vendors scrolling under it. ── */
.public-map__side {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-block-start: 1px solid var(--pm-line);
}

@media (width >= 1000px) {
  .public-map__side {
    border-block-start: none;
    border-inline-start: 1px solid var(--pm-line);
  }
}

.public-map__scroll {
  flex: 1 1 auto;
  min-height: 0;
}

.public-map__side :deep(.list-frame) {
  padding: 0 var(--space-4) var(--space-4);
}

.public-map__side :deep(.list-frame__tools) {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-block: var(--space-4) var(--space-2);
  background: white;
}

/* The vendors blur and fade out as they scroll up under the find field, once they have scrolled. */
.public-map__side--scrolled :deep(.list-frame__tools)::after {
  content: '';
  position: absolute;
  inset-inline: 0;
  top: 100%;
  height: 2rem;
  pointer-events: none;
  background: linear-gradient(to bottom, white, rgb(255 255 255 / 0%));
  backdrop-filter: blur(3px);
  mask-image: linear-gradient(to bottom, black, transparent);
}

/* The field's fade stands for the box's own top shade, which would lie over the field. */
.public-map__side :deep(.scroll-box__shade--top) {
  display: none;
}

/* No count of vendors on screen; a screen reader still hears how many a search finds. */
.public-map__side :deep(.list-frame__words[role='status']) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.public-map__side :deep(.list-frame__tools .field-label) {
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-md);
  color: var(--mm-black);
}

.public-map__side :deep(.list-frame__tools .field) {
  border: 1px solid var(--pm-line);
  border-radius: var(--radius-pill);
  background: white;
  padding-inline: var(--space-4);
}

.public-map__side :deep(.list-frame__rows > li + li) {
  border-block-start: 1px solid var(--layout-floor);
}

/* A vendor: their table's code, then their name over their hall, the whole row the button; the
   picked vendor ringed in mustard. */
.public-map__vendor {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--target-min);
  padding: var(--space-2);
  border: none;
  border-radius: 12px;
  background: none;
  color: var(--mm-black);
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.public-map__vendor:hover .public-map__vendor-name {
  text-decoration: underline;
  text-decoration-color: var(--mm-yellow);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.public-map__vendor[aria-current='true'] {
  box-shadow: inset 0 0 0 1.5px var(--mm-yellow);
}

.public-map__vendor-words {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  min-width: 0;
}

.public-map__vendor-name {
  font-weight: 600;
}

.public-map__vendor-seat {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

/* A table's code: a pill in its section's colours, as the map draws the table. */
.public-map__code {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  height: 1.5rem;
  padding-inline: var(--space-2);
  border: 1.5px solid var(--pm-line);
  border-radius: var(--radius-pill);
  background: var(--layout-floor);
  color: var(--mm-black);
  font-size: var(--text-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── A phone. ── */
@media (width < 1000px) {
  .public-map__legend {
    max-width: calc(100% - 9rem);
    border-radius: 14px;
  }
}

@media (width <= 640px) {
  .public-map {
    padding: var(--space-3) var(--space-3) var(--space-6);
  }

  /* No room beside the title, so the dropdowns keep the corner and the title starts under them. */
  .public-map__bar {
    padding: calc(var(--space-3) + 38px + var(--space-3)) var(--space-4) var(--space-3);
  }

  .public-map__title {
    font-size: 1.5625rem;
  }
}
</style>
