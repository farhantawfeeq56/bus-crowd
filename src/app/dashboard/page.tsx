'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, bandOf, pctText, useRealtime } from '@/lib/client';
import { Card, Empty, LoadBar, Pill, Tag, TopBar } from '@/components/ui';
import type { BusEvent, FullState } from '@/lib/types';

// MapLibre touches `window` on import, so it must never render on the server.
const FleetMap = dynamic(() => import('@/components/FleetMap'), {
  ssr: false,
  loading: () => <div className="grid size-full place-items-center text-ink-3">loading map…</div>,
});

/** The judge-facing screen: one map, three occupancy bars, one directive feed. */
export default function DashboardPage() {
  const [state, setState] = useState<FullState | null>(null);
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [clock, setClock] = useState('');
  const [reachable, setReachable] = useState<boolean | null>(null);

  const load = useCallback(() => {
    void api
      .get<FullState>('/state')
      .then((s) => { setState(s); setReachable(true); })
      .catch(() => setReachable(false));
    void api.get<BusEvent[]>('/events').then(setEvents).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  const live = useRealtime(load);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('en-GB')), 1000);
    return () => clearInterval(t);
  }, []);

  // Distinguish "the API answered and the DB is empty" from "the API never
  // answered at all" — those need completely different fixes, and conflating
  // them sends you hunting for a seeding problem that isn't there.
  if (!state?.routes?.length) {
    return (
      <div className="p-10">
        {reachable === false ? (
          <Card title="Can't reach the API">
            <p className="text-ink-2">
              <code className="font-mono text-accent">/api/state</code> did not respond.
              Is <code className="font-mono text-accent">npm run dev</code> still running?
            </p>
            <p className="mt-2 text-ink-2">
              If you opened this over the network (
              <code className="font-mono text-accent">http://&lt;laptop-ip&gt;:3000</code>) and the
              browser console shows <b className="text-ink">403</b> on{' '}
              <code className="font-mono text-accent">/_next/*</code>, add that address to{' '}
              <code className="font-mono text-accent">allowedDevOrigins</code> in{' '}
              <code className="font-mono text-accent">next.config.ts</code> and restart.
            </p>
          </Card>
        ) : reachable === null ? (
          <Card title="Connecting"><p className="text-ink-2">Loading fleet state…</p></Card>
        ) : (
          <Card title="No route seeded">
            <p className="text-ink-2">
              The API is up but the database is empty. Run{' '}
              <code className="font-mono text-accent">npm run setup</code>, then reload.
            </p>
          </Card>
        )}
      </div>
    );
  }

  const riders = state.buses.reduce((a, b) => a + b.onboard, 0);
  const capacity = state.buses.reduce((a, b) => a + b.capacity, 0);
  const rebalanced = state.directives.reduce((a, d) => a + d.moved, 0);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar tag={`${state.routes.length} routes → Broadway`} live={live}>
        <Tag>{clock || '—'}</Tag>
        <Tag href="/conductor?bus=18K">conductor →</Tag>
        <Tag href="/passenger">passenger →</Tag>
      </TopBar>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[45vh_1fr] lg:grid-cols-[1fr_380px] lg:grid-rows-1">
        <div className="relative">
          <FleetMap
            routes={state.routes}
            stops={state.stops}
            buses={state.buses}
            directives={state.directives}
          />
          <RouteLegend routes={state.routes} />
        </div>

        <aside className="flex flex-col gap-3.5 overflow-y-auto border-t border-line p-4 lg:border-t-0 lg:border-l">
          <div className="grid grid-cols-3 gap-2.5">
            <Stat value={riders} label="Riders aboard" />
            <Stat value={capacity ? pctText(riders / capacity) : '0%'} label="Fleet load" />
            <Stat value={rebalanced} label="Rebalanced" />
          </div>

          <Card title="Live occupancy">
            {state.buses.map((bus) => {
              const next = state.stops.find(
                (s) => s.route_id === bus.route_id && Number(s.progress) > Number(bus.progress)
              );
              const band = bandOf(bus.pct);
              return (
                <div key={bus.code} className="mb-3.5 last:mb-0">
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="font-mono text-[17px] font-bold tracking-tight">{bus.code}</span>
                    <span
                      className="rounded px-1.5 py-px font-mono text-[10px] uppercase tracking-wide"
                      style={{ color: bus.route_color, background: `${bus.route_color}1f` }}
                    >
                      {bus.route_short}
                    </span>
                    <Pill tone={band}>{pctText(bus.pct)}</Pill>
                    <span className="ml-auto font-mono text-[13px] text-ink-2">
                      <b className="text-[15px] text-ink">{bus.onboard}</b>/{bus.capacity}
                    </span>
                  </div>
                  <LoadBar pct={bus.pct} band={band} />
                  <div className="mt-1.5 flex gap-2.5 font-mono text-[11px] text-ink-3">
                    <span>
                      {bus.holding_for
                        ? `⏸ holding at ${bus.at_stop_name} for transfer`
                        : bus.at_stop_name
                          ? `◉ at ${bus.at_stop_name}`
                          : `→ ${next?.name ?? 'terminus'}`}
                    </span>
                    <span>{Math.round(bus.progress * 100)}%</span>
                  </div>
                </div>
              );
            })}
          </Card>

          <Card title="Directive feed" className="flex min-h-[200px] flex-1 flex-col">
            <div className="flex max-h-[260px] flex-col gap-2.5 overflow-y-auto">
              {state.directives.length === 0 && <Empty>No directives — fleet balanced</Empty>}
              {state.directives.map((d) => {
                const tone =
                  d.status === 'pending' ? 'crit' : d.status === 'accepted' ? 'ok' : 'muted';
                const border =
                  d.status === 'pending' ? 'border-crit' : d.status === 'accepted' ? 'border-ok' : 'border-line';
                return (
                  <div key={d.id} className={`animate-slide-in border-l-2 py-2 pl-3 ${border}`}>
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <Pill tone={tone}>{d.status}</Pill>
                      <b className="font-mono">{d.source_code} → {d.target_code}</b>
                      {d.moved > 0 && <Pill tone="ok">+{d.moved} moved</Pill>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Pill tone={d.both_present ? 'ok' : 'accent'}>
                        {d.both_present ? '● both at kerb' : `meet at ${d.transfer_stop_name}`}
                      </Pill>
                    </div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-2">{d.reason}</div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-3">{ago(d.created_at)}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Bus events">
            <div className="flex max-h-[170px] flex-col gap-2.5 overflow-y-auto">
              {events.length === 0 && <Empty>no events yet</Empty>}
              {events.slice(0, 14).map((e) => (
                <div key={e.id} className="animate-slide-in border-l-2 border-line py-2 pl-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <b className="font-mono">{e.code}</b>
                    <span className="text-ink-2">{e.type.split(':')[0]}</span>
                    {e.meta?.stop && <span className="font-mono text-ink-2">· {e.meta.stop}</span>}
                    {!!e.meta?.alighted && <Pill tone="ok">−{e.meta.alighted}</Pill>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** Which colour on the map is which route. */
function RouteLegend({ routes }: { routes: FullState['routes'] }) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5
      rounded-xl border border-line bg-ground/80 p-2.5 backdrop-blur">
      {routes.map((r) => (
        <div key={r.id} className="flex items-center gap-2 font-mono text-[11px] text-ink-2">
          <span className="h-0.5 w-5 rounded-sm" style={{ background: r.color }} />
          {r.name}
        </div>
      ))}
    </div>
  );
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="font-mono text-2xl font-bold tracking-[-0.03em]">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-2">{label}</div>
    </div>
  );
}
