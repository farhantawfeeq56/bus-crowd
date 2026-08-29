'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, bandOf, pctText, useRealtime, useToast } from '@/lib/client';
import {
  Card, Empty, LoadBar, Pill, Toast, TopBar,
  btnClass, btnPrimaryClass, inputClass,
} from '@/components/ui';
import type { BusView, Directive, FullState } from '@/lib/types';

export default function ConductorPage() {
  return (
    <Suspense fallback={null}>
      <Conductor />
    </Suspense>
  );
}

/** The phone in the conductor's hand: live count, issue flow, accept banner. */
function Conductor() {
  const router = useRouter();
  const code = useSearchParams().get('bus') ?? '18K';

  const [base, setBase] = useState<FullState | null>(null); // stops + fleet, effectively static
  const [view, setView] = useState<BusView | null>(null);   // this bus, refreshed every tick
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const toast = useToast();

  useEffect(() => {
    void api.get<FullState>('/state').then((s) => {
      setBase(s);
      if (s.stops.length) {
        setFrom(String(s.stops[0].id));
        setTo(String(s.stops[s.stops.length - 1].id));
      }
    });
  }, []);

  const load = useCallback(
    () => api.get<BusView>(`/bus/${encodeURIComponent(code)}`).then(setView).catch(() => {}),
    [code]
  );
  useEffect(() => { void load(); }, [load]);
  const live = useRealtime(load);

  if (!base || !view?.bus) {
    return (
      <Shell live={live}>
        <Empty>loading bus {code}…</Empty>
      </Shell>
    );
  }

  const { bus, riders, incoming, outgoing } = view;
  const band = bandOf(bus.pct);
  const myBus = base.buses.find((b) => b.code === bus.code);
  // Only this route's stops — three routes share the corridor, and a conductor
  // can only issue tickets to stops their own bus actually serves.
  const myStops = base.stops.filter((s) => s.route_id === myBus?.route_id);
  const next = myStops.find((s) => Number(s.progress) > Number(bus.progress));

  // The initial from/to were picked before we knew which route this bus runs,
  // and they are re-picked whenever the conductor switches bus.
  const onThisRoute = (id: string) => myStops.some((s) => String(s.id) === id);
  const fromId = onThisRoute(from) ? from : String(myStops[0]?.id ?? '');
  const toId = onThisRoute(to) ? to : String(myStops[myStops.length - 1]?.id ?? '');

  const accept = async (d: Directive, count: number) => {
    setBusy(true);
    try {
      const r = await api.post<{ moved: number }>('/transfer', { directive_id: d.id, count });
      toast.show(`+${r.moved} boarded from ${d.source_code}`);
    } catch (e) {
      toast.show((e as Error).message);
    }
    setBusy(false);
    void load();
  };

  const issue = async () => {
    const passenger = name.trim();
    if (!passenger) return;
    try {
      await api.post('/issue', {
        passenger_name: passenger,
        from_stop_id: Number(fromId),
        to_stop_id: Number(toId),
        bus_id: bus.id,
        board: true,
      });
      toast.show(`${passenger} boarded`);
      setName('');
      void load();
    } catch (e) {
      toast.show((e as Error).message);
    }
  };

  return (
    <Shell
      live={live}
      picker={
        <select
          value={code}
          onChange={(e) => router.push(`/conductor?bus=${e.target.value}`)}
          className="rounded-lg border border-line bg-panel-2 px-2.5 py-1 text-xs text-ink outline-none focus:border-accent"
          aria-label="Select bus"
        >
          {base.buses.map((b) => <option key={b.code} value={b.code}>Bus {b.code}</option>)}
        </select>
      }
    >
      <div className="rounded-2xl border border-line bg-panel p-4.5">
        <div className="mb-3.5 flex items-start justify-between">
          <div>
            <div className="font-mono text-[40px] font-extrabold leading-none tracking-[-0.04em]">
              {bus.code}
            </div>
            <div className="mt-1.5 font-mono text-[11px]"
                 style={{ color: bus.route_color }}>{bus.route_short}</div>
            <div className="mt-1 font-mono text-[11px] text-ink-2">
              {bus.holding_for
                ? `⏸ holding at ${bus.at_stop_name} for transfer`
                : bus.at_stop_name ? `◉ boarding at ${bus.at_stop_name}` : 'in transit'}
            </div>
          </div>
          <div>
            <div className="text-right font-mono text-[34px] font-extrabold leading-none tracking-[-0.03em]">
              {bus.onboard}
              <span className="text-[15px] font-semibold text-ink-2">/{bus.capacity}</span>
            </div>
            <div className="mt-1.5 text-right">
              <Pill tone={band}>{pctText(bus.pct)}</Pill>
            </div>
          </div>
        </div>
        <LoadBar pct={bus.pct} band={band} />
        <div className="mt-1.5 flex gap-2.5 font-mono text-[11px] text-ink-3">
          <span>route {Math.round(bus.progress * 100)}%</span>
          <span>{next ? `next · ${next.name}` : 'approaching terminus'}</span>
        </div>
      </div>

      {/* This bus is the TARGET of a directive — the accept banner. */}
      {incoming.map((d) => (
        <div
          key={d.id}
          className="animate-pop-in rounded-2xl border border-crit/50 bg-gradient-to-br from-[#3a1119] to-[#1d0a10]
            p-4 shadow-[0_8px_32px_rgba(255,77,94,0.15)]"
        >
          <div className="mb-1.5 flex items-center gap-2.5 text-base font-bold">
            <span className="animate-blink size-[9px] rounded-full bg-crit" />
            ACCEPT FROM {d.source_code}
          </div>
          <div className="mb-2">
            <Pill tone={d.both_present ? 'ok' : 'warn'}>
              {d.both_present
                ? `● ${d.source_code} is at the kerb — ${d.transfer_stop_name}`
                : `meet at ${d.transfer_stop_name}`}
            </Pill>
          </div>
          <p className="mb-3 font-mono text-xs leading-relaxed text-[#e7b9bf]">{d.reason}</p>
          <div className="grid grid-cols-4 gap-2">
            {[1, 5, 10].map((n) => (
              <button
                key={n}
                disabled={busy}
                onClick={() => accept(d, n)}
                className={`${btnClass} px-0 py-3 font-mono font-bold`}
              >
                +{n}
              </button>
            ))}
            <button
              onClick={async () => {
                await api.post(`/directive/${d.id}/done`, {});
                toast.show('transfer closed');
                void load();
              }}
              className={`${btnPrimaryClass} px-0 py-3 font-mono font-bold`}
            >
              DONE
            </button>
          </div>
          <div className="mt-2.5 font-mono text-[11px] text-ink-2">
            suggested +{d.suggested} · {d.moved} accepted so far
          </div>
        </div>
      ))}

      {/* This bus is the SOURCE — relief is on the way. */}
      {outgoing.map((d) => (
        <Card key={d.id} className="border-warn/40" title={<span className="text-warn">Overload — relief dispatched</span>}>
          <p className="font-mono text-xs text-ink-2">{d.reason}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Pill tone={d.both_present ? 'ok' : 'warn'}>
              {d.both_present ? `● ${d.target_code} alongside` : `meet at ${d.transfer_stop_name}`}
            </Pill>
            <Pill tone="warn">{d.moved} riders moved to {d.target_code}</Pill>
          </div>
        </Card>
      ))}

      <Card title="Issue ticket">
        <div className="grid gap-2.5">
          <input
            value={name}
            autoComplete="off"
            placeholder="Passenger name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && issue()}
            className={inputClass}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <StopSelect value={fromId} onChange={setFrom} stops={myStops} label="From stop" />
            <StopSelect value={toId} onChange={setTo} stops={myStops} label="To stop" />
          </div>
          <button onClick={issue} className={btnPrimaryClass}>Issue &amp; board</button>
        </div>
      </Card>

      <Card title={<>Onboard <span className="font-mono normal-case text-ink-2">({riders.length})</span></>} className="flex-1">
        <div className="max-h-[250px] overflow-y-auto">
          {riders.length === 0 && <Empty>empty bus</Empty>}
          {riders.slice(0, 40).map((r) => (
            <div key={r.id} className="flex items-center gap-2.5 border-b border-line py-2.5 text-[13px] last:border-b-0">
              <span>{r.passenger_name}</span>
              {r.transfers > 0 && <Pill tone="accent">transfer ×{r.transfers}</Pill>}
              <span className="ml-auto font-mono text-xs text-ink-2">→ {r.to_stop}</span>
            </div>
          ))}
        </div>
      </Card>

      <Toast message={toast.message} />
    </Shell>
  );
}

function Shell({
  children, live, picker,
}: { children: React.ReactNode; live: boolean; picker?: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col border-x border-line">
      <TopBar tag="conductor" live={live}>{picker}</TopBar>
      <div className="flex flex-1 flex-col gap-3.5 p-3.5">{children}</div>
    </div>
  );
}

function StopSelect({
  value, onChange, stops, label,
}: {
  value: string;
  onChange: (v: string) => void;
  stops: FullState['stops'];
  label: string;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    >
      {stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}
