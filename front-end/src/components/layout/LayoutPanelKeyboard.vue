<script setup lang="ts">
/**
 * The layout editor's keyboard shortcuts (T257), in the panel the keyboard button or `?` shows
 * beside the page (T422): what each key does is `LayoutEditor.vue`'s to do; this list only names
 * them, group by group, the tools' keys first, as the hint under the map says the few that matter
 * where the keys are.
 *
 * Past Draft (`settled`) it leaves out the keys that add or remove tables, which do nothing there:
 * Delete, Ctrl+D, Add table's Enter, and the Row of tables and Fill an area groups.
 */
import { computed } from 'vue';

const props = defineProps<{
  /** Whether the layout's seats are settled, so no table is added or removed. */
  settled?: boolean;
}>();

/** A key, what it does, and whether it adds or removes tables. */
type Key = readonly [string[], string, 'seats'?];

const GROUPS: readonly {
  title: string;
  keys: readonly Key[];
  /** Every key of it adds tables. */
  seats?: true;
  /** Its title once its keys that add tables are left out. */
  settledTitle?: string;
}[] = [
  {
    title: 'Tools',
    keys: [
      [['V'], 'Select'],
      [['T'], 'Add table', 'seats'],
      [['W'], 'Row of tables', 'seats'],
      [['A'], 'Fill an area', 'seats'],
      [['Z'], 'No-table zone'],
      [['Escape', 'Right-click'], 'Back to Select, with nothing being drawn'],
      [['?'], 'Show or hide these shortcuts'],
    ],
  },
  {
    title: 'On the map',
    keys: [
      [['Arrow keys'], 'With nothing selected, move to the nearest table that way'],
      [['Enter', 'Space'], 'Pick up the table, or the selection it is in'],
      [['Shift+Enter'], 'Select the table, or take it out'],
    ],
  },
  {
    title: 'With tables picked up',
    keys: [
      [['Arrow keys'], 'Move them 10 cm, or 1 m with Shift'],
      [['R'], 'Turn them 90°, or 15° with Shift'],
      [['Enter', 'Space'], 'Drop them'],
      [['Escape'], 'Put them back'],
    ],
  },
  {
    title: 'The selection',
    keys: [
      [['Arrow keys'], 'Move it 10 cm, or 1 m with Shift'],
      [['Alt+Arrow keys'], 'Move to the nearest table that way'],
      [['R'], 'Turn it 90°, or 15° with Shift'],
      [['Shift+drag a corner'], 'Turn it by the degree, not in 15° steps'],
      [['Delete', 'Backspace'], 'Remove it', 'seats'],
      [['Ctrl+D'], 'Duplicate it', 'seats'],
      [['Ctrl+A'], 'Select every table'],
      [['Escape'], 'Select nothing'],
    ],
  },
  {
    title: 'With Row of tables on',
    seats: true,
    keys: [
      [['Arrow keys'], 'Move the crosshair 10 cm, or 1 m with Shift'],
      [['Enter'], 'Lay a point of the row at the crosshair'],
      [['Backspace'], 'Take the last point back, or open a closed shape again'],
      [['C'], 'Close the path into a shape, of three points or more'],
      [['F'], 'Swap the side of the line the tables stand on'],
      [['Ctrl+Enter'], 'Place the row; Enter places a closed shape'],
      [['Escape'], 'Drop the row'],
      [['Shift'], 'While dragging: a straight row'],
      [['Shift+click'], 'Lay a point at any angle; a click holds the line to 15° steps'],
    ],
  },
  {
    title: 'With Fill an area on',
    seats: true,
    keys: [
      [['Arrow keys'], 'Move the crosshair 10 cm, or 1 m with Shift'],
      [['Enter'], 'Lay a corner of the area at the crosshair'],
      [['Backspace'], 'Take the last corner back'],
      [['Ctrl+Enter'], 'Close the area, of three corners or more, and ask how to fill it'],
      [['Escape'], 'Drop the area'],
    ],
  },
  {
    title: 'Adding, undo and the view',
    settledTitle: 'Undo and the view',
    keys: [
      [['Enter'], 'With Add table on, place a table at the middle of the view', 'seats'],
      [['Ctrl+Z'], 'Undo'],
      [['Ctrl+Shift+Z', 'Ctrl+Y'], 'Redo'],
      [['+', '-'], 'Zoom in and out'],
      [['0'], 'Fit the floorplan'],
    ],
  },
];

/** The groups and keys that do something now. */
const shown = computed(() =>
  props.settled
    ? GROUPS.filter((group) => !group.seats).map((group) => ({
        ...group,
        title: group.settledTitle ?? group.title,
        keys: group.keys.filter((key) => key[2] !== 'seats'),
      }))
    : GROUPS,
);
</script>

<template>
  <section data-testid="layout-panel-keyboard">
    <div class="keyboard">
      <h2 class="keyboard-heading">Keyboard shortcuts</h2>
      <template v-for="group in shown" :key="group.title">
        <h3 class="keyboard-group">{{ group.title }}</h3>
        <dl class="keyboard-keys">
          <template v-for="[keys, does] in group.keys" :key="does">
            <dt>
              <template v-for="(key, index) in keys" :key="key">
                <span v-if="index"> or </span><kbd>{{ key }}</kbd>
              </template>
            </dt>
            <dd>{{ does }}</dd>
          </template>
        </dl>
      </template>
      <p class="keyboard-note">On a Mac, Command stands in for Ctrl.</p>
    </div>
  </section>
</template>

<style scoped>
.keyboard {
  width: 100%;
}

.keyboard-heading {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.keyboard-heading + .keyboard-group {
  margin-top: var(--space-2);
}

.keyboard-group {
  margin: var(--space-3) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

/* The keys in one column and what they do beside them, every group's columns the same width. */
.keyboard-keys {
  display: grid;
  /* Room for the longest keys on one line. */
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
}

.keyboard-keys dd {
  margin: 0;
}

.keyboard-keys kbd {
  padding: 0 var(--space-1);
  border: 1px solid var(--mm-border);
  border-radius: var(--radius-control);
  background: var(--mm-beige);
  font-family: inherit;
  font-size: var(--text-xs);
  white-space: nowrap;
}

.keyboard-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--mm-text-muted);
}
</style>
