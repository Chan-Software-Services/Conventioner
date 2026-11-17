<script setup lang="ts">
/**
 * The toolbars (T466, release walk F5 and F7): `ToolRow`, `ToolGroup`, `SegmentedControl` and
 * `PinnedTools`, the parts Attendance's and Applications' toolbars are built from, on the fixture.
 *
 * A toolbar row with a select at its start and three groups at its end, Refresh last; a second row
 * whose search takes the room left; the review's five statuses as a segmented control that wraps on
 * a phone; and a pinned block over 60 rows in a box, which stays put as the box scrolls at a desk
 * and scrolls away on a phone. Every part here is the real component; the line under each reads out
 * what it holds, so a press is seen to land.
 */
import { computed, ref } from 'vue';
import ListFreshness from '@/components/ListFreshness.vue';
import PinnedTools from '@/components/PinnedTools.vue';
import ScrollBox from '@/components/ScrollBox.vue';
import SegmentedControl, { type SegmentedOption } from '@/components/SegmentedControl.vue';
import ToolGroup from '@/components/ToolGroup.vue';
import ToolRow from '@/components/ToolRow.vue';
import { ALL_VIEW_FILTERS } from '@/utils/reviewQueue';
import { getShortDate } from '@/utils/utils';
import LibrarySection from '../parts/LibrarySection.vue';
import LibraryPanel from '../parts/LibraryPanel.vue';
import ReadOut from '../parts/ReadOut.vue';
import { fixture } from '../fixture';

const { applications, seats } = fixture;

/** The fixture's market days, each with the vendors seated on it. */
const dates = [...new Set(seats.map(({ date }) => date))].sort();
const date = ref(dates[0]!);
const seatedOn = computed(() => seats.filter((seat) => seat.date === date.value).length);

const SHOW_AS: SegmentedOption[] = [
  { id: 'list', label: 'List' },
  { id: 'map', label: 'Map' },
];
const showAs = ref('list');
const labelOf = (options: readonly SegmentedOption[], id: string) =>
  options.find((option) => option.id === id)?.label ?? id;

/** The last press of the toolbar's own buttons, so each is seen to land. */
const pressed = ref('');
const readAt = ref(Date.now());
function refresh(): void {
  readAt.value = Date.now();
  pressed.value = 'Refresh';
}

const words = ref('');

const statuses = ref('all');

const VIEWS: SegmentedOption[] = [
  { id: 'all', label: 'All' },
  { id: 'one', label: 'One by one' },
];
const view = ref('all');
const rows = applications.slice(0, 60);
</script>

<template>
  <LibrarySection
    title="The toolbar row"
    about="Each row as wide as its card, its rule edge to edge, 12px over and under its compact controls. On a phone the end starts its own line at the start edge and the groups lose their rules."
  >
    <LibraryPanel
      class="library-wide"
      label="A select at the start; at the end three groups: a segmented control, the paper tools, Refresh"
    >
      <div class="library-demo" data-testid="library-demo-toolbar">
        <div class="library-card">
          <ToolRow testid="library-toolbar">
            <label class="library-select">
              <span class="visually-hidden">Market date</span>
              <select
                v-model="date"
                class="field field--select field--compact library-select__field"
                name="library-toolbar-date"
                data-testid="library-toolbar-date"
              >
                <option v-for="day in dates" :key="day" :value="day">
                  {{ getShortDate(day) }}
                </option>
              </select>
            </label>
            <template #end>
              <ToolGroup data-testid="library-toolbar-group">
                <SegmentedControl
                  v-model="showAs"
                  :options="SHOW_AS"
                  label="Show as"
                  testid="library-toolbar-view"
                />
              </ToolGroup>
              <ToolGroup data-testid="library-toolbar-group">
                <button
                  type="button"
                  class="btn btn--secondary btn--compact"
                  data-testid="library-toolbar-print"
                  @click="pressed = 'Print roster'"
                >
                  Print roster
                </button>
                <button
                  type="button"
                  class="btn btn--secondary btn--compact"
                  data-testid="library-toolbar-code"
                  @click="pressed = 'Door code'"
                >
                  Door code
                </button>
              </ToolGroup>
              <ToolGroup data-testid="library-toolbar-group">
                <ListFreshness
                  testid="library-toolbar"
                  :readAt="readAt"
                  :refreshing="false"
                  failed=""
                  :showTime="false"
                  @refresh="refresh"
                />
              </ToolGroup>
            </template>
          </ToolRow>
        </div>
        <ReadOut label="Market date" :value="getShortDate(date)" />
        <ReadOut label="Show as" :value="labelOf(SHOW_AS, showAs)" />
        <ReadOut label="Pressed" :value="pressed" />
      </div>
    </LibraryPanel>

    <LibraryPanel
      class="library-wide"
      label="A second row: a count, and a search taking the room left"
    >
      <div class="library-demo" data-testid="library-demo-count-row">
        <div class="library-card">
          <ToolRow testid="library-count-row">
            <h2 class="library-count" data-testid="library-count">
              0 of {{ seatedOn }} checked in
            </h2>
            <input
              v-model="words"
              type="search"
              class="field field--compact library-search"
              aria-label="Find a vendor"
              placeholder="Name, email or table"
              data-testid="library-search"
            />
          </ToolRow>
        </div>
        <ReadOut label="Finding" :value="words" />
      </div>
    </LibraryPanel>
  </LibrarySection>

  <LibrarySection
    title="The segmented control"
    about="One choice of a few, one always on, joined into one box: each option keeps its own border, and the one before the pressed option draws its edge green."
  >
    <LibraryPanel class="library-wide" label="Five options, apart on a phone (wrapsOnAPhone)">
      <div class="library-demo" data-testid="library-demo-statuses">
        <SegmentedControl
          v-model="statuses"
          :options="ALL_VIEW_FILTERS"
          label="Filter"
          testid="library-statuses"
          wrapsOnAPhone
        />
        <ReadOut label="Showing" :value="labelOf(ALL_VIEW_FILTERS, statuses)" />
      </div>
    </LibraryPanel>
  </LibrarySection>

  <LibrarySection
    title="The pinned block"
    about="From 1024px the block stands under the market's frame and the rows pass under it; narrower, it scrolls away with them. Here the box is the page and has no frame."
  >
    <LibraryPanel class="library-wide" :label="`Pinned over ${rows.length} rows in a box`">
      <div class="library-demo" data-testid="library-demo-pinned">
        <ScrollBox class="library-pinned-box" testid="library-pinned-box">
          <PinnedTools testid="library-pinned">
            <template #tools>
              <ToolRow testid="library-pinned-toolbar">
                <SegmentedControl
                  v-model="view"
                  :options="VIEWS"
                  label="How do you want to review?"
                  testid="library-pinned-view"
                />
              </ToolRow>
            </template>
            <ol class="library-rows" data-testid="library-pinned-rows">
              <li v-for="row in rows" :key="row.id" class="library-row">{{ row.name }}</li>
            </ol>
          </PinnedTools>
        </ScrollBox>
        <ReadOut label="View" :value="labelOf(VIEWS, view)" />
      </div>
    </LibraryPanel>
  </LibrarySection>
</template>

<style scoped>
.library-demo {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}

/* A toolbar is as wide as a screen's card, so each panel spans its section's grid. */
.library-wide {
  grid-column: 1 / -1;
}

/* The card a toolbar spans, so its rule runs from edge to edge. */
.library-card {
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.library-select__field {
  width: auto;
  font-variant-numeric: tabular-nums;
}

.library-count {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.library-search {
  flex: 1 1 240px;
  min-width: 0;
}

/* A box with no frame and no banner above it, so the block pins at its top. */
.library-pinned-box {
  --banner-h: 0px;
  --market-frame-h: 0px;

  width: 100%;
  height: 20rem;
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.library-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.library-row {
  padding: var(--space-2) var(--space-6);
  border-block-end: 1px solid var(--mm-border);
  font-size: var(--text-sm);
}

/* The rows start where the toolbar's controls do, at a phone's gutter. */
@media (width <= 640px) {
  .library-row {
    padding-inline: var(--space-4);
  }
}
</style>
