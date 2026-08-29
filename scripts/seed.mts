import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { pool, q } from '../src/lib/db';
import { interpolate, progressOf, routeLength } from '../src/lib/geo';
import type { Coord } from '../src/lib/types';

/*
 * Three Chennai feeder routes that converge on Anna Salai and run a shared trunk
 * into Broadway. The overlap is the point: a rider heading for Central or
 * Broadway can be moved between any two of these buses without their ticket
 * changing, because all three serve the same destination.
 *
 * Coordinates are from OpenStreetMap's Nominatim geocoder, except the two marked
 * `approx` — Church Park School and Shanthi Theatre are not in OSM's index, so
 * they sit on Anna Salai between their geocoded neighbours. OSRM snaps the road
 * geometry and `progressOf` snaps each stop onto that polyline, so a small
 * along-the-road offset changes nothing functionally.
 */
const STOPS = {
  royapettah_hospital: { name: 'Royapettah Hospital',            lat: 13.054686, lng: 80.264198 },
  woodlands:           { name: 'Woodlands Theatre',              lat: 13.057195, lng: 80.264729 },
  express_avenue:      { name: 'Express Avenue (EA Mall)',       lat: 13.058821, lng: 80.264103 },
  teynampet:           { name: 'Teynampet / DMS',                lat: 13.044324, lng: 80.249846 },
  gemini:              { name: 'Gemini Flyover / Sun Plaza',     lat: 13.051616, lng: 80.250323 },
  church_park:         { name: 'Church Park School',             lat: 13.053000, lng: 80.253500, approx: true },
  thousand_lights:     { name: 'Thousand Lights',                lat: 13.058516, lng: 80.258783 },
  spencer_plaza:       { name: 'Spencer Plaza (TVS)',            lat: 13.061584, lng: 80.260942 },
  lic:                 { name: 'L.I.C.',                         lat: 13.064372, lng: 80.265846 },
  shanthi:             { name: 'Shanthi Theatre / Simpson',      lat: 13.067000, lng: 80.269000, approx: true },
  orr_and_sons:        { name: 'P. Orr & Sons',                  lat: 13.070274, lng: 80.273020 },
  pallavan_salai:      { name: 'Pallavan Salai',                 lat: 13.073729, lng: 80.276420 },
  mgr_central:         { name: 'M.G.R. Central Railway Station', lat: 13.082590, lng: 80.276308 },
  evening_bazaar:      { name: 'Evening Bazaar',                 lat: 13.084932, lng: 80.278720 },
  broadway:            { name: 'Broadway Bus Terminus',          lat: 13.086880, lng: 80.283768 },
} as const;

type StopKey = keyof typeof STOPS;

/** Expected boarders per physical stop — the fake demand history the rules use. */
const DEMAND: Partial<Record<StopKey, number>> = {
  royapettah_hospital: 6, woodlands: 8, express_avenue: 14,
  teynampet: 10, gemini: 7, church_park: 9,
  thousand_lights: 16, spencer_plaza: 12,
  lic: 15, shanthi: 11, orr_and_sons: 9,
  pallavan_salai: 6, mgr_central: 12, evening_bazaar: 5, broadway: 0,
};

interface RouteSpec {
  name: string;
  short: string;
  color: string;
  stops: StopKey[];
}

const ROUTES: RouteSpec[] = [
  {
    name: 'Royapettah → Broadway',
    short: 'Royapettah',
    color: '#4da3ff',
    stops: ['royapettah_hospital', 'woodlands', 'express_avenue', 'lic',
            'orr_and_sons', 'pallavan_salai', 'mgr_central', 'broadway'],
  },
  {
    name: 'Teynampet → Broadway',
    short: 'Teynampet',
    color: '#c07cff',
    stops: ['teynampet', 'thousand_lights', 'lic', 'shanthi', 'orr_and_sons',
            'pallavan_salai', 'mgr_central', 'evening_bazaar', 'broadway'],
  },
  {
    name: 'Gemini → Broadway',
    short: 'Gemini',
    color: '#ff9f43',
    stops: ['gemini', 'church_park', 'thousand_lights', 'spencer_plaza', 'lic',
            'shanthi', 'orr_and_sons', 'pallavan_salai', 'mgr_central',
            'evening_bazaar', 'broadway'],
  },
];

/*
 * One bus per route so every transfer in the demo is a genuine cross-route move
 * on the shared trunk. `progress` is chosen so all three are approaching L.I.C.
 * — the first stop all three routes have in common — within the same minute.
 */
const BUSES = [
  { code: '5c', route: 0, capacity: 50, progress: 0.30, onboard: 36 },
  { code: '18K', route: 1, capacity: 50, progress: 0.22, onboard: 31 },
  { code: '26', route: 2, capacity: 50, progress: 0.16, onboard: 18 },
];

// One end-to-end run is 30 sim-minutes; at SIM_SPEED=15 that is 2 real minutes.
const SPEED = 1 / 1800;

const NAMES = ['Arun','Divya','Karthik','Meena','Ravi','Priya','Suresh','Lakshmi','Vignesh',
  'Anitha','Bala','Deepa','Ganesh','Hema','Iniya','Jayanth','Kavya','Manoj','Nithya','Prakash',
  'Ramya','Saravanan','Tamil','Uma','Vasanth','Yamini','Ashwin','Bhavana','Chitra','Dinesh',
  'Elango','Fathima','Gokul','Harini','Ilango','Janani','Kumar','Latha','Mohan','Nandini',
  'Oviya','Pandian','Rajesh','Sneha','Thara','Udhaya','Varun','Waseem','Yuvan','Zara'];

async function osrm(keys: readonly StopKey[]): Promise<Coord[]> {
  const coords = keys.map((k) => `${STOPS[k].lng},${STOPS[k].lat}`).join(';');
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson&steps=false`;

  let payload: { code: string; routes: { geometry: { coordinates: Coord[] } }[] };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'busmesh' } });
    if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
    payload = await res.json();
  } catch (e) {
    // Some sandboxes block Node's fetch but not curl. Try curl before giving up.
    console.warn(`    fetch failed (${(e as Error).message}) — retrying via curl`);
    payload = JSON.parse(execFileSync('curl', ['-sS', '-m', '30', url], { encoding: 'utf8' }));
  }
  if (payload.code !== 'Ok') throw new Error(`OSRM: ${payload.code}`);
  return payload.routes[0].geometry.coordinates;
}

/** If OSRM is unreachable we still need geometry — densify the straight legs. */
function fallback(keys: readonly StopKey[]): Coord[] {
  console.warn('    OSRM unavailable — densified straight-line fallback');
  const line: Coord[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = STOPS[keys[i]], b = STOPS[keys[i + 1]];
    for (let k = 0; k < 40; k++) {
      const f = k / 40;
      line.push([a.lng + (b.lng - a.lng) * f, a.lat + (b.lat - a.lat) * f]);
    }
  }
  const last = STOPS[keys[keys.length - 1]];
  line.push([last.lng, last.lat]);
  return line;
}

await q(`TRUNCATE bus_events, directives, tickets, expected_boarders,
         bus_positions, buses, stops, routes RESTART IDENTITY CASCADE`);

const routeIds: number[] = [];
const stopRowByRoute: Record<number, Record<string, number>> = {};

for (const spec of ROUTES) {
  console.log(`\n${spec.name}`);
  let line: Coord[];
  try { line = await osrm(spec.stops); } catch (e) {
    console.warn(`    ${(e as Error).message}`);
    line = fallback(spec.stops);
  }
  const lengthM = routeLength(line);
  console.log(`    ${line.length} points · ${(lengthM / 1000).toFixed(1)} km`);

  const { rows: [route] } = await q<{ id: number }>(
    `INSERT INTO routes (name, short_name, color, line_string, length_m)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [spec.name, spec.short, spec.color, JSON.stringify(line), lengthM]
  );
  routeIds.push(route.id);
  stopRowByRoute[route.id] = {};

  for (let i = 0; i < spec.stops.length; i++) {
    const key = spec.stops[i];
    const stop = STOPS[key];
    // Snap onto the polyline so "has the bus arrived" is a scalar comparison.
    const progress = progressOf(line, stop.lat, stop.lng);
    const { rows: [row] } = await q<{ id: number }>(
      `INSERT INTO stops (route_id, stop_key, name, lat, lng, seq, progress)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [route.id, key, stop.name, stop.lat, stop.lng, i, progress]
    );
    stopRowByRoute[route.id][key] = row.id;
    await q('INSERT INTO expected_boarders (stop_id,count) VALUES ($1,$2)',
            [row.id, DEMAND[key] ?? 0]);
    console.log(`      ${String(i).padStart(2)} ${stop.name.padEnd(32)} ${progress.toFixed(3)}`);
  }
}

// Which physical stops are served by more than one route — the transfer points.
const { rows: shared } = await q<{ stop_key: string; name: string; n: number }>(
  `SELECT stop_key, min(name) AS name, count(DISTINCT route_id)::int AS n
   FROM stops GROUP BY stop_key HAVING count(DISTINCT route_id) > 1
   ORDER BY n DESC, stop_key`
);
console.log('\nshared transfer points:');
for (const s of shared) console.log(`    ${s.name.padEnd(32)} served by ${s.n} routes`);

console.log('');
let n = 0;
for (const b of BUSES) {
  const routeId = routeIds[b.route];
  const spec = ROUTES[b.route];
  const { rows: [bus] } = await q<{ id: number }>(
    'INSERT INTO buses (route_id,code,capacity) VALUES ($1,$2,$3) RETURNING id',
    [routeId, b.code, b.capacity]
  );
  const { rows: [route] } = await q<{ line_string: Coord[] }>(
    'SELECT line_string FROM routes WHERE id=$1', [routeId]
  );
  const pos = interpolate(route.line_string, b.progress);
  await q('INSERT INTO bus_positions (bus_id,lat,lng,progress,speed) VALUES ($1,$2,$3,$4,$5)',
          [bus.id, pos.lat, pos.lng, b.progress, SPEED]);

  // Seed riders already aboard. Most are headed for the shared trunk, which is
  // what makes them eligible to be moved onto another route's bus.
  const ahead = spec.stops.slice(1);
  const trunk = ahead.filter((k) => shared.some((s) => s.stop_key === k));
  for (let k = 0; k < b.onboard; k++) {
    // 70% ride into the shared trunk, the rest get off before it.
    const pool_ = (k % 10) < 7 && trunk.length ? trunk : ahead;
    const dest = pool_[(k + n) % pool_.length];
    await q(
      `INSERT INTO tickets (passenger_name,from_stop_id,to_stop_id,origin_bus_id,active_bus_id,status,boarded_at)
       VALUES ($1,$2,$3,$4,$4,'active',now())`,
      [`${NAMES[(k + n) % NAMES.length]} ${String.fromCharCode(65 + ((k + n) % 26))}.`,
       stopRowByRoute[routeId][spec.stops[0]], stopRowByRoute[routeId][dest], bus.id]
    );
    n++;
  }
  console.log(`  bus ${b.code} on ${spec.short.padEnd(11)} progress ${b.progress} · ${b.onboard}/${b.capacity}`);
}

const { rows: occ } = await q('SELECT code, onboard, capacity, pct FROM occupancy ORDER BY code');
console.table(occ);
await pool.end();
console.log('seed complete — run `npm run dev` and `npm run sim`');
