---
layer: implementation
kind: convention
describes:
  - front-end/src/utils/market.ts#parseMarketFromApi
  - front-end/src/__tests__/noMarketInTheBrowser.test.ts
  - front-end/src/__tests__/everyMarketReadIsKeyed.test.ts
  - back-end/api/markets.py#get_market_for_user
verified: 2026-11-14
sources:
  - wayfinding/the-market-frame/map
  - wayfinding/the-market-frame/02
  - wayfinding/the-market-frame/03
  - E21/F02
  - E21/F03/S06
  - E04/F04/S02
  - T15
  - E38/F07/S02
  - E38/F12/S01
  - T204
  - T213
  - T263
  - T274
  - T421
  - T496
---

# One market, from the server

**The back end is the only source of truth about a market, and the browser holds it in one place**: [the market store](../modules/market-store.md).
Every market screen, the phase rail and every tab read it; a screen gets it through `useOpenMarket`.
The decision and its trade-off are [ADR 0009](../../adr/0009-the-back-end-is-the-only-source-of-truth.md).

The glossary concept: [Market](../../business/concepts/market.md).

## The rules

**A write is followed by a re-read, never a patch.**
After anything that changes the market (a transition, which the rail does itself, a plan or form save, an assignment run, a placement, an import, a highlight), call the store's `refresh()`.
Never assign into the held market: no caller should need to know which fields its write touched.
The write itself names what it changes; there is no whole-market write ([ADR 0008](../../adr/0008-each-write-names-what-it-changes.md)).

**Unsaved work is the editor's working copy, never layered on the store.**
The plan keeps its own `setupObject` and `planIntakeMode`, and the form builder its own form.
The editor writes, the store re-reads, and the working copy is reset from it; a re-read never overwrites a working copy that holds unsaved edits.
A phase move once replaced the whole local market with the transition's response, which carries the setup as last saved, so advancing a phase silently discarded every unsaved edit, and Assign was then disabled for a reason the screen never stated.

**A market-keyed read goes through `useServerRead`; no new read goes on a watch of a market id.**
A read of something keyed by the market open (the market itself, a roster, a list, a vendor's account) is one keyed read, [`useServerRead`](../../../front-end/src/utils/useServerRead.ts): a move to another market drops what the last one showed in the same tick, an answer or a refusal for the market left never lands, and a write held through it keeps every read asked before it from landing ([reads keyed by market](../modules/market-store.md#reads-keyed-by-market), [ADR 0036](../../adr/0036-a-market-keyed-read-is-one-keyed-read.md)).
The reads still made by hand, outside it, the review's own queue and the market's history among them, are listed in [reads keyed by market](../modules/market-store.md#reads-keyed-by-market); the rule holds every new one.
Each screen once read on `watch(marketId, load)` and checked each answer by hand, nine guards under eight names or none, and where one was missing a late answer for the market just left landed under the next one's name.
[`everyMarketReadIsKeyed.test.ts`](../../../front-end/src/__tests__/everyMarketReadIsKeyed.test.ts) fails, naming the file, on a `watch(` whose source names a market id outside the files it lists, each listed with why its watches are allowed (a reset of what is shown, a write resumed, the store opened, who is signed in asked again, or a read with its own guard: the review's queue and the history), or on more such watches in a file than it allows.
A screen forgets what it showed on a move by a watch of its read's `key`, which the test does not match.

**Nothing about a market is stored in the browser.**
The `localStorage` key `market` is gone, and [`noMarketInTheBrowser.test.ts`](../../../front-end/src/__tests__/noMarketInTheBrowser.test.ts) fails, naming the file, if any source file reads, writes or removes it again.
The browser keeps only the `lastMarketId` pointer, which the store sets when a market arrives.

**Facts derived from the market are served on it, not fetched per tab.**
`GET /markets/:id` ([`get_market_for_user`](../../../back-end/api/markets.py)) stamps the facts derived from it onto the market it serves, among them the form lock (`applicationFormLockReason`), the setup and rules locks, `transitionBlockers`, `applicationsStopped`, `vendorSelfCheckIn`, `phasesReached`, `assignmentOutOfDate`, the assignment's `allocation` and `assignRefusalReason` ([the assignment's lifecycle](../modules/assignment-lifecycle.md)), `orphanedPins`, each person's `actionRefusals` (every row of [the market's actions](../modules/market-actions.md) answered for them, from the rows the market holds) and `readOnlyReason`, the table itself for display (`permissionTable`), the rules of the market's life the rows never override (`verdictsSettledReason`, why the review is closed in the words of where the market stands, `addingVendorsReason`, `publishWaitsReason`, and the stage's `applicationsStopReason`, when stopping applications may be taken, E38/F04/S02), and `peopleOnMarket`, whom this reader's follow-up may name: everyone the role rule reaches to someone in the market's organization, the market's own roles to anyone else ([needs follow-up](../../business/rules/needs-follow-up.md)); `peopleOnMarket` is served only to someone who may give a verdict, and every other reader gets an empty list; `peopleWithAccess`, everyone with access at the role that counts, the owner first ([managing who has access](../../business/flows/ending-and-managing-a-market.md#l3-manage-who-has-access)), with the organization's people only to a reader in it or one who may give and take Editor and Viewer roles, and `inOrganization`, whether this reader belongs to the market's organization; the review's team and whom this reader may choose as a reviewer (`reviewTeam` to every reader, `reviewerCandidates` only to someone who may choose, while the review is open, [the review is dealt among chosen reviewers](../../business/rules/the-review-is-dealt-among-chosen-reviewers.md)); `discordSetUp`, whether the deployment has Discord's values, and `discordVendors`, each vendor as the last "Check Discord" found them and as the pages show them now, "Possible match" and "Check again" included ([the Discord connection](../modules/discord.md#who-is-in-the-server)).
It serves `planRevision` as the model reads it, 0 for a market that never stored one, since Market Setup sends it back with every plan save ([the plan's revision](../modules/market-write.md#the-plans-revision)).
It names no role: a screen reads what this person may do from `actionRefusals` alone, and the read serves no `user_role` ([what the screens read](../modules/market-actions.md#what-the-screens-read)).
A tab that fetches a fact for itself and publishes it to its siblings is how the form builder and the priority rules went stale.
Every screen makes this read, so it reads the accounts its lists name in one read, never one per person: the reader by address, then the market's roles and, on its organization's market, the organization's owner, admins and members in one `get_users_by_ids` ([users and email](../data/users-and-email.md#lookups)).
Reading an account serves it to no one: each list keeps its own rule on whom it names to this reader.
Nothing a client sends can write one of these.
One stored field is never served on it, or on a Markets list entry: the door code (`doorCode`, `NEVER_SERVED_FIELDS` in [`market_documents.py`](../../../back-end/market_documents.py), taken off by `leave_out_what_no_read_serves`), which a Viewer could otherwise read and check vendors in by proxy; only its own endpoints serve it ([attendance and the door](../modules/attendance-and-door.md#the-routes)).
Every answer a column of `exampleColumns` keeps (`answers`) is served only on this read, to someone who may change the form while it can still change ([ADR 0023](../../adr/0023-every-answer-for-an-option-to-offer.md)); a screen finds no `answers` for every other reader, and reads that as the common options being all there is.

**`parseMarketFromApi` carries every field the server sends.**
[`parseMarketFromApi`](../../../front-end/src/utils/market.ts) spreads the payload, and the plan inside it, first, and normalises only the fields it names over them.
It once rebuilt `setupObject` from a fixed key list and dropped `floorplans`; once screens read the parsed market, the plan's autosave erased the floorplan.
The plan write now keeps the stored layouts and table types whatever its body carries (T257, [a location's layout](../modules/floorplan-placement.md#sharp-edges)), so a dropped key can no longer erase a layout, but a screen reading `floorplans` or `tableTypes` still reads them from here.
Each field the server added and the old list missed (`intakeMode`, `transitionBlockers`, `setupLockReason`) was silently dropped until a screen behaved as though the server had never said it.
A field added to the read now reaches every screen without touching the parser.

## How it is enforced

- `noMarketInTheBrowser.test.ts` reads the source for the stored market key.
- `everyMarketReadIsKeyed.test.ts` reads the source for a watch of a market id.
- `front-end/src/__tests__/market.test.ts` pins that the parser carries fields it does not name.
- The back end has no route that accepts a whole market (`back-end/tests/test_the_market_put_is_gone.py`).

## What breaks it

- A screen that keeps its own `ref` of the market, or fetches the market itself instead of reading the store.
- A screen that reads on a watch of the market id, holding its own data, loading flag and error, instead of one keyed read.
- A write followed by assigning its response into the held market instead of `refresh()`.
- A parser, mapper or type guard that rebuilds the market from a list of keys.
- A tab computing a fact about the market (a lock, a verdict on a move) that the server already answers.
