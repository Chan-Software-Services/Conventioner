---
layer: business
kind: flow
describes:
  - front-end/src/views/InvitationsView.vue
  - front-end/src/components/InvitationRow.vue
  - front-end/src/utils/invitations.ts
  - front-end/src/__tests__/theInvitationsPage.test.ts
  - front-end/e2e/answering-an-invitation.spec.ts
  - front-end/e2e/pages/InvitationsPage.ts
  - front-end/e2e/helpers/invitations.ts
verified: 2026-11-24
sources:
  - T538
---

# Answering an invitation

**Who:** anyone with an account, signed in with the address an invitation was sent to.
**Where they start:** the link in the invitation's email, `/invitations`, or "See invitations" on the Markets list.
**Serves:** [A request can only do what its session may](../intents/a-request-can-only-do-what-its-session-may.md).

An organizer who may give a role on a market, or a place in an organization, invites an address to it, and only accepting it gives the role or the place ([a person accepts before they join](../rules/a-person-accepts-before-they-join.md)).
The Invitations page ([`InvitationsView.vue`](../../../front-end/src/views/InvitationsView.vue)) lists every invitation waiting for the signed-in address, newest first, each a row ([`InvitationRow.vue`](../../../front-end/src/components/InvitationRow.vue)) answered in place; its words are [`invitations.ts`](../../../front-end/src/utils/invitations.ts)'s.
The routes it reads and answers through are [the invitations module](../../implementation/modules/invitations.md#answering-an-invitation)'s.
Only invitations to the signed-in address are listed, so a forwarded email lets nobody else answer one.
The page fits a phone, as the Markets list does: nothing scrolls sideways, and each button is a 44px target ([the design language](../../design-system.md#layout)).
No place in the app bar leads to it.

Covered by:

- [`answering-an-invitation.spec.ts`](../../../front-end/e2e/answering-an-invitation.spec.ts), O1 to O4 end to end at 1440 and 390, through [`InvitationsPage.ts`](../../../front-end/e2e/pages/InvitationsPage.ts) and the invitations [`helpers/invitations.ts`](../../../front-end/e2e/helpers/invitations.ts) sends
- [`screen-sweeps-*.spec.ts`](../../design-system.md#what-keeps-this-true), two invitations waiting, none, and the Markets list's line
- [`theInvitationsPage.test.ts`](../../../front-end/src/__tests__/theInvitationsPage.test.ts), every state and answer below

## O1. Find the invitations

**Status:** Works (`answering-an-invitation.spec.ts`).
**Task:** "Someone invited me to their market."

1. Open the email's link, which is `/invitations`; signed out, sign in first and the page opens after, or create an account with that address, verify it and sign in, and the Markets list points to it, as step 2 says ([accounts](accounts.md)).
2. Or, on the Markets list, read "You have an invitation waiting." or "You have 2 invitations waiting." above the other lines, and "See invitations" ([C2](finding-a-market.md#c2-the-markets-list)).
3. Expect the heading "Invitations", "Loading invitations…" while it first reads, then a row each: "dana@example.com invited you to Riverside Market as an Editor." (an Admin, a Viewer), or "… invited you to the organization Ember Makers as a member." (an admin), and under it "Until 8 December, 16:44.", the moment it ends in the reader's own timezone, then "Accept" and "Decline".

None waiting reads "No invitations are waiting for you."
A read that fails says why ("Could not read your invitations." when the server gives no sentence of its own), with "Try again".
An invitation past its end, withdrawn, or to a market or an organization deleted or being deleted is not listed.

## O2. Accept

**Status:** Works (`answering-an-invitation.spec.ts`).

1. "Accept" on the row.
2. Expect, where the buttons were, "You are now an Editor on Riverside Market." with "Open Riverside Market", which opens the market as the Markets list does, or "You are now a member of Ember Makers." with "Open Organizations".
   The focus moves to that line, since the button pressed is gone.

Both buttons are held while the answer is out, so a second press sends nothing.
The row keeps its place until the page is left or read again, and the next one still waits.

## O3. Decline

**Status:** Works (`answering-an-invitation.spec.ts`).

1. "Decline" on the row.
2. Expect "You declined the invitation to Ember Makers." where the buttons were, the focus on it.

Nothing of the person is left on the market or in the organization; its history says they declined.

## O4. An invitation that can no longer be accepted

**Status:** Works (`answering-an-invitation.spec.ts` for one withdrawn while the page was open).

- Withdrawn, past its end, its inviter no longer able to give it, or its market or organization gone: "This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no longer give it. Ask them to invite you again.", in the refusal red, and the buttons go.
- Already holding a role on that market: "You already have a role on this market, so this invitation has ended. Ask its owner or an Admin to change your role."; already in that organization: "You are already in this organization, so this invitation has ended.". The buttons go.
- The market or the organization changed by someone else as it was accepted: the accept is judged again at once, and answers as above or gives what it offers.
- No connection, or a fault on the server: said under the buttons, which stay to answer again.

## Afterwards

The market's history and the organization's read the invitation in words ([reading the market's history](reading-the-markets-history.md)): "dana@example.com invited ana@example.com as an Editor", "… withdrew the invitation to ana@example.com", "ana@example.com declined the Editor role", and, once accepted, "dana@example.com gave ana@example.com the Editor role, which they accepted", the inviter being who gave it.
