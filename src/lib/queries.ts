import { q } from './db';
import { CFG } from './rules';
import type { BusLive, BusView, Directive, FullState, Rider, Route, Stop, Ticket } from './types';

// Read queries live here so the "one payload paints the whole screen" contract
// stays in one place rather than spread across route handlers.

export async function fullState(): Promise<FullState> {
  const [route, stops, buses, directives, tickets] = await Promise.all([
    q<Route>('SELECT id, name, short_name, color, line_string, length_m FROM routes ORDER BY id'),
    q<Stop>(`SELECT s.*, COALESCE(e.count,0) AS expected
       FROM stops s LEFT JOIN expected_boarders e ON e.stop_id=s.id ORDER BY s.seq`),
    q<BusLive>(`SELECT b.id, b.code, b.capacity, b.route_id,
              r.short_name AS route_short, r.color AS route_color,
              p.lat, p.lng, p.progress, p.dwell_until, p.at_stop_id, p.holding_for,
              p.last_stop_seq, o.onboard::int AS onboard, o.pct::float AS pct,
              st.name AS at_stop_name, st.stop_key AS at_stop_key
       FROM buses b
       JOIN routes r        ON r.id = b.route_id
       JOIN bus_positions p ON p.bus_id=b.id
       JOIN occupancy o     ON o.bus_id=b.id
       LEFT JOIN stops st   ON st.id=p.at_stop_id
       ORDER BY b.code`),
    q<Directive>(`SELECT d.*, sb.code AS source_code, tb.code AS target_code,
              (sp.holding_for = d.id AND tp.holding_for = d.id) AS both_present
       FROM directives d
       JOIN buses sb ON sb.id=d.source_bus_id
       JOIN buses tb ON tb.id=d.target_bus_id
       JOIN bus_positions sp ON sp.bus_id = sb.id
       JOIN bus_positions tp ON tp.bus_id = tb.id
       ORDER BY d.id DESC LIMIT 25`),
    q<Ticket>(`SELECT t.id, t.passenger_name, t.status, t.transfers, t.end_reason, t.created_at,
              f.name AS from_stop, tos.name AS to_stop, b.code AS bus_code, ob.code AS origin_code
       FROM tickets t
       LEFT JOIN stops f   ON f.id=t.from_stop_id
       LEFT JOIN stops tos ON tos.id=t.to_stop_id
       LEFT JOIN buses b   ON b.id=t.active_bus_id
       LEFT JOIN buses ob  ON ob.id=t.origin_bus_id
       ORDER BY t.id DESC LIMIT 60`),
  ]);

  return {
    routes: route.rows,
    stops: stops.rows,
    buses: buses.rows,
    directives: directives.rows,
    tickets: tickets.rows,
    config: CFG,
  };
}

export async function busView(code: string): Promise<BusView | null> {
  const { rows } = await q<BusView['bus']>(
    `SELECT b.id, b.code, b.capacity, p.progress, p.at_stop_id, p.holding_for,
            o.onboard::int AS onboard, o.pct::float AS pct,
            st.name AS at_stop_name, st.stop_key AS at_stop_key,
            r.short_name AS route_short, r.color AS route_color
     FROM buses b
     JOIN routes r        ON r.id = b.route_id
     JOIN bus_positions p ON p.bus_id=b.id
     JOIN occupancy o     ON o.bus_id=b.id
     LEFT JOIN stops st   ON st.id=p.at_stop_id
     WHERE b.code=$1`,
    [code]
  );
  const bus = rows[0];
  if (!bus) return null;

  const [riders, incoming, outgoing] = await Promise.all([
    q<Rider>(`SELECT t.id, t.passenger_name, t.transfers, s.name AS to_stop
       FROM tickets t JOIN stops s ON s.id=t.to_stop_id
       WHERE t.status='active' AND t.active_bus_id=$1 ORDER BY t.id DESC`, [bus.id]),
    q<Directive>(`SELECT d.*, sb.code AS source_code, tb.code AS target_code,
              (sp.holding_for = d.id AND tp.holding_for = d.id) AS both_present
       FROM directives d
       JOIN buses sb ON sb.id=d.source_bus_id JOIN buses tb ON tb.id=d.target_bus_id
       JOIN bus_positions sp ON sp.bus_id=sb.id JOIN bus_positions tp ON tp.bus_id=tb.id
       WHERE d.target_bus_id=$1 AND d.status IN ('pending','accepted') ORDER BY d.id DESC`, [bus.id]),
    q<Directive>(`SELECT d.*, sb.code AS source_code, tb.code AS target_code,
              (sp.holding_for = d.id AND tp.holding_for = d.id) AS both_present
       FROM directives d
       JOIN buses sb ON sb.id=d.source_bus_id JOIN buses tb ON tb.id=d.target_bus_id
       JOIN bus_positions sp ON sp.bus_id=sb.id JOIN bus_positions tp ON tp.bus_id=tb.id
       WHERE d.source_bus_id=$1 AND d.status IN ('pending','accepted') ORDER BY d.id DESC`, [bus.id]),
  ]);

  return { bus, riders: riders.rows, incoming: incoming.rows, outgoing: outgoing.rows };
}

export async function ticketView(id: number) {
  const { rows } = await q<Ticket>(
    `SELECT t.*, f.name AS from_stop, tos.name AS to_stop,
            b.code AS bus_code, ob.code AS origin_code
     FROM tickets t
     LEFT JOIN stops f   ON f.id=t.from_stop_id
     LEFT JOIN stops tos ON tos.id=t.to_stop_id
     LEFT JOIN buses b   ON b.id=t.active_bus_id
     LEFT JOIN buses ob  ON ob.id=t.origin_bus_id
     WHERE t.id=$1`,
    [id]
  );
  return rows[0] ?? null;
}
