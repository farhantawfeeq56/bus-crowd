import { tx, notify } from '@/lib/db';
import { logEvent } from '@/lib/rules';
import { handler, json } from '@/lib/api-route';
import type { Directive } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Accept a directive and move N riders. The `active_bus_id` flip, the transfer
 * counter and both event-log writes happen in ONE transaction, so occupancy can
 * never double-count mid-transfer.
 *
 * `to_stop_id` is deliberately never touched — that is the entire product: a
 * ticket belongs to the destination, not to a bus.
 */
export const POST = handler(async (req) => {
  const { directive_id, count = 1 } = (await req.json()) as { directive_id: number; count?: number };

  const result = await tx(async (c) => {
    const { rows: found } = await c.query<Directive>(
      'SELECT * FROM directives WHERE id=$1 FOR UPDATE', [directive_id]
    );
    const d = found[0];
    if (!d) throw new Error('directive not found');
    if (d.status === 'expired') throw new Error('directive expired — the transfer window closed');

    /*
     * Only riders the TARGET's route can actually deliver are eligible: its
     * route must serve their destination and it must not have passed it yet.
     * Destinations match on `stop_key`, because one physical stop is a separate
     * row on each route that serves it. Furthest-to-go move first — they gain
     * the most from the swap.
     */
    const { rows: moved } = await c.query<{ id: number }>(
      `UPDATE tickets SET active_bus_id=$2, transfers=transfers+1
       WHERE id IN (
         SELECT t.id
         FROM tickets t
         JOIN stops dest       ON dest.id = t.to_stop_id
         JOIN buses tb         ON tb.id = $2
         JOIN bus_positions tp ON tp.bus_id = tb.id
         JOIN stops ts         ON ts.route_id = tb.route_id
                              AND ts.stop_key = dest.stop_key
         WHERE t.status = 'active'
           AND t.active_bus_id = $1
           AND ts.progress > tp.progress
         ORDER BY ts.progress DESC
         LIMIT $3
       ) RETURNING id`,
      [d.source_bus_id, d.target_bus_id, count]
    );
    if (!moved.length) {
      throw new Error(
        `no eligible riders — nobody aboard ${d.source_bus_id} is still served by the other bus`
      );
    }
    for (const t of moved) {
      await logEvent(c, d.source_bus_id, `transfer_out:${d.id}`, t.id);
      await logEvent(c, d.target_bus_id, `transfer_in:${d.id}`, t.id);
    }
    const { rows: updated } = await c.query<Directive>(
      `UPDATE directives SET status='accepted', moved=moved+$2 WHERE id=$1 RETURNING *`,
      [d.id, moved.length]
    );
    return { directive: updated[0], moved: moved.length };
  });

  await notify('directive', { id: directive_id });
  await notify('tickets', {});
  return json(result);
});
