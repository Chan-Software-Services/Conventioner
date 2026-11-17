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
const HALF_NAMES = { left: 'Left half', right: 'Right half' } as const;

const listed = computed(() => (map.value ? mapListing(map.value, place.value.date) : []));
const finds = (vendor: ListedVendor, words: string) =>
  vendor.name.toLowerCase().includes(words.toLowerCase());

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
        <div class="public-map__words">
          <h1 class="public-map__title" data-testid="public-map-heading">{{ map.marketName }}</h1>
          <p class="public-map__subtitle" data-testid="public-map-subtitle">
            Vendor map · {{ listed.length }} {{ listed.length === 1 ? 'vendor' : 'vendors' }}
          </p>
        </div>

        <nav class="public-map__days" aria-label="Market day" data-testid="public-map-days">
          <button
            v-for="date in map.dates"
            :key="date"
            type="button"
            class="public-map__day"
            :aria-pressed="date === place.date"
            :data-date="date"
            data-testid="public-map-day"
            @click="chooseDay(date)"
          >
            {{ dayInWords(date) }}
          </button>
        </nav>
      </header>

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

        <aside class="public-map__side" aria-label="Vendors">
          <section
            class="public-map__card"
            :class="{ 'public-map__card--picked': card }"
            aria-live="polite"
            data-testid="public-map-card"
          >
            <p v-if="!card" class="public-map__hint">{{ PICK_A_TABLE }}</p>
            <template v-else>
              <h2 class="public-map__card-title">Table {{ card.code }}</h2>
              <div
                v-for="part in card.halves"
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
            </template>
          </section>

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
                  <span class="public-map__code" aria-hidden="true">{{ item.code }}</span>
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
.public-map {
  /* The window's height under the app bar, not the shell's `flex: 1`, which grows with the list. */
  flex: none;
  gap: var(--space-4);
  height: calc(100dvh - var(--banner-h));
  padding-block: var(--space-4);
  overflow: hidden;
}

/* The header: the name and how many vendors, the days at its end. */
.public-map__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3) var(--space-6);
}

.public-map__words {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.public-map__head .public-map__title {
  font-size: var(--text-lg);
  line-height: 1.2;
}

.public-map__head .public-map__subtitle {
  margin: 0;
}

/* A segmented control: the days on a beige track, the chosen one a raised white chip. */
.public-map__days,
.public-map__map :deep(.filter-toggles) {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--mm-beige);
}

.public-map__day,
.public-map__map :deep(.filter-toggles__toggle) {
  min-height: 32px;
  height: 32px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--mm-black);
  font: inherit;
  font-size: var(--text-sm);
  white-space: nowrap;
  cursor: pointer;
  box-shadow: none;
}

.public-map__day:hover,
.public-map__map :deep(.filter-toggles__toggle:hover) {
  background: var(--mm-beige-hover);
}

.public-map__day[aria-pressed='true'],
.public-map__map :deep(.filter-toggles__toggle[aria-pressed='true']) {
  background: white;
  color: var(--mm-black);
  font-weight: 600;
  box-shadow: var(--shadow-card);
}

/* The viewer: map and panel side by side, one height, in one framed box. */
.public-map__body {
  flex: 1 1 auto;
  min-height: 0;
  gap: 0;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  background: white;
  box-shadow: var(--shadow-card);
}

@media (width >= 1000px) {
  .public-map__body {
    grid-template-columns: minmax(0, 1fr) 22rem;
  }
}

/* The map fills its side of the viewer, whatever the hall's shape. */
.public-map__map {
  position: relative;
  top: auto;
  height: 100%;
  min-height: 0;
  background: var(--layout-floor);
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
}

/* The hall tabs float on the map's top left, the legend on its bottom left. */
.public-map__map :deep(.day-map__locations) {
  grid-area: map;
  align-self: start;
  justify-self: start;
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  background: white;
  box-shadow: var(--shadow-card);
}

.public-map__map :deep(.day-map__legend) {
  grid-area: map;
  align-self: end;
  justify-self: start;
  flex-wrap: nowrap;
  position: absolute;
  bottom: var(--space-3);
  left: var(--space-3);
  z-index: 1;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
  background: white;
  box-shadow: var(--shadow-card);
  font-size: var(--text-xs);
}

/* The zoom stays on the map's bottom right at every width, a phone's too. */
.public-map__map :deep(.day-map__zoom) {
  grid-area: map;
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: 1;
  padding: var(--space-1);
  box-shadow: var(--shadow-card);
}

/* The panel: the picked table over the vendors, which scroll inside it. */
.public-map__side {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  border-inline-start: 1px solid var(--mm-border);
}

.public-map__card {
  flex: none;
  padding: var(--space-4);
  border: none;
  border-block-end: 1px solid var(--mm-border);
  border-radius: 0;
  background: white;
}

.public-map__card--picked {
  box-shadow: inset 4px 0 0 var(--mm-green);
}

.public-map__card-title {
  font-family: 'Merge One';
  font-weight: 400;
}

.public-map__scroll {
  flex: 1 1 auto;
  min-height: 0;
}

.public-map__side :deep(.list-frame) {
  padding: 0 var(--space-4) var(--space-4);
}

/* The find field stays at the panel's top while the vendors scroll under it. */
.public-map__side :deep(.list-frame__tools) {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-block: var(--space-3) var(--space-2);
  background: white;
}

.public-map__side :deep(.list-frame__rows > li + li) {
  border-block-start: 1px solid var(--mm-border);
}

/* A vendor: their table's code, then their name over their hall. */
.public-map__vendor {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-1);
  border: none;
  border-radius: 0;
}

.public-map__vendor:hover {
  border-color: transparent;
}

.public-map__vendor:hover .public-map__vendor-name {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.public-map__vendor[aria-current='true'] {
  box-shadow: inset 3px 0 0 var(--mm-green);
  padding-inline-start: var(--space-3);
}

.public-map__vendor-words {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  min-width: 0;
}

.public-map__code {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3rem;
  height: 1.75rem;
  padding-inline: var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--mm-fill-third);
  color: var(--mm-black);
  font-size: var(--text-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* A phone: the map over the panel, the map the larger part, both within the window. */
@media (width < 1000px) {
  .public-map__body {
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }

  .public-map__card {
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
  }

  .public-map__card-title {
    font-size: var(--text-md);
  }

  .public-map__side {
    border-inline-start: none;
    border-block-start: 1px solid var(--mm-border);
  }
}

@media (width <= 640px) {
  .public-map {
    padding-inline: var(--space-3);
    padding-block-start: var(--space-4);
  }

  .public-map__days {
    max-width: 100%;
  }

  .public-map__day {
    padding-inline: var(--space-3);
  }
}
</style>
