import { busView } from '@/lib/queries';
import { handler, json } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

/** The conductor screen: who is aboard, and any directive touching this bus. */
export const GET = handler(async (_req, { params }) => {
  const { code } = await params;
  const view = await busView(code);
  return view ? json(view) : json({ error: 'no such bus' }, { status: 404 });
});
