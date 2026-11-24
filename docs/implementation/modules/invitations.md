---
layer: implementation
kind: module
describes:
  - back-end/invitations.py
  - back-end/api/markets.py#invite_to_market
  - back-end/api/markets.py#market_invitations
  - back-end/api/markets.py#withdraw_market_invitation
  - back-end/app.py#invite_to_market
  - back-end/app.py#get_market_invitations
  - back-end/app.py#withdraw_market_invitation
  - back-end/app.py#verify_invitation_indexes
  - back-end/utils/email.py#send_invitation_email
  - back-end/sign_in_limits.py#INVITATION_PER_INVITER
  - back-end/sign_in_limits.py#INVITATION_PER_ADDRESS
  - back-end/tests/test_inviting_someone_to_a_market.py
  - back-end/tests/real_mongo/test_invitations_on_the_server.py
verified: 2026-11-24
sources:
  - T538
---

# Invitations

[`back-end/invitations.py`](../../../back-end/invitations.py) is the one owner of the `invitations` collection: offers, each sent to an address, of a role on one market or a place in one organization.
Nothing else reads or writes it.
The rule it keeps is [a person accepts before they join](../../business/rules/a-person-accepts-before-they-join.md), and why is [ADR 0047](../../adr/0047-a-person-joins-only-by-accepting-an-invitation.md).

## The store

One document per waiting invitation:

| Field              | What it holds                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `id`               | a uuid4, kept when the same address is invited to the same target again                    |
| `target_kind`      | `market` or `organization`                                                                 |
| `target_id`        | the market's `id` (uuid) or the organization's `id`                                        |
| `email`            | the invited address, as `normalized_email` stores it                                       |
| `role`             | on a market `admin`, `editor` or `viewer`; in an organization `admin` or `member`          |
| `invited_by`       | the inviter's user id                                                                      |
| `invited_by_email` | the inviter's address when it was sent, which the email and the served rows name           |
| `sent_at`          | when it was last sent, in UTC                                                              |
| `expires_at`       | `sent_at` and 14 days (`LIFETIME`), which the TTL index removes it at                      |
| `counted_at`       | the instant its two limits were counted at, for the take-back an accepted invitation makes |

`ensure_invitation_indexes`, which `app.py`'s boot calls (`verify_invitation_indexes`) and refuses to start without, builds three ([lookup indexes](../data/lookup-indexes.md#what-is-not-here)):

- `invitation_target_email_unique` on `target_kind, target_id, email`, through [`unique_indexes`](../../../back-end/unique_indexes.py), whose refusal names the targets holding two invitations for one address, never the address; its prefix serves a target's list.
- `invitation_email` on `email`, the invitee's own list.
- The TTL index `invitation_ttl` on `expires_at`, with `expireAfterSeconds=0`.

**One invitation per address and target.**
`invite` writes by one `find_one_and_update` upsert on the target and the address, `$set` of every field but `id` and `$setOnInsert` of `id`, so inviting the address again replaces its role, its inviter, its times and its count instant, keeps its `id`, and starts a new 14 days.
Two upserts that both match nothing race on the unique index; the refused one is sent once more and finds the other's document.

**Every read asks for one still waiting**, `expires_at` after now, since the TTL monitor removes a document up to a minute late: `waiting_for` (a target's list, newest `sent_at` first) and `waiting` (one by id on its target).

**A withdrawal holds the role it read**: `withdraw` deletes by id, target and role, so an invitation sent again to another role between the read and the delete is left, and the withdrawal answers 409 `CHANGED_MEANWHILE`; one gone meanwhile answers 404 `ALREADY_ENDED`, "That invitation has already ended.", which Manage market reads as done.

**A market's invitations go with it**: `delete_for_market`, in `market_deletion.delete_records` ([market deletion](market-deletion.md#sharp-edges)).

## Inviting to a market

The routes, in [`back-end/app.py`](../../../back-end/app.py), each `@login_required`:

| Route                                                     | Answers                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /markets/<market_id>/invitations`                   | body `{"email", "role"}`; `200 {"invitation": <served>, "emailed": bool}` |
| `GET /markets/<market_id>/invitations`                    | `200 {"invitations": [<served>, ...]}`, newest first                      |
| `DELETE /markets/<market_id>/invitations/<invitation_id>` | `200 {"message": "Invitation withdrawn"}`                                 |

An invitation is served as `{id, email, role, invitedBy, sentAt, endsAt}`, `invitedBy` the inviter's address and both times ISO 8601 in UTC (`served`).

The invite refuses, in this order, before anything is written:

1. An `email` or a `role` that is not text: 400 "email and role required".
   The address is normalized, and one without an "@" and then a domain holding a "." (the sign-up's check) is 400 "Type an email address, such as name@example.com.".
2. A role that is none: 400 "Invalid role: <text>"; the Owner role, 400 "A market's Owner changes only when ownership is transferred.".
3. No live market: 404 "Market not found".
4. The row that gives the role refusing the inviter (`Actions.roles_row`, [the market's actions](market-actions.md)): 403 with its sentence.
   An archived market still takes the roles rows (`ARCHIVED_STILL_TAKES`), so it still invites.
5. Either limit: 429 "You have sent many invitations. Try again in <wait>.", with `Retry-After`.
6. Only now the account: an address whose account already has a role on the market is 400 "<address> already has a role on this market. Change it in their row under Users with access.", which the inviter can read in "Users with access" anyway.

Then `invite_to_market` in [`back-end/api/markets.py`](../../../back-end/api/markets.py) writes the invitation, calls `kept_only_while_live` so one landing as its market is deleted is taken back, records `invited` through the roles row's asking (subject `{email}`, detail `{role}`: [the market's history](../data/history.md#what-each-write-records)), and sends the email.
The answer depends only on the address typed, the role, the inviter and the time: an address with an account and one without answer the same status and body, are sent the same email and leave the same entry.
Nothing writes the market's `roles`.

The list is for a reader whom either roles row lets through, else 403 with the Editor and Viewer row's sentence.
The withdrawal refuses such a reader first in the same sentence, whether or not the invitation waits, then finds it, then asks the row of its role, and records `invitation_withdrawn` through that asking.

## The email

`send_invitation_email` in [`back-end/utils/email.py`](../../../back-end/utils/email.py) sends kind `invitation` through `send_mail`, whose log names the kind and never the address.
Its subject is "<inviter> invited you to <market name>"; its body says who invited them to join what as what ("as an Editor on Conventioner."), to sign in with this address at `<FRONTEND_URL>/invitations` to accept or decline, to create an account with this address first when they have none, when it ends ("It ends on 8 December 2026."), and that nothing happens unless they accept.
The HTML escapes every name and address (`html.escape`), the subject and the text read them on one line (`one_line`), and the bare link has no full stop after it.
A send that fails keeps the invitation and answers `"emailed": false`.

## The limits

`INVITATION_PER_INVITER` (100 in 15 minutes, by the inviter's user id) and `INVITATION_PER_ADDRESS` (5 in 15 minutes, by the address), in [`back-end/sign_in_limits.py`](../../../back-end/sign_in_limits.py) and its `LIMITS`, are counted together at step 5 by `count`, before the account is looked up, so a refusal is the same for every address.
`counted_at` keeps the instant they were counted at.

## How it is tested

- [`back-end/tests/test_inviting_someone_to_a_market.py`](../../../back-end/tests/test_inviting_someone_to_a_market.py) sends every route through the test client over fakes that apply the writes: the one answer for an address with an account and one without, nobody gaining a role, each refusal in its order and words, inviting again, the race's retry, the email's words and escaping, a failed send, the limits, the list, the withdrawal, the deletion, and the boot's refusal.
- [`back-end/tests/real_mongo/test_invitations_on_the_server.py`](../../../back-end/tests/real_mongo/test_invitations_on_the_server.py) builds the indexes on a real server and races invitations of one address, which leave one document.
- The guard lists name the routes: `test_an_exception_never_reaches_a_client.py`, `test_a_request_value_is_a_string.py` and `test_every_write_records.py`.
