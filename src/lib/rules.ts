import 'dotenv/config';
import { notify, type Queryable } from './db';
import type { Directive, Occupancy, SimConfig } from './types';

export const CFG: SimConfig = {
  simSpeed:   Number(process.env.SIM_SPEED ?? 15),            // sim-seconds per real second
  tickMs:     Number(process.env.SIM_TICK_MS ?? 1000),
  pendingTtl: Number(process.env.PENDING_TTL_SEC ?? 60),      // rule 1
  window:     Number(process.env.DIRECTIVE_WINDOW_MIN ?? 10), // rule 5
  threshold:  Number(process.env.OCCUPANCY_THRESHOLD ?? 0.85),
  arriveEps:  0.004,  // progress units — roughly 100 m on a 13 km route
  dwellMs:    6000,   // boarding dwell, so arrivals read as real
  // A bus that has raised (or been given) a transfer directive stands at the
  // shared stop this long, so both buses are visibly together when riders move.
  rendezvousMs: 45_000,
  safetyCapH: 3,      // rule 3
  roomPct:    0.75,   // a target bus must sit below this to be a transfer candidate
};

/**
 * Idempotent event log. The partial unique index on (bus_id, type, ticket_id)
 * means replaying a tick can never double-count a boarding.
 */
export const logEvent = (
  c: Queryable,
  busId: number,
  type: string,
  ticketId: number | null = null,
  meta: Record<string, unknown> | null = null
) =>
  c.query(
    `INSERT INTO bus_events (bus_id,type,ticket_id,meta) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [busId, type, ticketId, meta && JSON.stringify(meta)]
  );

export async function occupancy(c: Queryable): Promise<Occupancy[]> {
  const { rows } = await c.query('SELECT * FROM occupancy ORDER BY code');
  return (rows as Occupancy[]).map((r) => ({
    ...r, onboard: Number(r.onboard), pct: Number(r.pct),
  }));
}

// ── Ticket expiry matrix ────────────────────────────────────────────────────
// Nothing expires arbitrarily. Every expiry is one of these five rules, and
// each one is a status change. All of them run every sim tick.

/** Rule 1 · pending -> expired. Bought but never boarded within the TTL. */
export async function expirePendingTickets(c: Queryable): Promise<number> {
  const { rows } = await c.query(
    `UPDATE tickets SET status='expired', ended_at=now(), end_reason='ttl'
     WHERE status='pending' AND created_at < now() - ($1 || ' seconds')::interval
     RETURNING id`,
    [CFG.pendingTtl]
  );
  return rows.length;
}

/** Rule 2 · active -> completed. The bus reached the ticket's destination stop. */
export async function completeAtStop(c: Queryable, busId: number, stopId: number): Promise<number> {
  const { rows } = await c.query(
    `UPDATE tickets SET status='completed', ended_at=now(), end_reason='destination'
     WHERE status='active' AND active_bus_id=$1 AND to_stop_id=$2
     RETURNING id`,
    [busId, stopId]
  );
  for (const t of rows as { id: number }[]) await logEvent(c, busId, 'alight', t.id, { stop_id: stopId });
  return rows.length;
}

/** Rule 3 · active -> completed. Safety cap: the rider missed their stop. */
export async function safetyCapTickets(c: Queryable): Promise<number> {
  const { rows } = await c.query(
    `UPDATE tickets SET status='completed', ended_at=now(), end_reason='safety_cap'
     WHERE status='active' AND boarded_at < now() - ($1 || ' hours')::interval
     RETURNING id`,
    [CFG.safetyCapH]
  );
  return rows.length;
}

/** Rule 4 · active -> completed. Terminus reached; force-complete everyone left. */
export async function terminusComplete(c: Queryable, busId: number): Promise<number> {
  const { rows } = await c.query(
    `UPDATE tickets SET status='completed', ended_at=now(), end_reason='terminus'
     WHERE status='active' AND active_bus_id=$1
     RETURNING id`,
    [busId]
  );
  for (const t of rows as { id: number }[]) await logEvent(c, busId, 'alight', t.id, { terminus: true });
  return rows.length;
}

/** Rule 5 · directive -> expired. The transfer window closed. */
export async function expireDirectives(c: Queryable): Promise<number> {
  const { rows } = await c.query(
    `UPDATE directives SET status='expired'
     WHERE status IN ('pending','accepted') AND expires_at < now()
     RETURNING id`
  );
  return rows.length;
}

// ── Directive engine (pure rules, no AI) ────────────────────────────────────

interface Candidate {
  id: number;
  code: string;
  capacity: number;
  route_id: number;
  route_short: string;
  progress: number;
  speed: number;
  onboard: number;
  next_stop_id: number | null;
  next_stop_key: string | null;
  next_stop_name: string | null;
  next_stop_progress: number | null;
}

/**
 * How many riders on `sourceBus` could actually be moved to `targetBus`.
 *
 * A rider is eligible only if the target's route also serves their destination
 * AND the target has not already passed it. This is what keeps the promise
 * honest: nobody is moved onto a bus that will not take them where their ticket
 * says. Destinations are matched on `stop_key`, because the same physical stop
 * is a separate row on each route that serves it.
 */
export async function eligibleRiders(
  c: Queryable,
  sourceBusId: number,
  targetBusId: number
): Promise<number> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n
     FROM tickets t
     JOIN stops dest ON dest.id = t.to_stop_id
     JOIN buses tb   ON tb.id = $2
     JOIN bus_positions tp ON tp.bus_id = tb.id
     JOIN stops ts   ON ts.route_id = tb.route_id AND ts.stop_key = dest.stop_key
     WHERE t.status = 'active'
       AND t.active_bus_id = $1
       AND ts.progress > tp.progress`,
    [sourceBusId, targetBusId]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Per bus, per tick:
 *   1. projected = (onboard + expected_boarders[next stop]) / capacity
 *   2. below threshold -> nothing to do
 *   3. already has an open directive -> don't stack
 *   4. candidates are buses on ANY route that also serves that next stop and
 *      have not yet passed it — three routes share this corridor, so relief can
 *      come from a different route entirely
 *   5. the candidate must have room, be inside the ETA window, and be able to
 *      carry riders who are actually eligible to move
 *   6. raise a directive naming the stop where the two buses will meet
 */
export async function evaluateDirectives(c: Queryable): Promise<Directive[]> {
  const { rows: buses } = await c.query(
    `SELECT b.id, b.code, b.capacity, b.route_id, r.short_name AS route_short,
            p.progress, p.speed,
            o.onboard::int AS onboard,
            s.id       AS next_stop_id,
            s.stop_key AS next_stop_key,
            s.name     AS next_stop_name,
            s.progress AS next_stop_progress
     FROM buses b
     JOIN routes r        ON r.id = b.route_id
     JOIN bus_positions p ON p.bus_id = b.id
     JOIN occupancy o     ON o.bus_id = b.id
     LEFT JOIN LATERAL (
       SELECT s.id, s.stop_key, s.name, s.progress
       FROM stops s
       WHERE s.route_id = b.route_id AND s.progress > p.progress
       ORDER BY s.progress LIMIT 1
     ) s ON TRUE`
  );
  const fleet = buses as Candidate[];
  const created: Directive[] = [];

  for (const bus of fleet) {
    if (bus.next_stop_id == null || bus.next_stop_key == null) continue;

    const { rows: eb } = await c.query(
      'SELECT count FROM expected_boarders WHERE stop_id=$1', [bus.next_stop_id]
    );
    const expected = Number(eb[0]?.count ?? 0);
    const projected = (bus.onboard + expected) / bus.capacity;
    if (projected < CFG.threshold) continue;

    // Never stack directives on a bus that already has one open.
    const { rowCount } = await c.query(
      `SELECT 1 FROM directives WHERE source_bus_id=$1 AND status IN ('pending','accepted')`,
      [bus.id]
    );
    if (rowCount) continue;

    // Which other buses serve this same physical stop, and where is it on
    // THEIR route? Cross-route relief is the whole point of the mesh.
    const { rows: servers } = await c.query(
      `SELECT b.id, s.progress AS stop_progress
       FROM buses b
       JOIN stops s ON s.route_id = b.route_id AND s.stop_key = $1
       JOIN bus_positions p ON p.bus_id = b.id
       WHERE b.id <> $2 AND s.progress > p.progress`,
      [bus.next_stop_key, bus.id]
    );
    const reach = new Map(servers.map((r) => [Number(r.id), Number(r.stop_progress)]));

    const ranked = fleet
      .filter((t) => reach.has(t.id))
      .filter((t) => (t.onboard + expected) / t.capacity < CFG.roomPct)
      .map((t) => {
        const gap = reach.get(t.id)! - Number(t.progress);
        // ETA in sim-minutes for the candidate to reach the transfer stop.
        return { ...t, etaMin: gap > 0 ? gap / Number(t.speed) / 60 : 0 };
      })
      .filter((t) => t.etaMin >= 0 && t.etaMin < CFG.window)
      .sort((a, b) => a.onboard / a.capacity - b.onboard / b.capacity);

    let target: (typeof ranked)[number] | undefined;
    let movable = 0;
    for (const candidate of ranked) {
      movable = await eligibleRiders(c, bus.id, candidate.id);
      if (movable > 0) { target = candidate; break; }
    }
    if (!target) continue;

    const room = Math.max(0, Math.floor(target.capacity * CFG.roomPct) - target.onboard);
    const overflow = Math.ceil(bus.onboard + expected - bus.capacity * CFG.threshold);
    const suggested = Math.max(1, Math.min(room, overflow, movable));

    const reason =
      `${bus.code} (${bus.route_short}) projected ${Math.round(projected * 100)}% at ` +
      `${bus.next_stop_name} — ${bus.onboard}/${bus.capacity} + ${expected} boarding. ` +
      `${target.code} (${target.route_short}) has room and reaches the same stop in ` +
      `${target.etaMin.toFixed(1)} min; ${movable} riders aboard ${bus.code} are also served by it.`;

    const { rows } = await c.query(
      `INSERT INTO directives
         (source_bus_id, target_bus_id, transfer_stop_key, transfer_stop_name,
          reason, suggested, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)
       RETURNING *`,
      [bus.id, target.id, bus.next_stop_key, bus.next_stop_name,
       reason, suggested, CFG.window]
    );
    created.push(rows[0] as Directive);
  }

  if (created.length) await notify('directive', {}, c);
  return created;
}
