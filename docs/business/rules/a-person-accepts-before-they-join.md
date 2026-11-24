---
layer: business
kind: rule
verified: 2026-11-24
sources:
  - T538
---

# A person accepts before they join

A person gains a role on a market only by accepting an invitation, signed in with the address it was sent to.
Adding someone gives one answer for every address: whether or not the address has an account, the organizer reads "Invitation sent", the address is sent the same email, and the market's history records the same entry.

## The rule

- **An invitation gives nothing.**
  Inviting an address writes no role: the invitation waits ([invitations](../../implementation/modules/invitations.md)) until someone signed in with that address accepts it, and nobody reads it as a role meanwhile.
- **Every address gets the same answer.**
  The answer, the email and the entry depend only on the address typed, the role, the inviter and the time; the entry names the address alone, never an account.
  The one refusal that reads the address's account is of a person already holding a role on the market, whom the organizer can read in "Users with access" anyway.
- **Whoever may give the role may invite to it**, as [what each role may do](what-each-role-may-do.md) says: an Admin invites Editors and Viewers, the owner invites Admins too, and nobody is invited as the Owner, which changes only when ownership is transferred.
  An archived market still takes invitations, since who has access is not a change to its record ([an archived market is read-only](an-archived-market-is-read-only.md)).
- **An invitation waits 14 days.**
  Inviting the address again replaces it, with the new role, a new email and a new 14 days.
  Whoever may give its role may withdraw it while it waits.
- **Inviting is bounded.**
  An organizer sends at most 100 invitations, and one address is sent at most 5, in a quarter of an hour; past either the organizer reads how long to wait, alike for every address.
- **A market's invitations go with it** when it is deleted.
- **Everyone already holding a role keeps it**, unasked.

Why a person accepts, rather than being added with one answer: [ADR 0047](../../adr/0047-a-person-joins-only-by-accepting-an-invitation.md).
