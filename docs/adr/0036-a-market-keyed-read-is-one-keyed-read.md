---
layer: implementation
kind: adr
describes:
  - front-end/src/utils/useServerRead.ts#readStep
  - front-end/src/__tests__/everyMarketReadIsKeyed.test.ts
verified: 2026-11-17
sources:
  - T277
  - T421
status: accepted
---

# A market-keyed read is one keyed read with a phase union

## Context

An organizer moves from one market to another while a screen's read of the first is still out, and the screen showed the first market's data under the second market's name.
T277 reproduced it on Payments (market A's vendors and totals on B's page), in a vendor's drawer (Ana's account on Ben's Payment tab), in Manage market (A's late read putting A's name back, and Rename then renaming A) and at the door (a check-in refused on A said on B's roster, A's vendor notes on B's rows); in the All view, a re-read asked before a verdict landed after it and showed the application undecided again.
Each screen held its own data, loading flag and error, read on a watch of the market id and checked each answer by hand: nine guards under eight names, or none, and each a place the next screen could leave out.
The market store could read failed and stale at once, and nothing on screen said a re-read had failed.

## Decision

**A read keyed by the market open is one keyed read, `useServerRead(key, fetcher, options)` in [`front-end/src/utils/useServerRead.ts`](../../front-end/src/utils/useServerRead.ts), whose state is one phase union moved only by a pure table, `readStep(state, event)`: the reads on it, and those still made by hand (the review's own queue and the market's history among them), are listed in [reads keyed by market](../implementation/modules/market-store.md#reads-keyed-by-market), and every new read goes on it.**

- The phases are `empty`, `loading`, `ready`, `refreshing`, `failed` and `refresh_failed`, and `missing` for a read that names it (the market store's 404 and 403); the data, the failure's sentence and when the data was read sit beside the phase, and the screen reads its loading words, its error and its freshness from them, never from flags of its own.
- **The key moves the state in the same tick**: the key is watched synchronously, and a new key empties the state in one step, so nothing reads the last market's data under the new one, not even for a frame.
- **Only the newest read asked lands**: each read is numbered, and an answer to any other, a read of an old key or one a later ask overtook, changes nothing, its refusal included.
- **A write held through `holdWhile` keeps every read asked before or during it from landing**, since the server may have served that read before the write and its answer would put back what the write changed; the write's release asks again, and `holdWhile` answers `left`, saying nothing, when the key moved before the write answered.
- A write's own answer is taken in through `adopt`, only for the key it was made on.
- The composable has no timer and no retry of its own: a timeout is the fetcher's, a clock the screen's.
- No new read goes on a watch of a market id: [`everyMarketReadIsKeyed.test.ts`](../../front-end/src/__tests__/everyMarketReadIsKeyed.test.ts) fails on one outside the files it lists, each with why its watches are allowed (a reset of what is shown, or a read with its own guard: the review's queue and the history).

The table row by row, the interface and every screen on it: [reads keyed by market](../implementation/modules/market-store.md#reads-keyed-by-market); the rule: [one market, from the server](../implementation/conventions/one-market-from-the-server.md#the-rules).

## Consequences

- A screen moved to another market says its loading words at once and never shows the last market's data or error; a late answer, or a write's refusal, for the market left lands nowhere.
- A change to what an event does in a phase is one row of one table, and a test per row (`aReadBelongsToItsKey.test.ts`) sees it.
- A failed re-read keeps the data as last read and says so, where several screens emptied themselves; the frame says a failed re-read of the market once, for every market screen.
- A screen that needs to forget what it showed on a move (a fold, a refusal) watches its read's `key`, a reset and never a read.
- The vendor page's store holds one signed-in vendor rather than a market read, so it keeps no keyed read: its sign-in is one `session`, and an epoch moved when this tab's vendor stops being the one signed in (`clearSession`, on a sign-out or an ended sign-in, or another vendor's sign-in held in its place) keeps a late answer from landing.

## Considered and rejected

- **A guard per screen, in a shared helper each screen calls by hand**: the races came from the screens that left it out, and a helper is as easy to leave out as a guard.
- **Keying the app's `RouterView` by market, so each screen remounts per market**: it would drop a screen's unsaved working copy and its scroll on every move, and a read asked before a write on the same market would still land.
- **Letting a read asked before a write land when it answers after the write**: its answer may be the server's state before the write, so a verdict or a check-in would read as undone until the next re-read.
