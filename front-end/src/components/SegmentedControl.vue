<script setup lang="ts">
/**
 * A choice of one among a few, drawn as one joined box (T466, release walk F5 and F7): List and
 * Map, All and One by one, the review's statuses.
 *
 * Unlike `FilterToggles`, one option is always on: pressing the pressed one again emits nothing.
 * Each option is a compact secondary `.btn` with `aria-pressed`, its test id `<testid>-<id>`, in the
 * options' order, so the group reads as the toggle row it replaces.
 *
 * The box joins with no overlap: every option keeps its own 1px border, one after the first gives
 * up its start edge, and the option before the pressed one colours its end edge green, so the
 * pressed option shows green on all four sides with no negative margin. Only the outer corners
 * are round. With `wrapsOnAPhone` a phone wraps the options a small step apart, each whole and
 * round; without it the box stays joined, as two short options fit any phone.
 */
export interface SegmentedOption {
  id: string;
  label: string;
}

const props = defineProps<{
  options: readonly SegmentedOption[];
  modelValue: string;
  /** The group's name, for a screen reader: what the choice is of. */
  label: string;
  testid: string;
  /** The id of words that describe the choice, such as a hint. */
  describedBy?: string;
  /** At 640px and under, wrap the options apart rather than keep the joined box. */
  wrapsOnAPhone?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function press(id: string): void {
  if (id !== props.modelValue) emit('update:modelValue', id);
}
</script>

<template>
  <div
    class="segmented"
    :class="{ 'segmented--wraps': wrapsOnAPhone }"
    role="group"
    :aria-label="label"
    :aria-describedby="describedBy"
    :data-testid="testid"
  >
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="btn btn--secondary btn--compact segmented__option"
      :aria-pressed="option.id === modelValue"
      :data-testid="`${testid}-${option.id}`"
      @click="press(option.id)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: flex;
  min-width: 0;
}

/* A label never wraps inside the joined box, and a short one is still a whole target. */
.segmented__option {
  min-width: var(--target-min);
  border-radius: 0;
  white-space: nowrap;
}

.segmented__option + .segmented__option {
  border-inline-start-width: 0;
}

.segmented__option:first-child {
  border-start-start-radius: var(--radius-control);
  border-end-start-radius: var(--radius-control);
}

.segmented__option:last-child {
  border-start-end-radius: var(--radius-control);
  border-end-end-radius: var(--radius-control);
}

/* The pressed option's start edge is the end edge of the option before it. */
.segmented__option:has(+ [aria-pressed='true']) {
  border-inline-end-color: var(--mm-green);
}

@media (width <= 640px) {
  .segmented--wraps {
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .segmented--wraps .segmented__option {
    border-width: 1px;
    border-radius: var(--radius-control);
  }

  /* Apart, each option draws its own edges, so the one before the pressed one keeps its grey. */
  .segmented--wraps .segmented__option:has(+ [aria-pressed='true']) {
    border-inline-end-color: var(--mm-border);
  }
}
</style>
