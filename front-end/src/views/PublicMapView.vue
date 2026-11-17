<script setup lang="ts">
/**
 * A market's public map, at `/<market-slug>/map` (T422, D31 to D35): anyone, with no sign-in, picks
 * a market day and a location, presses a table or finds a vendor by name, and reads the public
 * name, website and Instagram the organizer chose to publish, and nothing else of them (D26).
 *
 * It is one sheet filling the window under the app bar, on the paper of its backdrop, and the page
 * never scrolls (T465): the map side holds the market's name, the day and hall selects at its top
 * right and the hall filling the rest, with the open hall's legend and the zoom at its bottom
 * corners; the vendor panel stands beside it at a desk and under it on a phone, the card of the
 * table picked at its top. The parts are in `components/publicmap/`.
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
import IconSparkle from '@/components/icons/IconSparkle.vue';
import PageNotFound from '@/components/PageNotFound.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import PublicMapBackdrop from '@/components/publicmap/PublicMapBackdrop.vue';
import PublicMapLegend from '@/components/publicmap/PublicMapLegend.vue';
import PublicMapTableCard from '@/components/publicmap/PublicMapTableCard.vue';
import PublicMapVendors from '@/components/publicmap/PublicMapVendors.vue';
import { hallLegend, tablePaints } from '@/components/publicmap/publicMapPaint';
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
  dayInWords,
  fetchPublicMap,
  fetchPublicMapImage,
  mapPlace,
  shortDay,
  tableCard,
  type ListedVendor,
  type MapPlace,
} from '@/utils/publicMap';
import { useFillsTheWindow } from '@/utils/useFillsTheWindow';

const route = useRoute();
const router = useRouter();

useFillsTheWindow();

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
/** The day map draws no legend of its own here: its `legend` slot holds the page's. */
const NO_LEGEND: readonly DayMapLegendItem[] = [];
const openLocation = computed(
  () => locations.value.find((l) => l.id === place.value.locationId) ?? locations.value[0],
);
const legendItems = computed(() => hallLegend(openLocation.value, seats.value));
const paints = computed(() => tablePaints(locations.value));

const day = computed(() => dayInWords(place.value.date));
const card = computed(() =>
  map.value && place.value.tableId
    ? tableCard(map.value, place.value.date, place.value.tableId)
    : null,
);
const hallName = computed(() => openLocation.value?.name ?? '');
const cardPaint = computed(() =>
  place.value.tableId ? (paints.value.get(place.value.tableId) ?? null) : null,
);

/** A vendor of the list: their location opened and their table picked. The page never scrolls,
 *  so the map is always in view. */
function openVendor(vendor: ListedVendor) {
  goTo({ ...place.value, locationId: vendor.locationId, tableId: vendor.tableId });
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
      <PublicMapBackdrop :locations="locations" />

      <div class="public-map__sheet">
        <div class="public-map__map" data-testid="public-map-map">
          <div class="public-map__bar">
            <!-- The title first, so a screen reader meets the heading before the controls; on a
                 phone the grid puts the selects above it. -->
            <div class="public-map__words">
              <h1 class="public-map__title" data-testid="public-map-heading">
                {{ map.marketName }}
              </h1>
              <p class="public-map__subtitle" data-testid="public-map-subtitle">
                <IconSparkle class="public-map__sparkle" />
                Vendor map
              </p>
            </div>
            <div class="public-map__pickers">
              <!-- Each label stands beside its select, not round it, so the select's name is the
                   label's words alone, without the chosen option's. -->
              <label for="public-map-day" class="visually-hidden">Market day</label>
              <select
                id="public-map-day"
                class="field field--select public-map__select"
                name="public-map-day"
                :value="place.date"
                data-testid="public-map-day-select"
                @change="chooseDay(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="date in map.dates" :key="date" :value="date">
                  {{ shortDay(date) }}
                </option>
              </select>
              <template v-if="locations.length > 1">
                <label for="public-map-location" class="visually-hidden">Location</label>
                <select
                  id="public-map-location"
                  class="field field--select public-map__select"
                  name="public-map-location"
                  :value="openLocation?.id"
                  data-testid="public-map-location-select"
                  @change="chooseLocation(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="location in locations" :key="location.id" :value="location.id">
                    {{ location.name }}
                  </option>
                </select>
              </template>
            </div>
          </div>

          <div class="public-map__hall" data-testid="public-map-hall">
            <DayMap
              fills
              :locations="locations"
              :tableTypes="map.tableTypes"
              :locationId="place.locationId"
              :seats="seats"
              :picked="place.tableId"
              :legend="NO_LEGEND"
              @update:locationId="chooseLocation"
              @pick="pick"
            >
              <template #legend>
                <PublicMapLegend :items="legendItems" />
              </template>
            </DayMap>
          </div>
        </div>

        <div class="public-map__side">
          <!-- The live region stays while the card comes and goes, so a pick is announced. -->
          <div class="public-map__live" aria-live="polite">
            <section v-if="card" class="public-map__card" data-testid="public-map-card">
              <PublicMapTableCard :card="card" :day="day" :hallName="hallName" :paint="cardPaint" />
            </section>
          </div>

          <PublicMapVendors
            class="public-map__vendors"
            :map="map"
            :date="place.date"
            :pickedTableId="place.tableId"
            :pickedSeatKey="null"
            :paints="paints"
            @open="openVendor"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The page's column: the window's height under the app bar, never more, so the page never
   scrolls (the shell's `flex: 1` would grow it with the list); the workspace's width at most. */
.public-map {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 100%;
  max-width: var(--workspace-max);
  height: calc(100dvh - var(--banner-h));
  margin: 0 auto;
  padding: var(--space-4) var(--space-4) var(--space-6);
  overflow: hidden;
  color: var(--mm-black);
}

.public-map__loading {
  margin: 0;
  padding: var(--space-12);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}

/* The sheet, over the backdrop: the map left of a 21rem panel at a desk, over it three to two
   on anything narrower. */
.public-map__sheet {
  position: relative;
  z-index: 1;
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 3fr) minmax(0, 2fr);
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-sheet);
  background: white;
  box-shadow: var(--shadow-float);
}

/* The map side: the title bar, then the hall, which takes the rest. */
.public-map__map {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--layout-floor);
}

/* The name wraps short of the selects, which stand 12px from the side's top and end edges, as
   the zoom and the legend stand from theirs. */
.public-map__bar {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'title pickers';
  gap: var(--space-3) var(--space-4);
  padding: var(--space-6) var(--space-3) var(--space-4) var(--space-6);
}

.public-map__words {
  display: flex;
  grid-area: title;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

/* The name over a honey marker stroke, a thick underline behind the letters, so it follows each
   line's words. */
.public-map__title {
  margin: 0;
  font-family: Outfit, sans-serif;
  font-size: var(--text-2xl);
  font-weight: 600;
  line-height: 1.15;
  color: var(--mm-black);
  overflow-wrap: anywhere;
  text-decoration: underline;
  text-decoration-color: var(--layout-section-1-fill);
  text-decoration-thickness: 0.4em;
  text-underline-offset: -0.22em;
  text-decoration-skip-ink: none;
}

.public-map__subtitle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-family: 'Merge One', sans-serif;
  font-size: var(--text-lg);
  line-height: 1.3;
  text-transform: lowercase;
  color: var(--mm-text-muted-on-beige);
}

/* The words are lower case, so their middle is the x-height's, a little under the line's: the
   star sits on that middle. */
.public-map__sparkle {
  flex: none;
  width: 0.9em;
  height: 0.9em;
  color: var(--layout-section-4-edge);
  transform: translateY(0.06em);
}

.public-map__pickers {
  display: flex;
  grid-area: pickers;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: calc(-1 * var(--space-3));
}

/* A pill floating over the floor; the app's select keeps its own padding, ground and chevron. */
.public-map__select {
  width: auto;
  min-width: 7.5rem;
  height: var(--control-height);
  border: 1px solid var(--mm-border-soft);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-float);
  font-size: var(--text-sm);
}

.public-map__select:hover {
  border-color: var(--layout-section-1-edge);
}

/* The hall takes what the bar leaves, a definite box the filling day map takes whole. */
.public-map__hall {
  display: grid;
  flex: 1 1 auto;
  grid-template-rows: minmax(0, 1fr);
  position: relative;
  min-height: 0;
}

/* The vendor panel: the card of the table picked at its top, the day's vendors taking the rest.
   The panel itself never scrolls: the vendors' part scrolls its own list in the box it is given,
   and keeps the panel's inset inside its scroller. */
.public-map__side {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-block-start: 1px solid var(--mm-border-soft);
}

.public-map__live {
  flex: none;
  padding: var(--space-4) var(--space-4) 0;
}

.public-map__live:empty {
  display: none;
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

.public-map__vendors {
  flex: 1 1 auto;
  min-height: 0;
}

@media (width >= 1000px) {
  .public-map__sheet {
    grid-template-columns: minmax(0, 1fr) 21rem;
    grid-template-rows: minmax(0, 1fr);
  }

  .public-map__side {
    border-block-start: none;
    border-inline-start: 1px solid var(--mm-border-soft);
  }
}

/* A phone: the selects keep the top end, and the title starts under them. */
@media (width <= 640px) {
  .public-map {
    padding: var(--space-3) var(--space-3) var(--space-6);
  }

  .public-map__bar {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'pickers'
      'title';
  }

  .public-map__title {
    font-size: var(--text-xl);
  }
}
</style>
