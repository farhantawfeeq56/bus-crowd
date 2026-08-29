-- BusMesh schema (local Postgres 16)
-- Realtime is Postgres LISTEN/NOTIFY -> SSE (see src/server.js), no Supabase.

DROP TABLE IF EXISTS bus_events, directives, tickets, expected_boarders,
                     bus_positions, buses, stops, routes CASCADE;
DROP TYPE IF EXISTS ticket_status, directive_status CASCADE;

CREATE TYPE ticket_status    AS ENUM ('pending','active','completed','expired','cancelled');
CREATE TYPE directive_status AS ENUM ('pending','accepted','done','expired');

CREATE TABLE routes (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,           -- 'Royapettah', 'Teynampet', 'Gemini'
  color       TEXT NOT NULL,           -- drawn on the dashboard map
  line_string JSONB NOT NULL,          -- [[lng,lat], ...] from OSRM
  length_m    DOUBLE PRECISION NOT NULL
);

-- A physical stop served by N routes is N rows here (one per route), sharing a
-- `stop_key`. That key is what makes cross-route transfers possible: "does the
-- other bus also serve this place?" is a stop_key comparison.
CREATE TABLE stops (
  id        SERIAL PRIMARY KEY,
  route_id  INT REFERENCES routes(id) ON DELETE CASCADE,
  stop_key  TEXT NOT NULL,             -- slug shared across routes, e.g. 'lic'
  name      TEXT NOT NULL,
  lat       DOUBLE PRECISION NOT NULL,
  lng       DOUBLE PRECISION NOT NULL,
  seq       INT NOT NULL,
  progress  DOUBLE PRECISION NOT NULL, -- 0..1 position along the route polyline
  UNIQUE (route_id, seq),
  UNIQUE (route_id, stop_key)
);
CREATE INDEX ON stops (stop_key);

CREATE TABLE buses (
  id        SERIAL PRIMARY KEY,
  route_id  INT REFERENCES routes(id) ON DELETE CASCADE,
  code      TEXT UNIQUE NOT NULL,      -- '5c','18K','26'
  capacity  INT NOT NULL DEFAULT 50
);

CREATE TABLE bus_positions (
  bus_id       INT PRIMARY KEY REFERENCES buses(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  progress     DOUBLE PRECISION NOT NULL DEFAULT 0,
  speed        DOUBLE PRECISION NOT NULL DEFAULT 0.0025, -- progress units / sim-second
  dwell_until  TIMESTAMPTZ,            -- set while boarding at a stop
  at_stop_id   INT REFERENCES stops(id),
  last_stop_seq INT NOT NULL DEFAULT -1,
  -- Set while this bus is holding at a transfer stop waiting for its partner,
  -- so the two are visibly standing together when riders walk across.
  holding_for  INT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE expected_boarders (
  id       SERIAL PRIMARY KEY,
  stop_id  INT REFERENCES stops(id) ON DELETE CASCADE,
  count    INT NOT NULL,               -- fake historical demand
  UNIQUE (stop_id)
);

CREATE TABLE tickets (
  id             SERIAL PRIMARY KEY,
  passenger_name TEXT NOT NULL,
  from_stop_id   INT REFERENCES stops(id),
  to_stop_id     INT REFERENCES stops(id),
  origin_bus_id  INT REFERENCES buses(id),
  active_bus_id  INT REFERENCES buses(id),
  status         ticket_status NOT NULL DEFAULT 'pending',
  transfers      INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  boarded_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  end_reason     TEXT                  -- 'destination' | 'ttl' | 'safety_cap' | 'terminus'
);
CREATE INDEX ON tickets (active_bus_id) WHERE status = 'active';
CREATE INDEX ON tickets (status);

CREATE TABLE directives (
  id             SERIAL PRIMARY KEY,
  source_bus_id  INT REFERENCES buses(id) ON DELETE CASCADE,
  target_bus_id  INT REFERENCES buses(id) ON DELETE CASCADE,
  -- Where the two buses meet. Riders only ever change bus standing at a stop.
  transfer_stop_key  TEXT NOT NULL,
  transfer_stop_name TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         directive_status NOT NULL DEFAULT 'pending',
  moved          INT NOT NULL DEFAULT 0,
  suggested      INT NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON directives (status);

-- Idempotent event log: (bus, type, ticket) can only ever happen once.
CREATE TABLE bus_events (
  id         SERIAL PRIMARY KEY,
  bus_id     INT REFERENCES buses(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,            -- board | alight | transfer_in | transfer_out | arrive | depart
  ticket_id  INT REFERENCES tickets(id) ON DELETE CASCADE,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bus_events_idem ON bus_events (bus_id, type, ticket_id)
  WHERE ticket_id IS NOT NULL;

-- Live occupancy in one query.
CREATE VIEW occupancy AS
SELECT b.id  AS bus_id,
       b.code,
       b.capacity,
       COUNT(t.id) FILTER (WHERE t.status = 'active') AS onboard,
       ROUND(COUNT(t.id) FILTER (WHERE t.status = 'active')::numeric
             / NULLIF(b.capacity,0), 4) AS pct
FROM buses b
LEFT JOIN tickets t ON t.active_bus_id = b.id AND t.status = 'active'
GROUP BY b.id, b.code, b.capacity;
