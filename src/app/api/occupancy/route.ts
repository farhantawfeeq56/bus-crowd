import { pool } from '@/lib/db';
import { occupancy } from '@/lib/rules';
import { handler, json } from '@/lib/api-route';

export const dynamic = 'force-dynamic';
export const GET = handler(async () => json(await occupancy(pool)));
