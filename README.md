# BusMesh

**Your ticket belongs to your destination, not to one bus.**

Three Chennai bus routes — from Royapettah, Teynampet and Gemini — converge on
Anna Salai and run a shared trunk into Broadway. When one of them is about to
overflow, BusMesh moves riders onto **another route's bus** that serves the same
destination: live, mid-route, at no extra fare. The two buses pull up together at
a shared stop, riders walk across, and both drive on. The rider's ticket still
reads the same destination; only the bus underneath them changes.

Three screens, one live simulation:

- **`/dashboard`** — control room: MapLibre map with live bus markers coloured by
  occupancy, load bars, and the directive feed.
- **`/conductor?bus=257`** — the phone on the bus: live count, ticket issuing, and
  the `ACCEPT FROM 257 · [+1] [+5] [+10] [DONE]` transfer banner, which tells the
  conductor where the two buses meet and when the other one is at the kerb.
- **`/passenger`** — the phone in the rider's hand: buy, ride, get moved, and watch
  the ticket auto-complete on arrival.

## Quick start

Requires Node 20+ and a Neon project — create one with `npx neon@latest init` (or `projects create`), then put its `DATABASE_URL` in `.env`.

```bash
npm install
npm run setup
```

Then, in three terminals:

```bash
npm run dev
```

```bash
npm run sim
```

```bash
npm run god
```

Open <http://localhost:3000>.

To drive the conductor and passenger screens from real phones, use the `Network:`
URL that `next dev` prints. That works out of the box — `next.config.ts` allows the
private address ranges via `allowedDevOrigins`, which Next's dev server otherwise
rejects with a `403` on its client bundle.

## How it works

GPS is simulated. At seed time the real road geometry for each route is fetched
once from OSRM and stored as a polyline; the sim engine slides buses along them at
15× speed, so a 30-minute journey plays in two minutes. Every screen subscribes to
a single Postgres `LISTEN/NOTIFY` channel over SSE, so the map, the conductor's
phone and the rider's phone all move on the same tick.

Occupancy is a boarding count, never a sales count. A rule engine — no AI —
watches each bus against the boarding demand at its next stop and raises a
transfer directive when the projection crosses 85%, choosing relief from any route
that also serves the stop. Riders are only ever moved to a bus whose route still
serves their destination, so the ticket's promise always holds.

See [CLAUDE.md](CLAUDE.md) for architecture, the full ticket-expiry matrix, tuning
knobs, and the gotchas worth knowing before you change anything.
