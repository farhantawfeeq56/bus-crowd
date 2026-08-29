import 'dotenv/config';
import { pool, q, notify } from '../src/lib/db';
import { logEvent } from '../src/lib/rules';

// "God mode": fake passengers board wherever a bus is currently dwelling, in
// roughly the volume expected_boarders predicts. The demo drives itself, so
// nobody has to tap frantically on stage.

const NAMES = ['Arjun','Sowmya','Vikram','Nila','Rahul','Keerthi','Ajay','Swathi','Naveen',
  'Pooja','Siva','Malar','Ashok','Revathi','Guna','Shalini','Kishore','Vidya','Rohit','Aarthi',
  'Selvam','Nithin','Charu','Barath','Indhu','Mani','Sangeetha','Vimal','Preethi','Hari'];

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

const INTERVAL  = Number(process.env.GOD_INTERVAL_MS ?? 2500);
const INTENSITY = Number(process.env.GOD_INTENSITY ?? 1);

console.log(`god mode · boarding wave every ${INTERVAL}ms · intensity ${INTENSITY}×`);
console.log('ctrl-c to stop\n');

// One boarding wave per (bus, stop visit) — the sim's dwell window is our cue.
const served = new Set<string>();

interface DwellingBus {
  id: number; code: string; capacity: number; onboard: number; route_id: number;
  at_stop_id: number; last_stop_seq: number; stop_name: string; stop_progress: number;
}

async function wave() {
  const { rows: buses } = await q<DwellingBus>(
    `SELECT b.id, b.code, b.capacity, b.route_id, o.onboard::int AS onboard,
            p.at_stop_id, p.last_stop_seq, s.name AS stop_name, s.progress AS stop_progress
     FROM buses b
     JOIN bus_positions p ON p.bus_id=b.id
     JOIN occupancy o     ON o.bus_id=b.id
     JOIN stops s         ON s.id=p.at_stop_id`
  );

  for (const bus of buses) {
    const key = `${bus.id}:${bus.at_stop_id}:${bus.last_stop_seq}`;
    if (served.has(key)) continue;
    served.add(key);
    if (served.size > 500) served.clear();

    const { rows: eb } = await q<{ count: number }>(
      'SELECT count FROM expected_boarders WHERE stop_id=$1', [bus.at_stop_id]
    );
    const base = Number(eb[0]?.count ?? 0);
    // A little variance so the same demo never plays out identically.
    const wanted = Math.round(base * INTENSITY * (0.7 + Math.random() * 0.6));
    // Never exceed physical capacity — overflow is what directives exist for.
    const n = Math.max(0, Math.min(wanted, bus.capacity - bus.onboard));
    if (!n) continue;

    // Destinations must be on THIS bus's own route — three routes share this
    // corridor, so an unscoped lookup would sell tickets to stops it never visits.
    const { rows: ahead } = await q<{ id: number; name: string }>(
      'SELECT id, name FROM stops WHERE route_id=$1 AND progress > $2 ORDER BY progress',
      [bus.route_id, bus.stop_progress]
    );
    if (!ahead.length) continue;

    for (let i = 0; i < n; i++) {
      const to = pick(ahead);
      const { rows: [t] } = await q<{ id: number }>(
        `INSERT INTO tickets (passenger_name,from_stop_id,to_stop_id,origin_bus_id,active_bus_id,status,boarded_at)
         VALUES ($1,$2,$3,$4,$4,'active',now()) RETURNING id`,
        [`${pick(NAMES)} ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}.`,
         bus.at_stop_id, to.id, bus.id]
      );
      await logEvent(pool, bus.id, 'board', t.id, { stop: bus.stop_name });
    }

    console.log(`  +${n} boarded bus ${bus.code} at ${bus.stop_name} (${bus.onboard} → ${bus.onboard + n})`);
    await notify('tickets', { bus: bus.code, boarded: n });
  }
}

const timer = setInterval(
  () => void wave().catch((e: Error) => console.error(e.message)),
  INTERVAL
);
const shutdown = async () => { clearInterval(timer); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
