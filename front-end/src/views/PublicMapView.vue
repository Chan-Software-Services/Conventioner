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
import PageNotFound from '@/components/PageNotFound.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import type { TablePaint } from '@/components/publicmap/publicMapPaint';
import {
  publicDayLocations,
  publicSeats,
  type DayMapLegendItem,
  type PublicMapAnswer,
} from '@/components/daymap/dayMap';
import { vendorPageAnswered } from '@/utils/currentPlace';
import { calendarToday } from '@/utils/marketGuide';
import {
  MAP_COULD_NOT_LOAD,
  PICK_A_TABLE,
  dayInWords,
  fetchPublicMap,
  fetchPublicMapImage,
  mapPlace,
  tableCard,
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

function pick(tableId: string) {
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
const hallName = computed(
  () => map.value?.locations.find((l) => l.id === place.value.locationId)?.name ?? '',
);
/** No table is painted in its section's colours yet. */
const NO_PAINTS: ReadonlyMap<string, TablePaint> = new Map();

const mapBox = ref<HTMLElement>();

/** A vendor of the list: their location opened, their table picked, and the map in view. */
function openVendor(vendor: ListedVendor) {
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
      <header class="public-map__head">
        <h1 class="public-map__title" data-testid="public-map-heading">{{ map.marketName }}</h1>
        <p class="public-map__subtitle" data-testid="public-map-subtitle">Map</p>
      </header>

      <nav class="public-map__days" aria-label="Market day" data-testid="public-map-days">
        <button
          v-for="date in map.dates"
          :key="date"
          type="button"
          class="btn btn--secondary btn--compact public-map__day"
          :aria-pressed="date === place.date"
          :data-date="date"
          data-testid="public-map-day"
          @click="chooseDay(date)"
        >
          {{ dayInWords(date) }}
        </button>
      </nav>

      <div class="public-map__body">
        <div ref="mapBox" class="public-map__map" data-testid="public-map-map">
          <DayMap
            :locations="locations"
            :tableTypes="map.tableTypes"
            :locationId="place.locationId"
            :seats="seats"
            :picked="place.tableId"
            :legend="LEGEND"
            @update:locationId="chooseLocation"
            @pick="pick"
          />
        </div>

        <div class="public-map__side">
          <section class="public-map__card" aria-live="polite" data-testid="public-map-card">
            <p v-if="!card" class="public-map__hint">{{ PICK_A_TABLE }}</p>
            <PublicMapTableCard v-else :card="card" :day="day" :hallName="hallName" :paint="null" />
          </section>

          <PublicMapVendors
            :map="map"
            :date="place.date"
            :pickedTableId="place.tableId"
            :pickedSeatKey="null"
            :paints="NO_PAINTS"
            @open="openVendor"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
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

.public-map__hint {
  margin: 0;
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
</style>
