/**
 * The hand-kept words of `DESIGN.md` (T582): what `design-md.ts` cannot read from the CSS.
 *
 * Each string is one line of the file, a whole sentence or a list item, written without a token's
 * value, so a changed value can never make the words false: the YAML and the generated tables carry
 * every value. A code span naming a token (`--space-4`, `var(--space-4)`) or classes (`.btn`) must
 * name one `base.css` or `primitives.css` has, or the generator refuses, so a rename cannot leave
 * the words behind. The generator writes only the file's headings, its table heads, the comment
 * saying it is generated and the YAML comment on `primary`, and this file holds no parsing.
 *
 * `COMPONENTS` names the primitives' entries and the selectors each merges; every class
 * `primitives.css` names must be one of their selectors or named in these words, or it refuses.
 *
 * Change a word here, then run `npm run design-md` in `front-end/` and commit `DESIGN.md` with it.
 */

/** The family headings are set in, which a heading's own rule names; `body` names the other. */
export const HEADING_FAMILY = 'Merge One';

/** The front matter's `description`. */
export const DESCRIPTION =
  "Conventioner's design system, generated from front-end/src/assets/base.css and primitives.css.";

export const OVERVIEW = [
  'Conventioner runs a vendor market from applications to the door: organizers work at a desk in dense lists, tables and plans, and vendors use a phone at the door.',
  'The look is quiet and legible: white cards on a white page, one brand green, Outfit for all but headings, and every text colour held to WCAG AA on the ground it sits on.',
  'This file is the contract to read first: `front-end/src/assets/base.css` and `front-end/src/assets/primitives.css` are the source of every value in it, and [the design language](docs/design-system.md) is the long statement of each decision and why.',
  'Write the token, never its value: `var(--mm-green)` in a component, never the hex it stands for.',
  "A token's name here is its CSS custom property without the `--`, and a component's name stands for the selectors listed beside it under Components.",
  "`primary` is the format's name for `--mm-green`; the CSS has no custom property of that name.",
  'After changing either file, run `npm run design-md` in `front-end/` and commit this file with it; CI fails when it is stale.',
];

export const COLORS = [
  "A colour token's name says its role: `--mm-text-*`, `--mm-black` and `--color-text` are ink, held to WCAG AA on each ground they are set on.",
  'Ink on a dark ground is its own family (`--mm-text-muted-on-dark`), and ink on beige or on a tint is its own token (`--mm-text-muted-on-beige`, `--mm-text-yellow-on-tint`): a colour is AA only on the ground it was measured on.',
  'Hover and pressed are fills of their own, a step darker each (`--mm-green-hover`, `--mm-green-pressed`), never an opacity.',
  '`--mm-border`, `--mm-border-soft` and `--edge-shade` are lines and shades, and carry no text.',
  "Where a colour's note gives a figure on a ground, that is its contrast there, from `base.css`; `front-end/src/__tests__/contrast.test.ts` holds every pair, and the lint's own contrast check reads colours without their alpha.",
  "A layout names its sections' colours by number (`--layout-section-1-fill` to `--layout-section-8-fill`), so the order is stored data: a ninth goes after them, never between.",
  '[Colour](docs/design-system.md#colour) and [the contrast contract](docs/design-system.md#the-contrast-contract) say why.',
];

export const TYPOGRAPHY = [
  "Two families: Outfit for everything, and Merge One for headings, which a heading's own rule names.",
  'Six sizes, `--text-xs` to `--text-2xl`, and nothing smaller than `--text-xs`: adjacent pixel sizes carry no meaning.',
  'Two weights, 400 and 600; 500 reads as 400 at these sizes, and 700 is heavier than this type wants.',
  "Running text's line height is `--leading`, a factor of the size; never give Merge One's deep descenders a tight line box.",
  'The levels are each size at 400 (`text-*`), at 600 (`text-*-strong`) and in Merge One (`heading-*`).',
  '[Type](docs/design-system.md#type) says why.',
];

export const LAYOUT = [
  'Spacing is the `--space-*` scale, `--space-1` to `--space-12`, and `--space-hairline` for the gap between an icon and its label, which nothing is laid out on.',
  'A margin, a padding or a gap is `0`, a spacing token, or a sum or negation of tokens; Stylelint refuses a raw pixel.',
  'A screen is a card of one of two widths, `--workspace-max` for a market screen and `--list-max` for Markets and Organizations, that grows to its content while the page scrolls; no screen caps its own height.',
  'A control is `--control-height` or `--control-height-compact` tall, and any other target at least `--target-min`; on a phone all three grow, as the table below says.',
  '`--market-frame-h` and `--pinned-tools-h` are measured at run time by the market frame and its pinned tools, and are zero outside them.',
  'A screen of cards is `.card-grid`: two tracks, a card half width unless it is `.card-grid__wide`, and one track below `--card-grid-one-track` of room.',
  '[Spacing](docs/design-system.md#spacing) and [Layout](docs/design-system.md#layout) say why.',
];

export const ELEVATION = [
  'Two shadows: `--shadow-card` lifts a card, and `--shadow-float` lifts what floats over a map, which draws its own edge in `--mm-border-soft`.',
  'A card that informs is flat: `--mm-beige`, a 1px `--mm-border` edge and no shadow.',
  'No other shadow: a ring of shadow with no offset is retired, and focus is not elevation.',
  'A scroller with more beyond an edge shades that edge in `--edge-shade` over `--edge-shade-depth`, and no in-app scroller draws a bar.',
  '[Elevation](docs/design-system.md#elevation) says why.',
];

export const SHAPES = [
  "Five radii: `--radius-control` for buttons, fields, selects and small chips; `--radius-card` for cards, panels and dialogs; `--radius-pill`, the one spelling of fully rounded, for pills; `--radius-sheet` and `--radius-bubble` for the public map's sheet and bubble.",
  '[Radius](docs/design-system.md#radius) says why.',
];

export const COMPONENTS_INTRO = [
  "Reach for a primitive before deciding a control's look again; a component's own rule outranks these, since `main.css` puts them in the `global` cascade layer.",
  'Each entry below is one under `components` in the tokens: its selectors, then the declarations of its last selector that the format has no sub-token for.',
  '[The primitive layer](docs/design-system.md#the-primitive-layer) says why, and the component library draws every variant at `/dev/components` in a development build.',
];

/** A group of the Components section: its `###` heading, and the words under it. */
export interface ComponentGroup {
  name: string;
  words: readonly string[];
}

export const COMPONENT_GROUPS: readonly ComponentGroup[] = [
  {
    name: 'Buttons',
    words: [
      '`.btn` and one intent: `.btn--primary`, `.btn--secondary` or `.btn--destructive`, and `.btn--compact` in a toolbar.',
      "A row's destructive action is `.btn--secondary.btn--destructive`, red ink on the secondary button, which asks before it acts.",
      'A toggle that is on is a `.btn` with `aria-pressed="true"`, tinted rather than filled.',
      'There is one disabled look for every intent.',
    ],
  },
  {
    name: 'Fields',
    words: [
      '`.field` for every text field, select and textarea, left-aligned, with a `.field-label` above it.',
      "`.field--select` draws the app's own chevron, and a select's own class may size or place it, never draw it.",
      '`.field--compact` stands beside a `.btn--compact`.',
    ],
  },
  {
    name: 'Chips',
    words: [
      '`.chip` and one tone: `.chip--neutral`, `.chip--positive`, `.chip--attention`, `.chip--informational` or `.chip--destructive`, a tinted ground with its own ink, in sentence case.',
      '`.chip--small` sits beside small type.',
    ],
  },
  {
    name: 'Tables',
    words: [
      "`.data-table` is a table whose columns are the screen's own; when it may be wider than its place it scrolls inside a sideways scroll box with `.data-table-scroll` on its root, and never moves the page.",
    ],
  },
  {
    name: 'Rows',
    words: [
      '`.add-row` is a button that adds a row to a plan card, and `.drag-handle` is the control grabbed to reorder one.',
    ],
  },
  {
    name: 'Links and notes',
    words: [
      '`.link-alone` is a link on a line of its own, at least `--target-min` tall; a link inside a sentence is not one.',
      '`.note` is a fact the page states about itself, quietly, with a rule down its edge.',
    ],
  },
  {
    name: 'Card grid',
    words: [
      "`.card-grid` lays a screen's cards in two tracks, each card ending at its own content.",
    ],
  },
  {
    name: 'Choice cards',
    words: [
      '`.choice-card` is one of a few ways of doing something, with its label and a line of help.',
      '`.chosen` marks the chosen card, and `.disabled` freezes them all: the chosen one keeps its white ground, a green ring and a bold label, and the others go beige.',
    ],
  },
  {
    name: 'Focus',
    words: [
      'A button shows a green outline inside its edge on `:focus-visible`, `--focus-border`, or `--focus-border-on-fill` on a fill of its own green or red.',
      "`.add-row`, `.drag-handle` and the step header's `.step-button` wear the same outline.",
      'A link or any other stop shows the soft `--focus-halo`, and `--focus-halo-on-dark` on the dark bar.',
      'A field shows no focus at all, only its caret: that was decided knowing a keyboard user loses the ring too, so do not add one.',
    ],
  },
];

/**
 * One entry under the format's `components`: its group's name, and the selectors whose rules in
 * `primitives.css` are merged in this order, each written exactly as a top-level rule lists it. A
 * state carries its base's selectors first, so the linter checks its ink on its own fill.
 */
export interface Component {
  key: string;
  group: string;
  selectors: readonly string[];
}

const ROW_DESTRUCTIVE = [
  '.btn',
  '.btn--secondary',
  '.btn--destructive',
  '.btn--secondary.btn--destructive',
];
const ON = ['.btn', '.btn--secondary', ".btn[aria-pressed='true']"];

export const COMPONENTS: readonly Component[] = [
  { key: 'btn', group: 'Buttons', selectors: ['.btn'] },
  { key: 'btn-compact', group: 'Buttons', selectors: ['.btn', '.btn--compact'] },
  { key: 'btn-primary', group: 'Buttons', selectors: ['.btn', '.btn--primary'] },
  {
    key: 'btn-primary-hover',
    group: 'Buttons',
    selectors: ['.btn', '.btn--primary', '.btn--primary:hover:not(:disabled)'],
  },
  {
    key: 'btn-primary-pressed',
    group: 'Buttons',
    selectors: ['.btn', '.btn--primary', '.btn--primary:active:not(:disabled)'],
  },
  { key: 'btn-secondary', group: 'Buttons', selectors: ['.btn', '.btn--secondary'] },
  {
    key: 'btn-secondary-hover',
    group: 'Buttons',
    selectors: ['.btn', '.btn--secondary', '.btn--secondary:hover:not(:disabled)'],
  },
  {
    key: 'btn-secondary-pressed',
    group: 'Buttons',
    selectors: ['.btn', '.btn--secondary', '.btn--secondary:active:not(:disabled)'],
  },
  { key: 'btn-destructive', group: 'Buttons', selectors: ['.btn', '.btn--destructive'] },
  {
    key: 'btn-destructive-hover',
    group: 'Buttons',
    selectors: ['.btn', '.btn--destructive', '.btn--destructive:hover:not(:disabled)'],
  },
  {
    key: 'btn-destructive-pressed',
    group: 'Buttons',
    selectors: ['.btn', '.btn--destructive', '.btn--destructive:active:not(:disabled)'],
  },
  { key: 'btn-row-destructive', group: 'Buttons', selectors: ROW_DESTRUCTIVE },
  {
    key: 'btn-row-destructive-hover',
    group: 'Buttons',
    selectors: [...ROW_DESTRUCTIVE, '.btn--secondary.btn--destructive:hover:not(:disabled)'],
  },
  {
    key: 'btn-row-destructive-pressed',
    group: 'Buttons',
    selectors: [...ROW_DESTRUCTIVE, '.btn--secondary.btn--destructive:active:not(:disabled)'],
  },
  { key: 'btn-on', group: 'Buttons', selectors: ON },
  {
    key: 'btn-on-hover',
    group: 'Buttons',
    selectors: [...ON, ".btn[aria-pressed='true']:hover:not(:disabled)"],
  },
  {
    key: 'btn-on-pressed',
    group: 'Buttons',
    selectors: [...ON, ".btn[aria-pressed='true']:active:not(:disabled)"],
  },
  { key: 'btn-disabled', group: 'Buttons', selectors: ['.btn', '.btn:disabled'] },
  { key: 'field', group: 'Fields', selectors: ['.field'] },
  { key: 'field-placeholder', group: 'Fields', selectors: ['.field', '.field::placeholder'] },
  { key: 'field-compact', group: 'Fields', selectors: ['.field', '.field--compact'] },
  { key: 'field-select', group: 'Fields', selectors: ['.field', '.field--select'] },
  { key: 'field-textarea', group: 'Fields', selectors: ['.field', '.field--textarea'] },
  { key: 'field-disabled', group: 'Fields', selectors: ['.field', '.field:disabled'] },
  {
    key: 'field-select-disabled',
    group: 'Fields',
    selectors: ['.field', '.field--select', '.field:disabled', '.field--select:disabled'],
  },
  { key: 'field-label', group: 'Fields', selectors: ['.field-label'] },
  { key: 'chip-neutral', group: 'Chips', selectors: ['.chip', '.chip--neutral'] },
  { key: 'chip-positive', group: 'Chips', selectors: ['.chip', '.chip--positive'] },
  { key: 'chip-attention', group: 'Chips', selectors: ['.chip', '.chip--attention'] },
  { key: 'chip-informational', group: 'Chips', selectors: ['.chip', '.chip--informational'] },
  { key: 'chip-destructive', group: 'Chips', selectors: ['.chip', '.chip--destructive'] },
  { key: 'chip-small', group: 'Chips', selectors: ['.chip', '.chip--small'] },
  { key: 'data-table-scroll', group: 'Tables', selectors: ['.data-table-scroll'] },
  { key: 'data-table', group: 'Tables', selectors: ['.data-table'] },
  {
    key: 'data-table-cell',
    group: 'Tables',
    selectors: ['.data-table', '.data-table :is(th, td)', '.data-table tbody :is(th, td)'],
  },
  {
    key: 'data-table-column-heading',
    group: 'Tables',
    selectors: ['.data-table', '.data-table :is(th, td)', '.data-table thead th'],
  },
  {
    key: 'data-table-row-heading',
    group: 'Tables',
    selectors: [
      '.data-table',
      '.data-table :is(th, td)',
      '.data-table tbody :is(th, td)',
      '.data-table tbody th',
    ],
  },
  { key: 'data-table-one-line', group: 'Tables', selectors: ['.data-table--one-line :is(th, td)'] },
  { key: 'add-row', group: 'Rows', selectors: ['.add-row'] },
  { key: 'add-row-icon', group: 'Rows', selectors: ['.add-row__icon'] },
  { key: 'drag-handle', group: 'Rows', selectors: ['.drag-handle'] },
  { key: 'drag-handle-hover', group: 'Rows', selectors: ['.drag-handle', '.drag-handle:hover'] },
  { key: 'drag-handle-grabbed', group: 'Rows', selectors: ['.drag-handle', '.drag-handle:active'] },
  { key: 'drag-handle-icon', group: 'Rows', selectors: ['.drag-handle__icon'] },
  { key: 'link-alone', group: 'Links and notes', selectors: ['.link-alone'] },
  {
    key: 'link-alone-hover',
    group: 'Links and notes',
    selectors: ['.link-alone', '.link-alone:hover'],
  },
  { key: 'note', group: 'Links and notes', selectors: ['.note'] },
  { key: 'note-link', group: 'Links and notes', selectors: ['.note', '.note a'] },
  { key: 'card-grid', group: 'Card grid', selectors: ['.card-grid'] },
  { key: 'card-grid-wide', group: 'Card grid', selectors: ['.card-grid > .card-grid__wide'] },
  { key: 'choice-card', group: 'Choice cards', selectors: ['.choice-card'] },
  {
    key: 'choice-card-chosen',
    group: 'Choice cards',
    selectors: ['.choice-card', '.choice-card.chosen'],
  },
  {
    key: 'choice-card-frozen',
    group: 'Choice cards',
    selectors: ['.choice-card', '.choice-card.disabled'],
  },
  {
    key: 'choice-card-frozen-chosen',
    group: 'Choice cards',
    selectors: [
      '.choice-card',
      '.choice-card.disabled',
      '.choice-card.chosen',
      '.choice-card.disabled.chosen',
    ],
  },
  { key: 'choice-card-input', group: 'Choice cards', selectors: ['.choice-card input'] },
  { key: 'choice-card-text', group: 'Choice cards', selectors: ['.choice-card-text'] },
  { key: 'choice-card-label', group: 'Choice cards', selectors: ['.choice-card-label'] },
  {
    key: 'choice-card-label-frozen',
    group: 'Choice cards',
    selectors: ['.choice-card-label', '.choice-card.disabled:not(.chosen) .choice-card-label'],
  },
  {
    key: 'choice-card-label-frozen-chosen',
    group: 'Choice cards',
    selectors: ['.choice-card-label', '.choice-card.disabled.chosen .choice-card-label'],
  },
  { key: 'choice-card-help', group: 'Choice cards', selectors: ['.choice-card-help'] },
  { key: 'btn-focus', group: 'Focus', selectors: ['.btn', '.btn:focus-visible'] },
  { key: 'link-focus', group: 'Focus', selectors: ['a:not(.btn):focus-visible'] },
  { key: 'field-focus', group: 'Focus', selectors: ['input:focus'] },
];

export const DOS_AND_DONTS = [
  "- Do reach for a primitive (`.btn`, `.field`, `.chip`, `.data-table`) before writing a control's own look.",
  '- Do write a token (`var(--space-4)`), never its value: a value not in this file does not belong in a component.',
  '- Do hold a new text colour to WCAG AA on each ground it is drawn on, as a token named for that ground, listed in `contrast.test.ts`.',
  '- Do give a hover and a pressed state fills of their own, each a step darker than the last.',
  "- Do say in words what a shade or a colour means: a chart's part and a table cell's fill carry nothing alone.",
  '- Do run `npm run design-md` in `front-end/` after changing `base.css` or `primitives.css`, and commit this file with them.',
  "- Don't set text in `--mm-yellow`, or white on it: yellow is a fill under `--mm-black`, and `--mm-text-yellow` is its ink.",
  "- Don't dim a control with `opacity` for its hover, pressed or disabled state.",
  "- Don't use a font size off the six steps, a weight but 400 or 600, or a family but Outfit and Merge One.",
  "- Don't put a focus ring on a field.",
  "- Don't draw a scroll bar inside the app, or cap a screen's height: the page scrolls, and a box that scrolls shades its edges.",
  "- Don't edit this file by hand: CI fails a file the generator would not write.",
];

/** Everything the generator takes from this file; a test passes its own to drive a guard. */
export interface Content {
  description: string;
  headingFamily: string;
  overview: readonly string[];
  colors: readonly string[];
  typography: readonly string[];
  layout: readonly string[];
  elevation: readonly string[];
  shapes: readonly string[];
  components: readonly string[];
  componentGroups: readonly ComponentGroup[];
  componentEntries: readonly Component[];
  dosAndDonts: readonly string[];
}

export const CONTENT: Content = {
  description: DESCRIPTION,
  headingFamily: HEADING_FAMILY,
  overview: OVERVIEW,
  colors: COLORS,
  typography: TYPOGRAPHY,
  layout: LAYOUT,
  elevation: ELEVATION,
  shapes: SHAPES,
  components: COMPONENTS_INTRO,
  componentGroups: COMPONENT_GROUPS,
  componentEntries: COMPONENTS,
  dosAndDonts: DOS_AND_DONTS,
};
