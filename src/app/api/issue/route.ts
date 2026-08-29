import { tx, notify } from '@/lib/db';
import { logEvent } from '@/lib/rules';
import { handler, json } from '@/lib/api-route';
import type { Ticket } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface IssueBody {
  passenger_name: string;
  from_stop_id: number;
  to_stop_id: number;
  bus_id?: number;
  /** Board immediately (conductor flow) rather than leaving the ticket pending. */
  board?: boolean;
}

/** Buy a ticket. It starts `pending` — occupancy only counts riders who board. */
export const POST = handler(async (req) => {
  const { passenger_name, from_stop_id, to_stop_id, bus_id, board = false } =
    (await req.json()) as IssueBody;

  if (!passenger_name || !from_stop_id || !to_stop_id)
    return json({ error: 'passenger_name, from_stop_id and to_stop_id are required' }, { status: 400 });

  const ticket = await tx(async (c) => {
    const { rows } = await c.query<Ticket>(
      `INSERT INTO tickets (passenger_name,from_stop_id,to_stop_id,origin_bus_id,active_bus_id,status,boarded_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING *`,
      [passenger_name, from_stop_id, to_stop_id, board ? bus_id ?? null : null,
       board ? 'active' : 'pending', board ? new Date() : null]
    );
    if (board && bus_id) await logEvent(c, bus_id, 'board', rows[0].id);
    return rows[0];
  });

  await notify('tickets', { id: ticket.id });
  return json(ticket);
});
