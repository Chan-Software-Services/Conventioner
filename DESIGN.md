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

A colour token's name says its role: `--mm-text-*`, `--mm-black` and `--color-text` are ink, held to WCAG AA on each ground they are set on, and a fill names the ink it carries in its note.
Ink on a dark ground is its own family (`--mm-text-muted-on-dark`), and ink on beige or on a tint is its own token (`--mm-text-muted-on-beige`, `--mm-text-yellow-on-tint`): a colour is AA only on the ground it was measured on.
Hover and pressed are fills of their own, a step darker each (`--mm-green-hover`, `--mm-green-pressed`), never an opacity.
`--mm-border`, `--mm-border-soft` and `--edge-shade` are lines and shades, and carry no text.
The figures after a colour are its contrast, from `base.css`; `front-end/src/__tests__/contrast.test.ts` holds every pair, and the lint's own contrast check reads colours without their alpha.
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

Spacing is a 4px grid, `--space-1` to `--space-12`, and `--space-hairline` for the gap between an icon and its label, which nothing is laid out on.
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

### Tokens the format has no group for

| Token | Value |
| --- | --- |
| `--scroll-box-overflow` | `auto hidden` |
| `--focus-border-offset` | `calc(-1 * var(--focus-border-width))` |
| `--focus-halo` | `0 0 0 2px white, 0 0 0 5px rgba(54, 130, 111, 0.35)` |
| `--focus-halo-inset` | `inset 0 0 0 2px white, inset 0 0 0 5px rgba(54, 130, 111, 0.35)` |
| `--focus-halo-on-dark` | `0 0 0 3px rgba(255, 255, 255, 0.35)` |
| `--focus-halo-on-dark-inset` | `inset 0 0 0 3px rgba(255, 255, 255, 0.35)` |

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
