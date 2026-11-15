// Storage interface. The default adapter is in-memory (zero-config demo).
// When DATABASE_URL is set, server.js uses pgStore.js instead, which
// implements exactly the same methods on PostgreSQL (incl. Supabase).
const crypto = require("crypto");

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

class MemoryStore {
  constructor() {
    this.tables = new Map();
    this.sessions = new Map();
    this.requests = new Map();
    this.guests = new Map(); // guestToken -> guest
    this.menu = new Map();
    this.orders = new Map();
    this.bills = new Map(); // sessionId -> bill
    this.calls = new Map(); // waiter-assistance calls
    this.nextRequest = 1;
    this.nextOrder = 1;
    this.nextCall = 1;
  }

  // ---- tables ----
  listTables() {
    return [...this.tables.values()];
  }
  getTable(id) {
    return this.tables.get(Number(id)) || null;
  }
  getTableByToken(token) {
    return [...this.tables.values()].find((t) => t.qrToken === token) || null;
  }
  upsertTable(table) {
    this.tables.set(table.id, table);
    return table;
  }
  updateTable(table) {
    this.tables.set(table.id, table);
    return table;
  }

  // ---- join requests (waiter approval) ----
  createRequest(tableId, deviceLabel) {
    const req = {
      id: this.nextRequest++,
      tableId,
      deviceLabel,
      status: "pending",
      reason: null,
      createdAt: new Date().toISOString(),
    };
    this.requests.set(req.id, req);
    return req;
  }
  getRequest(id) {
    return this.requests.get(Number(id)) || null;
  }
  listPendingRequests() {
    return [...this.requests.values()].filter((r) => r.status === "pending");
  }
  updateRequest(req) {
    this.requests.set(req.id, req);
    return req;
  }

  // ---- sessions + access codes ----
  createSession(tableId, code) {
    const s = {
      id: newToken().slice(0, 12),
      tableId,
      code,
      status: "active",
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    this.sessions.set(s.id, s);
    return s;
  }
  getSession(id) {
    return this.sessions.get(id) || null;
  }
  getActiveSessionByTable(tableId) {
    return (
      [...this.sessions.values()].find(
        (s) => s.tableId === tableId && s.status === "active"
      ) || null
    );
  }
  closeSession(id) {
    const s = this.sessions.get(id);
    if (s) {
      s.status = "closed";
      s.closedAt = new Date().toISOString();
    }
    return s;
  }
  activeCodes() {
    return new Set(
      [...this.sessions.values()]
        .filter((s) => s.status === "active")
        .map((s) => s.code)
    );
  }

  // ---- guests ----
  createGuest(sessionId, tableId, name) {
    const g = {
      token: newToken(),
      sessionId,
      tableId,
      name: name || "Guest",
      joinedAt: new Date().toISOString(),
    };
    this.guests.set(g.token, g);
    return g;
  }
  getGuest(token) {
    const g = this.guests.get(token) || null;
    if (!g) return null;
    const s = this.sessions.get(g.sessionId);
    if (!s || s.status !== "active") return null; // code/session expired
    return g;
  }

  // ---- code-guessing lockout ----
  recordBadCode(table) {
    table.codeAttempts = (table.codeAttempts || 0) + 1;
    if (table.codeAttempts >= 3) {
      table.lockedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    }
    this.tables.set(table.id, table);
    return table;
  }
  resetCodeAttempts(table) {
    table.codeAttempts = 0;
    table.lockedUntil = null;
    this.tables.set(table.id, table);
    return table;
  }
  isLocked(table) {
    return !!table.lockedUntil && new Date(table.lockedUntil) > new Date();
  }

  // ---- menu ----
  listMenu() {
    return [...this.menu.values()].sort((a, b) => a.id - b.id);
  }
  getMenuItem(id) {
    return this.menu.get(Number(id)) || null;
  }
  createMenuItem(data) {
    const id = Math.max(0, ...this.menu.keys()) + 1;
    const item = { id, available: true, ...data };
    this.menu.set(id, item);
    return item;
  }
  updateMenuItem(id, data) {
    const item = { ...this.menu.get(Number(id)), ...data };
    this.menu.set(Number(id), item);
    return item;
  }
  deleteMenuItem(id) {
    return this.menu.delete(Number(id));
  }

  // ---- orders ----
  createOrder(order) {
    order.id = this.nextOrder++;
    order.createdAt = new Date().toISOString();
    this.orders.set(order.id, order);
    return order;
  }
  getOrder(id) {
    return this.orders.get(Number(id)) || null;
  }
  listOrdersBySession(sessionId) {
    return [...this.orders.values()]
      .filter((o) => o.sessionId === sessionId)
      .sort((a, b) => b.id - a.id);
  }
  listActiveOrders() {
    return [...this.orders.values()]
      .filter((o) => !["served", "cancelled"].includes(o.status))
      .sort((a, b) => a.id - b.id);
  }
  updateOrder(order) {
    this.orders.set(order.id, order);
    return order;
  }
  listAllOrders() {
    return [...this.orders.values()].sort((a, b) => b.id - a.id);
  }

  // ---- waiter-assistance calls ----
  createCall(call) {
    call.id = this.nextCall++;
    call.status = "open";
    call.createdAt = new Date().toISOString();
    this.calls.set(call.id, call);
    return call;
  }
  listOpenCalls() {
    return [...this.calls.values()]
      .filter((c) => c.status === "open")
      .sort((a, b) => a.id - b.id);
  }
  dismissCall(id) {
    const c = this.calls.get(Number(id));
    if (c) c.status = "dismissed";
    return c;
  }

  // ---- sessions (waiter view) ----
  listActiveSessions() {
    return [...this.sessions.values()]
      .filter((s) => s.status === "active")
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  listGuestsBySession(sessionId) {
    return [...this.guests.values()].filter((g) => g.sessionId === sessionId);
  }

  // ---- bills ----
  getBillBySession(sessionId) {
    return this.bills.get(sessionId) || null;
  }
  upsertBill(bill) {
    this.bills.set(bill.sessionId, bill);
    return bill;
  }
  getBillByRef(ref) {
    return [...this.bills.values()].find((b) => b.providerRef === ref) || null;
  }
}

module.exports = { MemoryStore, newToken };
