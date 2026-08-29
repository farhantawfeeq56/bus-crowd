import { ticketView } from '@/lib/queries';
import { handler, json } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

/** One passenger's live ticket, including which bus they are actually on now. */
export const GET = handler(async (_req, { params }) => {
  const { id } = await params;
  return json((await ticketView(Number(id))) ?? { error: 'not found' });
});
