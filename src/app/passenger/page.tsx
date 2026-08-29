'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, bandOf, useRealtime } from '@/lib/client';
import { Card, Empty, LoadBar, Pill, TopBar, btnPrimaryClass, inputClass } from '@/components/ui';
import type { FullState, Ticket } from '@/lib/types';

const STORAGE_KEY = 'busmesh.ticket';

/** The phone in the rider's hand: buy, ride, get moved, auto-complete. */
export default function PassengerPage() {
  const [base, setBase] = useState<FullState | null>(null);
  const [state, setState] = useState<FullState | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [session, setSession] = useState<{ ticketId: number | null } | null>(null);

  // Remember which bus they were on, so a transfer can be announced.
  const previousBus = useRef<string | null>(null);
  const [transferFrom, setTransferFrom] = useState<string | null>(null);

  // localStorage is client-only, so the stored ticket is read after mount.
  // `session === null` means "not hydrated yet" and renders a neutral state,
  // which keeps the server and first client render identical.
  useEffect(() => {
    void Promise.resolve().then(() => {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      setSession({ ticketId: Number.isFinite(stored) && stored > 0 ? stored : null });
    });
  }, []);

  const ticketId = session?.ticketId ?? null;

  const load = useCallback(() => {
    void api.get<FullState>('/state').then(setState).catch(() => {});
    if (!base) void api.get<FullState>('/state').then(setBase).catch(() => {});
    if (ticketId == null) return;

    void api
      .get<Ticket & { error?: string }>(`/ticket/${ticketId}`)
      .then((t) => {
        if (t.error) {
          localStorage.removeItem(STORAGE_KEY);
          previousBus.current = null;
          setSession({ ticketId: null });
          setTicket(null);
          return;
        }
        if (t.bus_code && previousBus.current && previousBus.current !== t.bus_code) {
          setTransferFrom(previousBus.current);
        }
        if (t.bus_code) previousBus.current = t.bus_code;
        setTicket(t);
      })
      .catch(() => {});
  }, [ticketId, base]);

  useEffect(() => { load(); }, [load]);
  const live = useRealtime(load);

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    previousBus.current = null;
    setTransferFrom(null);
    setSession({ ticketId: null });
    setTicket(null);
  };

  const onBought = (id: number) => {
    localStorage.setItem(STORAGE_KEY, String(id));
    previousBus.current = null;
    setTransferFrom(null);
    setTicket(null);
    setSession({ ticketId: id });
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col border-x border-line">
      <TopBar tag="passenger" live={live}>
        <button
          onClick={reset}
          className="whitespace-nowrap rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px]
            text-ink-2 transition hover:border-accent hover:text-accent"
        >
          new ticket
        </button>
      </TopBar>

      <div className="flex flex-1 flex-col gap-3.5 p-3.5">
        {!session || !base ? (
          <Empty>loading…</Empty>
        ) : ticketId == null ? (
          <BuyTicket base={base} onBought={onBought} />
        ) : !ticket ? (
          <Empty>loading your ticket…</Empty>
        ) : (
          <LiveTicket
            ticket={ticket}
            state={state ?? base}
            transferFrom={transferFrom}
            pendingTtl={base.config.pendingTtl}
            onReset={reset}
          />
        )}
      </div>
    </div>
  );
}

function BuyTicket({ base, onBought }: { base: FullState; onBought: (id: number) => void }) {
  // Riders pick physical places, not route-specific stop rows. The same stop is
  // a separate row on every route serving it, so the picker is keyed on stop_key
  // and the route is chosen for them afterwards.
  const places = useMemo(() => {
    const seen = new Map<string, { key: string; name: string }>();
    for (const s of base.stops) if (!seen.has(s.stop_key)) seen.set(s.stop_key, { key: s.stop_key, name: s.name });
    return [...seen.values()];
  }, [base.stops]);

  const [name, setName] = useState('');
  const [from, setFrom] = useState(places[0]?.key ?? '');
  const [to, setTo] = useState(places[places.length - 1]?.key ?? '');
  const [error, setError] = useState<string | null>(null);

  const buy = async () => {
    const passenger = name.trim();
    if (!passenger) return;
    setError(null);
    if (from === to) { setError('Pick two different stops.'); return; }

    try {
      const now = await api.get<FullState>('/state');

      /*
       * Find every route that serves BOTH places in the right order, then board
       * the bus on one of them that is closest behind the origin. Which route
       * the rider starts on is an implementation detail to them — the mesh may
       * move them to another one mid-journey and the ticket will not change.
       */
      const options = now.buses.flatMap((bus) => {
        const onRoute = now.stops.filter((s) => s.route_id === bus.route_id);
        const origin = onRoute.find((s) => s.stop_key === from);
        const dest = onRoute.find((s) => s.stop_key === to);
        if (!origin || !dest || Number(dest.progress) <= Number(origin.progress)) return [];
        if (Number(bus.progress) > Number(origin.progress)) return []; // already gone past
        return [{ bus, origin, dest, gap: Number(origin.progress) - Number(bus.progress) }];
      });

      if (!options.length) {
        setError('No bus is heading that way right now — try another pair of stops.');
        return;
      }
      // The bus closest behind the origin stop is the one arriving soonest.
      const best = options.sort((a, b) => a.gap - b.gap)[0];

      const ticket = await api.post<Ticket>('/issue', {
        passenger_name: passenger,
        from_stop_id: best.origin.id,
        to_stop_id: best.dest.id,
        bus_id: best.bus.id,
        board: true,
      });
      onBought(ticket.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <Card title="Buy a ticket">
        <div className="grid gap-2.5">
          <input
            value={name}
            autoComplete="off"
            placeholder="Your name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && buy()}
            className={inputClass}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className={inputClass}>
              {places.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className={inputClass}>
              {places.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
          <button onClick={buy} className={btnPrimaryClass}>Buy ticket</button>
          {error && <p className="text-center font-mono text-[11.5px] text-crit">{error}</p>}
          <p className="text-center font-mono text-[11.5px] text-ink-3">
            valid for the whole trip · ends at your destination
          </p>
        </div>
      </Card>

      <Card title="How it works">
        <p className="text-[13px] leading-relaxed text-ink-2">
          Your ticket is tied to your <b className="text-ink">destination</b>, not to one bus. If your
          bus gets overcrowded, BusMesh moves you to a following bus on the same corridor — your
          destination stays the same and you pay nothing extra.
        </p>
      </Card>
    </>
  );
}

function LiveTicket({
  ticket, state, transferFrom, pendingTtl, onReset,
}: {
  ticket: Ticket;
  state: FullState;
  transferFrom: string | null;
  pendingTtl: number;
  onReset: () => void;
}) {
  if (ticket.status === 'completed') {
    const why =
      ticket.end_reason === 'destination' ? `You arrived at ${ticket.to_stop}.`
      : ticket.end_reason === 'terminus'   ? 'The route ended at its terminus.'
      : ticket.end_reason === 'safety_cap' ? 'Ticket auto-closed after the 3-hour cap.'
      : 'Journey closed.';
    return (
      <>
        <div className="rounded-2xl border border-ok/45 bg-gradient-to-br from-[#0f3325] to-[#0a1e17] p-6 text-center">
          <div className="mb-1.5 text-[26px] font-extrabold tracking-tight">Journey complete</div>
          <p className="text-ink-2">{why}</p>
          <div className="mt-3 flex justify-center gap-1.5">
            <Pill tone="ok">{ticket.transfers} transfer{ticket.transfers === 1 ? '' : 's'}</Pill>
            <Pill tone="accent">no extra fare</Pill>
          </div>
        </div>
        <button onClick={onReset} className={btnPrimaryClass}>Buy another ticket</button>
      </>
    );
  }

  if (ticket.status === 'expired') {
    return (
      <>
        <Card className="border-crit/40" title={<span className="text-crit">Ticket expired</span>}>
          <p className="text-ink-2">
            Not boarded within {pendingTtl}s. Nothing was charged — occupancy only counts riders who
            actually board.
          </p>
        </Card>
        <button onClick={onReset} className={btnPrimaryClass}>Buy another ticket</button>
      </>
    );
  }

  const bus = state.buses.find((b) => b.code === ticket.bus_code);
  // Scope to the bus's own route — the same stop name exists on all three.
  const onRoute = state.stops.filter((s) => s.route_id === bus?.route_id);
  const from = onRoute.find((s) => s.name === ticket.from_stop);
  const to = onRoute.find((s) => s.name === ticket.to_stop);
  const span = to && from ? Number(to.progress) - Number(from.progress) : 1;
  const travelled =
    bus && from
      ? Math.max(0, Math.min(100, ((Number(bus.progress) - Number(from.progress)) / (span || 1)) * 100))
      : 0;

  return (
    <>
      {transferFrom && (
        <div className="animate-pop-in rounded-2xl border border-accent/50 bg-gradient-to-br from-[#12324f] to-[#0b1c2c] p-4">
          <div className="mb-1.5 text-base font-bold">🔄 You&apos;ve been moved to bus {ticket.bus_code}</div>
          <p className="text-[13px] text-ink-2">
            Bus {transferFrom} was over capacity. Same destination —{' '}
            <b className="text-ink">{ticket.to_stop}</b>. No extra fare, no new ticket.
          </p>
        </div>
      )}

      <div className="relative overflow-hidden rounded-[18px] border border-line bg-gradient-to-br from-panel-2 to-panel p-5">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(600px 120px at 80% -10%, rgba(77,163,255,.14), transparent)' }}
        />
        <div className="text-[11px] uppercase tracking-[0.1em] text-ink-2">
          Riding{bus ? ` · ${bus.route_short}` : ''}
        </div>
        <div className="font-mono text-[46px] font-extrabold leading-[1.05] tracking-[-0.04em]">
          {ticket.bus_code ?? '—'}
        </div>

        <div className="my-4 flex items-center gap-3">
          <span className="size-[9px] flex-none rounded-full bg-accent shadow-[0_0_0_4px_rgba(77,163,255,0.18)]" />
          <span className="h-0.5 flex-1 overflow-hidden rounded-sm bg-line">
            <i className="block h-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${travelled}%` }} />
          </span>
          <span className={`size-[9px] flex-none rounded-full ${travelled >= 99 ? 'bg-accent' : 'bg-ink-3'}`} />
        </div>
        <div className="flex justify-between font-mono text-xs text-ink-2">
          <b className="text-ink">{ticket.from_stop}</b>
          <b className="text-ink">{ticket.to_stop}</b>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Pill tone="accent">{ticket.status}</Pill>
          {ticket.transfers > 0 && <Pill tone="ok">transferred ×{ticket.transfers}</Pill>}
          {ticket.origin_code && ticket.origin_code !== ticket.bus_code && (
            <Pill tone="warn">boarded on {ticket.origin_code}</Pill>
          )}
          <Pill>ticket #{ticket.id}</Pill>
        </div>
      </div>

      <Card title="Your bus">
        {bus ? (
          <>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="font-mono text-[17px] font-bold tracking-tight">{bus.code}</span>
              <span className="ml-auto font-mono text-[13px] text-ink-2">
                <b className="text-[15px] text-ink">{bus.onboard}</b>/{bus.capacity}
              </span>
            </div>
            <LoadBar pct={bus.pct} band={bandOf(bus.pct)} />
            <div className="mt-1.5 font-mono text-[11px] text-ink-3">
              {bus.at_stop_name ? `◉ at ${bus.at_stop_name}` : 'in transit'}
            </div>
          </>
        ) : (
          <Empty>waiting to board</Empty>
        )}
      </Card>

      <p className="text-center font-mono text-[11.5px] text-ink-3">
        ends automatically when the bus reaches {ticket.to_stop}
      </p>
    </>
  );
}
