<script setup lang="ts">
/**
 * A market's page, at its own address `/<slug>` (T469): for anyone, signed in or out, in every
 * stage. While the server says the public map is open it is the map, in any stage; while a market
 * whose vendors apply on its page takes applications it is the application call, with Apply and a
 * sign-in for a vendor who already applied; and otherwise a notice of where the market stands.
 * Each leads to the vendor's side, `/<slug>/vendor`, where a vendor signs in.
 *
 * It reads the vendor page's answer before drawing anything, so a slug is never printed back
 * before the server has said there is a market here. A market with no vendor page (a draft, a
 * Google Form market before its results are out, a slug that names nothing) reads "Page not found"
 * as any address that leads nowhere; a request that never answered is neither, and says so with
 * Try again. It holds no vendor state: the read is its own, not the application store's.
 *
 * A door code on this address comes from a poster printed while it was the vendor page: the router
 * sends it on to the vendor page on the way in, and this page does on a second scan in the same
 * tab, which keeps the route and changes only its query.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import PageNotFound from '@/components/PageNotFound.vue';
import ReadFailed from '@/components/ReadFailed.vue';
import { useApplicationStore } from '@/stores/application';
import { marketPageAnswered, vendorPageAnswered } from '@/utils/currentPlace';
import { vendorPagePath } from '@/utils/market';
import { getFormattedDate } from '@/utils/utils';
import {
  fetchVendorPage,
  marketPageNotice,
  marketPageShows,
  type VendorPageInfo,
} from '@/utils/vendorPage';
import PublicMapView from '@/views/PublicMapView.vue';

const PAGE_COULD_NOT_LOAD = 'This page could not be loaded. Check your connection and try again.';

const route = useRoute();
const router = useRouter();
const store = useApplicationStore();

const marketSlug = computed(() => String(route.params.marketSlug ?? ''));

/** The page has left: nothing read after it is kept. */
let gone = false;

type State = 'loading' | 'not-found' | 'failed' | 'ready';
const state = ref<State>('loading');
const page = ref<VendorPageInfo | null>(null);

const signedIn = computed(() => store.isAuthenticatedFor(marketSlug.value));

// A "Page not found" here is no vendor's page, so the app bar keeps an organizer's way about on it,
// as on the vendor page; a page that found its market (the call, a notice or the map) gives the bar
// its link to the vendor's side, and whether this tab is signed in for it, which the bar's words
// follow. Told by the slug the page answered for, kept, since by the page's unmount the route is
// already the next page's.
let answeredFor = marketSlug.value;
watch(state, (now) => {
  answeredFor = marketSlug.value;
  vendorPageAnswered(answeredFor, now === 'not-found');
  marketPageAnswered(answeredFor, now === 'ready', signedIn.value);
});
// A sign-in that starts or ends while the page stands, for the market it answered for.
watch(signedIn, (now) => {
  if (state.value === 'ready' && answeredFor === marketSlug.value) {
    marketPageAnswered(answeredFor, true, now);
  }
});

/** Take back what the bar was told for the slug the page last answered. */
function takeBackAnswer() {
  vendorPageAnswered(answeredFor, false);
  marketPageAnswered(answeredFor, false);
}

/** Each read is numbered, so one answering after the address moved to another market is dropped. */
let reads = 0;

async function load() {
  const read = ++reads;
  state.value = 'loading';
  const answer = await fetchVendorPage(marketSlug.value);
  if (read !== reads || gone) return;
  page.value = answer.page;
  state.value = answer.notFound ? 'not-found' : answer.failed ? 'failed' : 'ready';
}

void load();

// The map is the page whole, with no element of this one around it, so it lays out as its own route
// would; keyed by the slug, so another market's map is mounted afresh. No comment stands between
// the template's roots, since a development build would render it as a root of its own.
const shows = computed(() => (page.value ? marketPageShows(page.value) : null));
const notice = computed(() => (page.value ? marketPageNotice(page.value) : ''));
const vendorPage = computed(() => vendorPagePath(marketSlug.value));
/** A door code that arrived on the open page goes on to the vendor page, which takes it. */
function forwardDoorCode(): boolean {
  if (gone || typeof route.query.door !== 'string' || route.name !== 'market-page') return false;
  void router.replace({
    name: 'vendor-page',
    params: route.params,
    query: route.query,
    hash: route.hash,
  });
  return true;
}

watch(() => route.query.door, forwardDoorCode);

// The app's one RouterView is unkeyed, so an in-app move to another market's page keeps this one:
// it forgets the first market and reads the second afresh. A move off the page reads nothing.
watch(marketSlug, (now, before) => {
  if (now === before || gone || route.name !== 'market-page') return;
  if (typeof route.query.door === 'string') return;
  takeBackAnswer();
  page.value = null;
  void load();
});

onUnmounted(() => {
  gone = true;
  takeBackAnswer();
});
</script>

<template>
  <div v-if="state === 'not-found'" data-testid="market-page-not-found">
    <PageNotFound />
  </div>
  <PublicMapView v-else-if="state === 'ready' && shows === 'map'" :key="marketSlug" />
  <div v-else class="market-page" data-testid="market-page">
    <p v-if="state === 'loading'" class="market-page__loading" data-testid="market-page-loading">
      Loading…
    </p>

    <ReadFailed
      v-else-if="state === 'failed'"
      name="market-page"
      :message="PAGE_COULD_NOT_LOAD"
      @retry="load"
    />

    <template v-else-if="page">
      <header class="market-page__head">
        <h1 class="market-page__name" data-testid="market-page-name">{{ page.marketName }}</h1>
        <ul
          v-if="page.marketDates.length"
          class="market-page__dates"
          aria-label="Market dates"
          data-testid="market-page-dates"
        >
          <li v-for="date in page.marketDates" :key="date">{{ getFormattedDate(date) ?? date }}</li>
        </ul>
      </header>

      <section v-if="shows === 'call'" class="market-page__body" data-testid="market-page-call">
        <p class="market-page__line">Applications are open.</p>
        <RouterLink :to="vendorPage" class="btn btn--primary" data-testid="market-page-apply">
          Apply
        </RouterLink>
        <p class="market-page__aside">
          Already applied?
          <RouterLink :to="vendorPage" class="market-page__link" data-testid="market-page-sign-in">
            Sign in
          </RouterLink>
        </p>
      </section>

      <section v-else class="market-page__body" data-testid="market-page-notice">
        <p class="market-page__line" data-testid="market-page-notice-line">{{ notice }}</p>
        <RouterLink
          :to="vendorPage"
          class="btn btn--secondary"
          data-testid="market-page-vendor-link"
        >
          {{ signedIn ? 'Your vendor page' : 'Vendor sign-in' }}
        </RouterLink>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* The vendor page's column, so the market's two pages read as one place. */
.market-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: 100%;
  max-width: var(--applicant-max);
  margin: var(--space-8) auto;
  padding: 0 var(--space-4);
}

.market-page__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  text-align: center;
}

.market-page__name {
  font-family: 'Merge One';
  font-size: var(--text-xl);
  color: var(--mm-black);
  margin: 0;
  overflow-wrap: anywhere;
}

.market-page__dates {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

.market-page__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}

.market-page__line {
  margin: 0;
  font-size: var(--text-md);
  color: var(--mm-black);
}

.market-page__aside {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
}

/* Underlined, since colour alone does not set a link apart from the sentence around it (WCAG
   1.4.1, axe's link-in-text-block). */
.market-page__link {
  color: var(--mm-text-link);
  text-decoration: underline;
}

.market-page__loading {
  margin: 0;
  text-align: center;
  padding: var(--space-12);
  font-size: var(--text-sm);
  color: var(--mm-text-muted);
}
</style>
