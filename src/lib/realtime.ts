import { Client } from '@neondatabase/serverless';
import { DB_URL } from './db';

type Send = (payload: string) => void;

/**
 * ONE Postgres LISTEN connection per server process, fanned out to every open
 * screen. Pinned to globalThis because Next re-evaluates route modules on hot
 * reload — otherwise dev mode leaks a connection per edit.
 */
const globalForHub = globalThis as unknown as {
  __busmeshHub?: { clients: Set<Send>; listener: Client | null; connecting: Promise<Client> | null };
};
const hub = (globalForHub.__busmeshHub ??= { clients: new Set(), listener: null, connecting: null });

function ensureListener(): Promise<Client> {
  if (hub.listener) return Promise.resolve(hub.listener);
  hub.connecting ??= (async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query('LISTEN busmesh');
    client.on('notification', (msg) => {
      const payload = msg.payload ?? '{}';
      for (const send of hub.clients) {
        try { send(payload); } catch { hub.clients.delete(send); }
      }
    });
    client.on('error', (e) => {
      console.error('[realtime]', e.message);
      hub.listener = null;
      hub.connecting = null; // the next subscriber reconnects
    });
    hub.listener = client;
    return client;
  })();
  return hub.connecting;
}

/** Subscribe a writer. Returns an unsubscribe function. */
export async function subscribe(send: Send): Promise<() => void> {
  await ensureListener();
  hub.clients.add(send);
  return () => hub.clients.delete(send);
}
