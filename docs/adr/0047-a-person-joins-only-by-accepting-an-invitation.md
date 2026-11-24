---
layer: implementation
kind: adr
describes:
  - back-end/invitations.py
verified: 2026-11-24
sources:
  - T538
status: accepted
---

# A person joins only by accepting an invitation

The rule it keeps: [a person accepts before they join](../business/rules/a-person-accepts-before-they-join.md); the node it constrains: [invitations](../implementation/modules/invitations.md).

## Context

An organizer gave someone a role on a market, or a place in an organization, by typing their address.
An address with an account was placed at once, unasked, and one without was answered "User not found".
So adding someone said which addresses had accounts, which nothing else in the product says: the sign-up, the sign-in and the reset already answer alike for every address.

## Decision

**Every role and place a person gains, after the market's or the organization's creation, is an invitation they accept.**
The organizer types an address and a role; every address gets the same answer, the same email and the same history entry, and an invitation is written in `invitations` ([`back-end/invitations.py`](../../back-end/invitations.py)), keyed by its target and address.
Only someone signed in with that address accepts it, on the Invitations page.

- **Acceptance is judged again, as the inviter's act.**
  The role is given at the moment it is accepted, so the inviter must still be able to give it then: accepting asks the inviter's row again, and records the role given through that asking, with the inviter as its actor.
  An invitation whose inviter can no longer give it has ended.
- **The email carries no one-click link.**
  It names who invited them, to what, as what and until when, and points at the Invitations page.
  A link that accepted by itself would let whoever holds the email join, a forwarded copy included; signing in with the address is what proves it is theirs.
- **An invitation waits 14 days**, and inviting the address again replaces it, so inviting again is how an organizer resends.
- **Nothing migrates**: every role and place held before this stands.

## Alternatives considered

- **A direct add that answers alike for every address**, placing an address with an account at once and answering one without as if it had: rejected.
  It still places people where they did not choose to be, and it needs the same record of an address with no account, to give the role once they sign up, which is an invitation by another name.
- **Accepting judged only when it was sent**: rejected.
  An invitation sent by an Admin who is no longer one would give a role nobody can give any more.

## Consequences

- An organizer waits for the person to accept, where before the role was there at once; the market's history says who invited whom, who withdrew it and who declined.
- Every E2E spec and seed that gave a role directly gives it by inviting and accepting.
