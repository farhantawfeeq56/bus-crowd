import { subscribe } from '@/lib/realtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg needs real Node, not the edge runtime

/**
 * Server-sent events — this is what replaces Supabase Realtime. The dashboard,
 * conductor and passenger screens all subscribe here, so they repaint on the
 * same simulation tick.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const push = (text: string) => {
        try { controller.enqueue(encoder.encode(text)); } catch { /* client gone */ }
      };
      push('retry: 1000\n\n');
      unsubscribe = await subscribe((payload) => push(`data: ${payload}\n\n`));

      // Keep proxies and sleeping laptops from dropping the stream mid-demo.
      heartbeat = setInterval(() => push(': ping\n\n'), 15_000);

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
