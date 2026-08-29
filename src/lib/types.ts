/** Shared domain types. The DB is the source of truth; these mirror it. */

export type TicketStatus = 'pending' | 'active' | 'completed' | 'expired' | 'cancelled';
export type DirectiveStatus = 'pending' | 'accepted' | 'done' | 'expired';
export type EndReason = 'destination' | 'ttl' | 'safety_cap' | 'terminus' | null;

/** [lng, lat] — GeoJSON order, as returned by OSRM. */
export type Coord = [number, number];

export interface Route {
  id: number;
  name: string;
  short_name: string;
  color: string;
  line_string: Coord[];
  length_m: number;
}

export interface Stop {
  id: number;
  route_id: number;
  /** Slug shared by every route serving this physical stop — the transfer key. */
  stop_key: string;
  name: string;
  lat: number;
  lng: number;
  seq: number;
  /** 0..1 along the route polyline, snapped at seed time. */
  progress: number;
  expected?: number;
}

export interface BusLive {
  id: number;
  code: string;
  capacity: number;
  route_id: number;
  route_short: string;
  route_color: string;
  lat: number;
  lng: number;
  progress: number;
  dwell_until: string | null;
  at_stop_id: number | null;
  at_stop_name: string | null;
  at_stop_key: string | null;
  /** Directive this bus is standing still for, waiting on its transfer partner. */
  holding_for: number | null;
  last_stop_seq: number;
  onboard: number;
  /** 0..1 — onboard / capacity. */
  pct: number;
}

export interface Occupancy {
  bus_id: number;
  code: string;
  capacity: number;
  onboard: number;
  pct: number;
}

export interface Directive {
  id: number;
  source_bus_id: number;
  target_bus_id: number;
  source_code: string;
  target_code: string;
  /** The shared stop where the two buses meet and riders walk across. */
  transfer_stop_key: string;
  transfer_stop_name: string;
  /** True once both buses are standing at the transfer stop together. */
  both_present?: boolean;
  reason: string;
  status: DirectiveStatus;
  moved: number;
  suggested: number;
  expires_at: string;
  created_at: string;
}

export interface Ticket {
  id: number;
  passenger_name: string;
  from_stop_id: number;
  to_stop_id: number;
  origin_bus_id: number | null;
  active_bus_id: number | null;
  status: TicketStatus;
  transfers: number;
  created_at: string;
  boarded_at: string | null;
  ended_at: string | null;
  end_reason: EndReason;
  from_stop?: string;
  to_stop?: string;
  bus_code?: string | null;
  origin_code?: string | null;
}

export interface Rider {
  id: number;
  passenger_name: string;
  transfers: number;
  to_stop: string;
}

export interface BusEvent {
  id: number;
  bus_id: number;
  code: string;
  type: string;
  ticket_id: number | null;
  meta: { stop?: string; alighted?: number; terminus?: boolean } | null;
  created_at: string;
}

export interface SimConfig {
  simSpeed: number;
  tickMs: number;
  pendingTtl: number;
  window: number;
  threshold: number;
  arriveEps: number;
  dwellMs: number;
  /** How long a bus holds at a transfer stop waiting for its partner. */
  rendezvousMs: number;
  safetyCapH: number;
  roomPct: number;
}

/** One payload that paints any screen on first load. */
export interface FullState {
  /** All three corridor routes — they overlap, and the overlap is the product. */
  routes: Route[];
  stops: Stop[];
  buses: BusLive[];
  directives: Directive[];
  tickets: Ticket[];
  config: SimConfig;
}

export interface BusView {
  bus: Pick<BusLive,
    'id' | 'code' | 'capacity' | 'progress' | 'at_stop_id' | 'at_stop_name'
    | 'at_stop_key' | 'holding_for' | 'onboard' | 'pct' | 'route_short' | 'route_color'>;
  riders: Rider[];
  /** Directives where THIS bus is the target — the accept banner. */
  incoming: Directive[];
  /** Directives where THIS bus is the source — relief is coming. */
  outgoing: Directive[];
}

/** Realtime signal pushed over SSE. Carries a kind, never a data dump. */
export interface TickMessage {
  kind: 'positions' | 'tickets' | 'directive' | 'arrival' | 'rendezvous';
  tick?: number;
  bus?: string;
  stop?: string;
  alighted?: number;
  id?: number | string;
  boarded?: number;
}
