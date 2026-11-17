<script setup lang="ts">
/**
 * The card of the layout editor's tool on (T422, the QC walk of 2026-11-16): Add table, Row of
 * tables or Fill an area, in the layout page's panel under the sections, in place of the selection's
 * card, so the map never moves as the tool changes. The page renders it beside the editor
 * (`LayoutView.vue`), which holds the tool on and the section and type it adds; the editor holds
 * what the tool does with them.
 *
 * Section and Table type stand once at its head and carry from one adding tool to the next. Row of
 * tables adds where its tables stand on the line, Centred on the line first and at first (item
 * 17), the gap, the rows, the aisle between rows of more than one, and Spread evenly to the ends;
 * their values are the app's while it is open (`rowChoices`). Fill an area adds "Fill what is in
 * view". Both take Group tables, so many to a group with a spacer between groups, one choice for
 * the two (`groupChoices`, item 15); a group field that holds no usable number says so under them
 * (D9). Its last line says a right-click on the map or Escape goes back to Select.
 */
import { computed, useId } from 'vue';
import type { SectionObject, TableTypeObject } from '@/assets/types/datatypes';
import { groupChoices, groupFieldErrors } from './layoutGroups';
import { rowChoices, rowFieldErrors, rowsOf } from './layoutRow';
import { TOOL_NAMES, type AddingTool } from './layoutTools';

defineProps<{
  /** The tool on, one that adds tables. */
  tool: AddingTool;
  /** The location's sections a table may be put in. */
  sections: readonly SectionObject[];
  tableTypes: readonly TableTypeObject[];
  /** Whether the row being drawn is a closed shape, whose tables cannot be spread to its ends. */
  rowClosed?: boolean;
}>();
/** The section a new table takes: '' is "No section", null no choice made yet. */
const sectionId = defineModel<string | null>('sectionId', { default: null });
/** The type a new table takes. */
const typeId = defineModel<string>('typeId', { default: '' });
const emit = defineEmits<{
  /** Swap the side of the line a row's tables stand on. */
  flip: [];
  /** Fill what the map shows of the floorplan. */
  fillInView: [];
}>();

const toolCardTitleId = useId();
/** What Gap and Aisle say of a value that is no length, each under its own id. */
const rowErrors = computed(rowFieldErrors);
/** What Per group and Spacer say of a value they cannot use, while grouping is on. */
const groupErrors = computed(() => groupFieldErrors());
/** The Aisle's sentence, only while the field stands: one row has no aisle. */
const aisleError = computed(() => (rowsOf(rowChoices.rows) > 1 ? rowErrors.value.aisle : ''));
</script>

<template>
  <section
    class="layout-tool-card"
    :aria-labelledby="toolCardTitleId"
    data-testid="layout-add-options"
  >
    <h2 :id="toolCardTitleId" class="layout-tool-card__title">{{ TOOL_NAMES[tool] }}</h2>
    <div class="layout-tool-card__fields">
      <label class="layout-tool-card__name" :for="`${toolCardTitleId}-section`">Section</label>
      <select
        :id="`${toolCardTitleId}-section`"
        v-model="sectionId"
        class="field field--select"
        data-testid="layout-add-section"
      >
        <option v-for="section in sections" :key="section.id" :value="section.id">
          {{ section.name || 'Unnamed section' }}
        </option>
        <option value="">No section</option>
      </select>
      <label class="layout-tool-card__name" :for="`${toolCardTitleId}-type`">Table type</label>
      <select
        :id="`${toolCardTitleId}-type`"
        v-model="typeId"
        class="field field--select"
        data-testid="layout-add-type"
      >
        <option v-for="type in tableTypes" :key="type.id" :value="type.id">
          {{ type.name }}
        </option>
      </select>
      <template v-if="tool === 'row'">
        <span class="layout-tool-card__name" :id="`${toolCardTitleId}-stand`">Tables</span>
        <div
          class="layout-tool-card__choices"
          role="radiogroup"
          :aria-labelledby="`${toolCardTitleId}-stand`"
          data-testid="layout-row-stand"
        >
          <label class="layout-tool-card__choice">
            <input
              v-model="rowChoices.centred"
              type="radio"
              :value="true"
              data-testid="layout-row-centred"
            />
            Centred on the line
          </label>
          <label class="layout-tool-card__choice">
            <input
              v-model="rowChoices.centred"
              type="radio"
              :value="false"
              data-testid="layout-row-beside"
            />
            Beside the line
          </label>
          <button
            v-if="!rowChoices.centred"
            type="button"
            class="btn btn--secondary btn--compact layout-tool-card__flip"
            data-testid="layout-row-flip"
            @click="emit('flip')"
          >
            Flip side
          </button>
        </div>
        <label class="layout-tool-card__name" :for="`${toolCardTitleId}-gap`">Gap</label>
        <span class="layout-tool-card__unit">
          <input
            :id="`${toolCardTitleId}-gap`"
            v-model="rowChoices.gapCm"
            class="field layout-tool-card__number"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-invalid="!!rowErrors.gap"
            :aria-describedby="rowErrors.gap ? 'layout-row-gap-error' : undefined"
            data-testid="layout-row-gap"
          />
          cm between tables
        </span>
        <label class="layout-tool-card__name" :for="`${toolCardTitleId}-rows`">Rows</label>
        <input
          :id="`${toolCardTitleId}-rows`"
          v-model="rowChoices.rows"
          class="field layout-tool-card__number"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          data-testid="layout-row-rows"
        />
        <template v-if="rowsOf(rowChoices.rows) > 1">
          <label class="layout-tool-card__name" :for="`${toolCardTitleId}-aisle`">Aisle</label>
          <span class="layout-tool-card__unit">
            <input
              :id="`${toolCardTitleId}-aisle`"
              v-model="rowChoices.aisleCm"
              class="field layout-tool-card__number"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              :aria-invalid="!!rowErrors.aisle"
              :aria-describedby="rowErrors.aisle ? 'layout-row-aisle-error' : undefined"
              data-testid="layout-row-aisle"
            />
            cm between rows
          </span>
        </template>
        <label class="layout-tool-card__tick">
          <input
            v-model="rowChoices.spread"
            type="checkbox"
            :disabled="rowClosed"
            data-testid="layout-row-spread"
          />
          Spread evenly to the ends
        </label>
        <p v-if="rowErrors.gap || aisleError" class="layout-tool-card__error">
          <span
            v-if="rowErrors.gap"
            id="layout-row-gap-error"
            role="alert"
            data-testid="layout-row-gap-error"
            >{{ rowErrors.gap }}</span
          >
          <span
            v-if="aisleError"
            id="layout-row-aisle-error"
            role="alert"
            data-testid="layout-row-aisle-error"
            >{{ aisleError }}</span
          >
        </p>
      </template>
      <template v-if="tool === 'row' || tool === 'fill'">
        <label class="layout-tool-card__tick">
          <input v-model="groupChoices.grouped" type="checkbox" data-testid="layout-group" />
          Group tables
        </label>
        <template v-if="groupChoices.grouped">
          <label class="layout-tool-card__name" :for="`${toolCardTitleId}-group-size`">
            Per group
          </label>
          <span class="layout-tool-card__unit">
            <input
              :id="`${toolCardTitleId}-group-size`"
              v-model="groupChoices.size"
              class="field layout-tool-card__number"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              :aria-invalid="!!groupErrors.size"
              :aria-describedby="groupErrors.size ? 'layout-group-size-error' : undefined"
              data-testid="layout-group-size"
            />
            tables
          </span>
          <label class="layout-tool-card__name" :for="`${toolCardTitleId}-group-spacer`">
            Spacer
          </label>
          <span class="layout-tool-card__unit">
            <input
              :id="`${toolCardTitleId}-group-spacer`"
              v-model="groupChoices.spacerCm"
              class="field layout-tool-card__number"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              :aria-invalid="!!groupErrors.spacer"
              :aria-describedby="groupErrors.spacer ? 'layout-group-spacer-error' : undefined"
              data-testid="layout-group-spacer"
            />
            cm between groups
          </span>
          <p v-if="groupErrors.size || groupErrors.spacer" class="layout-tool-card__error">
            <span
              v-if="groupErrors.size"
              id="layout-group-size-error"
              role="alert"
              data-testid="layout-group-size-error"
              >{{ groupErrors.size }}</span
            >
            <span
              v-if="groupErrors.spacer"
              id="layout-group-spacer-error"
              role="alert"
              data-testid="layout-group-spacer-error"
              >{{ groupErrors.spacer }}</span
            >
          </p>
        </template>
      </template>
    </div>
    <button
      v-if="tool === 'fill'"
      type="button"
      class="btn btn--secondary btn--compact"
      data-testid="layout-fill-view"
      @click="emit('fillInView')"
    >
      Fill what is in view
    </button>
    <p class="layout-tool-card__back">Right-click the map or press Escape for Select.</p>
  </section>
</template>

<style scoped>
/* The tool's card in the panel, drawn as the panel's cards are. */
.layout-tool-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background: white;
  box-shadow: var(--shadow-card);
}

.layout-tool-card__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.layout-tool-card__back {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

/* Each field beside its name, the names in one column, as the selection's card has them. */
.layout-tool-card__fields {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2) var(--space-3);
  width: 100%;
  font-size: var(--text-sm);
}

.layout-tool-card__name {
  color: var(--mm-text-muted);
  white-space: nowrap;
}

.layout-tool-card__choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.layout-tool-card__choice,
.layout-tool-card__tick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.layout-tool-card__tick {
  grid-column: 1 / -1;
}

.layout-tool-card__unit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--mm-text-muted);
}

.layout-tool-card__number {
  width: 4.5rem;
}

.layout-tool-card__error {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-red);
}
</style>
