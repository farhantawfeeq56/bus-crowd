import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';

export const DB_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/busmesh';

/**
 * One pool per process. Next re-evaluates modules on hot reload, so the pool is
 * pinned to globalThis — otherwise dev mode leaks a pool on every edit.
 */
const globalForPg = globalThis as unknown as { __busmeshPool?: Pool };
export const pool = globalForPg.__busmeshPool ?? new Pool({ connectionString: DB_URL });
if (process.env.NODE_ENV !== 'production') globalForPg.__busmeshPool = pool;

/**
 * Query helper. The row generic is deliberately unconstrained: our domain
 * interfaces are exact shapes, not pg's index-signature `QueryResultRow`.
 */
export async function q<R = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: R[]; rowCount: number | null }> {
  const res = await pool.query(text, params as never[]);
  return { rows: res.rows as R[], rowCount: res.rowCount };
}

/** Run fn inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export type Queryable = Pick<PoolClient, 'query'> | Pool;

/**
 * Broadcast a change to every connected screen via Postgres NOTIFY, which the
 * SSE route fans out. This is what replaces Supabase Realtime.
 */
export async function notify(
  kind: string,
  payload: Record<string, unknown> = {},
  client: Queryable = pool
): Promise<void> {
  // NOTIFY payloads cap at 8000 bytes — we send signals, never data dumps.
  await client.query(`SELECT pg_notify('busmesh', $1)`, [JSON.stringify({ kind, ...payload })]);
}
