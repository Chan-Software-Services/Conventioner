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
  PICK_A_TABLE,
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
   however many sections it has: each shape takes the next colour in turn, and a market with more
   colours than shapes gets a lump for each colour over. Blurred whole by CSS, they blend. */
const BACKDROP_SHAPES = [
  {
    d: 'M-100 -100 H 1540 V 150 C 1320 230, 1180 70, 980 150 C 800 220, 700 60, 500 140 C 320 210, 160 90, -100 190 Z',
    opacity: 0.42,
  },
  {
    d: 'M-100 1000 V 700 C 140 620, 300 760, 480 700 C 660 640, 760 790, 960 730 C 1140 680, 1260 590, 1540 660 V 1000 Z',
    opacity: 0.42,
  },
  {
    d: 'M1040 -80 C 1300 -60, 1560 60, 1520 300 C 1480 480, 1260 420, 1160 330 C 1060 240, 900 180, 940 60 C 960 -10, 990 -80, 1040 -80 Z',
    opacity: 0.36,
  },
  {
    d: 'M-120 300 C 60 220, 260 300, 290 440 C 320 580, 170 660, 30 640 C -110 620, -230 400, -120 300 Z',
    opacity: 0.32,
  },
  {
    d: 'M1160 600 C 1320 540, 1520 620, 1500 780 C 1480 940, 1260 980, 1160 880 C 1070 790, 1040 660, 1160 600 Z',
    opacity: 0.32,
  },
  {
    d: 'M560 380 C 700 340, 860 400, 840 500 C 820 600, 660 600, 580 540 C 500 480, 460 410, 560 380 Z',
    opacity: 0.22,
  },
];

/** The market's section colours, each once, in the order its halls draw them. */
const sectionColours = computed(() => {
  const seen = new Set<string>();
  for (const location of locations.value) {
    for (const { paint, tables } of layoutSections(location.layout, location.sections)) {
      // Mostly the section's light fill with a touch of its edge, mixed in OKLCH, which keeps the
      // colour clear where OKLab greys it: light and bright, never the edge's brown.
      if (tables.length) {
        seen.add(`color-mix(in oklch, ${paintValue(paint.edge)} 22%, ${paintValue(paint.fill)})`);
      }
    }
  }
  return seen.size ? [...seen] : ['var(--mm-green)'];
});

const backdrop = computed(() => {
  const colours = sectionColours.value;
  const shapes = BACKDROP_SHAPES.map((shape, index) => ({
    ...shape,
    colour: colours[index % colours.length]!,
  }));
  // A colour no shape reached gets a lump of its own, spread along the window's middle band.
  for (let index = BACKDROP_SHAPES.length; index < colours.length; index++) {
    const x = 120 + (((index - BACKDROP_SHAPES.length) * 520) % 1200);
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
        class="public-map__doodles"
        viewBox="0 0 1440 900"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect width="1440" height="900" class="pm-bg__paper" />
        <path
          v-for="(shape, index) in backdrop"
          :key="index"
          :d="shape.d"
          :style="{ fill: shape.colour, opacity: shape.opacity }"
        />
      </svg>
      <header class="public-map__head">
        <div class="public-map__words">
          <h1 class="public-map__title" data-testid="public-map-heading">{{ map.marketName }}</h1>
          <p class="public-map__subtitle" data-testid="public-map-subtitle">
            <svg class="public-map__subtitle-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5 Q8.6 7.4 14.5 8 Q8.6 8.6 8 14.5 Q7.4 8.6 1.5 8 Q7.4 7.4 8 1.5 Z" />
            </svg>
            Vendor map
          </p>
        </div>
      </header>

      <div class="public-map__body">
        <div ref="mapBox" class="public-map__map" data-testid="public-map-map">
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

        <aside class="public-map__side" aria-label="Vendors">
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
   A quiet header, the market's name and the days; under it one viewer: the map large on the left,
   the hall tabs and the legend floating on it, and beside it a panel as tall as the map, the
   picked table on top and the vendors under it. The page fills the window and never scrolls; only
   the vendor list scrolls, inside the panel. */
/* The page's column: the workspace's width at most, on the app bar's own inset. */
.public-map {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--workspace-max);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-8);
  color: var(--mm-black);
}

.public-map__loading {
  margin: 0;
  padding: var(--space-12);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map__title {
  margin: 0;
  font-family: 'Merge One';
  font-size: var(--text-xl);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

.public-map__subtitle {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map__days {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* At a desk the map takes the left and the card, the find field and the list a 22rem column on
   the right; on a phone they stack, in that order. */
.public-map__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  align-items: start;
  gap: var(--space-6);
}

/* The map stays in sight beside a long list, under the app bar. */
.public-map__map {
  position: sticky;
  top: calc(var(--banner-h) + var(--space-4));
  min-width: 0;
  scroll-margin-top: calc(var(--banner-h) + var(--space-4));
}

.public-map__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  min-width: 0;
}

.public-map__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: white;
  overflow-wrap: anywhere;
}

.public-map__hint,
.public-map__note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

.public-map__card-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.public-map__part {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.public-map__half {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mm-text-muted);
}

.public-map__name {
  margin: 0;
  font-weight: 600;
}

.public-map__links {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}

.public-map__links dt {
  color: var(--mm-text-muted);
}

.public-map__links dd {
  margin: 0;
  min-width: 0;
}

.public-map__link {
  color: var(--mm-text-link);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Each link stands alone on its line, so on a phone it is a thumb's target, its name level with
   its middle, as an answer that is only an address is (`AnswerValue.vue`). */
@media (width <= 640px) {
  .public-map__links {
    align-items: center;
  }

  .public-map__link {
    display: inline-flex;
    align-items: center;
    min-height: var(--target-min);
  }
}

/* A vendor of the list: their name over their table, the whole row the button. */
.public-map__vendor {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-hairline);
  width: 100%;
  min-height: var(--target-min);
  /* The card's own inset, so a vendor's name stands on the card's text above it. */
  padding: var(--space-2) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: none;
  color: var(--mm-black);
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}

/* An edge, not a tint: the muted table line would fall under AA on a hover's grey. The picked
   vendor's edge is the map's own mark, black. */
.public-map__vendor:hover {
  border-color: var(--mm-border);
}

.public-map__vendor[aria-current='true'] {
  border-color: var(--mm-black);
}

.public-map__vendor-name {
  font-weight: 600;
}

.public-map__vendor-seat {
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

@media (width < 1000px) {
  .public-map__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .public-map__map {
    position: static;
  }
}

@media (width <= 640px) {
  .public-map__vendor {
    min-height: 44px;
  }
}

/* ── Prototype (release walk F6) ── */
/* Cute and elegant: cream paper, Merge One's soft capitals for the name, fine charcoal lines, round
   pastel pills, a mustard sparkle; a picked table speaks in a bubble from the map itself. */
.public-map {
  /* The window's height under the app bar, not the shell's `flex: 1`, which grows with the list. */
  flex: none;
  gap: var(--space-4);
  height: calc(100dvh - var(--banner-h));
  padding-block: var(--space-4) var(--space-6);
  overflow: hidden;
  background: #ebe8e2;
  box-shadow: 0 0 0 100vmax #ebe8e2;
  clip-path: inset(0 -100vmax);
  --pm-line: rgba(39, 35, 35, 0.16);
  --pm-soft-shadow: 0 1px 2px rgba(39, 35, 35, 0.06), 0 8px 24px rgba(39, 35, 35, 0.08);
}

.public-map__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3) var(--space-6);
}

.public-map__words {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

/* Prototype (release walk F6): the name and "vendor map" lifted off the gradient by a subtle white
   glow round their letters, no card. */
.public-map__head .public-map__title,
.public-map__head .public-map__subtitle {
  text-shadow:
    0 0 1px rgb(255 255 255 / 90%),
    0 0 8px rgb(255 255 255 / 75%),
    0 0 18px rgb(255 255 255 / 55%);
}

.public-map__subtitle-icon {
  filter: drop-shadow(0 0 4px rgb(255 255 255 / 80%));
}

/* The name in bold Outfit over a honey stroke, drawn as a thick underline behind the letters so it
   follows each line's words; under it "vendor map" in Merge One, led by a teal sparkle. */
.public-map__head .public-map__title {
  font-family: 'Outfit', sans-serif;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
  text-decoration: underline;
  text-decoration-color: var(--layout-section-1-fill);
  text-decoration-thickness: 0.4em;
  text-underline-offset: -0.22em;
  text-decoration-skip-ink: none;
}

.public-map__head .public-map__subtitle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-md);
  letter-spacing: 0.01em;
  text-transform: lowercase;
  color: var(--mm-text-muted-on-beige);
}

.public-map__subtitle-icon {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--layout-section-4-edge);
  stroke-width: 1.5;
  stroke-linejoin: round;
}

/* The day and the hall: two soft pill selects side by side on the map's top left; the map's own
   hall tabs give way to them. */
.public-map__pickers {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  max-width: calc(100% - 2 * var(--space-3));
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

.public-map__map :deep(.day-map__locations) {
  display: none;
}

/* The viewer: one soft white sheet, map and panel. */
.public-map__body {
  flex: 1 1 auto;
  min-height: 0;
  gap: 0;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--pm-line);
  border-radius: 22px;
  background: white;
  box-shadow: var(--pm-soft-shadow);
}

@media (width >= 1000px) {
  .public-map__body {
    grid-template-columns: minmax(0, 1fr) 21rem;
  }
}

.public-map__map {
  position: relative;
  top: auto;
  height: 100%;
  min-height: 0;
  background: #fbfaf7;
}

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

.public-map__map :deep(.day-map__locations) {
  grid-area: map;
  align-self: start;
  justify-self: start;
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  box-shadow: var(--pm-soft-shadow);
}

/* The map's own legend gives way to the page's: the sections in their colours. */
.public-map__map :deep(.day-map__legend) {
  display: none;
}

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

/* The speech bubble: anchored on the picked table, up and right of it by default; the tail points
   at the table, at the bubble's corner nearest it. */
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

.public-map__bubble .public-map__name {
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-lg);
  font-weight: 400;
  line-height: 1.2;
}

.public-map__bubble .public-map__half {
  margin-block-start: var(--space-1);
}

.public-map__bubble .public-map__links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* The links as soft pills, their labels for a screen reader alone: the address and the handle
   say which is which. */
.public-map__bubble .public-map__links dt {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.public-map__bubble .public-map__link {
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

.public-map__bubble .public-map__link:hover {
  border-color: var(--layout-section-4-edge);
  background: var(--layout-section-4-fill);
}

/* The panel: the vendors, which alone scroll. */
.public-map__side {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  border-inline-start: 1px solid var(--pm-line);
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

/* The vendors blur and fade out as they scroll up under the find field. */
.public-map__side :deep(.list-frame__tools)::after {
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
  background: var(--layout-floor);
  padding-inline: var(--space-4);
}

.public-map__side :deep(.list-frame__rows > li + li) {
  border-block-start: 1px solid var(--layout-floor);
}

.public-map__vendor {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
  border: none;
  border-radius: 12px;
}

.public-map__vendor:hover {
  border-color: transparent;
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

/* A phone: the map over the vendors, within the window; the map the larger part. */
@media (width < 1000px) {
  .public-map__body {
    grid-template-rows: minmax(0, 3fr) minmax(0, 2fr);
  }

  .public-map__side {
    border-inline-start: none;
    border-block-start: 1px solid var(--pm-line);
  }

  .public-map__legend {
    max-width: calc(100% - 9rem);
    border-radius: 14px;
  }
}

@media (width <= 640px) {
  .public-map {
    padding-inline: var(--space-3);
    padding-block-start: var(--space-3);
  }
}

/* ── Prototype (release walk F6): a wavy, lumpy gradient behind the page ──
   Waves along the top and bottom and lumps between, in the market's own section colours (the
   script deals them), on warm paper, blurred together so no edge shows; the layer is larger than
   the window so the blur never fades at its edges. The sheet in the middle is solid. */
.public-map {
  position: relative;
  --pm-paper: #ebe8e2;
}

.public-map__head,
.public-map__body {
  position: relative;
  z-index: 1;
}

/* Fixed to the window under the app bar, a tenth of the window past each edge, and blurred whole. */
.public-map__doodles {
  position: fixed;
  top: calc(var(--banner-h) - 10vh);
  left: -10vw;
  z-index: 0;
  width: 120vw;
  height: calc(120vh - var(--banner-h));
  pointer-events: none;
  filter: blur(70px);
}

.pm-bg__paper {
  fill: var(--pm-paper);
}

.public-map .public-map__body {
  background: white;
}

.public-map .public-map__map {
  background: var(--layout-floor);
}
</style>
