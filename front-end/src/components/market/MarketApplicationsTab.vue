<script setup lang="ts">
/**
 * The applications tab's body (E18/F02/S01).
 *
 * Extracted from `MarketSetupView`, which held all four tab bodies inline across 1300 lines. The
 * DOM and every `data-testid` are unchanged - this is the prefactor that makes `S02`'s shell
 * change a shell change rather than a whole-file rewrite carrying a fifteen-spec migration.
 *
 * State arrives as props rather than being reached for, so a later story can mount this under a
 * different parent without rewriting it.
 *
 * Its toolbar (T466, release walk F7) is one row pinned under the market's frame from 1024px: the
 * view switch and Publish results at its start, and at its end the open view's read time, Refresh
 * and, on All, Export. Each view keeps its own read, which every verdict holds, and exposes its
 * state (`ReviewViewTools`); the tab draws the buttons from it. While applications are open the
 * line saying what arrives and the reviewers line go to the open view's `lead` slot, under the
 * pinned tools, so the tools stand in the same place in every stage.
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ApplicationMonitor from '@/components/application/ApplicationMonitor.vue';
import ApplicationsAll from '@/components/application/ApplicationsAll.vue';
import PublishResults from '@/components/application/PublishResults.vue';
import type { ReviewViewTools } from '@/components/application/reviewViewTools';
import ReviewersPanel from '@/components/market/ReviewersPanel.vue';
import ListFreshness from '@/components/ListFreshness.vue';
import PinnedTools from '@/components/PinnedTools.vue';
import SegmentedControl from '@/components/SegmentedControl.vue';
import ToolRow from '@/components/ToolRow.vue';
import { withoutQueryKey } from '@/utils/routeQuery';
import { IntakeMode, MarketPhase, type Market } from '@/assets/types/datatypes';
import { intakeModeOf } from '@/utils/marketGuide';
import { reviewView, type ReviewView } from '@/utils/reviewQueue';

const props = defineProps<{
  market: Market | null;
  visible: boolean;
}>();

const router = useRouter();
const route = useRoute();

/** The application this page's address names, as an assignment that refused links to it (bug 42). */
const namedApplication = computed(() => String(route.query.application ?? ''));

/**
 * All, or One by one (E34/F04/S01): the review's two views, the choice in the address so a reload
 * or a shared link opens the same one. All is first and the default (E38/F05/S01), so it drops
 * `view`, and the application a link named with it: a named application is One by one's card.
 */
const view = computed(() => reviewView(route.query));
const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'one', label: 'One by one' },
] as const;
function showView(next: ReviewView) {
  const query = withoutQueryKey(withoutQueryKey(route.query, 'view'), 'application');
  void router.replace({ query: next === 'one' ? { ...route.query, view: 'one' } : query });
}

/**
 * Bumped by every change of reviewers (E38/F07/S02): the deal moved applications between them, so
 * the open view reads its list again to show whom each went to.
 */
const dealt = ref(0);

/**
 * The open view, for the toolbar's end. Null for the first render, before the view has mounted, so
 * the end fills in the same tick; a change of view swaps it.
 */
const tools = ref<ReviewViewTools | null>(null);

/** Its vendors apply on the organizer's own Google Form and arrive by import (E31/F03). */
const csvMarket = computed(() => intakeModeOf(props.market) === IntakeMode.Csv);

/**
 * Where the market stands, IN WORDS (E18/F02/S03).
 *
 * One surface serves the whole stage where applications arrive and are reviewed (E38/F04/S01), on
 * both paths, so this line says what is true of it now. It offers no import on either path: a
 * Google Form market's first import is the rail's step out of draft and a late export its Redo
 * import, and an own-form market takes nothing from a file. The next step is the rail's to say
 * (E31/F02/S02), so these describe the page rather than repeat it. Past the stage it says nothing
 * (T466): the review's controls are simply gone, and a write that still reaches the server is
 * refused in the words of why the review closed (`verdictsSettledReason`).
 */
const condition = computed(() => {
  switch (props.market?.phase) {
    // What arrives here, and how: only a form market's applications arrive by themselves. A CSV
    // market's come in by import (bug 16), which the rail's sentence just above already says
    // ("Every imported response is here."), so the page says nothing more (T96). How many are left
    // to decide is the rail's to say, with the step they hold.
    case MarketPhase.Applications:
      return csvMarket.value
        ? ''
        : props.market?.applicationsStopped
          ? 'This market is not taking applications. No new ones will arrive.'
          : 'This market is open for applications. New ones keep arriving here.';
    default:
      return '';
  }
});
</script>

<template>
  <!-- The toolbar pinned over the open view: it spans the card's width under the frame, so at rest
       it already stands where it pins. -->
  <PinnedTools testid="applications-tools">
    <template #tools>
      <ToolRow testid="applications-toolbar">
        <SegmentedControl
          :options="VIEWS"
          :modelValue="view"
          label="How do you want to review?"
          describedBy="review-views-hint"
          testid="applications-view"
          @update:modelValue="showView($event as ReviewView)"
        />
        <!-- What the two views are, for a screen reader: the switch's description. -->
        <p id="review-views-hint" class="visually-hidden">
          All lists every application, to filter and decide several at once. One by one shows one
          application at a time, with every answer.
        </p>
        <!-- A step for the market, over whichever view is open (E38/F05/S01). -->
        <PublishResults :market="market" />
        <template #end>
          <!-- Refresh before Export, so the Tab key meets them in the order they stand. -->
          <ListFreshness
            v-if="tools?.freshness.ready"
            testid="applications"
            :readAt="tools.freshness.readAt"
            :refreshing="tools.freshness.refreshing"
            :failed="tools.freshness.failed"
            @refresh="tools.refresh()"
          />
          <button
            v-if="view === 'all' && tools?.mayExport"
            type="button"
            class="btn btn--secondary btn--compact"
            data-testid="applications-all-export-button"
            @click="tools.openExport?.()"
          >
            Export
          </button>
        </template>
      </ToolRow>
    </template>
    <div class="applications-body">
      <ApplicationsAll v-if="view === 'all'" ref="tools" :market="market" :dealt="dealt">
        <template #lead>
          <!-- One block, spaced by the list's own gap; empty, and so not drawn, past the stage. -->
          <div class="applications-lead">
            <p
              v-if="condition"
              class="applications-condition"
              data-testid="market-setup-applications-condition"
            >
              {{ condition }}
            </p>
            <!-- Who reviews which application, while the review is open (E38/F07/S02). -->
            <ReviewersPanel :market="market" @saved="dealt++" />
          </div>
        </template>
      </ApplicationsAll>
      <ApplicationMonitor
        v-else
        ref="tools"
        :market="market"
        :visible="visible"
        :named="namedApplication"
        :dealt="dealt"
      >
        <template #lead>
          <!-- The same block, set off the card's counts under it. -->
          <div class="applications-lead applications-lead--over-the-card">
            <p
              v-if="condition"
              class="applications-condition"
              data-testid="market-setup-applications-condition"
            >
              {{ condition }}
            </p>
            <ReviewersPanel :market="market" @saved="dealt++" />
          </div>
        </template>
      </ApplicationMonitor>
    </div>
  </PinnedTools>
</template>

<style scoped>
/* The open view, in the market screen's gutter; its own top stands off the toolbar's rule. */
.applications-body {
  padding: 0 var(--space-6) var(--space-6);
}

.applications-lead {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Past the stage it holds nothing, and a box of nothing would still take a gap. */
.applications-lead:empty {
  display: none;
}

.applications-lead--over-the-card {
  margin-block-end: var(--space-4);
}

/* The block spaces its lines, so neither brings a margin of its own. */
.applications-lead > .applications-condition,
.applications-lead > .reviewers {
  margin: 0;
}

.applications-condition {
  font-size: var(--text-sm);
  color: var(--mm-black);
  line-height: 1.4;
}

/* The phone's gutter, as the other pages that fit a phone take it (T180). */
@media (width <= 640px) {
  .applications-body {
    padding: 0 var(--space-4) var(--space-4);
  }
}
</style>
