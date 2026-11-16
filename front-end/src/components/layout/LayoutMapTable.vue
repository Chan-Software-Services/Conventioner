<script setup lang="ts">
/**
 * One table of a layout's drawing (T257), for `LayoutMap.vue` alone: a rounded rectangle at its
 * true size about its centre, turned with the table, filled and edged in its section's paint, its
 * number in the middle. Every prop is a plain value, so a table whose own values did not change is
 * not drawn again when another moves.
 *
 * Its paint is written on the elements (`fill="var(--token)"`), not in a class, so the drawing
 * carries what it looks like wherever its markup goes; lengths the eye reads in pixels (the edge,
 * the selection's outline, the focus border) are given in millimetres for the scale it is drawn at.
 *
 * Focus shows as the app's button border, drawn by the table itself: a browser reads a CSS
 * outline's width on an SVG shape in the drawing's units, so the app's 2px outline would be a
 * fraction of a pixel here. The border is a shape over the table's own edge, turned with it, 2px
 * on the screen and never past the edge, so focus moves nothing; and in the deep green
 * (`--focus-border-on-fill`), since the edge it lies over is a section's colour, which the plain
 * green shows on only by chance. The focus sweep reads it by its `data-focus-border`.
 *
 * A table picked up by keyboard (`carried`) is drawn lifted: a shadow 3 px under it, straight down
 * the screen however the table is turned, and its selection's outline dashed.
 *
 * On a day's map (T422) a table is painted in its seat's tone, and a shared table is drawn as its
 * two `halves` (D41): each half its own shape and paint and label, each half with a seat a button
 * of its own carrying the seat's key, a half with none drawn and never pressed; the table itself is
 * then no button. Each button says which it is when it takes the focus.
 */
import { computed } from 'vue';
import { OUTLINE_OUT_PX, OUTLINE_WIDTH_PX, grownTable, readsUpsideDown } from './layoutGeometry';
import { paintValue } from './layoutDrawing';

/** One half of a shared table as `LayoutMap` draws it, in the table's own turn. */
export interface DrawnHalf {
  side: 'left' | 'right';
  /** The key of the seat at it, or null where the half is free and no button. */
  seatKey: string | null;
  /** What a screen reader calls it, as a button. */
  name: string;
  /** Its shape, and the focus border's inside its edge. */
  d: string;
  focusD: string;
  fill: string;
  edge: string;
  dashes?: string;
  ink: string;
  /** Its label, "12L", at the middle of its box; a size of 0 leaves it out. */
  label: string;
  labelSizeMm: number;
  xMm: number;
  yMm: number;
  /** Whether the Tab key stops on it. */
  tabStop: boolean;
}

const props = defineProps<{
  id: string;
  name: string;
  xMm: number;
  yMm: number;
  rotation: number;
  widthMm: number;
  depthMm: number;
  /** The tokens it is filled and edged with (or a CSS colour, `white`), its edge's dashes when it
   *  has any, and the ink of its number. */
  fill: string;
  edge: string;
  dashes?: string;
  ink?: string;
  /** The key of the seat that holds the whole table, on a day's map. */
  seatKey?: string | null;
  /** A shared table's two halves, drawn in place of the table's one top. */
  halves?: readonly DrawnHalf[] | null;
  /** Its number, or nothing for a table in no section. */
  number: string;
  /** The number's size, in millimetres at the map's scale; 0 leaves it out. */
  numberSizeMm: number;
  selected: boolean;
  /** Picked up by keyboard, in the editor: drawn lifted off the floor. */
  carried?: boolean;
  /** Whether it is pressed, where a press selects it (the editor); unsaid where it does not. */
  pressed?: boolean;
  /** A button a keyboard reaches, in the read and edit modes; a shape alone in print. */
  interactive: boolean;
  /** The one table of the map the Tab key stops on. */
  tabStop: boolean;
  /** Millimetres to a screen pixel, at the map's scale. */
  mmPerPx: number;
}>();

const emit = defineEmits<{
  /** The table, or one of its halves (`target`, "<id>#left"), took the focus. It says so itself: a
   *  focus listener on the map's `<svg>` would make Chromium count the map as a Tab stop of its
   *  own, before its tables. */
  focused: [id: string, target: string];
}>();

/** Whether the table is one button: a shared table's halves are buttons in its place. */
const oneButton = computed(() => props.interactive && !props.halves);
const halfButton = (half: DrawnHalf) => props.interactive && half.seatKey !== null;

/** The table's rectangle grown by `px` screen pixels on every side. */
const grown = (px: number) => grownTable(props, px * props.mmPerPx);

const top = computed(() => grown(0));
/** The selection's outline: 1.5 px of --mm-black, flush on the outside of the table's edge. */
const outline = computed(() => grown(OUTLINE_OUT_PX));
/** The focus border: 2 px over the table's 1.5 px edge, their outer sides together. */
const focusBorder = computed(() => grown(-0.25));

/** How far under a carried table its shadow lies, in screen pixels. */
const LIFT_PX = 3;
/** The shadow's place: down the screen, which in the turned table's own axes is turned back. */
const shadow = computed(() => {
  const turn = (-props.rotation * Math.PI) / 180;
  const by = LIFT_PX * props.mmPerPx;
  return { ...top.value, transform: `translate(${-by * Math.sin(turn)} ${by * Math.cos(turn)})` };
});
</script>

<template>
  <g
    class="layout-table"
    :class="{ 'layout-table--button': oneButton }"
    :transform="`translate(${xMm} ${yMm}) rotate(${rotation})`"
    :role="oneButton ? 'button' : undefined"
    :tabindex="oneButton ? (tabStop ? 0 : -1) : undefined"
    :aria-label="oneButton ? name : undefined"
    :aria-pressed="oneButton ? pressed : undefined"
    :data-table-id="id"
    :data-target="oneButton ? id : undefined"
    :data-seat-key="seatKey ?? undefined"
    :data-selected="selected ? '' : undefined"
    :data-carried="carried ? '' : undefined"
    data-testid="layout-table"
    v-on="oneButton ? { focus: () => emit('focused', id, id) } : {}"
  >
    <!-- Only a button listens for focus, the table or a seated half: Chromium makes an SVG element
         with a focus listener a Tab stop of its own, so a shared table, whose halves are the
         buttons, or a free half, would be one too. -->
    <template v-if="halves">
      <g
        v-for="half in halves"
        :key="half.side"
        class="layout-table__half"
        :class="{ 'layout-table--button': halfButton(half) }"
        :role="halfButton(half) ? 'button' : undefined"
        :tabindex="halfButton(half) ? (half.tabStop ? 0 : -1) : undefined"
        :aria-label="halfButton(half) ? half.name : undefined"
        :data-half="half.side"
        :data-target="halfButton(half) ? `${id}#${half.side}` : undefined"
        :data-seat-key="half.seatKey ?? undefined"
        data-testid="layout-table-half"
        v-on="halfButton(half) ? { focus: () => emit('focused', id, `${id}#${half.side}`) } : {}"
      >
        <path
          :d="half.d"
          :fill="paintValue(half.fill)"
          :stroke="paintValue(half.edge)"
          stroke-width="1.5"
          :stroke-dasharray="half.dashes"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="halfButton(half) && half.tabStop"
          class="layout-table__focus"
          :d="half.focusD"
          fill="none"
          stroke="var(--focus-border-on-fill)"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
          data-focus-border
        />
      </g>
      <!-- Each half's label stands beside its button, not in it: the button's name says the half
           in words, and a label inside it would be words it does not say. -->
      <template v-for="half in halves" :key="`label-${half.side}`">
        <text
          v-if="half.label && half.labelSizeMm > 0"
          class="layout-table__number"
          data-testid="layout-table-number"
          :data-label-of="half.side"
          :x="half.xMm"
          :y="half.yMm"
          :transform="readsUpsideDown(rotation) ? `rotate(180 ${half.xMm} ${half.yMm})` : undefined"
          :font-size="half.labelSizeMm"
          font-family="Outfit, sans-serif"
          font-weight="600"
          text-anchor="middle"
          dy="0.36em"
          :fill="paintValue(half.ink)"
          aria-hidden="true"
        >
          {{ half.label }}
        </text>
      </template>
    </template>
    <template v-else>
      <rect
        v-if="carried"
        class="layout-table__shadow"
        data-testid="layout-table-shadow"
        v-bind="shadow"
        fill="var(--mm-black)"
        fill-opacity="0.3"
        aria-hidden="true"
      />
      <rect
        class="layout-table__top"
        data-testid="layout-table-top"
        v-bind="top"
        :fill="paintValue(fill)"
        :stroke="paintValue(edge)"
        stroke-width="1.5"
        :stroke-dasharray="dashes"
        vector-effect="non-scaling-stroke"
      />
      <rect
        v-if="oneButton && tabStop"
        class="layout-table__focus"
        v-bind="focusBorder"
        fill="none"
        stroke="var(--focus-border-on-fill)"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        data-focus-border
      />
      <rect
        v-if="selected"
        class="layout-table__selected"
        data-testid="layout-table-selected"
        v-bind="outline"
        fill="none"
        stroke="var(--mm-black)"
        :stroke-width="OUTLINE_WIDTH_PX"
        :stroke-dasharray="carried ? '6 4' : undefined"
        vector-effect="non-scaling-stroke"
      />
      <text
        v-if="number && numberSizeMm > 0"
        class="layout-table__number"
        data-testid="layout-table-number"
        :transform="readsUpsideDown(rotation) ? 'rotate(180)' : undefined"
        :font-size="numberSizeMm"
        font-family="Outfit, sans-serif"
        font-weight="600"
        text-anchor="middle"
        dy="0.36em"
        :fill="paintValue(ink ?? '--mm-black')"
        aria-hidden="true"
      >
        {{ number }}
      </text>
    </template>
  </g>
</template>

<style scoped>
/* The table draws its own focus border (above), so the outline a button takes from primitives.css,
   too thin to see in a drawing's units, is not drawn as well. */
.layout-table {
  outline: none;
}

.layout-table--button {
  cursor: pointer;
}

.layout-table__focus {
  display: none;
}

.layout-table:focus-visible > .layout-table__focus,
.layout-table__half:focus-visible > .layout-table__focus {
  display: inline;
}

/* A half draws its own focus border, as a table does. */
.layout-table__half {
  outline: none;
}

/* A number is read, never pressed or selected: a press on it is a press on its table. */
.layout-table__number {
  pointer-events: none;
  user-select: none;
}
</style>
