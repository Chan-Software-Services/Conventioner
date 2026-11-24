---
layer: implementation
kind: adr
describes:
  - back-end/utils/captcha.py
  - front-end/src/utils/captcha.ts
  - front-end/src/components/HumanCheck.vue
  - front-end/vercel.json
verified: 2026-11-24
sources:
  - T539
status: accepted
---

# Turnstile is the one human check

The nodes it constrains: [security invariants](../implementation/conventions/security-invariants.md), [the component library](../implementation/modules/component-library.md), [users, and the one spelling of an address](../implementation/data/users-and-email.md) and [a vendor signs in before applying](../business/rules/a-vendor-signs-in-before-applying.md); the glossary's **Human check** ([`CONTEXT.md`](../../CONTEXT.md)).

## Context

Organizer sign-up asked Google reCAPTCHA v3 for a score before it made an account.
reCAPTCHA's free tier ends at 10,000 checks a month, and past it, without billing, every check errors, which the server read as a refusal: sign-up would stop for everyone until the month turned.
A low score was a dead end too: v3 shows the person nothing they can do, so a person whose browser scored low could not sign up at all.

The vendor's code request and a sign-in past its limits each need the same kind of check, a vendor at the door on a phone among them, so the product wants one check it can ask anywhere with no allowance to run out and no step a person cannot take.

## Decision

**Cloudflare Turnstile, in its managed mode, is the app's one human check**, called "the human check" in code and docs; the provider is named only where it must be: its script and siteverify addresses, its variables, the CSP and the docs that say which provider.

- **It is shown only when Cloudflare needs the person.**
  The widget renders with `appearance: 'interaction-only'`, so it takes no room until Cloudflare asks for a tick, and `execution: 'render'`, so its token is made as the form renders and a submit rarely waits.
  It is `flexible` from 300px wide and `compact` under it, so it fits a 320-pixel phone's sign-in.
- **It is asked on every organizer sign-up and every vendor code request, and on a sign-in past its per-address limit**, each request carrying its token as `captcha_token` and each check its own action (`sign-up`, `vendor-sign-in`, `sign-in`), which the server requires the token to carry.
  A request the check is needed for and not passed is answered 403 with `captcha: required`, one answer for every address and market.
- **One component renders it**: [`HumanCheck.vue`](../../front-end/src/components/HumanCheck.vue), over the loader in [`front-end/src/utils/captcha.ts`](../../front-end/src/utils/captcha.ts), which loads Cloudflare's script once a page and holds the two sentences a person is told: that the check did not load, and that it could not confirm them after the one automatic retry a `captcha: required` answer gets.
- **Cloudflare unreachable lets the request through under the sign-in limits.**
  When the server cannot reach siteverify (a timeout, a connection error, a 5xx, a body that is not JSON, or Cloudflare's `internal-error`), [`captcha_passes`](../../back-end/utils/captcha.py) passes and logs the kind alone, so the door does not depend on a third party being up; the limits still stand in front of the request.
- **A deployment cannot run on a test key.**
  The back end refuses to boot without `TURNSTILE_SECRET_KEY` or with one of Cloudflare's published test secrets, and `vite build` refuses a bundle without `VITE_TURNSTILE_SITE_KEY` or with a test site key, each unless it is a local development one.
- **The CSP ([`front-end/vercel.json`](../../front-end/vercel.json)) adds `https://challenges.cloudflare.com` to `script-src` and `frame-src`**, as Cloudflare's reference lists Turnstile's sources, and drops every Google host.

## Consequences

- No monthly allowance can stop sign-up: managed mode is free with no cap.
- A person Cloudflare is unsure of ticks one box rather than being refused; a vendor on a phone otherwise sees no new step.
- An organizer's everyday sign-in loads no Cloudflare script: its forms mount the check only after a `captcha: required` answer.
- A browser that cannot load the check is told so in one sentence, and the step stays as it was.
- The reCAPTCHA variables are no longer read; Daniel deletes them once the release is live ([releasing](../RELEASING.md)).
- Local stacks and E2E run with no site key: the check renders nothing and sends a placeholder token, which only a back end with `DISABLE_CAPTCHA` accepts, and a request with no token is still refused there.

## Rejected

- **Keeping reCAPTCHA v3**, with billing past its allowance: a cost that grows with use, and a low score's dead end stays.
- **reCAPTCHA v2's checkbox**: a step every person takes, where Turnstile asks only the ones Cloudflare is unsure of.
- **A check of our own** (a question, a delay): it passes a script as easily as a person, and is one more thing to keep.
- **Refusing when Cloudflare is unreachable**: it would make sign-up and the door depend on Cloudflare being up, where the sign-in limits already bound what passes in that time.
