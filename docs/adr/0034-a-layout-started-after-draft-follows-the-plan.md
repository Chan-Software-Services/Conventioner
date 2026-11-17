---
layer: implementation
kind: adr
describes:
  - back-end/layout.py
  - back-end/api/floorplans_save.py#save_floorplan_to_market
  - front-end/src/components/layout/useLayoutEditor.ts
verified: 2026-11-17
sources:
  - T422
status: accepted
---

# A layout started after Draft follows the plan

## Context

A location's layout started in Draft decides its sections' tables: its tables are the seats, each section counting the tables in it ([`back-end/layout.py`](../../back-end/layout.py)'s `derive_counts`), numbered 1 to N.
Those seats [settle on leaving draft](../business/rules/the-setup-settles-on-leaving-draft.md), so past Draft no layout could start: its tables would be seats Section Setup never had.

A market planned without a layout could therefore never have one, and so never a day map, and the market running on production was already past Draft, its seats typed on Section Setup and vendors placed at them.
Its organizers asked to draw the floorplan afterwards, by hand.

## Decision

**A layout started past Draft follows the plan: it draws the seats Section Setup settled, and never decides them.**

- **It is a kind of layout, kept in a stored flag**, `followsPlan`, which the save ([`back-end/api/floorplans_save.py`](../../back-end/api/floorplans_save.py)) sets as the layout starts, true past Draft and false in it, and keeps on every later save whatever a body sends.
  A market that goes back to Draft keeps it.
- **Its sections keep their typed counts**: `derive_counts` never counts it, so every write of the plan leaves its location's sections as Section Setup has them, and Section Setup keeps a typed Count for them.
- **Its tables are numbered once each from 1 to their section's count**, fewer than the count saving; anything else is refused 400 "<Section>'s tables are numbered 1 to <count>, each number once.", a number that is not whole among them.
  A plan write that would leave a count below a number its tables hold is refused 400 "<Section>'s layout holds table <n>. Remove it from the layout first.", after the setup-settled sentence, which answers first past Draft.
- **Its seats do not settle**: past Draft its tables are still added, removed, renumbered and put in another of its location's sections (`layout.settled_part` leaves it out), though a kept table keeps its type; the market's table types and the layouts started in Draft settle as before, and a market with no table type is given "Standard 6 ft" as it starts, as a first layout always was.
- **A table's number is its seat, and stays put** ([`useLayoutEditor.ts`](../../front-end/src/components/layout/useLayoutEditor.ts)): a removal leaves the other numbers alone, a new table takes its section's lowest free number, the tools that add tables place what fits in the order drawn and say what they held back, "Renumber by position" deals the section's own numbers out again by where the tables stand, closing no gap, and the selection's card numbers one table by hand, swapping with the table that held the number, as one step of undo.

## Consequences

- An organizer lays out a location past Draft as [planning](../business/flows/planning.md#e6-a-locations-layout) says, each section counted "<placed> of <count>".
- So a market planned without a layout can still have a [day's map](../business/flows/the-markets-map.md), public and on Attendance.
- The layout page and the editor's commands work in three ways: open (a layout started in Draft, in Draft), following (this layout, in any phase) and settled (a layout started in Draft, past Draft).
- Past Draft a seat is still settled: a layout that follows the plan draws the plan's seats and moves none of them, because a number names a seat with a vendor at it, so it never moves when another table is removed.
- A layout started in Draft works exactly as before, in Draft and past it.

## Considered options

- **Refuse, as before**: the production market could not have a map.
- **Let a settled market's layout rewrite its sections' counts**: it would move seats under placed vendors.
- **A stored flag**: chosen.
