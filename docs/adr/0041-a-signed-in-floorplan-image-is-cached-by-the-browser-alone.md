---
layer: implementation
kind: adr
describes:
  - back-end/api/floorplans.py#get_floorplan
  - back-end/api/floorplans.py#_asked_about_again
  - front-end/src/components/layout/floorplanImages.ts
verified: 2026-11-20
sources:
  - T501
status: accepted
---

# A signed-in floorplan image is cached by the browser alone and asked about on every use

The nodes it constrains: [a location's layout](../implementation/modules/floorplan-placement.md#who-may-use-the-floorplan-routes), whose image read this is, [attendance and the door](../implementation/modules/attendance-and-door.md) and [the public map](../implementation/modules/public-map.md), whose own image keeps its own rule.

## Context

A market's floorplan images are up to 4 MB each, and Attendance's map, the layout page and the public map draw one per location.
`GET /floorplans/<id>` is the signed-in read: anyone signed in with any role on the image's market may read it, an archived market's too, and anyone else is answered 404 "Image not found".
It was sent by `send_file`, which writes `Cache-Control: no-cache` and no validator, so the browser kept the body but could never use it: every switch of Attendance's map, and every reload, downloaded the whole image again.
On a seeded stack under DevTools' Fast 4G that was 3.9 to 4.0 s of a 4 s switch, the server's own first byte about 10 ms of it (T501's measurement).
The image is the market's private plan, read only by its team, and an organizer at the door may be on a shared device, sign out, or lose their role while the browser still holds a copy.

## Decision

**The image is kept by the browser alone, and asked about before every use.**
[`get_floorplan`](../../back-end/api/floorplans.py) answers with `Cache-Control: private, no-cache` and a strong `ETag` of the image's id, quoted (`"<gridfs id>"`), both set by `_asked_about_again`:

- `private`: no shared cache, Vercel's edge or a proxy, may keep it; only the person's own browser.
- `no-cache`: the browser keeps the body but must ask the server before each use, sending `If-None-Match`.
- The tag is the id, since the bytes under an id never change: a replaced floorplan gets a new id, and the old image is deleted.

**The access check runs first, on every request, unchanged.**
Then a request whose `If-None-Match` names the image's tag (or `*`, or the tag's weak form) is answered `304 Not Modified` with both headers and no body, without reading the image from GridFS; any other request is sent the image whole, with both headers.
A refusal is the same 404 whether or not the request carries a tag, so a tag reveals nothing, and a signed-out request is the 401 every floorplan route answers.

**The page keeps each image for its own life, and nowhere else.**
[`floorplanImages.ts`](../../front-end/src/components/layout/floorplanImages.ts), the one loader every map reads its images through, holds each image's bytes as an object URL for the page's life, so a switch back to a location opened before costs no request at all; it keeps nothing at module level, so nothing follows a person past a sign-out or to another account, and the next page fetches again, which the 304 spares the body of.

**The public image's rule is its own and unchanged**: `GET /public/markets/<slug>/map/image/<location_id>` is public while the map's gate serves the market, and keeps `Cache-Control: public, max-age=300` with no `ETag`, since its tag would be the image's id, which that route deliberately never shows ([the public map](../implementation/modules/public-map.md)).

## Consequences

- A reload, or a new visit, of a page that draws a floorplan read through `GET /floorplans/<id>` downloads no image the browser already holds: each is one round trip answered 304.
- A person who signs out, loses their role on the market, or whose market or image is deleted is never shown the image from the browser's copy: the browser never uses a `no-cache` copy without the server's 304, and their next request is answered 404 or 401.
- The only copies that outlive a refusal are the object URLs a page already open holds in memory, which go when the page does, as an image already drawn stays on a screen.
- Every use still costs a round trip, so the access check holds on every one; a page open for the day pays it once per image.
- That Vercel passes `If-None-Match` through to Flask and sends the 304 back unchanged, and that its edge keeps no `private` answer, is Vercel's documented behaviour, unmeasured here; were it wrong, a reload would download the image as before, and nothing would leak.

## Considered and rejected

- **A `max-age`**, which would spare the round trip on a reload: the browser would then use its copy unasked until it ran out, so a person who lost their role, or the next person on a shared device, would be shown the market's plan meanwhile.
  The round trip of a 304 is small beside a 4 MB body, and the page keeps each image in memory for the rest of its life, so only a reload or a new visit pays it.
- **No caching at all**, as before (`no-store`, or `no-cache` with no validator): every reload downloads every image whole, and on a venue's network each is seconds of the door's bandwidth, for no gain in who may read it, since the access check runs before every 304 as it runs before every 200.
