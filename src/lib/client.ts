'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TickMessage } from './types';

/** Occupancy band — drives every colour decision in the UI. */
export type Band = 'ok' | 'warn' | 'crit';
export const bandOf = (pct: number): Band => (pct >= 0.85 ? 'crit' : pct >= 0.6 ? 'warn' : 'ok');

export const pctText = (n: number | null | undefined) => `${Math.round((n ?? 0) * 100)}%`;

export const ago = (ts: string) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
};

export const api = {
  get: <T,>(path: string): Promise<T> => fetch(`/api${path}`).then((r) => r.json() as Promise<T>),
  post: async <T,>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data?.error) throw new Error(data?.error ?? 'request failed');
    return data as T;
  },
};

/**
 * Subscribe to the simulation's realtime stream. Every screen uses this, so the
 * dashboard, conductor and passenger apps all repaint on the same tick.
 * Bursty ticks are coalesced into at most one callback per `throttle` window.
 */
export function useRealtime(onTick: (msg: TickMessage) => void, throttle = 140): boolean {
  const [live, setLive] = useState(false);
  const latest = useRef(onTick);

  // Keep the ref pointing at the newest callback without re-opening the stream.
  useEffect(() => { latest.current = onTick; }, [onTick]);

  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const source = new EventSource('/api/stream');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false); // EventSource reconnects on its own
    source.onmessage = (e) => {
      if (pending) return;
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        if (closed) return;
        try { latest.current(JSON.parse(e.data) as TickMessage); } catch { /* ignore */ }
      }, throttle);
    };

    return () => { closed = true; clearTimeout(timer); source.close(); };
  }, [throttle]);

  return live;
}

/** Load a resource once, then re-load it on every realtime tick. */
export function useLive<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(
    () => api.get<T>(path).then(setData).catch(() => {}),
    [path]
  );
  useEffect(() => { void load(); }, [load]);
  const live = useRealtime(load);
  return { data, live, reload: load };
}

/** A toast that clears itself — the conductor needs instant confirmation on stage. */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? null : m)), 2200);
  }, []);
  return { message, show };
}
