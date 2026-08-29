import { pool } from '@/lib/db';
import { evaluateDirectives } from '@/lib/rules';
import { handler, json } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

/** Force one rule-engine pass — used by the auto-demo and for manual poking. */
export const POST = handler(async () => json({ directives: await evaluateDirectives(pool) }));
