---
layer: business
kind: rule
verified: 2026-11-24
sources:
  - T538
---

# A person accepts before they join

A person invited to a role on a market, or a place in an organization, gains it only by accepting the invitation, signed in with the address it was sent to.
Inviting someone gives one answer for every address: whether or not the address has an account, the invite answers the same status and body, the address is sent the same email, and the market's or the organization's history records the same entry.
Manage market's "Add user" and Manage organization's "Add admin" and "Add member" still add a person directly, at once, until they invite instead and the direct adds are removed.

## The rule

- **An invitation gives nothing.**
  Inviting an address writes no role: the invitation waits ([invitations](../../implementation/modules/invitations.md)) until someone signed in with that address accepts it, and nobody reads it as a role meanwhile.
- **Every address gets the same answer.**
  The answer, the email and the entry depend only on the address typed, the role, the inviter and the time; the entry names the address alone, never an account.
  The one refusal that reads the address's account is of a person already holding a role on the market, whom the organizer can read in "Users with access" anyway, or a place in the organization, whom its owner and admins read among its people; it comes only after the limits.
  A member invited as an admin is pointed at their row, where the owner makes them one.
- **Whoever may give the role may invite to it**, as [what each role may do](what-each-role-may-do.md) says: an Admin invites Editors and Viewers, the owner invites Admins too, and nobody is invited as the Owner, which changes only when ownership is transferred.
  An archived market still takes invitations, since who has access is not a change to its record ([an archived market is read-only](an-archived-market-is-read-only.md)).
  An organization's owner invites admins and members, and its admins invite members, as adding them allowed; its owner and admins see its invitations.
- **An invitation waits 14 days.**
  Inviting the address again replaces it, with the new role, a new email and a new 14 days.
  Whoever may give its role may withdraw it while it waits.
- **Inviting is bounded.**
  An organizer sends at most 100 invitations, and one address is sent at most 5, in a quarter of an hour; past either the organizer reads how long to wait, alike for every address.
- **Only the invited address may answer.**
  A person signed in with the address it was sent to lists it, accepts it or declines it; to anyone else it reads as an invitation that has ended, so a forwarded email lets nobody else join.
- **Accepting is the inviter's act, judged again.**
  It gives the role only while the market is live, the inviter's account is the one that sent it, and the inviter may still give that role; otherwise the invitation has ended, and the invitee is told to ask for it again.
  The market's history records the inviter giving the role, by an invitation accepted.
  Someone who already holds a role on the market is told so, and the invitation ends: accepting never changes a role.
  An organization's place is judged the same way; a member who accepts an invitation to be an admin becomes one, and anyone else already in it is told so, and the invitation ends.
- **Declining leaves nothing of the person on the market or in the organization**; the history records that they declined.
- **A market's invitations go with it** when it is deleted, and an organization's with it, its markets' with each market.
- **Everyone already holding a role keeps it**, unasked.

Why a person accepts, rather than being added with one answer: [ADR 0047](../../adr/0047-a-person-joins-only-by-accepting-an-invitation.md).
