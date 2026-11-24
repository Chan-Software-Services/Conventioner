---
version: alpha
name: Conventioner
description: "Conventioner's design system, generated from front-end/src/assets/base.css and primitives.css."
colors:
  primary: "{colors.mm-green}" # the format's name for --mm-green; the CSS has no --primary
  mm-black: "#272323" # 15.54 on white, 12.49 on beige
  mm-text-muted: "rgba(39, 35, 35, 0.63)" # #777474, 4.63 on white
  mm-text-muted-on-beige: "rgba(39, 35, 35, 0.7)"
  mm-text-yellow: "#996f1b" # 4.52 on white
  mm-text-yellow-on-tint: "#7a5815"
  mm-text-link: "#1a6f8b" # 5.69 on white. Replaces a hardcoded #2196F3 at 3.12.
  mm-text-green: "#2a6858" # 5.34 on rgba(54,130,111,.16) over white
  mm-text-red-on-tint: "#a93226"
  mm-text-muted-on-dark: "rgba(255, 255, 255, 0.72)" # 8.62 on --mm-black
  mm-text-hover-on-dark: "rgba(255, 255, 255, 0.9)"
  mm-green: "#36826f" # white text on it: 4.59
  mm-yellow: "#e4a629" # --mm-black on it: 7.24
  mm-beige: "#e9e6e1" # --mm-black on it: 12.49
  mm-red: "#c0392b" # white text on it: 5.44
  mm-blue: "#1a6f8b" # white text on it: 5.69
  mm-chart-yellow: "#bd8619" # on white: 3.19
  mm-chart-grey: "#777474" # on white: 4.63
  mm-fill-third: "#e3eeeb" # --mm-black on it: 13.10
  mm-fill-two-thirds: "#bfd7d1" # 10.26
  mm-fill-nearly: "#96beb4" # 7.64
  mm-fill-full: "#68a193" # 5.26
  mm-green-hover: "#327866" # --mm-green and 8% black; white text on it: 5.23
  mm-green-pressed: "#2e6f5e" # 15% black; white text on it: 5.91
  mm-red-hover: "#b13428" # --mm-red and 8% black; white text on it: 6.19
  mm-red-pressed: "#a33025" # 15% black; white text on it: 6.98
  mm-white-hover: "#f6f6f6" # white and 4% --mm-black; --mm-black on it: 14.38
  mm-white-pressed: "#eeeded" # 8%; --mm-black on it: 13.30
  mm-chip-positive-hover: "#d7e6e2" # --mm-chip-positive and 5% --mm-green
  mm-chip-positive-pressed: "#cee1dc" # 10%
  mm-yellow-hover: "#d29926" # --mm-yellow and 8% black; --mm-black on it: 6.16
  mm-beige-hover: "#d6d4cf" # --mm-beige and 8% black; --mm-black on it: 10.49
  mm-chip-positive: "#dfebe8" # rgba(54, 130, 111, 0.16) over white
  mm-chip-attention: "#faefd8" # rgba(228, 166, 41, 0.18) over white
  mm-chip-informational: "#dfebef" # rgba(26, 111, 139, 0.14) over white
  mm-chip-destructive: "#f6e3e1" # rgba(192, 57, 43, 0.14) over white
  layout-floor: "#f4f2ee"
  layout-section-1-fill: "#f8e7c2" # gold; --mm-black on it: 12.73
  layout-section-1-edge: "#a97a1b" # on the floor: 3.42; on white: 3.83
  layout-section-1-out: "#d1b270" # --mm-black on it: 7.63; from the tint: 1.67
  layout-section-2-fill: "#dce9ee" # blue; --mm-black on it: 12.53
  layout-section-2-edge: "#1a6f8b" # on the floor: 5.09; on white: 5.69
  layout-section-2-out: "#92bbc8" # --mm-black on it: 7.52; from the tint: 1.67
  layout-section-3-fill: "#f3ddd8" # terracotta; --mm-black on it: 11.95
  layout-section-3-edge: "#b0503f" # on the floor: 4.62; on white: 5.17
  layout-section-3-out: "#daa99f" # --mm-black on it: 7.52; from the tint: 1.59
  layout-section-4-fill: "#dfebe8" # green; --mm-black on it: 12.72
  layout-section-4-edge: "#36826f" # on the floor: 4.10; on white: 4.59
  layout-section-4-out: "#95bdb3" # --mm-black on it: 7.56; from the tint: 1.68
  layout-section-5-fill: "#e6e0f3" # violet; --mm-black on it: 12.08
  layout-section-5-edge: "#6b54a8" # on the floor: 5.43; on white: 6.07
  layout-section-5-out: "#baaed8" # --mm-black on it: 7.50; from the tint: 1.61
  layout-section-6-fill: "#cfeeee" # teal; --mm-black on it: 12.67
  layout-section-6-edge: "#0e8a8f" # on the floor: 3.72; on white: 4.16
  layout-section-6-out: "#78c1c3" # --mm-black on it: 7.56; from the tint: 1.68
  layout-section-7-fill: "#f5dde8" # rose; --mm-black on it: 12.13
  layout-section-7-edge: "#b0457a" # on the floor: 4.72; on white: 5.28
  layout-section-7-out: "#dba5bf" # --mm-black on it: 7.51; from the tint: 1.62
  layout-section-8-fill: "#e8ebd0" # olive; --mm-black on it: 12.75
  layout-section-8-edge: "#6f7a25" # on the floor: 4.19; on white: 4.68
  layout-section-8-out: "#b3b985" # --mm-black on it: 7.55; from the tint: 1.69
  layout-no-section-fill: "#e7e5e2" # --mm-black on it: 12.36
  layout-no-section-edge: "#7a7672" # on the floor: 4.03; on white: 4.50
  layout-zone-fill: "#efedea" # --mm-black on it: 13.30
  layout-zone-hatch: "#c9c5bf" # --mm-black on it: 9.05
  layout-zone-edge: "#817d78" # on the floor: 3.66; on white: 4.09
  mm-border: "rgba(39, 35, 35, 0.25)"
  mm-border-soft: "rgba(39, 35, 35, 0.16)"
  mm-paper: "#fbfaf8"
  hover-grey: "rgba(192, 192, 192, 0.486)"
  edge-shade: "rgba(39, 35, 35, 0.12)"
  edge-shade-on-dark: "rgba(255, 255, 255, 0.25)"
  focus-border: "{colors.mm-green}"
  focus-border-on-fill: "#07231c"
  color-background: "#ffffff"
  color-text: "#2c3e50" # 10.35 on white
typography:
  text-xs:
    fontFamily: "Outfit"
    fontSize: "12px" # captions, metadata, table labels, chips
    fontWeight: 400
    lineHeight: 1.6
  text-xs-strong:
    fontFamily: "Outfit"
    fontSize: "12px" # captions, metadata, table labels, chips
    fontWeight: 600
    lineHeight: 1.6
  heading-xs:
    fontFamily: "Merge One"
    fontSize: "12px" # captions, metadata, table labels, chips
    fontWeight: 400
    lineHeight: 1.6
  text-sm:
    fontFamily: "Outfit"
    fontSize: "14px" # body, form fields, buttons, list rows
    fontWeight: 400
    lineHeight: 1.6
  text-sm-strong:
    fontFamily: "Outfit"
    fontSize: "14px" # body, form fields, buttons, list rows
    fontWeight: 600
    lineHeight: 1.6
  heading-sm:
    fontFamily: "Merge One"
    fontSize: "14px" # body, form fields, buttons, list rows
    fontWeight: 400
    lineHeight: 1.6
  text-md:
    fontFamily: "Outfit"
    fontSize: "16px" # lead paragraphs, emphasis within body
    fontWeight: 400
    lineHeight: 1.6
  text-md-strong:
    fontFamily: "Outfit"
    fontSize: "16px" # lead paragraphs, emphasis within body
    fontWeight: 600
    lineHeight: 1.6
  heading-md:
    fontFamily: "Merge One"
    fontSize: "16px" # lead paragraphs, emphasis within body
    fontWeight: 400
    lineHeight: 1.6
  text-lg:
    fontFamily: "Outfit"
    fontSize: "20px" # section headings, card titles
    fontWeight: 400
    lineHeight: 1.6
  text-lg-strong:
    fontFamily: "Outfit"
    fontSize: "20px" # section headings, card titles
    fontWeight: 600
    lineHeight: 1.6
  heading-lg:
    fontFamily: "Merge One"
    fontSize: "20px" # section headings, card titles
    fontWeight: 400
    lineHeight: 1.6
  text-xl:
    fontFamily: "Outfit"
    fontSize: "26px" # page and screen titles
    fontWeight: 400
    lineHeight: 1.6
  text-xl-strong:
    fontFamily: "Outfit"
    fontSize: "26px" # page and screen titles
    fontWeight: 600
    lineHeight: 1.6
  heading-xl:
    fontFamily: "Merge One"
    fontSize: "26px" # page and screen titles
    fontWeight: 400
    lineHeight: 1.6
  text-2xl:
    fontFamily: "Outfit"
    fontSize: "32px" # display figures - the assignment summary's numbers
    fontWeight: 400
    lineHeight: 1.6
  text-2xl-strong:
    fontFamily: "Outfit"
    fontSize: "32px" # display figures - the assignment summary's numbers
    fontWeight: 600
    lineHeight: 1.6
  heading-2xl:
    fontFamily: "Merge One"
    fontSize: "32px" # display figures - the assignment summary's numbers
    fontWeight: 400
    lineHeight: 1.6
rounded:
  radius-control: "6px" # buttons, inputs, selects, small chips
  radius-card: "10px" # cards, panels, dialogs
  radius-pill: "999px" # pills and fully-rounded badges
  radius-sheet: "22px" # a window-filling sheet, the public map's (T465)
  radius-bubble: "18px" # a speech bubble, the public map's card at a desk (T465)
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-6: "24px"
  space-8: "32px"
  space-12: "48px"
  space-hairline: "2px"
  control-height: "36px"
  control-height-compact: "28px"
  target-min: "24px"
  banner-h: "44px"
  market-frame-h: "0px"
  pinned-tools-h: "0px"
  card-grid-gap: "{spacing.space-8}"
  card-grid-one-track: "900px"
  workspace-max: "1440px" # Every market screen; `MarketFrame` sets it (E22/F04/S01)
  list-max: "1100px" # Markets, Organizations
  applicant-max: "640px" # The applicant's column, and the form's preview of it (E33/F01/S01)
  edge-shade-depth: "{spacing.space-3}"
  focus-border-width: "2px"
components:
  btn:
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-compact:
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height-compact}"
  btn-primary:
    backgroundColor: "{colors.mm-green}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-primary-hover:
    backgroundColor: "{colors.mm-green-hover}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-primary-pressed:
    backgroundColor: "{colors.mm-green-pressed}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-secondary:
    backgroundColor: "white"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-secondary-hover:
    backgroundColor: "{colors.mm-white-hover}"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-secondary-pressed:
    backgroundColor: "{colors.mm-white-pressed}"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-destructive:
    backgroundColor: "{colors.mm-red}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-destructive-hover:
    backgroundColor: "{colors.mm-red-hover}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-destructive-pressed:
    backgroundColor: "{colors.mm-red-pressed}"
    textColor: "white"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-row-destructive:
    backgroundColor: "white"
    textColor: "{colors.mm-red}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-row-destructive-hover:
    backgroundColor: "{colors.mm-white-hover}"
    textColor: "{colors.mm-red}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-row-destructive-pressed:
    backgroundColor: "{colors.mm-white-pressed}"
    textColor: "{colors.mm-red}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-on:
    backgroundColor: "{colors.mm-chip-positive}"
    textColor: "{colors.mm-text-green}"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-on-hover:
    backgroundColor: "{colors.mm-chip-positive-hover}"
    textColor: "{colors.mm-text-green}"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-on-pressed:
    backgroundColor: "{colors.mm-chip-positive-pressed}"
    textColor: "{colors.mm-text-green}"
    typography: "{typography.text-sm-strong}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  btn-disabled:
    backgroundColor: "{colors.mm-beige}"
    textColor: "{colors.mm-text-muted-on-beige}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  field:
    backgroundColor: "white"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
    width: "100%"
  field-placeholder:
    backgroundColor: "white"
    textColor: "{colors.mm-text-muted}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
    width: "100%"
  field-compact:
    backgroundColor: "white"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height-compact}"
    width: "100%"
  field-select:
    backgroundColor: "white"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
    width: "100%"
  field-textarea:
    backgroundColor: "white"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "var(--space-2) var(--space-3)"
    height: "auto"
    width: "100%"
  field-disabled:
    backgroundColor: "{colors.mm-beige}"
    textColor: "{colors.mm-text-muted-on-beige}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
    width: "100%"
  field-select-disabled:
    backgroundColor: "{colors.mm-beige}"
    textColor: "{colors.mm-text-muted-on-beige}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
    width: "100%"
  field-label:
    textColor: "{colors.mm-text-muted}"
    typography: "{typography.text-xs}"
  chip-neutral:
    backgroundColor: "{colors.mm-beige}"
    textColor: "{colors.mm-black}"
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-pill}"
    padding: "var(--space-hairline) var(--space-2)"
  chip-positive:
    backgroundColor: "{colors.mm-chip-positive}"
    textColor: "{colors.mm-text-green}"
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-pill}"
    padding: "var(--space-hairline) var(--space-2)"
  chip-attention:
    backgroundColor: "{colors.mm-chip-attention}"
    textColor: "{colors.mm-text-yellow-on-tint}"
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-pill}"
    padding: "var(--space-hairline) var(--space-2)"
  chip-informational:
    backgroundColor: "{colors.mm-chip-informational}"
    textColor: "{colors.mm-blue}"
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-pill}"
    padding: "var(--space-hairline) var(--space-2)"
  chip-destructive:
    backgroundColor: "{colors.mm-chip-destructive}"
    textColor: "{colors.mm-text-red-on-tint}"
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-pill}"
    padding: "var(--space-hairline) var(--space-2)"
  chip-small:
    typography: "{typography.text-xs}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-1)"
  data-table-scroll:
    rounded: "{rounded.radius-control}"
  data-table:
    typography: "{typography.text-sm}"
    width: "100%"
  data-table-cell:
    typography: "{typography.text-sm}"
    padding: "var(--space-2) var(--space-3)"
  data-table-column-heading:
    textColor: "{colors.mm-text-muted}"
    typography: "{typography.text-xs-strong}"
    padding: "var(--space-2) var(--space-3)"
  data-table-row-heading:
    typography: "{typography.text-sm}"
    padding: "var(--space-2) var(--space-3)"
  data-table-one-line: {}
  add-row:
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-3)"
    height: "{spacing.control-height}"
  add-row-icon:
    height: "2em"
    width: "2em"
  drag-handle:
    textColor: "{colors.mm-text-muted}"
    padding: "0 var(--space-1)"
  drag-handle-hover:
    textColor: "{colors.mm-black}"
    padding: "0 var(--space-1)"
  drag-handle-grabbed:
    textColor: "{colors.mm-text-muted}"
    padding: "0 var(--space-1)"
  drag-handle-icon:
    width: "{spacing.space-2}"
  link-alone:
    textColor: "{colors.mm-text-link}"
    typography: "{typography.text-sm}"
  link-alone-hover:
    textColor: "{colors.mm-text-link}"
    typography: "{typography.text-sm}"
  note:
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
    padding: "var(--space-2) var(--space-3)"
  note-link:
    textColor: "{colors.mm-text-link}"
    typography: "{typography.text-sm}"
  card-grid: {}
  card-grid-wide: {}
  choice-card:
    backgroundColor: "white"
    rounded: "{rounded.radius-control}"
    padding: "{spacing.space-3}"
  choice-card-chosen:
    backgroundColor: "white"
    rounded: "{rounded.radius-control}"
    padding: "{spacing.space-3}"
  choice-card-frozen:
    backgroundColor: "{colors.mm-beige}"
    rounded: "{rounded.radius-control}"
    padding: "{spacing.space-3}"
  choice-card-frozen-chosen:
    backgroundColor: "white"
    rounded: "{rounded.radius-control}"
    padding: "{spacing.space-3}"
  choice-card-input: {}
  choice-card-text: {}
  choice-card-label:
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm}"
  choice-card-label-frozen:
    textColor: "{colors.mm-text-muted-on-beige}"
    typography: "{typography.text-sm}"
  choice-card-label-frozen-chosen:
    textColor: "{colors.mm-black}"
    typography: "{typography.text-sm-strong}"
  choice-card-help:
    textColor: "{colors.mm-text-muted-on-beige}"
    typography: "{typography.text-xs}"
  btn-focus:
    typography: "{typography.text-sm}"
    rounded: "{rounded.radius-control}"
    padding: "0 var(--space-4)"
    height: "{spacing.control-height}"
  link-focus: {}
  field-focus: {}
---
<!-- Generated by front-end/scripts/design-md.ts from front-end/src/assets/base.css and primitives.css. Never edit it by hand: change the CSS or scripts/design-md-content.ts, then run `npm run design-md` in front-end/. -->

# Conventioner's design contract

## Overview

Conventioner runs a vendor market from applications to the door: organizers work at a desk in dense lists, tables and plans, and vendors use a phone at the door.
The look is quiet and legible: white cards on a white page, one brand green, Outfit for all but headings, and every text colour held to WCAG AA on the ground it sits on.
This file is the contract to read first: `front-end/src/assets/base.css` and `front-end/src/assets/primitives.css` are the source of every value in it, and [the design language](docs/design-system.md) is the long statement of each decision and why.
Write the token, never its value: `var(--mm-green)` in a component, never the hex it stands for.
A token's name here is its CSS custom property without the `--`, and a component's name stands for the selectors listed beside it under Components.
`primary` is the format's name for `--mm-green`; the CSS has no custom property of that name.
After changing either file, run `npm run design-md` in `front-end/` and commit this file with it; CI fails when it is stale.

## Colors

A colour token's name says its role: `--mm-text-*`, `--mm-black` and `--color-text` are ink, held to WCAG AA on each ground they are set on.
Ink on a dark ground is its own family (`--mm-text-muted-on-dark`), and ink on beige or on a tint is its own token (`--mm-text-muted-on-beige`, `--mm-text-yellow-on-tint`): a colour is AA only on the ground it was measured on.
Hover and pressed are fills of their own, a step darker each (`--mm-green-hover`, `--mm-green-pressed`), never an opacity.
`--mm-border`, `--mm-border-soft` and `--edge-shade` are lines and shades, and carry no text.
Where a colour's note gives a figure on a ground, that is its contrast there, from `base.css`; `front-end/src/__tests__/contrast.test.ts` holds every pair, and the lint's own contrast check reads colours without their alpha.
A layout names its sections' colours by number (`--layout-section-1-fill` to `--layout-section-8-fill`), so the order is stored data: a ninth goes after them, never between.
[Colour](docs/design-system.md#colour) and [the contrast contract](docs/design-system.md#the-contrast-contract) say why.

## Typography

Two families: Outfit for everything, and Merge One for headings, which a heading's own rule names.
Six sizes, `--text-xs` to `--text-2xl`, and nothing smaller than `--text-xs`: adjacent pixel sizes carry no meaning.
Two weights, 400 and 600; 500 reads as 400 at these sizes, and 700 is heavier than this type wants.
Running text's line height is `--leading`, a factor of the size; never give Merge One's deep descenders a tight line box.
The levels are each size at 400 (`text-*`), at 600 (`text-*-strong`) and in Merge One (`heading-*`).
[Type](docs/design-system.md#type) says why.

## Layout

Spacing is the `--space-*` scale, `--space-1` to `--space-12`, and `--space-hairline` for the gap between an icon and its label, which nothing is laid out on.
A margin, a padding or a gap is `0`, a spacing token, or a sum or negation of tokens; Stylelint refuses a raw pixel.
A screen is a card of one of two widths, `--workspace-max` for a market screen and `--list-max` for Markets and Organizations, that grows to its content while the page scrolls; no screen caps its own height.
A control is `--control-height` or `--control-height-compact` tall, and any other target at least `--target-min`; on a phone all three grow, as the table below says.
`--market-frame-h` and `--pinned-tools-h` are measured at run time by the market frame and its pinned tools, and are zero outside them.
A screen of cards is `.card-grid`: two tracks, a card half width unless it is `.card-grid__wide`, and one track below `--card-grid-one-track` of room.
[Spacing](docs/design-system.md#spacing) and [Layout](docs/design-system.md#layout) say why.

At `(width <= 640px)`:

| Token | Otherwise | Here |
| --- | --- | --- |
| `--control-height` | `36px` | `44px` |
| `--control-height-compact` | `28px` | `44px` |
| `--target-min` | `24px` | `44px` |

## Elevation & Depth

Two shadows: `--shadow-card` lifts a card, and `--shadow-float` lifts what floats over a map, which draws its own edge in `--mm-border-soft`.
A card that informs is flat: `--mm-beige`, a 1px `--mm-border` edge and no shadow.
No other shadow: a ring of shadow with no offset is retired, and focus is not elevation.
A scroller with more beyond an edge shades that edge in `--edge-shade` over `--edge-shade-depth`, and no in-app scroller draws a bar.
[Elevation](docs/design-system.md#elevation) says why.

| Token | Value |
| --- | --- |
| `--shadow-card` | `0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.07), 0 6px 14px rgba(0, 0, 0, 0.08)` |
| `--shadow-float` | `0 1px 2px rgba(39, 35, 35, 0.06), 0 8px 24px rgba(39, 35, 35, 0.08)` |

## Shapes

Five radii: `--radius-control` for buttons, fields, selects and small chips; `--radius-card` for cards, panels and dialogs; `--radius-pill`, the one spelling of fully rounded, for pills; `--radius-sheet` and `--radius-bubble` for the public map's sheet and bubble.
[Radius](docs/design-system.md#radius) says why.

## Components

Reach for a primitive before deciding a control's look again; a component's own rule outranks these, since `main.css` puts them in the `global` cascade layer.
Each entry below is one under `components` in the tokens: its selectors, then the declarations of its last selector that the format has no sub-token for.
[The primitive layer](docs/design-system.md#the-primitive-layer) says why, and the component library draws every variant at `/dev/components` in a development build.

### Buttons

`.btn` and one intent: `.btn--primary`, `.btn--secondary` or `.btn--destructive`, and `.btn--compact` in a toolbar.
A row's destructive action is `.btn--secondary.btn--destructive`, red ink on the secondary button, which asks before it acts.
A toggle that is on is a `.btn` with `aria-pressed="true"`, tinted rather than filled.
There is one disabled look for every intent.

- **`btn`** (`.btn`): `display: inline-flex`, `align-items: center`, `justify-content: center`, `gap: var(--space-2)`, `border: 1px solid transparent`, `font-family: inherit`, `font-weight: 400`, `line-height: normal`, `white-space: nowrap`, `cursor: pointer`, `transition: background-color 0.15s ease-in-out`.
- **`btn-compact`** (`.btn`, `.btn--compact`).
- **`btn-primary`** (`.btn`, `.btn--primary`): `--focus-border: var(--focus-border-on-fill)`.
- **`btn-primary-hover`** (`.btn`, `.btn--primary`, `.btn--primary:hover:not(:disabled)`).
- **`btn-primary-pressed`** (`.btn`, `.btn--primary`, `.btn--primary:active:not(:disabled)`).
- **`btn-secondary`** (`.btn`, `.btn--secondary`): `border-color: var(--mm-border)`.
- **`btn-secondary-hover`** (`.btn`, `.btn--secondary`, `.btn--secondary:hover:not(:disabled)`).
- **`btn-secondary-pressed`** (`.btn`, `.btn--secondary`, `.btn--secondary:active:not(:disabled)`).
- **`btn-destructive`** (`.btn`, `.btn--destructive`): `--focus-border: var(--focus-border-on-fill)`.
- **`btn-destructive-hover`** (`.btn`, `.btn--destructive`, `.btn--destructive:hover:not(:disabled)`).
- **`btn-destructive-pressed`** (`.btn`, `.btn--destructive`, `.btn--destructive:active:not(:disabled)`).
- **`btn-row-destructive`** (`.btn`, `.btn--secondary`, `.btn--destructive`, `.btn--secondary.btn--destructive`): `--focus-border: var(--mm-green)`, `border-color: var(--mm-border)`, `font-weight: 400`.
- **`btn-row-destructive-hover`** (`.btn`, `.btn--secondary`, `.btn--destructive`, `.btn--secondary.btn--destructive`, `.btn--secondary.btn--destructive:hover:not(:disabled)`).
- **`btn-row-destructive-pressed`** (`.btn`, `.btn--secondary`, `.btn--destructive`, `.btn--secondary.btn--destructive`, `.btn--secondary.btn--destructive:active:not(:disabled)`).
- **`btn-on`** (`.btn`, `.btn--secondary`, `.btn[aria-pressed='true']`): `--focus-border: var(--focus-border-on-fill)`, `border-color: var(--mm-green)`.
- **`btn-on-hover`** (`.btn`, `.btn--secondary`, `.btn[aria-pressed='true']`, `.btn[aria-pressed='true']:hover:not(:disabled)`).
- **`btn-on-pressed`** (`.btn`, `.btn--secondary`, `.btn[aria-pressed='true']`, `.btn[aria-pressed='true']:active:not(:disabled)`).
- **`btn-disabled`** (`.btn`, `.btn:disabled`): `border-color: var(--mm-border)`, `font-weight: 400`, `cursor: not-allowed`.

### Fields

`.field` for every text field, select and textarea, left-aligned, with a `.field-label` above it.
`.field--select` draws the app's own chevron, and a select's own class may size or place it, never draw it.
`.field--compact` stands beside a `.btn--compact`.

- **`field`** (`.field`): `display: block`, `border: 1px solid var(--mm-border)`, `font-family: inherit`, `line-height: normal`, `text-align: left`.
- **`field-placeholder`** (`.field`, `.field::placeholder`).
- **`field-compact`** (`.field`, `.field--compact`).
- **`field-select`** (`.field`, `.field--select`): `min-width: 0`, `appearance: none`, `padding-right: calc(var(--space-3) + var(--space-3) + var(--space-3))`, `background-image: url('/icons/select-chevron.svg')`, `background-repeat: no-repeat`, `background-position: right var(--space-3) center`, `background-size: var(--space-3) var(--space-2)`, `text-overflow: ellipsis`.
- **`field-textarea`** (`.field`, `.field--textarea`): `min-height: 72px`, `line-height: 1.5`, `resize: vertical`.
- **`field-disabled`** (`.field`, `.field:disabled`): `cursor: not-allowed`.
- **`field-select-disabled`** (`.field`, `.field--select`, `.field:disabled`, `.field--select:disabled`): `background-image: url('/icons/select-chevron-disabled.svg')`, `opacity: 1`.
- **`field-label`** (`.field-label`): `display: block`, `margin-bottom: var(--space-1)`, `text-align: left`.

### Chips

`.chip` and one tone: `.chip--neutral`, `.chip--positive`, `.chip--attention`, `.chip--informational` or `.chip--destructive`, a tinted ground with its own ink, in sentence case.
`.chip--small` sits beside small type.

- **`chip-neutral`** (`.chip`, `.chip--neutral`).
- **`chip-positive`** (`.chip`, `.chip--positive`).
- **`chip-attention`** (`.chip`, `.chip--attention`).
- **`chip-informational`** (`.chip`, `.chip--informational`).
- **`chip-destructive`** (`.chip`, `.chip--destructive`).
- **`chip-small`** (`.chip`, `.chip--small`).

### Tables

`.data-table` is a table whose columns are the screen's own; when it may be wider than its place it scrolls inside a sideways scroll box with `.data-table-scroll` on its root, and never moves the page.

- **`data-table-scroll`** (`.data-table-scroll`): `overflow: hidden`, `border: 1px solid var(--mm-border)`.
- **`data-table`** (`.data-table`): `border-collapse: collapse`.
- **`data-table-cell`** (`.data-table`, `.data-table :is(th, td)`, `.data-table tbody :is(th, td)`): `border-top: 1px solid var(--mm-border)`.
- **`data-table-column-heading`** (`.data-table`, `.data-table :is(th, td)`, `.data-table thead th`): `white-space: nowrap`.
- **`data-table-row-heading`** (`.data-table`, `.data-table :is(th, td)`, `.data-table tbody :is(th, td)`, `.data-table tbody th`): `font-weight: 400`.
- **`data-table-one-line`** (`.data-table--one-line :is(th, td)`): `white-space: nowrap`.

### Rows

`.add-row` is a button that adds a row to a plan card, and `.drag-handle` is the control grabbed to reorder one.

- **`add-row`** (`.add-row`): `display: inline-flex`, `align-items: center`, `justify-content: center`, `gap: var(--space-2)`, `background: none`, `border: none`, `font-family: inherit`, `font-weight: 400`, `line-height: normal`, `cursor: pointer`.
- **`add-row-icon`** (`.add-row__icon`): `flex: 0 0 auto`, `stroke-width: 1.25`.
- **`drag-handle`** (`.drag-handle`): `display: inline-flex`, `align-items: center`, `justify-content: center`, `min-width: var(--space-6)`, `border: none`, `background: none`, `cursor: grab`.
- **`drag-handle-hover`** (`.drag-handle`, `.drag-handle:hover`).
- **`drag-handle-grabbed`** (`.drag-handle`, `.drag-handle:active`): `cursor: grabbing`.
- **`drag-handle-icon`** (`.drag-handle__icon`): `flex: 0 0 auto`.

### Links and notes

`.link-alone` is a link on a line of its own, at least `--target-min` tall; a link inside a sentence is not one.
`.note` is a fact the page states about itself, quietly, with a rule down its edge.

- **`link-alone`** (`.link-alone`): `display: inline-flex`, `align-items: center`, `min-height: var(--target-min)`, `text-decoration: none`.
- **`link-alone-hover`** (`.link-alone`, `.link-alone:hover`): `text-decoration: underline`.
- **`note`** (`.note`): `margin: 0`, `border-left: var(--space-hairline) solid var(--mm-green)`.
- **`note-link`** (`.note`, `.note a`): `text-decoration: underline`.

### Card grid

`.card-grid` lays a screen's cards in two tracks, each card ending at its own content.

- **`card-grid`** (`.card-grid`): `display: grid`, `grid-template-columns: repeat(auto-fit, minmax(min(100%, max((var(--card-grid-one-track) - var(--card-grid-gap)) / 2, (100% - var(--card-grid-gap)) / 2)), 1fr))`, `gap: var(--card-grid-gap)`, `align-items: start`.
- **`card-grid-wide`** (`.card-grid > .card-grid__wide`): `grid-column: 1 / -1`.

### Choice cards

`.choice-card` is one of a few ways of doing something, with its label and a line of help.
`.chosen` marks the chosen card, and `.disabled` freezes them all: the chosen one keeps its white ground, a green ring and a bold label, and the others go beige.

- **`choice-card`** (`.choice-card`): `display: flex`, `flex-direction: row`, `align-items: flex-start`, `gap: var(--space-2)`, `border: 1px solid var(--mm-border)`, `cursor: pointer`, `text-align: left`.
- **`choice-card-chosen`** (`.choice-card`, `.choice-card.chosen`): `border-color: var(--mm-green)`.
- **`choice-card-frozen`** (`.choice-card`, `.choice-card.disabled`): `cursor: not-allowed`.
- **`choice-card-frozen-chosen`** (`.choice-card`, `.choice-card.disabled`, `.choice-card.chosen`, `.choice-card.disabled.chosen`): `outline: 1px solid var(--mm-green)`, `outline-offset: -2px`.
- **`choice-card-input`** (`.choice-card input`): `margin-top: var(--space-hairline)`, `flex: 0 0 auto`.
- **`choice-card-text`** (`.choice-card-text`): `display: flex`, `flex-direction: column`, `gap: var(--space-hairline)`.
- **`choice-card-label`** (`.choice-card-label`).
- **`choice-card-label-frozen`** (`.choice-card-label`, `.choice-card.disabled:not(.chosen) .choice-card-label`).
- **`choice-card-label-frozen-chosen`** (`.choice-card-label`, `.choice-card.disabled.chosen .choice-card-label`).
- **`choice-card-help`** (`.choice-card-help`): `line-height: 1.4`.

### Focus

A button shows a green outline inside its edge on `:focus-visible`, `--focus-border`, or `--focus-border-on-fill` on a fill of its own green or red.
`.add-row`, `.drag-handle` and the step header's `.step-button` wear the same outline.
A link or any other stop shows the soft `--focus-halo`, and `--focus-halo-on-dark` on the dark bar.
A field shows no focus at all, only its caret: that was decided knowing a keyboard user loses the ring too, so do not add one.

- **`btn-focus`** (`.btn`, `.btn:focus-visible`): `outline: var(--focus-border-width) solid var(--focus-border)`, `outline-offset: var(--focus-border-offset)`.
- **`link-focus`** (`a:not(.btn):focus-visible`): `outline: none`, `box-shadow: var(--focus-halo)`.
- **`field-focus`** (`input:focus`): `outline: none`.

### Tokens the format has no group for

| Token | Value |
| --- | --- |
| `--scroll-box-overflow` | `auto hidden` |
| `--focus-border-offset` | `calc(-1 * var(--focus-border-width))` |
| `--focus-halo` | `0 0 0 2px white, 0 0 0 5px rgba(54, 130, 111, 0.35)` |
| `--focus-halo-inset` | `inset 0 0 0 2px white, inset 0 0 0 5px rgba(54, 130, 111, 0.35)` |
| `--focus-halo-on-dark` | `0 0 0 3px rgba(255, 255, 255, 0.35)` |
| `--focus-halo-on-dark-inset` | `inset 0 0 0 3px rgba(255, 255, 255, 0.35)` |

### Rules no entry ends on

- `.chip`: `display: inline-flex`, `align-items: center`, `gap: var(--space-1)`, `padding: var(--space-hairline) var(--space-2)`, `border-radius: var(--radius-pill)`, `font-size: var(--text-xs)`, `font-weight: 400`, `line-height: 1.5`, `white-space: nowrap`.
- `.data-table :is(th, td)`: `padding: var(--space-2) var(--space-3)`, `text-align: left`, `vertical-align: middle`.
- `:where(:focus-visible:not(input, textarea, select, [tabindex='-1'], .btn, button, [role='button']))`: `outline: none`, `box-shadow: var(--focus-halo)`.
- `:where(a, button, summary, [role='button'], [tabindex='0']):focus-visible`: `border-radius: var(--radius-control)`.
- `:where(a, button, summary, [role='button'], [tabindex])`: `scroll-margin: var(--space-2)`.
- `:where([tabindex='-1']):focus`: `outline: none`.

Under `@media (forced-colors: active)`:

- `.field--select, .field--select:disabled`: `appearance: auto`, `padding-right: var(--space-3)`, `background-image: none`.

Under `@media print`:

- `.data-table :is(th, td)`: `white-space: normal`.

## Do's and Don'ts

- Do reach for a primitive (`.btn`, `.field`, `.chip`, `.data-table`) before writing a control's own look.
- Do write a token (`var(--space-4)`), never its value: a value not in this file does not belong in a component.
- Do hold a new text colour to WCAG AA on each ground it is drawn on, as a token named for that ground, listed in `contrast.test.ts`.
- Do give a hover and a pressed state fills of their own, each a step darker than the last.
- Do say in words what a shade or a colour means: a chart's part and a table cell's fill carry nothing alone.
- Do run `npm run design-md` in `front-end/` after changing `base.css` or `primitives.css`, and commit this file with them.
- Don't set text in `--mm-yellow`, or white on it: yellow is a fill under `--mm-black`, and `--mm-text-yellow` is its ink.
- Don't dim a control with `opacity` for its hover, pressed or disabled state.
- Don't use a font size off the six steps, a weight but 400 or 600, or a family but Outfit and Merge One.
- Don't put a focus ring on a field.
- Don't draw a scroll bar inside the app, or cap a screen's height: the page scrolls, and a box that scrolls shades its edges.
- Don't edit this file by hand: CI fails a file the generator would not write.
