import { q } from '@/lib/db';
import { handler, json } from '@/lib/api-route';
import type { BusEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const { rows } = await q<BusEvent>(
    `SELECT e.*, b.code FROM bus_events e JOIN buses b ON b.id=e.bus_id
     ORDER BY e.id DESC LIMIT 40`
  );
  return json(rows);
});
