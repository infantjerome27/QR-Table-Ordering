-- QR Table Ordering — PostgreSQL schema (also works on Supabase).
-- Run once:  psql "$DATABASE_URL" -f schema.sql
-- or paste into the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS tables (
  id            INTEGER PRIMARY KEY,
  number        INTEGER NOT NULL,
  label         TEXT NOT NULL,
  qr_token      TEXT NOT NULL UNIQUE,   -- printed QR points at /t/<qr_token>
  status        TEXT NOT NULL DEFAULT 'free',
  code_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id         TEXT PRIMARY KEY,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  code       CHAR(4) NOT NULL,          -- one-time 4-digit access code
  status     TEXT NOT NULL DEFAULT 'active',  -- active | closed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_table_active
  ON table_sessions (table_id, status);

CREATE TABLE IF NOT EXISTS join_requests (
  id           SERIAL PRIMARY KEY,
  table_id     INTEGER NOT NULL REFERENCES tables(id),
  device_label TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  reason       TEXT,                    -- empty_table | occupied | other
  host_token   TEXT,                    -- guest token issued to the requester on approval
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guests (
  token      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  name       TEXT,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  category    TEXT NOT NULL,
  image_url   TEXT,
  available   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES table_sessions(id),
  table_id    INTEGER NOT NULL REFERENCES tables(id),
  guest_name  TEXT,                    -- who placed the order
  items       JSONB NOT NULL,           -- [{id, name, qty, priceCents, note?}]
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received', -- received|preparing|ready|served|cancelled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders (session_id);
-- For databases created from an older schema revision:
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_name TEXT;

CREATE TABLE IF NOT EXISTS calls (
  id          SERIAL PRIMARY KEY,
  table_id    INTEGER NOT NULL REFERENCES tables(id),
  session_id  TEXT NOT NULL REFERENCES table_sessions(id),
  guest_name  TEXT,
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open', -- open | dismissed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calls_open ON calls (status);

CREATE TABLE IF NOT EXISTS bills (
  session_id  TEXT PRIMARY KEY REFERENCES table_sessions(id),
  table_id    INTEGER NOT NULL REFERENCES tables(id),
  total_cents INTEGER NOT NULL,
  provider    TEXT NOT NULL,            -- mock | stripe | razorpay
  provider_ref TEXT NOT NULL UNIQUE,    -- provider's payment id; NEVER card data
  status      TEXT NOT NULL DEFAULT 'unpaid'  -- unpaid | paid
);

-- One active session per table is enforced in the app layer (a table's
-- new request is blocked while a session is active), which keeps the
-- rule visible in code rather than hidden in a partial unique index.
