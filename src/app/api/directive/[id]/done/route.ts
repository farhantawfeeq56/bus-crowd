import { q, notify } from '@/lib/db';
import { handler, json } from '@/lib/api-route';
import type { Directive } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** The conductor tapped DONE — this transfer is finished. */
export const POST = handler(async (_req, { params }) => {
  const { id } = await params;
  const { rows } = await q<Directive>(
    `UPDATE directives SET status='done' WHERE id=$1 RETURNING *`, [id]
  );
  await notify('directive', { id });
  return json(rows[0] ?? { error: 'not found' });
});
