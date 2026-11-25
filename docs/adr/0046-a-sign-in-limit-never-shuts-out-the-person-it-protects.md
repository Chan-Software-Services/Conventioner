---
layer: implementation
kind: adr
describes:
  - back-end/sign_in_limits.py
  - back-end/api/users.py#login
  - back-end/api/users.py#login_with_otp
  - back-end/tests/test_a_strangers_tries_shut_no_one_out.py
  - back-end/tests/test_a_strangers_requests_use_up_no_ones.py
verified: 2026-11-25
sources:
  - T539
status: accepted
---

# A sign-in limit never shuts out the person it protects

The nodes it constrains: [a vendor signs in before applying](../business/rules/a-vendor-signs-in-before-applying.md) and [users, and the one spelling of an address](../implementation/data/users-and-email.md#the-sign-in-is-bounded); the glossary's **Sign-in limit** ([`CONTEXT.md`](../../CONTEXT.md)).

## Context

Every sign-in limit per address was one count for all callers together, checked before the code or the password was.
The vendor's code sign-in allowed 10 tries per address in 15 minutes and took no right try back; the organizer's password and code sign-ins allowed 10 per address and took a right try back.
The requests that mail a code or a link allowed 5 per address, counted the same way.
And a caller was an address, so a machine handed an IPv6 network counted as many callers.
The limits are hardened so that each bounds guesses and mail while a person's own tries are counted apart from every other caller's.

## Decision

**Every limit in [`back-end/sign_in_limits.py`](../../back-end/sign_in_limits.py) on a public sign-in or a public request that mails counts in a way that no one else's tries can turn against the person whose address it is.**
An organizer's invitation is signed in, and is counted per inviter and per address, an accepted one taken back from both, as [ADR 0047](0047-a-person-joins-only-by-accepting-an-invitation.md) and [invitations](../implementation/modules/invitations.md#the-limits) say.

- **A caller is a network**: an IPv4 address, or the /64 network an IPv6 address sits in, so one machine is one caller on IPv6 as on IPv4.
- **A sign-in that checks a secret is counted per caller and address together** (`SecretBounds`), 10 wrong tries in 15 minutes, which bounds one caller's guesses at one address and is the only count that says to wait.
  It is also counted per address alone, 50 wrong tries in 15 minutes, which only many callers together reach; past it a try must pass the human check ([ADR 0045](0045-turnstile-is-the-one-human-check.md)) rather than being refused, so the person passes and signs in, and a script does not.
  A try refused for want of the check is taken back from the pair and the address, a try the pair refused is not counted on the address, and a right secret is taken back from every count, so only wrong tries whose secret was checked pile up.
  The vendor's code sign-in is bounded this way (`verify-code:caller-address`, `verify-code:address-ceiling`), its sign-in sending the check's token with every try, and so are the organizer's password and code sign-ins in [`api/users.py`](../../back-end/api/users.py) (`password:caller-address`, `password:address-ceiling`, `organizer-code:caller-address`, `organizer-code:address-ceiling`, action `sign-in`), whose forms put the check on the page only once the server asks for it, so an everyday sign-in loads no script of Cloudflare's ([`test_a_strangers_tries_shut_no_one_out.py`](../../back-end/tests/test_a_strangers_tries_shut_no_one_out.py)).
- **A request that mails is counted per caller and address together** (`MailBounds`), 5 in 15 minutes, so one stranger cannot use up a person's requests, **and per address alone by the hour**, 20, so one inbox's mail stays bounded whoever asks; a request the pair refused is not counted on the address ([`test_a_strangers_requests_use_up_no_ones.py`](../../back-end/tests/test_a_strangers_requests_use_up_no_ones.py)).
- Every count exists for every address alike and is counted before any account, application or market is looked up, so a refusal and the check's answer are the same for every address and market.
- The old per-address limits (`verify-code:address`, `password:address`, `organizer-code:address` and the mail requests' `<request>:address`) left the table; their counters are never read again and expire by the TTL index within 15 minutes, with no migration.

Each limit, its count and its window, are in [users, and the one spelling of an address](../implementation/data/users-and-email.md#the-sign-in-is-bounded).

## Consequences

- A vendor's right code signs them in whatever anyone else has typed for their address; past fifty others' wrong codes they meet, at most, Cloudflare's tick box.
- An organizer's right password or code signs them in whatever anyone else has typed for their address; past fifty others' wrong tries the form asks for the check and sends once more, and they meet, at most, Cloudflare's tick box.
- **The organizer's one code an hour is kept** ([ADR 0028](0028-an-accounts-sign-in-secrets-are-one-machine.md)'s consequences, amended): anyone may ask for an organizer's code, which mails it to the organizer, and use up its five tries; the code sign-in then waits out the hour, while the password and the reset link stay open.
  The wait bounds guesses at a six-digit code to five an hour, which a count per caller and address would not.
- A vendor's own mistyped codes are bounded as before, 10 a quarter of an hour from one caller, and a code's own five tries are counted on the code as before.
- Guesses at one address from many callers together are bounded by the human check, not by a count: a script past the address's fifty gets no further.
- A right try is written twice more than before, its take-back from the pair and the address.
- An E2E spec cannot reach an address's fifty with its own requests in a test's time, so it fills the counter as the module keys it ([E2E patterns](../implementation/testing/e2e-patterns.md)).

## Rejected

- **Counting per address only**, as before: it counts a person's own tries together with every other caller's.
- **Counting per caller only**: one address could be guessed at from as many callers as a script can find.
- **A slower answer past a count** (a growing delay rather than a refusal): it holds the person back as much as a script, and a serverless process waiting costs as much as one working.
