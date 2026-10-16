# Pulse — assessment notes

Live: _see submission email_ · Repo: https://github.com/lucky0559/pulse-assessment

`node scripts/api-smoke.mjs [baseUrl]` runs 30+ end-to-end checks against a
running server (lifecycle, authorization, privacy offset, expiry, block).

## Phase 1 — Make it run

Found by reading every route + the client state machine end to end, then
exercising the API with a script (not by guessing).

| Bug | Symptom | Fix |
| --- | --- | --- |
| `poll` heartbeat used `updateMany({ where: {} })` | Every poll refreshed _everyone's_ `lastSeen`, so nobody went stale and dots lived forever (the example in the brief) | Heartbeat only the caller; reaper now actually fires |
| `sendChat` tagged messages `t: "msg"`, receiver only accepts `"chat"` | Chat text silently dropped both ways | Match the tag |
| ICE candidates flushed _before_ `setRemoteDescription` | Every queued candidate failed → flaky/failed media connections | Flush after the remote description is set |
| `busy` set on accept but never cleared on `end`/leave | People stayed greyed-out and un-connectable | Added `Presence.peerPub` pairing; `end`, `leave` and the stale reaper release the partner |
| `decline` freed `busy` for both users | A busy user auto-declining a third party hung up their own live call | `decline` no longer touches busy state |
| No handling when the other side vanishes | Chat panel left open on a dead connection | End on data-channel close, on the peer disappearing from the list, and on ICE `failed` |
| A reaped presence row (throttled background tab, bfcache `pagehide`) was never restored | User silently invisible forever | `poll` reports `online:false`; client re-joins |
| Signals ordered by `createdAt` (ms ties) | Offer/ICE could arrive out of order | Autoincrement `seq` used for delivery order |
| `join` fetch result never checked | Silent failure on entry | Surfaces as an error on the entry screen |

## Phase 2 — Make it good

Concept: **the night side of Earth.** People are city lights; a conversation is
a thread of light between two of them. One memorable idea (the _pulse_), kept
disciplined everywhere else.

- Identity: ink/dusk base, sodium-amber for action (streetlight colour, chosen
  from the subject rather than a generic accent), lagoon for "you", rose for
  end/block. Instrument Serif wordmark + panel titles over Geist UI text.
- Entry: a field of breathing lights; three plain-language privacy promises
  instead of a legal-sounding block; specific, recoverable error copy
  (location blocked vs. unavailable vs. network).
- Map: globe projection with atmosphere + stars, glide-in to the user, dots that
  breathe out of phase, ripple on arrival, 44px effective tap targets, live
  "N lights on · M conversations" readout.
- Chat: floating glass card (bottom sheet on phones), real focus management,
  `aria-live` updates, options menu with a confirm step for block.
- Video: mute / camera toggles; remote video **starts blurred** (see Phase 4).
- Craft: `prefers-reduced-motion` respected, visible focus rings, Escape
  declines prompts, notice timer bug fixed.

## Phase 3 — Make it secure

Ranked by what an attacker gets:

1. **Session id was both public and the only credential (critical).** `poll`
   returned every user's id and the same id authenticated poll/signal/leave.
   Anyone could drain another user's mailbox, send as them, hang up their call,
   or delete their dot. _Fixed:_ per-tab **secret token** (only its SHA-256 is
   stored) is the credential; peers see a separate server-issued **public id**.
   Sender identity comes from the token, never the request body. Token moved
   from the poll URL (logged/cached) to a header.
2. **No server-side state machine (high).** Any client could `accept` a
   request nobody made, force-pair strangers, or relay SDP/ICE to anyone.
   _Fixed:_ `accept`/`decline` only answer a real outstanding request;
   offer/answer/ice only between paired sessions; `end` only by a participant;
   payloads must be well-formed SDP/ICE.
3. **Unbounded abuse surface (high).** No rate limits, body caps or mailbox
   caps. _Fixed:_ per-IP limiter per route, body-size caps, 200-signal mailbox
   cap, 1000-dot cap per poll, generic 500s (no stack/DB leakage).
4. **Location privacy (medium).** Re-joining re-rolled the 1–3 km offset, so
   repeated joins could be averaged back to the true location; "you" was drawn
   at the _raw_ coordinates. _Fixed:_ rejoin keeps the existing offset; "you"
   is drawn at the offset position.
5. **Hardcoded Mapbox token fallback in source (medium).** Removed (it lives in
   git history regardless — it should be rotated by whoever owns it). Use a
   URL-restricted public token.
6. **Untrusted peer input (medium).** Data-channel messages were unbounded.
   _Fixed:_ size cap, incoming rate limit, control-message whitelist. Chat is
   rendered as text (no `dangerouslySetInnerHTML`), so no XSS path.
7. **Browser hardening (low).** CSP (Mapbox/WebRTC-aware), `nosniff`,
   frame-ancestors/X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS,
   no `X-Powered-By`; stray ngrok dev origin removed.

Not fixed / known limits (deliberate trade-offs):

- **Rate limiter is in-memory,** so per-serverless-instance. It blunts naive
  floods with zero infra; Upstash/Redis would make it exact.
- **No CSRF tokens needed:** auth is a bearer header/body token, no cookies,
  and Next route handlers send no CORS headers.
- STUN-only, no TURN (called out as known in the brief).
- Sessions are bearer tokens in JS memory; anyone with XSS could steal one —
  mitigated by the CSP and by never rendering peer input as HTML.
- A stranger's IP is visible to the peer through WebRTC ICE candidates (inherent
  to P2P without a relay). Worth disclosing in the UI / a TURN-only "private
  mode" with more time.

## Phase 4 — Make it better

Theme: make the globe feel **alive** and the strangers feel **safe**.

- **Alive:** conversations are visible as animated threads of light between two
  dots (anonymous — it only shows that _someone_ is talking to _someone_), new
  arrivals ripple onto the map, dots breathe, and a live readout counts
  lights and conversations. The map shows the human activity, not just a list
  of dots.
- **Safe — blur-first video:** a stranger's video always starts blurred until
  you press _Show video_, and you can re-blur instantly. Local CSS only, so it
  can't be bypassed by the sender and adds no server cost.
- **Safe — block:** one tap (with confirm) hangs up, notifies the other side,
  and hides both of you from each other's map for the session; requests between
  you silently auto-decline like a normal "not now" (no signal that a block
  exists). Block rows die with the session — consistent with "nothing persists".

With more time: reports feeding a short-lived reputation signal, TURN-only
"private mode" to hide IPs, proximity ("someone near you just arrived")
notifications, push instead of polling (SSE/Pusher), shared-store rate limiting.

## Assumptions & honest verification status

- Verified: typecheck, lint, production build, Prisma migrations
  (`migrate deploy` + `migrate diff` = no drift), the API smoke test
  (`scripts/api-smoke.mjs`), and a real-browser run of `scripts/e2e.mjs`:
  three Chrome sessions go through map → request → accept → WebRTC chat both
  ways → video with blur-first reveal/re-blur and mute → end video → block →
  leave, plus a bystander seeing busy dots and the conversation arc.
- That e2e run found a bug the API tests could not: my `breathe`/hover
  animations set `transform` on the same element Mapbox positions, so every
  peer dot collapsed to the top-left corner. Fixed by wrapping each dot.
- Caveats: the e2e stubs Mapbox's style request (no real token was available),
  so the _real_ dark-v11 basemap/globe fog was not seen. Video steps need
  headed Chrome (headless fake camera never resolves); the full run, video
  included, passed headed on the final code (remote frames on both sides,
  blur-first, reveal/re-blur, mute, end video, block).
- Not done: Vercel deployment (needs a Mapbox token, a hosted Postgres URL and a
  Vercel login). Steps: set `DATABASE_URL` + `NEXT_PUBLIC_MAPBOX_TOKEN` in
  Vercel, run `npx prisma migrate deploy` against that database, deploy.
- Local development used an in-memory Postgres (PGlite) instead of Neon.
