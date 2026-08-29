import { tx, notify } from '@/lib/db';
import { logEvent } from '@/lib/rules';
import { handler, json } from '@/lib/api-route';
import type { Ticket } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** pending -> active. Boarding is the event occupancy counts, not the sale. */
export const POST = handler(async (req) => {
  const { ticket_id, bus_id } = (await req.json()) as { ticket_id: number; bus_id: number };

  const ticket = await tx(async (c) => {
    const { rows } = await c.query<Ticket>(
      `UPDATE tickets SET status='active', origin_bus_id=COALESCE(origin_bus_id,$2),
              active_bus_id=$2, boarded_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [ticket_id, bus_id]
    );
    if (!rows[0]) throw new Error('ticket is not pending (expired or already boarded)');
    await logEvent(c, bus_id, 'board', rows[0].id);
    return rows[0];
  });

  await notify('tickets', { id: ticket.id });
  return json(ticket);
});
