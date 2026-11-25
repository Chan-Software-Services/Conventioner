---
layer: implementation
kind: module
describes:
  - back-end/organization_people.py
  - back-end/tests/test_one_writer_holds_each_place_it_judged.py
  - back-end/tests/test_an_organizations_people_stay_one_map.py
  - back-end/tests/real_mongo/test_an_organizations_people_on_the_server.py
  - back-end/tests/test_the_shared_organizations_fake.py
  - back-end/tests/test_answering_an_organization_invitation.py
  - back-end/tests/test_every_module_imports_first.py
  - front-end/src/views/ManageOrgOverlay.vue
  - front-end/src/utils/api.ts#isOrganizationChanged
  - front-end/src/__tests__/aChangeThatMetAnotherInAnOrganization.test.ts
  - front-end/src/__tests__/changingAPlaceAsksFirst.test.ts
  - front-end/src/__tests__/manageOrganizationPeople.test.ts
  - front-end/e2e/an-organizations-people-change-place.spec.ts
  - front-end/src/__tests__/manageOrganizationInvites.test.ts
verified: 2026-11-25
sources:
  - T283
  - T315
  - T411
  - T538
  - T583
---

# The organization's people

[`back-end/organization_people.py`](../../../back-end/organization_people.py) is the one writer of an organization's people, the map `people` from user id to `owner`, `admin` or `member` ([the organization document](../data/organization-document.md#one-map-of-people), [ADR 0025](../../adr/0025-an-organizations-people-are-one-map.md)).
It also builds the one filter that finds the organizations a person is in, `of_person`, and the one spelling of a person's path in the map, `people_key`.

## Its interface

- `add_admin(org_id, email, requester)`, `add_member(org_id, email, requester)` and `remove(org_id, user_id, requester)`: each loads the organization and the account asking, judges the change on the organization as read and writes it in one conditional write, then records the change in the organization's history.
  `api/organizations.py`'s `add_org_admin`, `add_org_member` and `remove_org_user` call them and nothing more, so the routes keep their names.
- `change_place(org_id, user_id, place, requester)`: the owner makes an admin a member or a member an admin, `place` being the request's `"admin"` or `"member"` and anything else refused before the organization is read, 400 "A place is admin or member.".
  `api/organizations.py`'s `change_org_place` calls it, for `PUT /organizations/<org_id>/users/<user_id>`, which answers `{"message": "Place changed"}`.
- `place_by_invitation(invitation, invitee)` (T538): someone signed in with an invited address accepts an invitation to be an admin or a member ([invitations](invitations.md#answering-an-invitation)).
  It is judged as the inviter's act: the organization live, the inviter's account the one that sent it, `may` with the place's event (`INVITED_TO`: `admin` asks "Add admin", `member` "Add member") of the inviter's place as read, and `next_people` on the invitee's.
  The first three refused end the invitation, 404 `InvitationEnded`; the table refusing the invitee (the owner, an admin, a member invited as a member) ends it, 400 "You are already in this organization, so this invitation has ended."; a member invited as an admin becomes one.
  The invitation is claimed before the write (`Invitations.claim`), so one withdrawn, declined or sent again to another place meanwhile answers ended and gives nothing ([invitations](invitations.md#answering-an-invitation), steps 4 and 5).
  The write is `_change`'s, holding the inviter's key and the invitee's as read; an `OrganizationChanged` judges again and writes again in the same request, never putting the invitation back, and its entry is `_record_role`'s, the inviter its actor and `"by_invitation": true` in its detail.
  [`test_answering_an_organization_invitation.py`](../../../back-end/tests/test_answering_an_organization_invitation.py) pins each step.
  `already_placed(address, place, held)` is the sentence an invite to an address already holding a place answers, which `api/organizations.py`'s `invite_to_organization` says.
- `transfer(org_id, requester, new_owner_email)`: the owner transfers the organization's ownership to one of its admins or members, and stays on it as an admin.
  `api/organizations.py`'s `transfer_org_ownership` calls it, for `POST /organizations/<org_id>/transfer`, which answers `{"message": "Ownership transferred successfully"}`.
  Anyone but the owner is refused first, 403 "Only current owner can transfer ownership", then an address with no account, 400 "New owner user not found".
  The history records `transfer-organization` with the owner's address before and after, as it always has.
- `forget(user_id)`: an account's deletion takes its place in every organization it was an admin or a member of, by one `update_many`, their key unset wherever it is `admin` or `member`.
  An owner is not matched: `delete_user` refuses an owner before it deletes the account.
  That leaves one window, accepted: `delete_user` reads that the account owns no organization and only then deletes it, so a transfer to that account landing in between leaves an organization owned by an account that is gone, which `forget` does not match and nobody can transfer.
  It needs the person deleting their account and someone handing them an organization in the same moment, no screen deletes an account, and closing it needs a transaction across the users and organizations collections.
  A market has the same window: `delete_user` reads that the account owns no market and only then deletes it, so a market the same person creates in another tab in between, or one whose ownership another market's owner transfers to them then ([transferring a market's ownership](market-actions.md#transfer-ownership-hand-on-market)), is left owned by an account that is gone; it is accepted for the same reasons, a transaction across the users and markets collections closing it.
- `next_people(people, event, requester_id, target_id)`: the map a change leaves, or the client error it answers, with no database; the writer and the tests both call it.
- `OrganizationChanged`, a `ConflictError`: 409, body `{"error": ORGANIZATION_CHANGED, "code": "organization_changed"}`.

## The table

**`AUTHORITY` says who may ask for each change, by their place as read, and is checked first**: "Add admin" is the owner's ("Only organization owner can add admins"), "Add member" and "Remove" the owner's or an admin's ("Only organization owner or admin can add members", "... can remove users"), a place change the owner's ("Only the organization's owner can change someone's place in it."), and a transfer the owner's ("Only current owner can transfer ownership").
**`TABLE` says what each change does to the target's place as read**:

| Target's place | Add admin                                             | Add member                                            | Change place to admin | Change place to member | Remove                                                              | Transfer to them                                                              | Forget        |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------- | --------------------- | ---------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| none           | admin                                                 | member                                                | 404 (as Remove)       | 404 (as Remove)        | 404 "They are no longer in this organization."                      | 400 "Transfer ownership only to one of the organization's admins or members." | nothing       |
| member         | admin                                                 | 400 "They are already a member of this organization." | admin                 | member, nothing done   | none                                                                | owner, and the giver admin                                                    | none          |
| admin          | 400 "They are already an admin of this organization." | 400 "Admin cannot be added as member"                 | admin, nothing done   | member                 | none, the owner's alone (403 "Only owner can remove admins")        | owner, and the giver admin                                                    | none          |
| owner          | 400 "Owner cannot be added as admin"                  | 400 "Owner cannot be added as member"                 | 400 (below)           | 400 (below)            | 400 "They own this organization, so they can't be removed from it." | 400 "They already own this organization"                                      | never reached |

"Add admin" of a member makes them an admin, recorded as the place changed; Manage organization's "Invite admin" refuses a member's address instead, pointing at "Make admin" ([invitations](invitations.md)), so only an accepted invitation to an admin's place sent before they became a member reaches that cell from a screen.
A place set to the place held answers 200 and writes and records nothing; the owner's place is refused, 400 "The owner's place changes only when ownership of the organization is transferred.".
The owner's removal names no fix, since no screen transfers an organization's ownership yet ([B6](../../business/flows/organizations.md#b6-transfer-ownership)).
A person changing place keeps their position in the map's order, the transfer's giver and new owner alike; someone added joins its end.
A place change is recorded as the admins' `role_changed`, with the place before and after.

## Every write holds what it judged

**The write's filter holds the requester's and the target's keys at their places as read**, `{"$exists": false}` where the target had none, and its update moves the target's one key, `$set` or `$unset` of `people.<id>`, and nothing else: no write touches `owner`, `admins` or `members`, which the organization no longer keeps (T583, [the organization document](../data/organization-document.md#migrations)).
An organization with no map reads as nobody, so no change is ever judged allowed on it, and no write meets one.
**A change that changes nothing writes and records nothing.**
A user id reaches a path only from a stored account or the stored map: `remove`'s and `change_place`'s id comes from the request's address, and is looked up in the map as read before any path is built, so one the map does not hold, dotted or not, is a 404.

**Transferring the organization's ownership is one such write, filtered on the giver being owner** and the new owner at their place as read, so no cut and no read finds the organization with two owners or none.
Its update sets the new owner's key to `owner` and the giver's to `admin`, and holds nothing beyond those two keys, so an admin the owner added meanwhile is no change to it: written after that add, it lands beside it; written before it, it makes the owner an admin, so the add, holding the owner's place as read, is the 409.
It was four unconditional writes: cut between them, an organization stored its owner in its own `admins` and did not parse, or the person it was transferred to had no place in it at all.

## A write that met a change

**A write that matched nothing reads the organization once more to answer**: gone, 404 "Organization not found"; a removal whose target is now gone, 404 "They are no longer in this organization.", which Manage organization reads as done; anything else, `OrganizationChanged`, 409, "This organization changed while you were working on it, so your change was not saved. Check its people as they are now, then make your change again."
Nothing is retried on the server: the person decides again on what is true.
So two transfers judged on one read land once, a transfer to someone removed meanwhile is the 409, and an "Add member" judged before the owner transferred ownership to that same person is refused, where it used to land the new owner in `members` and leave an organization that did not parse.
A place change of someone removed meanwhile is that 409 too, since only a removal reads the person gone as done.
**Manage organization** ([`ManageOrgOverlay.vue`](../../../front-end/src/views/ManageOrgOverlay.vue)) tells the 409 apart by its code (`isOrganizationChanged` in [`api.ts`](../../../front-end/src/utils/api.ts)), shows its sentence where the control's refusal shows, in the Remove or place-change confirmation, which stays open, and reads the organization again behind it, the list behind and the History with it.
**Each write belongs to the opening it was sent from** (T411, [dialogs](../conventions/dialogs.md)): Invite admin, Invite member and Rename write through `useDialogSubmit` handles opened on the organization Manage organization is open on, said beside their rows, and Remove, the place change and an invitation's Withdraw through handles opened on what each confirmation asks, each holding its dialog through its write and the re-read after it.
An invitation writes none of the organization's people: Invite admin and Invite member post an invitation and re-read the invitations alone, a read of their own keyed by the organization Manage organization is open on, and nobody joins Admins or Members until they accept ([inviting an admin or a member](../../business/flows/organizations.md#b2-invite-an-admin-or-a-member)).
Each re-read runs inside its write and asks the write's submission whether its opening still stands (`isCurrent`), so a re-read for an opening that has gone is not sent, and one that lands after it writes nothing; a change that lands after its opening has gone still tells the list behind, by `changed`.

**No change writes the account's `organizations`**, which nothing reads (T583, [users and email](../data/users-and-email.md)).

## Make member and Make admin

**Manage organization gives its owner "Make member" on each admin's row and "Make admin" on each member's**, secondary buttons before Remove, each naming the person in a visually hidden span, as Remove does.
Each carries `data-dialog-not-first`, so Manage organization still opens on "Invite admin", never on the first admin's row ([dialogs](../conventions/dialogs.md)).
Each opens a confirmation in `AppDialog`, not destructive, whose words `organizationPlaceChange` in [`organizations.ts`](../../../front-end/src/utils/organizations.ts) gives: "Make <email> a member?", "They will read every market of <organization> instead of running it, unless a market gives them a role of its own.", confirmed by "Make member"; or "Make <email> an admin?", "They will run every market of <organization> as its Admin.", confirmed by "Make admin".
`AppDialog` draws its title, as every dialog's, through `EmailAddress`, so a long address breaks only before its "@" or a dot ([dialogs](../conventions/dialogs.md)), and so does the Remove confirmation's.
The flow is [B3a in organizations](../../business/flows/organizations.md#b3a-make-an-admin-a-member-or-a-member-an-admin).
Confirmed, the organization is read again, the confirmation closes, and focus goes to the list the person now stands in, a `tabindex="-1"` group named by its heading, as after a Remove.
A 404, someone removed meanwhile, is read as done, with focus on the list their row left; every other refusal stays in the confirmation, the 409 with the organization read again behind it.

## Sharp edges

**It imports `history` inside `_record_role`**: `history` reads `api.market_actions`, which reads `api.permissions`, which reads `of_person` here, so a module-level import is a cycle that stops the server at boot while the suite, importing in conftest's order, passes.
[`test_every_module_imports_first.py`](../../../back-end/tests/test_every_module_imports_first.py) imports every back-end module first in a fresh interpreter, and names any that cannot be.

**The organization tests write through one fake**: `FakeOrganizations` in `back-end/tests/conftest.py` filters with `mongo_matches` and writes with `mongo_update`, as the server does, with a hook that runs another request between a read and the next write and a cut at a chosen write; `install_organizations` makes it the collection of both `api/organizations.py` and this module.
[`test_the_shared_organizations_fake.py`](../../../back-end/tests/test_the_shared_organizations_fake.py) runs `tests/mongo_cases.py`'s update table through it, and that table and the filter table carry every shape this module writes and filters by, checked on a server by [the real-MongoDB suite](../testing/real-mongo-suite.md).

## How it is tested

[`test_one_writer_holds_each_place_it_judged.py`](../../../back-end/tests/test_one_writer_holds_each_place_it_judged.py): every cell of the table through `next_people`, every authority and refusal through the routes, each write's filter and update with no list on the document after, the history, and each way a write meets a change, the add judged before a transfer among them; the transfer's cells, authority and refusals, and its write to a member and to an admin.
[`test_an_organizations_people_stay_one_map.py`](../../../back-end/tests/test_an_organizations_people_stay_one_map.py): the planner's two transfer-cut probes, asserting the organization reads as it was or with its ownership transferred; a cut at each write a transfer makes (the organization's and the history's), from a member and from an admin, leaving one owner; and the property, 50 seeds of 40 changes each (add admin, add member, change place, remove, transfer) by random requesters on random targets among six accounts, a third with a second change landing between the first's read and its write, asserting after each one owner, every value a place, no `owner`, `admins` or `members` on the document, the document parsing, and, for a change nothing met, the map `next_people` answers, in its order.
[`test_an_organizations_people_on_the_server.py`](../../../back-end/tests/real_mongo/test_an_organizations_people_on_the_server.py), in [the real-MongoDB suite](../testing/real-mongo-suite.md): the races on a server.
[`aChangeThatMetAnotherInAnOrganization.test.ts`](../../../front-end/src/__tests__/aChangeThatMetAnotherInAnOrganization.test.ts): the 409's sentence in the Remove and the place change's confirmation, with the re-read behind it, and no re-read for an invitation's refusal.
[`changingAPlaceAsksFirst.test.ts`](../../../front-end/src/__tests__/changingAPlaceAsksFirst.test.ts): the two buttons for the owner alone, the confirmations' words, Cancel and Escape, the request, the re-read and where focus goes, the 404 read as done, the 409 and any other refusal in the confirmation, and one request however often the confirm is pressed, the confirmation held by the shell while it writes, and a refusal not in the next change.
[`manageOrganizationPeople.test.ts`](../../../front-end/src/__tests__/manageOrganizationPeople.test.ts): Rename held and sent once, and an invitation's refusal, a rename's answers and a stale re-read after a removal kept out of Manage organization opened on another organization.
[`manageOrganizationInvites.test.ts`](../../../front-end/src/__tests__/manageOrganizationInvites.test.ts): Invite admin and Invite member, "Invited" and Withdraw, each held, sent once and kept to its opening.
[`an-organizations-people-change-place.spec.ts`](../../../front-end/e2e/an-organizations-people-change-place.spec.ts): the owner makes an admin a member and back on the stack, each asked first, with the buttons' names, the rows, the focus, the History and a reload, at a desk and on a phone.

## Why

[Organization and roles](../../business/concepts/organization-and-roles.md) and [what each role may do](../../business/rules/what-each-role-may-do.md): a person has one place in an organization, and an organization one owner, at every moment.
