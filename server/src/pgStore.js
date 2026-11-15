// PostgreSQL adapter implementing the same interface as MemoryStore.
// Use with DATABASE_URL (works with Supabase: paste the project's
// Postgres connection string). Schema lives in schema.sql — run it
// once before starting the server.
const { Pool } = require("pg");

const toTable = (r) => r && {
  id: r.id,
  number: r.number,
  label: r.label,
  qrToken: r.qr_token,
  status: r.status,
  codeAttempts: r.code_attempts,
  lockedUntil: r.locked_until ? new Date(r.locked_until).toISOString() : null,
};
const toSession = (r) => r && {
  id: r.id,
  tableId: r.table_id,
  code: r.code,
  status: r.status,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
};
const toRequest = (r) => r && {
  id: r.id,
  tableId: r.table_id,
  deviceLabel: r.device_label,
  status: r.status,
  reason: r.reason,
  hostGuestToken: r.host_token || null,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
};
const toItem = (r) => r && {
  id: r.id,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  category: r.category,
  imageUrl: r.image_url,
  available: r.available,
};
const toOrder = (r) => r && {
  id: r.id,
  sessionId: r.session_id,
  tableId: r.table_id,
  guestName: r.guest_name || null,
  items: r.items,
  totalCents: r.total_cents,
  status: r.status,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
};
const toCall = (r) => r && {
  id: r.id,
  tableId: r.table_id,
  sessionId: r.session_id,
  guestName: r.guest_name || null,
  message: r.message || "",
  status: r.status,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
};
const toBill = (r) => r && {
  sessionId: r.session_id,
  tableId: r.table_id,
  totalCents: r.total_cents,
  provider: r.provider,
  providerRef: r.provider_ref,
  status: r.status,
};

class PgStore {
  constructor(connectionString) {
    // Bound every wait: pg's defaults wait forever, which turned a
    // transient database stall into a hung function. 10s to connect
    // (covers a cold Neon compute waking) and 15s per statement mean
    // a stall fails fast with a 500 the client can show and retry,
    // instead of hanging until the host kills the function.
    this.pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });
  }
  async init() {
    await this.pool.query("SELECT 1");
  }

  async listTables() {
    const { rows } = await this.pool.query("SELECT * FROM tables ORDER BY number");
    return rows.map(toTable);
  }
  async getTable(id) {
    const { rows } = await this.pool.query("SELECT * FROM tables WHERE id=$1", [id]);
    return toTable(rows[0]);
  }
  async getTableByToken(token) {
    const { rows } = await this.pool.query("SELECT * FROM tables WHERE qr_token=$1", [token]);
    return toTable(rows[0]);
  }
  async upsertTable(t) {
    await this.pool.query(
      `INSERT INTO tables (id, number, label, qr_token, status, code_attempts, locked_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET number=EXCLUDED.number, label=EXCLUDED.label,
         qr_token=EXCLUDED.qr_token, status=EXCLUDED.status,
         code_attempts=EXCLUDED.code_attempts, locked_until=EXCLUDED.locked_until`,
      [t.id, t.number, t.label, t.qrToken, t.status || "free", t.codeAttempts || 0, t.lockedUntil]
    );
    return t;
  }
  async updateTable(t) {
    return this.upsertTable(t);
  }

  async createRequest(tableId, deviceLabel) {
    const { rows } = await this.pool.query(
      "INSERT INTO join_requests (table_id, device_label, status) VALUES ($1,$2,'pending') RETURNING *",
      [tableId, deviceLabel]
    );
    return toRequest(rows[0]);
  }
  async getRequest(id) {
    const { rows } = await this.pool.query("SELECT * FROM join_requests WHERE id=$1", [id]);
    return toRequest(rows[0]);
  }
  async listPendingRequests() {
    const { rows } = await this.pool.query("SELECT * FROM join_requests WHERE status='pending' ORDER BY id");
    return rows.map(toRequest);
  }
  async updateRequest(r) {
    await this.pool.query("UPDATE join_requests SET status=$2, reason=$3, host_token=$4 WHERE id=$1", [r.id, r.status, r.reason, r.hostGuestToken || null]);
    return r;
  }

  async createSession(tableId, code) {
    const id = require("crypto").randomBytes(6).toString("hex");
    const { rows } = await this.pool.query(
      "INSERT INTO table_sessions (id, table_id, code, status) VALUES ($1,$2,$3,'active') RETURNING *",
      [id, tableId, code]
    );
    return toSession(rows[0]);
  }
  async getSession(id) {
    const { rows } = await this.pool.query("SELECT * FROM table_sessions WHERE id=$1", [id]);
    return toSession(rows[0]);
  }
  async getActiveSessionByTable(tableId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM table_sessions WHERE table_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1",
      [tableId]
    );
    return toSession(rows[0]);
  }
  async closeSession(id) {
    const { rows } = await this.pool.query(
      "UPDATE table_sessions SET status='closed', closed_at=NOW() WHERE id=$1 RETURNING *", [id]
    );
    return toSession(rows[0]);
  }
  async activeCodes() {
    const { rows } = await this.pool.query("SELECT code FROM table_sessions WHERE status='active'");
    return new Set(rows.map((r) => r.code));
  }

  async createGuest(sessionId, tableId, name) {
    const token = require("crypto").randomBytes(16).toString("hex");
    await this.pool.query(
      "INSERT INTO guests (token, session_id, table_id, name) VALUES ($1,$2,$3,$4)",
      [token, sessionId, tableId, name || "Guest"]
    );
    return { token, sessionId, tableId, name: name || "Guest" };
  }
  async getGuest(token) {
    const { rows } = await this.pool.query(
      `SELECT g.* FROM guests g JOIN table_sessions s ON s.id=g.session_id
       WHERE g.token=$1 AND s.status='active'`, [token]
    );
    if (!rows[0]) return null;
    return { token: rows[0].token, sessionId: rows[0].session_id, tableId: rows[0].table_id, name: rows[0].name };
  }

  async recordBadCode(table) {
    const { rows } = await this.pool.query(
      `UPDATE tables SET code_attempts = code_attempts + 1,
        locked_until = CASE WHEN code_attempts + 1 >= 3 THEN NOW() + INTERVAL '10 minutes' ELSE locked_until END
       WHERE id=$1 RETURNING *`, [table.id]
    );
    return toTable(rows[0]);
  }
  async resetCodeAttempts(table) {
    const { rows } = await this.pool.query(
      "UPDATE tables SET code_attempts=0, locked_until=NULL WHERE id=$1 RETURNING *", [table.id]
    );
    return toTable(rows[0]);
  }
  isLocked(table) {
    return !!table.lockedUntil && new Date(table.lockedUntil) > new Date();
  }

  async listMenu() {
    const { rows } = await this.pool.query("SELECT * FROM menu_items ORDER BY id");
    return rows.map(toItem);
  }
  async getMenuItem(id) {
    const { rows } = await this.pool.query("SELECT * FROM menu_items WHERE id=$1", [id]);
    return toItem(rows[0]);
  }
  async createMenuItem(d) {
    const { rows } = await this.pool.query(
      "INSERT INTO menu_items (name, description, price_cents, category, image_url, available) VALUES ($1,$2,$3,$4,$5,COALESCE($6,true)) RETURNING *",
      [d.name, d.description, d.priceCents, d.category, d.imageUrl, d.available]
    );
    return toItem(rows[0]);
  }
  async updateMenuItem(id, d) {
    const cur = await this.getMenuItem(id);
    const next = { ...cur, ...d };
    const { rows } = await this.pool.query(
      "UPDATE menu_items SET name=$2, description=$3, price_cents=$4, category=$5, image_url=$6, available=$7 WHERE id=$1 RETURNING *",
      [id, next.name, next.description, next.priceCents, next.category, next.imageUrl, next.available]
    );
    return toItem(rows[0]);
  }
  async deleteMenuItem(id) {
    await this.pool.query("DELETE FROM menu_items WHERE id=$1", [id]);
    return true;
  }

  async createOrder(o) {
    const { rows } = await this.pool.query(
      "INSERT INTO orders (session_id, table_id, guest_name, items, total_cents, status) VALUES ($1,$2,$3,$4::jsonb,$5,'received') RETURNING *",
      [o.sessionId, o.tableId, o.guestName || null, JSON.stringify(o.items), o.totalCents]
    );
    return toOrder(rows[0]);
  }

  async createCall(c) {
    const { rows } = await this.pool.query(
      "INSERT INTO calls (table_id, session_id, guest_name, message, status) VALUES ($1,$2,$3,$4,'open') RETURNING *",
      [c.tableId, c.sessionId, c.guestName || null, c.message || ""]
    );
    return toCall(rows[0]);
  }
  async listOpenCalls() {
    const { rows } = await this.pool.query("SELECT * FROM calls WHERE status='open' ORDER BY id");
    return rows.map(toCall);
  }
  async dismissCall(id) {
    const { rows } = await this.pool.query("UPDATE calls SET status='dismissed' WHERE id=$1 RETURNING *", [id]);
    return toCall(rows[0]);
  }
  async listActiveSessions() {
    const { rows } = await this.pool.query("SELECT * FROM table_sessions WHERE status='active' ORDER BY created_at");
    return rows.map(toSession);
  }
  async listGuestsBySession(sessionId) {
    const { rows } = await this.pool.query("SELECT * FROM guests WHERE session_id=$1 ORDER BY joined_at", [sessionId]);
    return rows.map((r) => ({ token: r.token, sessionId: r.session_id, tableId: r.table_id, name: r.name }));
  }
  async getOrder(id) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    return toOrder(rows[0]);
  }
  async listOrdersBySession(sessionId) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE session_id=$1 ORDER BY id DESC", [sessionId]);
    return rows.map(toOrder);
  }
  async listActiveOrders() {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE status NOT IN ('served','cancelled') ORDER BY id");
    return rows.map(toOrder);
  }
  async updateOrder(o) {
    const { rows } = await this.pool.query("UPDATE orders SET status=$2 WHERE id=$1 RETURNING *", [o.id, o.status]);
    return toOrder(rows[0]);
  }
  async listAllOrders() {
    const { rows } = await this.pool.query("SELECT * FROM orders ORDER BY id DESC");
    return rows.map(toOrder);
  }

  async getBillBySession(sessionId) {
    const { rows } = await this.pool.query("SELECT * FROM bills WHERE session_id=$1", [sessionId]);
    return toBill(rows[0]);
  }
  async upsertBill(b) {
    const { rows } = await this.pool.query(
      `INSERT INTO bills (session_id, table_id, total_cents, provider, provider_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET total_cents=EXCLUDED.total_cents,
         provider=EXCLUDED.provider, provider_ref=EXCLUDED.provider_ref, status=EXCLUDED.status
       RETURNING *`,
      [b.sessionId, b.tableId, b.totalCents, b.provider, b.providerRef, b.status]
    );
    return toBill(rows[0]);
  }
  async getBillByRef(ref) {
    const { rows } = await this.pool.query("SELECT * FROM bills WHERE provider_ref=$1", [ref]);
    return toBill(rows[0]);
  }
}

module.exports = { PgStore };
