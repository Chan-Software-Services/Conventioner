<script setup lang="ts">
/**
 * The layout page's selection card (T257): nothing selected, "Select tables to change them."; one
 * table, its code and where its centre stands, in metres from the floorplan's top-left corner;
 * several, how many and how many of them are in each section. Its fields put the selection in a
 * section or give it a table type, each reading "Mixed" while the selected tables differ; its
 * buttons turn the selection a quarter, duplicate it, line it up or space it evenly (the Align
 * menu) and remove it, with no question asked first, since Undo takes a removal back. For one
 * table, "Row of N…" opens a count to type and "Add row", which asks for that many more tables
 * going on along the table's line: the quick straight row, with no path to draw.
 *
 * Past Draft (`settled`) a table's seat is settled: the Section and Table type fields, Duplicate,
 * "Row of N…" and Remove are disabled, and Turn 90° and Align, which only move tables, stay.
 *
 * On a layout that follows the plan (`followsPlan`, T422) the seat's controls stay enabled past
 * Draft, the Table type field alone settled with the market's types (`typesSettled`), and one
 * table of a section gains a Number field: a whole number from 1 to the section's count in the
 * plan, a number another table holds swapping the two (`useLayoutEditor`'s `setNumber`), and
 * anything else saying what to type under it.
 */
import { computed, ref, useId, watch } from 'vue';
import type { FloorplanTable, TableTypeObject } from '@/assets/types/datatypes';
import RowMenu from '@/components/RowMenu.vue';
import IconExpandDown from '@/components/icons/IconExpandDown.vue';
import { plural } from '@/utils/utils';
import { placeInMetres, tableCode, type LayoutSection } from './layoutDrawing';
import type { Alignment } from './layoutGeometry';
import { MAX_LENGTH_CM } from './layoutLength';
import { rowFieldErrors } from './layoutRow';

/** What the Align menu offers: an edge or a centre to line up by, or an even spacing. */
export type Arrangement = Alignment | 'across' | 'down';

const props = defineProps<{
  /** The selected tables. */
  tables: readonly FloorplanTable[];
  /** The location's sections, as the map draws them. */
  sections: readonly LayoutSection[];
  tableTypes: readonly TableTypeObject[];
  /** Whether the layout's seats are settled, so no table is added, removed, re-sectioned or
   *  re-typed. */
  settled?: boolean;
  /** Whether the market's table types are settled, so no table is re-typed; unsaid, as the seats. */
  typesSettled?: boolean;
  /** Whether the layout follows the plan, so one table of a section is numbered by hand. */
  followsPlan?: boolean;
}>();

const emit = defineEmits<{
  turn: [];
  remove: [];
  duplicate: [];
  arrange: [how: Arrangement];
  /** The section chosen for the selection; null is no section. */
  section: [sectionId: string | null];
  type: [tableTypeId: string];
  /** That many more tables, going on along the one selected table's line. */
  row: [count: number];
  /** The number typed for the one selected table, a whole one from 1 to its section's count. */
  number: [number: number];
}>();

const titleId = useId();
const sectionFieldId = useId();
const typeFieldId = useId();
const rowFormId = useId();
const rowCountId = useId();
const numberFieldId = useId();
const numberErrorId = useId();

/** The most tables one "Add row" asks for. */
const MOST_IN_A_ROW = 100;
/** Whether the count of "Row of N…" is open, and what is typed in it. */
const rowOpen = ref(false);
const rowCount = ref('5');
/** The count typed, as a whole number from 1; null while it is none. */
const rowAsked = computed(() => {
  const count = Number(rowCount.value);
  return Number.isInteger(count) && count >= 1 && count <= MOST_IN_A_ROW ? count : null;
});

/** Why "Add row" is off while Row of tables' gap, which the row takes, is no length: the Gap
 *  field and its own sentence stand only in the tool card, off the screen here. */
const gapRefusal = computed(() =>
  rowFieldErrors().gap
    ? `Row of tables' gap is no length. Type it in centimetres, 0 to ${MAX_LENGTH_CM.toLocaleString('en')}, with Row of tables on.`
    : '',
);
const rowGapErrorId = useId();

function addRow() {
  if (rowAsked.value !== null && !gapRefusal.value) emit('row', rowAsked.value);
}

// The count is one table's: it closes when the selection is no longer the one table, or once no
// table may be added.
watch(
  () => props.tables.length === 1 && !props.settled,
  (open) => {
    if (!open) rowOpen.value = false;
  },
);

const NO_SECTION = 'Table in no section';
/** The value a field holds while the selected tables differ. */
const MIXED = '\u0000mixed';

function sectionOf(table: FloorplanTable) {
  if (table.number === null) return null;
  return props.sections.find(({ section }) => section.id === table.sectionId)?.section ?? null;
}

/** Several tables, counted by section in the sections' order, no section last: "15 in B, 12 in
 *  no section" (the QC walk of 2026-11-16). A list of every table's code said one name many
 *  times over and the rest as "and 17 more", which told nothing a count does not. */
const counts = computed(() => {
  const counted = new Map<string | null, number>();
  for (const table of props.tables) {
    const id = sectionOf(table)?.id ?? null;
    counted.set(id, (counted.get(id) ?? 0) + 1);
  }
  const parts = props.sections
    .filter(({ section }) => counted.has(section.id))
    .map(({ section }) => `${counted.get(section.id)} in ${section.name}`);
  if (counted.has(null)) parts.push(`${counted.get(null)} in no section`);
  return parts.join(', ');
});

/** Whether a table's type may change here. */
const typeSettled = computed(() => props.typesSettled ?? props.settled);

/** The one selected table's section and its count in the plan, on a layout that follows it. */
const numbered = computed(() => {
  if (!props.followsPlan || props.tables.length !== 1) return null;
  const table = props.tables[0];
  const section = sectionOf(table);
  return section ? { id: table.id, number: table.number, count: section.count } : null;
});
/** What the Number field holds, and what it says of what was typed that is no number to take. */
const numberTyped = ref('');
const numberError = ref('');
watch(
  () => numbered.value && `${numbered.value.id}:${numbered.value.number}`,
  () => {
    numberTyped.value = String(numbered.value?.number ?? '');
    numberError.value = '';
  },
  { immediate: true },
);

function setNumber() {
  const held = numbered.value;
  if (!held) return;
  const typed = numberTyped.value.trim();
  // Digits alone: `Number` would read "0x3", "1e0" and "3.0" as whole numbers too.
  const number = /^\d+$/.test(typed) ? Number(typed) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > held.count) {
    numberError.value = `Type a number from 1 to ${held.count}.`;
    return;
  }
  numberError.value = '';
  if (number !== held.number) emit('number', number);
}

/** The one selected table, as the card reads it. */
const one = computed(() => {
  if (props.tables.length !== 1) return null;
  const table = props.tables[0];
  return {
    code: tableCode(table, sectionOf(table)) ?? NO_SECTION,
    position: placeInMetres(table),
  };
});

/** The one value every selected table has, or `MIXED`. */
function shared(values: string[]): string {
  return values.every((value) => value === values[0]) ? (values[0] ?? '') : MIXED;
}

/** The selection's section: '' is no section. */
const sectionValue = computed(() =>
  shared(props.tables.map((table) => sectionOf(table)?.id ?? '')),
);
const typeValue = computed(() => shared(props.tables.map((table) => table.tableTypeId)));
/** A type that is not one of the market's is offered by no option: the field reads it as unknown. */
const typeKnown = computed(
  () => typeValue.value === MIXED || props.tableTypes.some((type) => type.id === typeValue.value),
);

function chosen(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

const ARRANGEMENTS: readonly { id: Arrangement; label: string }[] = [
  { id: 'left', label: 'Align left' },
  { id: 'centre', label: 'Align centre' },
  { id: 'right', label: 'Align right' },
  { id: 'top', label: 'Align top' },
  { id: 'middle', label: 'Align middle' },
  { id: 'bottom', label: 'Align bottom' },
  { id: 'across', label: 'Space evenly across' },
  { id: 'down', label: 'Space evenly down' },
];
</script>

<template>
  <section :aria-labelledby="titleId" data-testid="layout-panel-selection">
    <h2 :id="titleId" class="selection-title" data-testid="layout-selection-title">
      <template v-if="one">{{ one.code }}</template>
      <template v-else-if="tables.length">
        {{ plural(tables.length, 'table', 'tables') }} selected
      </template>
      <template v-else>Selection</template>
    </h2>
    <p v-if="!tables.length" class="selection-text" data-testid="layout-selection-none">
      Select tables to change them.
    </p>
    <template v-else>
      <p v-if="!one" class="selection-text" data-testid="layout-selection-counts">{{ counts }}</p>
      <div class="selection-fields">
        <label class="selection-field-name" :for="sectionFieldId">Section</label>
        <select
          :id="sectionFieldId"
          class="field field--select"
          :value="sectionValue"
          :disabled="settled"
          data-testid="layout-selection-section"
          @change="emit('section', chosen($event) || null)"
        >
          <option v-if="sectionValue === MIXED" :value="MIXED" disabled>Mixed</option>
          <option v-for="{ section } in sections" :key="section.id" :value="section.id">
            {{ section.name || 'Unnamed section' }}
          </option>
          <option value="">No section</option>
        </select>
        <label class="selection-field-name" :for="typeFieldId">Table type</label>
        <select
          :id="typeFieldId"
          class="field field--select"
          :value="typeValue"
          :disabled="typeSettled"
          data-testid="layout-selection-type"
          @change="emit('type', chosen($event))"
        >
          <option v-if="typeValue === MIXED" :value="MIXED" disabled>Mixed</option>
          <option v-else-if="!typeKnown" :value="typeValue" disabled>Unknown type</option>
          <option v-for="type in tableTypes" :key="type.id" :value="type.id">
            {{ type.name }}
          </option>
        </select>
        <template v-if="numbered">
          <label class="selection-field-name" :for="numberFieldId">Number</label>
          <div class="selection-number">
            <input
              :id="numberFieldId"
              v-model="numberTyped"
              class="field selection-number-field"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              :aria-invalid="numberError ? 'true' : undefined"
              :aria-describedby="numberError ? numberErrorId : undefined"
              data-testid="layout-selection-number"
              @change="setNumber"
              @keydown.enter.prevent="setNumber"
            />
            <p
              v-if="numberError"
              :id="numberErrorId"
              class="selection-number-error"
              data-testid="layout-selection-number-error"
            >
              {{ numberError }}
            </p>
          </div>
        </template>
        <template v-if="one">
          <span class="selection-field-name">Position</span>
          <span class="selection-position" data-testid="layout-selection-position">
            {{ one.position }}
          </span>
        </template>
      </div>
      <div class="selection-actions">
        <button
          type="button"
          class="btn btn--secondary"
          data-testid="layout-selection-turn"
          @click="emit('turn')"
        >
          Turn 90°
        </button>
        <button
          type="button"
          class="btn btn--secondary"
          :disabled="settled"
          data-testid="layout-selection-duplicate"
          @click="emit('duplicate')"
        >
          Duplicate
        </button>
        <RowMenu
          v-if="tables.length > 1"
          class="selection-align"
          label="Align the selected tables"
          :items="ARRANGEMENTS"
          testid="layout-selection-align"
          @select="emit('arrange', $event as Arrangement)"
        >
          <template #trigger>
            Align
            <IconExpandDown class="selection-align-chevron" aria-hidden="true" />
          </template>
        </RowMenu>
        <button
          v-if="one"
          type="button"
          class="btn btn--secondary"
          :aria-expanded="rowOpen"
          :aria-controls="rowFormId"
          :disabled="settled"
          data-testid="layout-selection-row"
          @click="rowOpen = !rowOpen"
        >
          Row of N…
        </button>
        <button
          type="button"
          class="btn btn--secondary btn--destructive"
          :disabled="settled"
          data-testid="layout-selection-remove"
          @click="emit('remove')"
        >
          Remove
        </button>
      </div>
      <form
        v-if="one"
        v-show="rowOpen"
        :id="rowFormId"
        class="selection-row"
        data-testid="layout-selection-row-form"
        @submit.prevent="addRow"
      >
        <label class="selection-field-name" :for="rowCountId">Tables to add</label>
        <input
          :id="rowCountId"
          v-model="rowCount"
          class="field selection-row-count"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          :aria-describedby="gapRefusal ? rowGapErrorId : undefined"
          data-testid="layout-selection-row-count"
        />
        <button
          type="submit"
          class="btn btn--secondary"
          :disabled="rowAsked === null || !!gapRefusal"
          data-testid="layout-selection-row-add"
        >
          Add row
        </button>
        <p class="selection-row-note">
          They go on along {{ one.code }}'s line, with the gap of Row of tables.
        </p>
        <p
          v-if="gapRefusal"
          :id="rowGapErrorId"
          class="selection-row-error"
          data-testid="layout-selection-row-gap-error"
        >
          {{ gapRefusal }}
        </p>
      </form>
    </template>
  </section>
</template>

<style scoped>
.selection-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.selection-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--mm-black);
  overflow-wrap: anywhere;
}

/* Each field beside its name, the names in one column. */
.selection-fields {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2) var(--space-3);
  width: 100%;
  font-size: var(--text-sm);
}

.selection-field-name {
  color: var(--mm-text-muted);
  white-space: nowrap;
}

.selection-position {
  text-align: right;
}

/* The Number field, its sentence under it when what was typed is no number to take. */
.selection-number {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
}

.selection-number-field {
  width: 4.5rem;
}

.selection-number-error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-red);
  text-align: right;
}

.selection-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

/* "Row of N…": the count beside its name and its button, the note under them. */
.selection-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  width: 100%;
  font-size: var(--text-sm);
}

.selection-row-count {
  width: 4.5rem;
}

.selection-row-note {
  flex: 1 0 100%;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}

.selection-row-error {
  flex: 1 0 100%;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--mm-red);
}

/* The menu's button stands in the row of buttons as one of them: the secondary button's edge and
   height round its words. */
.selection-align :deep(.row-menu-button--words) {
  height: var(--control-height);
  padding: 0 var(--space-4);
  border: 1px solid var(--mm-border);
  background: white;
}

.selection-align :deep(.row-menu-button--words:hover),
.selection-align :deep(.row-menu-button--words[aria-expanded='true']) {
  background: var(--mm-white-hover);
}

.selection-align-chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}
</style>
