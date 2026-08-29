import { fullState } from '@/lib/queries';
import { handler, json } from '@/lib/api-route';

export const dynamic = 'force-dynamic';
export const GET = handler(async () => json(await fullState()));
