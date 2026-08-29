# BusMesh

Live bus load-balancing for a city corridor. **A ticket belongs to a destination,
not to a bus** — so when a bus is about to overflow, the system moves riders onto
another bus serving the same destination, mid-route, at no extra fare, and their
ticket still reads the same destination.

Three Chennai feeder routes converge on Anna Salai and share a trunk into
Broadway. That overlap is the product: relief can come from a *different route*,
which is what makes this a mesh rather than a queue.

Hackathon MVP. The database runs on **Neon** (serverless Postgres) — no Supabase, no local install.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App | **Next.js 16** (App Router, TypeScript, Tailwind v4) in `src/` | UI + API + realtime in one process |
| DB | **Neon** (serverless Postgres 16), pool via `@neondatabase/serverless` over WSS | No local install; created once with `npx neon@latest init` |
| Realtime | Postgres `LISTEN/NOTIFY` (Neon supports it over the WebSocket endpoint) → SSE at `GET /api/stream` | Replaces Supabase Realtime; every screen repaints on the same tick |
| Map | MapLibre GL + OpenFreeMap `dark` tiles | Free, unlimited, no signup, no key |
| Geometry | OSRM public API, fetched **once at seed** per route | Polylines live in the DB — no rate-limit risk mid-demo |
| Geocoding | Nominatim, run **once during development**, results hardcoded | No lookups at runtime |
| Scripts | `tsx` running `.mts` files | Share `src/lib` with the app, no duplicate logic |

GPS is **simulated**: `scripts/sim.mts` slides buses along the stored polyline.

## Running it

```bash
npm install
npm run setup   # create db + apply schema + fetch OSRM route + seed
npm run dev     # Next: UI, API and realtime on :3000
npm run sim     # bus movement engine        (separate terminal)
npm run god     # auto-demo passenger spawner (separate terminal)
```

Screens: `/dashboard` (judge-facing), `/conductor?bus=18K`, `/passenger`.
Bus 5c runs Royapettah, 18K runs Teynampet, 26 runs Gemini.
`npm run seed` alone re-seeds without dropping the schema.
`npm run typecheck` and `npm run lint` both pass — keep them that way.

## Layout

```
db/schema.sql            tables, occupancy view, idempotent event log
src/lib/types.ts         shared domain types (the DB is the source of truth)
src/lib/db.ts            pool, tx(), notify() -> pg_notify('busmesh', …)
src/lib/geo.ts           polyline maths: haversine, cumulative, interpolate, progressOf
src/lib/rules.ts         CFG + the ticket expiry matrix + the directive engine
src/lib/queries.ts       read queries shared by the route handlers
src/lib/realtime.ts      one pinned LISTEN client, fanned out to all SSE clients
src/lib/client.ts        'use client' hooks: api, useRealtime, useToast, bandOf
src/lib/api-route.ts     shared error envelope for route handlers
src/app/api/**/route.ts  REST + SSE
src/app/{dashboard,conductor,passenger}/page.tsx
src/components/          FleetMap (MapLibre) + ui.tsx primitives
scripts/*.mts            reset, seed, sim, godmode
```

## The three routes

| Route | Bus | Stops | Colour |
|---|---|---|---|
| Royapettah → Broadway | 5c | 8 | blue |
| Teynampet → Broadway | 18K | 9 | purple |
| Gemini → Broadway | 26 | 11 | orange |

Served by all three: **L.I.C., P. Orr & Sons, Pallavan Salai, M.G.R. Central,
Broadway**. Served by two: Thousand Lights, Shanthi Theatre, Evening Bazaar.

Coordinates come from OpenStreetMap's Nominatim geocoder, except **Church Park
School** and **Shanthi Theatre / Simpson**, which are not in OSM's index — those
two sit on Anna Salai between their geocoded neighbours and are marked `approx`
in `scripts/seed.mts`. It does not matter functionally: OSRM snaps the road
geometry and `progressOf` snaps each stop onto that polyline.

## Core model

- `progress` is **0..1 by arc length** along *that bus's own route* polyline.
  Every spatial question reduces to a comparison on that one scalar. Stops are
  snapped onto the polyline at seed time via `progressOf`.
- **`stop_key` is the join that makes the mesh work.** One physical stop is a
  separate `stops` row on every route serving it, all sharing a `stop_key` slug.
  "Does that other bus also go to L.I.C.?" is a `stop_key` comparison.
- **Occupancy is a boarding count, not a sales count**: `COUNT(tickets WHERE
  status='active') GROUP BY active_bus_id`, exposed as the `occupancy` view. A
  `pending` ticket never counts.
- `origin_bus_id` = where the rider boarded. `active_bus_id` = the bus they are on
  **now**. A transfer flips `active_bus_id` only; `to_stop_id` is never touched.
  That invariant *is* the product.
- **A stopped bus is stored at the stop's own coordinates**, not at the nearest
  polyline vertex — those can differ by 100 m, which is the difference between two
  buses visibly sharing a kerb and appearing to be in different places.
- `bus_events` has a partial unique index on `(bus_id, type, ticket_id)`, so a
  replayed tick can't double-count a boarding. Per-visit event types are
  namespaced (`arrive:<seq>:<tick>`, `transfer_in:<directive_id>`).

## Ticket expiry matrix

Nothing expires arbitrarily. All five rules live in `src/lib/rules.ts` and run
every sim tick.

| # | Transition | Trigger | Handler |
|---|---|---|---|
| 1 | `pending → expired` | not boarded within `PENDING_TTL_SEC` (demo 60s) | `expirePendingTickets` |
| 2 | `active → completed` | bus reaches `to_stop` (`end_reason='destination'`) | `completeAtStop` |
| 3 | `active → completed` | aboard > 3h safety cap (`end_reason='safety_cap'`) | `safetyCapTickets` |
| 4 | `active → completed` | bus hits terminus (`end_reason='terminus'`) | `terminusComplete` |
| 5 | `directive → expired` | transfer window closed | `expireDirectives` |

## Directive engine (pure rules, no AI)

`evaluateDirectives()`, per bus, per tick:

1. `projected = (onboard + expected_boarders[next stop]) / capacity`
2. below `OCCUPANCY_THRESHOLD` (0.85) → skip
3. that bus already has a `pending`/`accepted` directive → don't stack
4. candidates are buses on **any route that also serves that next stop** and have
   not yet passed it — found by `stop_key`, so relief routinely comes from a
   different route
5. candidate must have room (`< CFG.roomPct`), be inside the ETA window
   (`Δprogress / speed / 60` sim-minutes), and carry riders who are genuinely
   eligible; pick the emptiest that clears all three
6. insert a directive naming the stop where the two buses will meet

**Eligibility is the honesty check.** `eligibleRiders()` counts only riders whose
destination the target's route also serves *and has not yet passed*. `POST
/api/transfer` re-applies the same filter when it moves people, and refuses the
whole request if nobody qualifies. Nobody is ever moved onto a bus that will not
take them where their ticket says.

## Rendezvous — how a transfer actually looks

Riders only ever change bus standing still, at a stop. When a directive exists:

1. Whichever bus reaches the transfer stop first sets `bus_positions.holding_for`
   and stops there (`CFG.rendezvousMs`, 45s real).
2. The partner arrives and holds too. Both are now at identical coordinates, so
   `fullState` reports `both_present` on the directive.
3. The dashboard fans overlapping markers apart (~26 px), draws a dashed white
   link between the pair, and pulses both — this is the moment to point at.
4. Accepting the transfer moves riders; `DONE` (or the window expiring) clears
   `holding_for` and both buses pull away on the next tick.

## Tuning

`.env` drives the pace. Routes are 9–13 km; seed speed is `1/1800` progress-units
per sim-second, so one end-to-end run is 30 sim-minutes — at `SIM_SPEED=15` that
is **2 real minutes**. `CFG.rendezvousMs` (45s, in `rules.ts`) is how long a bus
will wait at a transfer stop; raise it if you want more time to talk on stage.

| Var | Default | Effect |
|---|---|---|
| `SIM_SPEED` | 15 | sim-seconds per real second |
| `SIM_TICK_MS` | 1000 | wall-clock tick interval |
| `OCCUPANCY_THRESHOLD` | 0.85 | when a directive fires |
| `PENDING_TTL_SEC` | 60 | rule 1 |
| `DIRECTIVE_WINDOW_MIN` | 10 | rule 5 |
| `GOD_INTENSITY` | 1 | scales god-mode boarding volume |

Buses seed at 5c = 36/50 (72%), 18K = 31/50 (62%), 26 = 18/50 (36%). Thousand
Lights expects 16 boarders, which is what tips 18K (Teynampet) past the threshold
and pulls in 26 (Gemini) as relief — a cross-route rescue in the first minute.

## Demo beat

1. Boarders push **18K** past 85% approaching Thousand Lights → a directive
   appears in the dashboard feed, naming the meeting stop.
2. **18K stops and waits.** 26 — a *different route* — pulls in behind it. Both
   markers snap together, the dashed link lights up, the feed flips to
   `● BOTH AT KERB`.
3. Conductor **26** sees `🔴 ACCEPT FROM 18K` — tap `+5`.
4. 18K drops, 26 rises, markers recolour, bars animate — every screen at once.
5. The transferred rider's app still reads **dest Broadway**, now on bus 26,
   with a `boarded on 18K` pill. Their route changed; their ticket did not.
6. Tap `DONE`; both buses pull away. At Broadway the tickets complete.

## Opening it on a phone (LAN)

`next dev` prints a `Network:` URL. Loading it from another device only works
because `next.config.ts` sets **`allowedDevOrigins`** — Next's dev server answers
`403` on `/_next/*` for any Host it doesn't recognise, so without it the phone
gets the HTML, no client bundle, no hydration, and the page sits forever on its
server-rendered empty state. The config allows the whole private address space
(`10.*`, `172.16–31.*`, `192.168.*`, `*.local`) because the laptop's DHCP address
changes with every network. It is dev-only; `next build`/`next start` ignore it.

The HMR websocket still fails over the LAN address — that is hot reload only and
has no effect on the demo. Nothing here is CORS: every screen calls `/api/...`
as a same-origin relative URL.

## Gotchas (all hit during the build)

- **`403` on `/_next/*` from a phone is `allowedDevOrigins`, not CORS.** See above.
- **Never use CSS `transform` on a MapLibre marker element.** MapLibre writes the
  positioning transform inline on that same element, and inline wins — a
  `transform: scale()` in a stylesheet is silently dead. Emphasise markers with
  size, border and shadow instead.
- **Two buses at one stop must be fanned apart in code.** `FleetMap.fanOut()`
  groups markers by rounded coordinate and spreads them, otherwise the single
  most important frame of the demo renders as one marker hiding another.
- **Use `style.load`, not `load`, for MapLibre.** `load` additionally waits for a
  completed first render, which never arrives on software/headless renderers —
  the map then stays permanently blank. `style.load` is render-independent.
- **maplibre-gl is pinned to v4.** v5/v6 construct their web worker via
  `import.meta.url`; Turbopack serves that URL as HTML, the worker dies, and no
  tiles are ever fetched. v4 bundles the worker inline.
- **Node's `fetch` is blocked in some sandboxes but `curl` is not.**
  `scripts/seed.mts` tries `fetch`, falls back to `curl`, then to a densified
  straight-line route. If the seed log says "densified straight-line fallback",
  you got fake geometry for that route — re-run with network access.
- **Anything that looks up stops must filter by `route_id`.** Three routes share
  this corridor and stop names repeat across them, so an unscoped `SELECT ... FROM
  stops WHERE progress > $1` silently mixes routes. This bit god mode once.
- **Scripts are `.mts`, not `.ts`.** `package.json` has no `"type": "module"`, so
  `tsx` treats `.ts` as CJS and rejects the top-level `await` these scripts use.
- `pool` (`db.ts`) and the LISTEN client (`realtime.ts`) are pinned to
  `globalThis`; Next re-evaluates modules on hot reload and would otherwise leak
  a connection per edit.
- The sim recycles buses at the terminus (progress wraps to 0), so the demo loops
  indefinitely without a restart.
- `dwell_until` freezes a bus at a stop for `CFG.dwellMs`; god mode keys its
  one-wave-per-visit set on `bus:stop:last_stop_seq`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
