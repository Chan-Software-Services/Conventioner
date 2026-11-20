---
layer: implementation
kind: module
describes:
  - front-end/src/stores/market.ts
  - front-end/src/utils/openMarket.ts
  - front-end/src/utils/lastMarket.ts
  - front-end/src/utils/marketActions.ts
  - front-end/src/utils/useServerRead.ts
verified: 2026-11-17
sources:
  - E38/F04/S02
  - wayfinding/the-market-frame/03
  - wayfinding/claims-and-room/02
  - E21/F02/S01
  - E21/F02/S05
  - E21/F02
  - E21/F02/S04
  - E39/F01/S02
  - E41/F01/S01
  - E41/F01/S02
  - E40/F01/S03
  - E40/F01/S04
  - T205
  - T217
  - T263
  - T274
  - T421
  - T422
  - T501
---

# The market store

[`front-end/src/stores/market.ts`](../../../front-end/src/stores/market.ts) is the one holder of a market in the browser: the open market, exactly as the server last reported it.
Every market screen, the phase rail and every tab read it; nothing else keeps a copy.
The rules it keeps for all code are [one market, from the server](../conventions/one-market-from-the-server.md); this node is how it does it.

## Interface

- `open(id)` opens a market by id, or re-reads it when it is the one already open.
  Opening another id drops what was held for the old one at once.
- `refresh()` re-reads the open market with `GET /markets/:id` and takes what it says.
  Every write that changes the market is followed by a call to it; it is also the retry after a failed arrival.
- `clear()` forgets the market entirely; signing out calls it, so one account is never shown another's market.
- `installMarketChanged()`, exported beside the store and installed once from `main.ts`, calls `refresh()` whenever a write answers that the market changed under it, so every screen follows the market as it now stands ([the market write](market-write.md#on-the-screen)).
- `market` is the held market, and only while its id is the open id; `status` is the keyed read's phase, one of `empty`, `loading`, `ready`, `refreshing`, `failed`, `refresh_failed` or `missing`, so the store can never read failed and old at once.
- `rereadFailed` is true in `refresh_failed` and in the `refreshing` that follows it, until a re-read lands; the frame says it once for every market screen ([the market frame](market-frame.md#sharp-edges)).
- `open(id)` resolves once the read it asked settles (`settled()`); `refresh()` is the read's `reread()`, and `clear()` empties the key, so an answer out when it is called lands nowhere.

Screens do not call the store directly: [`useOpenMarket`](../../../front-end/src/utils/openMarket.ts) takes the route's market id, opens the market on arrival and whenever the id changes, re-reads it when the organizer comes back to the browser tab (`visibilitychange`), and returns `{ market, status, refresh }`.
Every view routed by market id uses it, and hands the market to [the market frame](market-frame.md).

## Where a screen's permission comes from

**From the market in the store, never from a role.**
The market read carries the table's answer for the person asking, per action, as `actionRefusals` ([the market's actions](market-actions.md#what-the-screens-read)), and a screen asks it through one helper, [`front-end/src/utils/marketActions.ts`](../../../front-end/src/utils/marketActions.ts): `mayTake(market, MarketAction.CheckIn)`, or `actionRefusal(...)` for the sentence to say.
A market that carries no answer for an action refuses it, so nothing is offered before the server has said.
Each control asks the row of the action it takes, one block per screen.
A new control is one line under its screen, and a new screen is a block beside the nearest screen of its page ([two features never share a line](../conventions/two-features-never-share-a-line.md)):

**The phase rail**

- every move: Move the phase

**The phase rail's More…, in Applications**

- Redo import: Import applications
- Stop taking applications, Take applications again: Stop taking applications, and take them again, while `applicationsStopReason` is null

**Market Setup, the plan and the floorplan flow**

- every plan card, the plan's autosave: Change Market Setup
- How vendors apply's "Draft from a Google Form's responses": Import applications, since the start it opens prepares the import; the start's own page asks no row, and the server asks Import applications on its proposal and its confirm

**The Assignment tab's Settings page**

- the rules: Allocate tables, change the assignment rules, and assign, swap or free seats, and Change Market Setup, since the rules ride in the plan
- Allocate tables: Allocate tables, change the assignment rules, and assign, swap or free seats

**Tools, the Discord card**

- Connect, Disconnect, and each choice: Connect Discord and give roles

**Tools, the Public map card**

- turning the map on or off, and each question chosen: Publish the map

**The form tab, and the review's highlights**

- the questions, the highlights, the automatic rejections: Change the form

**The import**

- Import: Import applications

**Applications, the review and All**

- verdicts and follow-ups: Give verdicts, while `verdictsSettledReason` is null; on an application already approved or rejected, Change a verdict, or overturn an automatic rejection too

**Applications, the review**

- Choose reviewers, Change reviewers: Choose reviewers, while `verdictsSettledReason` is null
- Publish results: Publish results; disabled with `publishWaitsReason`

**Assignments, and the drawer's link to it**

- Change on a seat: Allocate tables, change the assignment rules, and assign, swap or free seats
- "Also remove its $15.00…" beside Free this seat: Change the amount owed, besides the Assignment row the free itself asks

**Vendors**

- Add a vendor: Add a vendor, while `addingVendorsReason` is null
- Check Discord, Give roles: Connect Discord and give roles

**The drawer, the review card and Attendance**

- vendor notes: Write vendor notes

**The drawer**

- Update info: Update a vendor's info, and, for an answer the assignment or a price group reads, Update info the assignment or price reads
- History: Read the market's history

**The drawer's Discord section**

- Confirm…, Not them: Update a vendor's info, and, for an answer the assignment or a price group reads, Update info the assignment or price reads

**The drawer's Payment tab**

- Record payment: Record a payment
- Change the amount owed, Use the calculated price: Change the amount owed
- Record refund, Edit, Remove: Adjust the amount paid

**Attendance**

- Check in, Undo: Check vendors in, in market days

**Manage market**

- each role's select, Remove, Add user: the row that gives the role (`canManageRoles` in [`permissions.ts`](../../../front-end/src/utils/permissions.ts))
- the Permissions section's Show and its dialog's rows; its changes; each row's select and Reset to built-in defaults: Read the market; Read the market's history; Change this table
- History: Read the market's history
- Rename: Change Market Setup
- Delete: Delete the market

**The markets list**

- Manage: Read the market

**Vendors, Applications' All view, and Assignments**

- Export; Download CSV: Export CSV

The frame alone says why a person may change nothing, from `readOnlyReason` ([the market frame](market-frame.md)).
No screen reads the role-shaped reasons the screens read before: every screen that read one is listed above.
The read serves none of them, nor the person's `user_role` ([the market's actions](market-actions.md#what-the-screens-read)), and the `Market` type names none of them, nor the role, so the type checker refuses a screen that reads one.

## Reads keyed by market

The reads listed below are each one keyed read, [`useServerRead`](../../../front-end/src/utils/useServerRead.ts), so the screens on it never show one market's answer, or its refusal, under another market's name.
Some reads keyed by the market are still read by hand, outside it: the review's own queue (`ApplicationMonitor.vue`) and the market's history (`MarketHistory.vue`, through `useHistoryPages`), which keep their own guards on an overtaken read, and the assignment statistics on Tables (`ResultSummary.vue`), the permission history (`MarketPermissions.vue`), the Discord roles (`MarketDiscordCard.vue`), the application form (`MarketFormTab.vue`), the door code (`DoorCodeScreen.vue`) and the import's form (`CsvImportView.vue`).
The rule for a new read and the test that holds it: [one market, from the server](../conventions/one-market-from-the-server.md#the-rules); the decision: [ADR 0036](../../adr/0036-a-market-keyed-read-is-one-keyed-read.md).
The reads on it, each keyed by the market id unless it says otherwise:

- The market store itself (`landed` sets the pointer below, `gone` forgets it).
- Attendance's roster, whose check-ins and undos go through `holdWhile` ([attendance and the door](attendance-and-door.md#sharp-edges)).
- The vendors' details ([`vendorDetails.ts`](../../../front-end/src/utils/vendorDetails.ts)), read on arriving by Vendors and Payments, and lazy where Attendance, Tables and the All view hold them for the drawer, read only when asked; and the vendor notes ([vendor notes](vendor-notes.md)).
- Payments' payments, beside the vendors' details ([`PaymentsView.vue`](../../../front-end/src/views/PaymentsView.vue)).
- Stats' figures ([`StatsView.vue`](../../../front-end/src/views/StatsView.vue)).
- Tables, keyed by the market id only while someone is signed in ([`ResultView.vue`](../../../front-end/src/views/ResultView.vue)).
- The All view's list, whose verdicts, follow-ups and undos go through `holdWhile` and whose answers it adopts ([`ApplicationsAll.vue`](../../../front-end/src/components/application/ApplicationsAll.vue)).
- Manage market's copy of the market, keyed by the market only while the dialog is open ([the market write](market-write.md)).
- A vendor's Payment tab, keyed by the market and the vendor's address together, `[marketId, email]`, compared element by element ([payments](../data/payments.md)).

`useServerRead(key, fetcher, options)` takes a getter of the key (the market id, null with none), the read, and `{ failure, refreshFailure?, missing?, lazy?, landed?, gone? }`.
It returns `key`, `phase`, `data`, `sentence` and `readAt`, all read-only, and four calls:

- `reread()` asks again (Refresh, Try again, a clock), and resolves when that read lands, fails or is dropped.
- `settled()` resolves when the newest read out settles, at once with none out.
- `holdWhile(write)` makes a write on the key open, handing it the key; it answers `ok` with the write's answer or `failed` with its error, and `left` when the key moved before the write answered (or the component is gone), so a write on another market is never said, and it never throws.
- `adopt(key, change)` takes a write's own answer into the data, for the key it was made on only.

`phase` is one of `empty` (no key, or a lazy read not asked), `loading` (nothing held), `ready`, `refreshing` (a re-read out, the data held), `failed` (the first read failed), `refresh_failed` (a re-read failed; the data kept as last read) and `missing` (only with `options.missing`: gone, or not this person's).
`sentence` is the failure said, `getApiErrorMessage(error, failure)`, or `refreshFailure` for a re-read when given; it stays while the next re-read from `refresh_failed` is out, so a line saying the data is old does not blink on every clock tick.

The moves are one pure table, `readStep(state, event)`, beside the composable, one test per row in `aReadBelongsToItsKey.test.ts`:

| From                        | Event                         | To                                                                                   |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| any                         | the same key                  | unchanged                                                                            |
| any                         | another key, or none          | `loading`, or `empty` with none or when lazy; nothing held, every read out overtaken |
| `empty` with a key, `ready` | ask                           | `loading`, `refreshing`                                                              |
| `failed`, `missing`         | ask                           | `loading`                                                                            |
| `refresh_failed`            | ask                           | `refreshing`, the sentence kept                                                      |
| `loading`, `refreshing`     | ask                           | the same phase; the read out is overtaken                                            |
| `loading`, `refreshing`     | the newest answer             | `ready`, with the data and its time                                                  |
| `loading`, `refreshing`     | the newest failure            | `failed`, `refresh_failed` with the data kept, or `missing` with nothing held        |
| any                         | an answer not the newest      | unchanged                                                                            |
| a key held                  | a write held                  | while any write is held, no answer lands and no ask is sent; the last release asks   |
| `ready`, `refresh_failed`   | an adopt of this key          | the data changed, its time kept                                                      |
| `refreshing`                | an adopt of this key          | the data changed; with no write held, the read out is overtaken and asked again      |
| any                         | a release or adopt of another | unchanged                                                                            |

The key is watched synchronously, so the state moves in the same tick as the key: nothing reads the last market's data under the new one, not even for a frame.
A read held while a write is out may have been served before the write, so it never lands; the write's release reads again.
Adopt the write's answer inside the write, on the key it is handed: the key is still held there, so the read the release asks is the only one, where an adopt after the release overtakes that read and asks once more.
Once the component is gone nothing out lands, and no `landed` or `gone` is called.
It has no timer and no retry of its own: a read that needs a timeout gives one to axios, and a clock is the screen's.

The vendors' read ([`vendorDetails.ts`](../../../front-end/src/utils/vendorDetails.ts)), which Vendors, Payments and the drawer share, says why its first read failed, or "The vendors could not be loaded." when the server gives no reason, only while nothing is held; a failed re-read keeps the vendors as last read and says "Could not update. The vendors are as they were last read.", as the roster does, on while the next re-read is out and gone once one lands (Vendors and the drawer show it only while no read is out, since they show "Loading vendors…" in place of the rows), as [the Vendors flow](../../business/flows/vendors.md) says (`vendorReadsBelongToTheirMarket.test.ts`).

The vendor page's store ([`stores/application.ts`](../../../front-end/src/stores/application.ts)) holds one signed-in vendor, not a read keyed by the market open, so it is no keyed read: its sign-in is one `session` (market, slug, address and token together, kept to `sessionStorage`), set whole and cleared whole, and a private `epoch`, moved on by `clearSession` and by a sign-in of another vendor, or on another market's page, held in place of one still signed in, keeps a late answer from landing.
Each signed-in request notes the epoch as it starts; one answering after it moved writes nothing (no application, no error, no draft kept, no questions, no second sign-out) and answers with nothing to show or say, so on a shared door device the next person sees nothing of the last vendor's, and a 401 after the sign-out never renews into the next vendor's sign-in.
A renewal through `resume` signs the same vendor in again and leaves the epoch, so the request it renews still lands.
The device remembers one vendor per market, not per tab, so another tab signing Ben in with "Remember me" makes the remembered sign-in his: a renewal that brings back an address other than the one it renews is refused and held nowhere, and the request ends as any sign-in that could not be renewed does, Ana's answers kept for her next sign-in (`aVendorsSessionEndsWhole.test.ts`).
A door code it holds through a sign-in is kept with the address it is for once it has one (`holdDoorCode`'s `email`), and the rule for who may take it is in [attendance and the door](attendance-and-door.md#sharp-edges).

## Sharp edges

**Keyed by the route's id.**
The store is built on [the keyed read](#reads-keyed-by-market), its key the open id, so a market held for one id is never shown while another is open, not even for a frame, and an answer to a fetch that a later fetch has overtaken is dropped.

**What it holds is shown while a re-read of the same market is in flight**, so returning to a screen or saving does not blank it.
Only an arrival with nothing held shows `loading`.

**A missing market and one the organizer cannot reach read identically.**
A 404 and a 403 both drop what is held and set `missing`; telling them apart would confirm to anyone guessing ids that a market is real.
Any other failure is `failed` when nothing is held, and a failed re-read keeps the held market and reads `refresh_failed`, so a dropped connection never unmounts a screen's unsaved work.
Moving to another market empties the read in one step: a failed re-read of one market, then another failing to arrive, reads `failed` alone, where a `stale` flag beside the status once read failed and old at once (T277 probe 15, in `marketStore.test.ts`).

**The pointer to the market last opened is set here and nowhere else.**
[`front-end/src/utils/lastMarket.ts`](../../../front-end/src/utils/lastMarket.ts) keeps `lastMarketId` in `localStorage`: a pointer for Markets' "Previously opened" line, never a copy.
The store sets it when a market arrives, by whatever route, and forgets it when that market comes back missing; Markets forgets it when the account's list no longer holds it ([finding a market](../../business/flows/finding-a-market.md#c2-the-markets-list)).
Every access to storage may fail quietly, since losing the pointer costs only a convenience.

**The rail never fails a screen that cannot load one.**
The frame draws the rail only once a market is in hand, so a market that will not load shows the frame's own arrival states and nothing that depends on it.

## Why

The market used to be held three ways at once (a view's ref, a value one tab published for its siblings, and `localStorage`), written by eleven call sites that each patched their own copy.
That is how the form builder ignored a phase change until the organizer left the tab.
The decision is [ADR 0009](../../adr/0009-the-back-end-is-the-only-source-of-truth.md).

The glossary concept it serves: [Market](../../business/concepts/market.md).
