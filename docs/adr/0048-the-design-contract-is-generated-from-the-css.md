---
layer: implementation
kind: adr
describes:
  - front-end/scripts/design-md.ts
  - front-end/scripts/design-md-content.ts
verified: 2026-11-25
sources:
  - T512
  - T582
status: accepted
---

# The design contract is generated from the CSS

The contract this decides: [`DESIGN.md`](../../DESIGN.md), read before [the design language](../design-system.md#the-contract-agents-read-designmd) that stands behind it.

## Context

Agents building or reviewing a screen hand-picked pixels and colours, because nothing short and machine-readable said what the design system is.
The design language is long, and holds the history and the reasons of each decision; the tokens and primitives in `base.css` and `primitives.css` are scattered over comments.
T512's research found Google's DESIGN.md format, with its CLI `@google/design.md` (`lint`, `diff`, `export`), the right contract for an agent to read, and later work reads the same file.
A hand-kept contract would drift from the CSS the first time a token moved.

## Decision

**`DESIGN.md`, at the repository's root, is generated from the CSS in Google's DESIGN.md format, and CI fails a stale or unclean one.**

- [`front-end/scripts/design-md.ts`](../../front-end/scripts/design-md.ts) writes it from `base.css` and `primitives.css` (`npm run design-md` in `front-end/`): every colour, radius, spacing and type token in the format's groups, every primitive and its states as the format's components, the tables the format has no group for, and, written whole, every rule of `primitives.css` no entry ends on and every `@media` rule.
- Its words are hand-kept in one module, [`front-end/scripts/design-md-content.ts`](../../front-end/scripts/design-md-content.ts), which holds no parsing, while the generator writes only the headings, the table heads, the line that opens each query's rows and the two comments that are its own; the generator refuses words that name a token or class the CSS no longer has, and a rule of `primitives.css` that nests another, which the file would leave out.
- `npm run design-md:check`, in CI's required `frontend-lint-and-types` job and in `scripts/nm-test.sh`, fails when the committed file differs by a byte from what the generator writes, and lints it with the pinned package's own linter.
- `@google/design.md` is pinned exactly in `front-end/package.json`, since the format is alpha and its lint rules change between versions.
- The lint fails on every error and every warning but `orphaned-tokens`, and prints how many of those it allowed; the generator's unit test holds that allowance to exactly the colours no generated component uses.
  The rule takes every colour to be a component's fill or ink, while most of Conventioner's colours draw a layout, a chart, a line or a shade, which no primitive uses.

## Consequences

- A change to a token or a primitive needs `npm run design-md` and the regenerated file in the same commit, or CI fails, naming the command and the first line that differs.
- Nobody edits `DESIGN.md`: a hand edit is drift, the comment under its front matter says where its words live, and its last Don't says not to edit it.
- A new rule of `primitives.css` is in the file at once, in an entry when one ends on its selector, else whole under "Rules no entry ends on"; a selector beside an entry's last selector in a rule's list is written on the entry's line, after "with".
- A bump of `@google/design.md`, which Dependabot proposes, is a reviewed change: a new rule or a changed severity fails the bump's own pull request, and is answered in the generator, the content module or by holding the pin.
- The linter's contrast check reads a colour without its alpha, so `contrast.test.ts` stays the contrast guard.

## Considered and rejected

- **A hand-written `DESIGN.md`**: it drifts from the CSS the first time a token moves, and nothing would say so.
- **Style Dictionary or another token pipeline**: it would make the CSS a build output, a pipeline Conventioner's hand-written `base.css` does not need for one generated file.
- **The words taken from the CSS comments**: those comments are history and reasons, not a contract, and would change the file whenever a comment did.
- **Failing on every warning**: `orphaned-tokens` would then push every colour no primitive uses out of the contract, the layouts', the charts' and the lines' among them, and the contract is meant to hold every token.
