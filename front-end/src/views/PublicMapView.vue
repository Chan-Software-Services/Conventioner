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

async function load() {
  state.value = 'loading';
  const read = await fetchPublicMap(marketSlug.value);
  map.value = read.map;
  state.value = read.notFound ? 'not-found' : read.failed ? 'failed' : 'ready';
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
let gone = false;

watch(
  () => [map.value, place.value.locationId] as const,
  async ([answer, locationId]) => {
    const location = answer?.locations.find((l) => l.id === locationId);
    if (!location?.layout.hasImage || asked.has(locationId)) return;
    asked.add(locationId);
    try {
      const blob = await fetchPublicMapImage(marketSlug.value, locationId);
      if (gone) return;
      imageUrls[locationId] = URL.createObjectURL(blob);
    } catch {
      // Drawn on the floor's colour alone: the tables still say where everyone is.
      asked.delete(locationId);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  gone = true;
  vendorPageAnswered(answeredFor, false);
  document.title = titleBefore;
  for (const url of Object.values(imageUrls)) URL.revokeObjectURL(url);
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

          <ListFrame
            :items="listed"
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
                <span class="public-map__vendor-name">{{ item.name }}</span>
                <span class="public-map__vendor-seat"
                  >Table {{ item.code }}, {{ item.locationName }}</span
                >
              </button>
            </template>
            <template #empty>
              <p>{{ NO_VENDORS_LISTED }}</p>
            </template>
          </ListFrame>
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
</style>
