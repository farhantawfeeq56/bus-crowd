import 'dotenv/config';
import { pool, q, notify } from '../src/lib/db';
import { interpolate } from '../src/lib/geo';
import {
  CFG, logEvent, completeAtStop, terminusComplete,
  expirePendingTickets, safetyCapTickets, expireDirectives, evaluateDirectives,
} from '../src/lib/rules';
import type { Coord, Stop } from '../src/lib/types';

// The GPS is simulated. Every tick this slides each bus along the stored OSRM
// polyline, fires the stop-arrival checks, runs the expiry matrix, and asks the
// directive engine whether anything needs rebalancing.

// Three routes share this corridor, so geometry and stops are indexed by route.
const { rows: routes } = await q<{ id: number; short_name: string; line_string: Coord[] }>(
  'SELECT id, short_name, line_string FROM routes ORDER BY id'
);
if (!routes.length) {
  console.error('no routes in the database — run `npm run setup` first');
  process.exit(1);
}
const { rows: allStops } = await q<Stop>('SELECT * FROM stops ORDER BY route_id, seq');

const lineOf = new Map(routes.map((r) => [r.id, r.line_string]));
const stopsOf = new Map<number, Stop[]>(
  routes.map((r) => [r.id, allStops.filter((s) => s.route_id === r.id)])
);

const dtSim = (CFG.tickMs / 1000) * CFG.simSpeed; // sim-seconds elapsed per tick
console.log(`sim engine · ${CFG.simSpeed}× speed · tick ${CFG.tickMs}ms (${dtSim}s sim per tick)`);
for (const r of routes) {
  console.log(`  ${r.short_name.padEnd(12)} ${r.line_string.length} pts · ${stopsOf.get(r.id)!.length} stops`);
}
console.log('');

interface BusRow {
  id: number; code: string; route_id: number; progress: number; speed: number;
  dwell_until: string | null; last_stop_seq: number;
  at_stop_key: string | null; holding_for: number | null;
}

/**
 * A live directive that meets at the stop this bus is standing at. While one
 * exists the bus holds, so the two buses are physically together at the kerb
 * when riders walk across — a transfer between moving buses would be a lie.
 */
async function rendezvousAt(busId: number, stopKey: string): Promise<number | null> {
  const { rows } = await q<{ id: number }>(
    `SELECT id FROM directives
     WHERE status IN ('pending','accepted') AND expires_at > now()
       AND transfer_stop_key = $2 AND (source_bus_id = $1 OR target_bus_id = $1)
     ORDER BY id LIMIT 1`,
    [busId, stopKey]
  );
  return rows[0]?.id ?? null;
}

let tick = 0;

async function step() {
  tick++;
  const { rows: buses } = await q<BusRow>(
    `SELECT b.id, b.code, b.route_id, p.progress, p.speed, p.dwell_until,
            p.last_stop_seq, p.holding_for, s.stop_key AS at_stop_key
     FROM buses b
     JOIN bus_positions p ON p.bus_id=b.id
     LEFT JOIN stops s    ON s.id = p.at_stop_id
     ORDER BY b.code`
  );

  for (const bus of buses) {
    const line = lineOf.get(bus.route_id)!;
    const stops = stopsOf.get(bus.route_id)!;

    // A hold ends the moment its directive is closed out — no dead air on stage.
    if (bus.holding_for !== null) {
      const still = bus.at_stop_key ? await rendezvousAt(bus.id, bus.at_stop_key) : null;
      if (still === null) {
        await q('UPDATE bus_positions SET holding_for=NULL, dwell_until=NULL WHERE bus_id=$1',
                [bus.id]);
        console.log(`  ${bus.code} released — transfer closed`);
      }
      continue; // still holding: stay put this tick
    }

    // Dwelling at a stop: boarding takes time, so the arrival reads as real.
    if (bus.dwell_until && new Date(bus.dwell_until) > new Date()) continue;

    // Standing at a stop that just became a rendezvous point? Hold for a partner.
    if (bus.at_stop_key) {
      const directiveId = await rendezvousAt(bus.id, bus.at_stop_key);
      if (directiveId !== null) {
        await q(
          `UPDATE bus_positions SET holding_for=$2,
             dwell_until = now() + ($3 || ' milliseconds')::interval
           WHERE bus_id=$1`,
          [bus.id, directiveId, CFG.rendezvousMs]
        );
        console.log(`  ${bus.code} holding at ${bus.at_stop_key} for directive #${directiveId}`);
        await notify('rendezvous', { bus: bus.code, directive: directiveId });
        continue;
      }
    }

    let progress = Number(bus.progress) + Number(bus.speed) * dtSim;
    let dwellUntil: Date | null = null;
    let atStopId: number | null = null;
    let atStopPos: { lat: number; lng: number } | null = null;
    let lastSeq = bus.last_stop_seq;

    if (progress >= 1) {
      // Rule 4 — terminus. Force-complete anyone still aboard, then recycle so
      // the demo can loop indefinitely without a restart.
      const forced = await terminusComplete(pool, bus.id);
      if (forced) console.log(`  ${bus.code} terminus · force-completed ${forced} ticket(s)`);
      await logEvent(pool, bus.id, `terminus:${tick}`, null, { tick });
      progress = 0;
      lastSeq = -1;
    } else {
      // Did we cross a stop this tick? Progress is monotonic between terminals.
      const crossed = stops.find(
        (s) => Number(s.progress) > Number(bus.progress) &&
               Number(s.progress) <= progress &&
               s.seq > lastSeq
      );
      if (crossed) {
        progress = Number(crossed.progress);
        dwellUntil = new Date(Date.now() + CFG.dwellMs);
        atStopId = crossed.id;
        lastSeq = crossed.seq;
        // A stopped bus is drawn at the stop itself, not at the nearest polyline
        // vertex — those can differ by 100 m, which is the difference between
        // two buses visibly sharing a kerb and appearing to be at different places.
        atStopPos = { lat: Number(crossed.lat), lng: Number(crossed.lng) };

        // Rule 2 — everyone whose destination is this stop completes here.
        const alighted = await completeAtStop(pool, bus.id, crossed.id);
        await logEvent(pool, bus.id, `arrive:${crossed.seq}:${tick}`, null,
          { stop: crossed.name, alighted });
        console.log(`  ${bus.code} → ${crossed.name}${alighted ? ` · ${alighted} alighted` : ''}`);
        await notify('arrival', { bus: bus.code, stop: crossed.name, alighted });
      }
    }

    const pos = atStopPos ?? interpolate(line, progress);
    await q(
      `UPDATE bus_positions
       SET lat=$2, lng=$3, progress=$4, dwell_until=$5, at_stop_id=$6,
           last_stop_seq=$7, holding_for=NULL, updated_at=now()
       WHERE bus_id=$1`,
      [bus.id, pos.lat, pos.lng, progress, dwellUntil, atStopId, lastSeq]
    );
  }

  // Expiry matrix rules 1, 3 and 5, then re-run the directive engine.
  const [ttl, cap, expired] = await Promise.all([
    expirePendingTickets(pool), safetyCapTickets(pool), expireDirectives(pool),
  ]);
  if (ttl)     console.log(`  ${ttl} pending ticket(s) expired · TTL`);
  if (cap)     console.log(`  ${cap} ticket(s) auto-completed · 3h safety cap`);
  if (expired) console.log(`  ${expired} directive(s) expired · window closed`);

  for (const d of await evaluateDirectives(pool)) {
    console.log(`  ⚠ DIRECTIVE #${d.id} — ${d.reason}`);
  }

  await notify('positions', { tick });
}

const timer = setInterval(
  () => void step().catch((e: Error) => console.error('tick error:', e.message)),
  CFG.tickMs
);

const shutdown = async () => { clearInterval(timer); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
