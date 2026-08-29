import { q, notify } from '@/lib/db';
import { handler, json } from '@/lib/api-route';
import type { Ticket } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Manual completion. Rule 2 also fires automatically on every sim tick. */
export const POST = handler(async (req) => {
  const { ticket_id } = (await req.json()) as { ticket_id: number };
  const { rows } = await q<Ticket>(
    `UPDATE tickets SET status='completed', ended_at=now(), end_reason='destination'
     WHERE id=$1 AND status='active' RETURNING *`,
    [ticket_id]
  );
  await notify('tickets', { id: ticket_id });
  return json(rows[0] ?? { error: 'ticket is not active' });
});
