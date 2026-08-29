import Link from 'next/link';

const SCREENS = [
  { href: '/dashboard', kicker: 'Judge screen', name: 'Control dashboard',
    blurb: 'Live map, occupancy bars, directive feed.' },
  { href: '/conductor?bus=257', kicker: 'On the bus', name: 'Conductor · 257',
    blurb: 'Issue tickets, accept transfer directives.' },
  { href: '/passenger', kicker: 'In the hand', name: 'Passenger app',
    blurb: 'Buy, ride, get moved, auto-complete.' },
];

const COMMANDS = [
  ['npm run setup', 'db + OSRM route + seed'],
  ['npm run dev', 'Next app: UI, API and realtime'],
  ['npm run sim', 'bus movement engine, 15× speed'],
  ['npm run god', 'auto-demo passenger spawner'],
];

export default function Home() {
  return (
    <main className="grid flex-1 place-items-center p-7">
      <div className="w-full max-w-[760px]">
        <h1 className="text-[44px] font-extrabold tracking-[-0.035em]">
          Bus<span className="text-accent">Mesh</span>
        </h1>
        <p className="mb-7 mt-2 max-w-[560px] text-base leading-relaxed text-ink-2">
          A ticket belongs to your <b className="text-ink">destination</b>, not to one bus. When a bus
          is about to overflow, the mesh moves riders to the next bus on the same corridor — live,
          mid-route, at no extra fare.
        </p>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5">
          {SCREENS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="rounded-2xl border border-line bg-panel p-5 transition
                hover:-translate-y-0.5 hover:border-accent"
            >
              <div className="text-[11px] uppercase tracking-[0.1em] text-ink-2">{s.kicker}</div>
              <div className="my-1.5 text-xl font-bold tracking-tight">{s.name}</div>
              <div className="text-[13px] leading-relaxed text-ink-2">{s.blurb}</div>
            </Link>
          ))}
        </div>

        <div className="mt-7 font-mono text-[12.5px] leading-loose text-ink-2">
          {COMMANDS.map(([cmd, note]) => (
            <div key={cmd}>
              <span className="text-ink-3">$ </span>{cmd.padEnd(16, ' ')}
              <span className="text-ok"># {note}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
