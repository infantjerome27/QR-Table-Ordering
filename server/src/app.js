// QR Table Ordering — API + WebSocket server.
//
// Flow: scan QR -> "Request to order" -> waiter approves (physically
// verifying someone sits at the table) -> 4-digit one-time code is
// issued -> friends join with the code -> orders -> kitchen display
// -> pay at table -> session closes, code dies. The table's QR code
// itself NEVER expires: it is printed and stuck on the table, so it
// must work bill after bill. A fresh code per session plus waiter
// approval is what keeps a reused QR safe.
//
// Security layers (see README for the full write-up):
//  1. Shared link: a QR link alone can only REQUEST. Ordering requires
//     an approved session. The waiter denies with reason "empty_table"
//     when nobody is physically at the table.
//  2. Code guessing: 3 wrong codes lock the table for 10 minutes.
//  3. Permanent QR, one-time code: the QR token never rotates on
//     payment (an admin can still rotate it manually from Admin if a
//     printed code is compromised). The 4-digit access code dies with
//     its session, so an old code can never join a new session.
//  4. Payments: HTTPS enforced (HSTS + redirect behind a TLS proxy);
//     checkout happens on the provider's page; no card data is stored.
//  5. No GPS: location is never used. Waiter approval is the only
//     trust mechanism.
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const { newToken } = require("./store");
const { createPayment } = require("./payments");

const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || "mock";

// Public base URL for QR codes and payment return links. Explicit
// PUBLIC_URL wins; otherwise it is derived from the incoming request,
// which is what makes the same build work on localhost and on Vercel.
function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

async function genCode(store) {
  const taken = await store.activeCodes();
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (taken.has(code));
  return code;
}

function deviceLabel(req) {
  const ua = req.headers["user-agent"] || "";
  const mobile = /mobile|android|iphone/i.test(ua) ? "Phone" : "Desktop";
  return `${mobile} · ${req.ip}`;
}


function buildApp(store, broadcastAll) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json());

  // HTTPS enforcement: behind a TLS terminator (Render/Fly/Cloudflare/
  // Caddy) the proxy sets x-forwarded-proto. Refuse plain HTTP in prod.
  app.use((req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (process.env.NODE_ENV === "production" && req.protocol !== "https") {
      return res.redirect(301, `https://${req.get("host")}${req.originalUrl}`);
    }
    next();
  });

  const api = express.Router();

  api.get("/health", async (req, res) => res.json({ ok: true, provider: PAYMENT_PROVIDER }));

  // Resolve a scanned QR token. 410 = replaced by the admin (manual
  // rotation only — paying a bill never expires a QR code).
  api.get("/tables/by-token/:token", async (req, res) => {
    const table = await store.getTableByToken(req.params.token);
    if (!table) return res.status(410).json({ error: "qr_expired", message: "This QR code was replaced by the restaurant. Please scan the fresh QR code on the table." });
    const session = await store.getActiveSessionByTable(table.id);
    res.json({
      table: { id: table.id, number: table.number, label: table.label },
      locked: store.isLocked(table),
      lockedUntil: table.lockedUntil,
      hasActiveSession: !!session,
      pendingRequest: (await store.listPendingRequests()).some((r) => r.tableId === table.id),
    });
  });

  // Guest taps "Request to order". Creates a pending request for the
  // waiter. Ordering is impossible until the waiter approves.
  api.post("/tables/by-token/:token/request", async (req, res) => {
    const table = await store.getTableByToken(req.params.token);
    if (!table) return res.status(410).json({ error: "qr_expired", message: "This QR code was replaced by the restaurant. Please scan the fresh QR code on the table." });
    if (store.isLocked(table)) return res.status(423).json({ error: "table_locked", lockedUntil: table.lockedUntil });
    if (await store.getActiveSessionByTable(table.id)) {
      return res.json({ needsCode: true, tableId: table.id });
    }
    const existing = (await store.listPendingRequests()).find((r) => r.tableId === table.id);
    if (existing) return res.json({ request: existing });
    const request = await store.createRequest(table.id, deviceLabel(req));
    broadcastAll({ type: "request_created", tableId: table.id, request });
    res.status(201).json({ request });
  });

  api.get("/requests/:id", async (req, res) => {
    const r = await store.getRequest(req.params.id);
    if (!r) return res.status(404).json({ error: "not_found" });
    res.json({ request: r });
  });

  // The requester polls this after tapping "Request to order". Once
  // approved it hands them their guest token and the shareable code.
  api.get("/requests/:id/result", async (req, res) => {
    const r = await store.getRequest(req.params.id);
    if (!r) return res.status(404).json({ error: "not_found" });
    if (r.status === "pending") return res.json({ status: "pending" });
    if (r.status === "denied") return res.json({ status: "denied", reason: r.reason });
    const session = await store.getActiveSessionByTable(r.tableId);
    if (!session) return res.json({ status: "denied", reason: "other" });
    res.json({ status: "approved", code: session.code, guestToken: r.hostGuestToken, sessionId: session.id, tableId: r.tableId });
  });

  api.get("/waiter/requests", async (req, res) => {
    res.json({ requests: await store.listPendingRequests() });
  });

  // Waiter approves AFTER physically checking the table. This is the
  // only trust mechanism: no GPS, no location check.
  api.post("/waiter/requests/:id/approve", async (req, res) => {
    const r = await store.getRequest(req.params.id);
    if (!r || r.status !== "pending") return res.status(404).json({ error: "not_found" });
    const session = await store.createSession(r.tableId, await genCode(store));
    // The requester is the first guest; the code is shown to them so
    // they can share it with friends at the table.
    const guest = await store.createGuest(session.id, r.tableId, "Table host");
    r.status = "approved";
    r.hostGuestToken = guest.token;
    await store.updateRequest(r);
    await store.resetCodeAttempts(await store.getTable(r.tableId));
    broadcastAll({ type: "request_approved", tableId: r.tableId, requestId: r.id, sessionId: session.id });
    res.json({ session: { id: session.id, tableId: session.tableId }, code: session.code, guestToken: guest.token });
  });

  // Waiter denies. Reason "empty_table" is the shared-link defence:
  // someone opened the link remotely, the table is physically empty.
  api.post("/waiter/requests/:id/deny", async (req, res) => {
    const r = await store.getRequest(req.params.id);
    if (!r || r.status !== "pending") return res.status(404).json({ error: "not_found" });
    const reason = ["empty_table", "occupied", "other"].includes(req.body.reason) ? req.body.reason : "other";
    r.status = "denied";
    r.reason = reason;
    await store.updateRequest(r);
    broadcastAll({ type: "request_denied", tableId: r.tableId, requestId: r.id, reason });
    res.json({ request: r });
  });

  api.post("/waiter/tables/:id/unlock", async (req, res) => {
    const table = await store.getTable(req.params.id);
    if (!table) return res.status(404).json({ error: "not_found" });
    await store.resetCodeAttempts(table);
    broadcastAll({ type: "table_unlocked", tableId: table.id });
    res.json({ table: { id: table.id, number: table.number, locked: false } });
  });

  // Friends join an approved table with the 4-digit code.
  api.post("/tables/:id/join", async (req, res) => {
    const table = await store.getTable(req.params.id);
    if (!table) return res.status(404).json({ error: "not_found" });
    if (store.isLocked(table)) {
      return res.status(423).json({ error: "table_locked", lockedUntil: table.lockedUntil, message: "Too many wrong codes. This table is locked for 10 minutes. Ask your waiter to unlock it." });
    }
    const session = await store.getActiveSessionByTable(table.id);
    if (!session) return res.status(409).json({ error: "no_session", message: "No approved session for this table yet. Tap 'Request to order' and ask your waiter to approve it." });
    const code = String(req.body.code || "").trim();
    if (code !== session.code) {
      const updated = await store.recordBadCode(table);
      const attemptsLeft = Math.max(0, 3 - (updated.codeAttempts || 0));
      if (store.isLocked(updated)) {
        broadcastAll({ type: "table_locked", tableId: table.id, lockedUntil: updated.lockedUntil });
        return res.status(423).json({ error: "table_locked", lockedUntil: updated.lockedUntil, message: "Too many wrong codes. This table is locked for 10 minutes." });
      }
      return res.status(401).json({ error: "bad_code", attemptsLeft, message: `Wrong code. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before the table locks.` });
    }
    await store.resetCodeAttempts(table);
    const guest = await store.createGuest(session.id, table.id, req.body.name);
    res.json({ guestToken: guest.token, sessionId: session.id, tableId: table.id });
  });

  // ---- menu & orders (guest token required, session must be active) ----
  async function requireGuest(req, res, next) {
    const guest = await store.getGuest(req.headers["x-guest-token"]);
    if (!guest) return res.status(401).json({ error: "invalid_session", message: "Your table session has ended. Please scan the QR code again." });
    req.guest = guest;
    next();
  }

  api.get("/menu", async (req, res) => res.json({ items: await store.listMenu() }));

  api.post("/orders", requireGuest, async (req, res) => {
    const items = [];
    let total = 0;
    for (const line of req.body.items || []) {
      const item = await store.getMenuItem(line.id);
      if (!item || !item.available) return res.status(400).json({ error: "item_unavailable", id: line.id });
      const qty = Math.max(1, Math.min(20, Number(line.qty) || 1));
      const note = String(line.note || "").trim().slice(0, 200);
      items.push({ id: item.id, name: item.name, qty, priceCents: item.priceCents, ...(note ? { note } : {}) });
      total += item.priceCents * qty;
    }
    if (!items.length) return res.status(400).json({ error: "empty_order" });
    const order = await store.createOrder({
      sessionId: req.guest.sessionId,
      tableId: req.guest.tableId,
      guestName: req.guest.name || "Guest",
      items,
      totalCents: total,
      status: "received",
    });
    broadcastAll({ type: "order_created", tableId: order.tableId, sessionId: order.sessionId, order });
    res.status(201).json({ order });
  });

  api.get("/sessions/:id/orders", requireGuest, async (req, res) => {
    if (req.guest.sessionId !== req.params.id) return res.status(403).json({ error: "forbidden" });
    res.json({ orders: await store.listOrdersBySession(req.params.id) });
  });

  // ---- call waiter (guest asks for assistance) ----
  api.post("/calls", requireGuest, async (req, res) => {
    const message = String(req.body.message || "").trim().slice(0, 200);
    const call = await store.createCall({
      tableId: req.guest.tableId,
      sessionId: req.guest.sessionId,
      guestName: req.guest.name || "Guest",
      message,
    });
    broadcastAll({ type: "call_created", tableId: call.tableId, call });
    res.status(201).json({ call });
  });
  api.get("/waiter/calls", async (req, res) => {
    res.json({ calls: await store.listOpenCalls() });
  });
  api.post("/waiter/calls/:id/dismiss", async (req, res) => {
    const call = await store.dismissCall(req.params.id);
    if (!call) return res.status(404).json({ error: "not_found" });
    broadcastAll({ type: "call_dismissed", tableId: call.tableId });
    res.json({ call });
  });

  // ---- waiter session management ----
  api.get("/waiter/sessions", async (req, res) => {
    const sessions = await store.listActiveSessions();
    const out = [];
    for (const s of sessions) {
      const guests = await store.listGuestsBySession(s.id);
      out.push({ ...s, guestCount: guests.length, guests: guests.map((g) => g.name) });
    }
    res.json({ sessions: out });
  });
  // Waiter ends a session without payment (guests left, table to reset).
  // Guest tokens die; the table's QR code stays exactly the same.
  api.post("/waiter/tables/:id/close-session", async (req, res) => {
    const session = await store.getActiveSessionByTable(Number(req.params.id));
    if (!session) return res.status(404).json({ error: "no_active_session" });
    await store.closeSession(session.id);
    broadcastAll({ type: "session_closed", tableId: session.tableId, sessionId: session.id });
    res.json({ ok: true, sessionId: session.id });
  });

  api.get("/kitchen/orders", async (req, res) => res.json({ orders: await store.listActiveOrders() }));

  api.patch("/kitchen/orders/:id", async (req, res) => {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });
    const next = req.body.status;
    const allowed = { received: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["served", "cancelled"] };
    if (!allowed[order.status]?.includes(next)) {
      return res.status(400).json({ error: "bad_transition", from: order.status, to: next });
    }
    order.status = next;
    await store.updateOrder(order);
    broadcastAll({ type: "order_status", tableId: order.tableId, sessionId: order.sessionId, order });
    res.json({ order });
  });

  // ---- pay at table ----
  api.get("/sessions/:id/bill", requireGuest, async (req, res) => {
    if (req.guest.sessionId !== req.params.id) return res.status(403).json({ error: "forbidden" });
    const orders = (await store.listOrdersBySession(req.params.id)).filter((o) => o.status !== "cancelled");
    const total = orders.reduce((s, o) => s + o.totalCents, 0);
    const bill = await store.getBillBySession(req.params.id);
    res.json({ orders, totalCents: total, bill });
  });

  api.post("/sessions/:id/pay", requireGuest, async (req, res) => {
    if (req.guest.sessionId !== req.params.id) return res.status(403).json({ error: "forbidden" });
    const orders = (await store.listOrdersBySession(req.params.id)).filter((o) => o.status !== "cancelled");
    const total = orders.reduce((s, o) => s + o.totalCents, 0);
    if (total <= 0) return res.status(400).json({ error: "empty_bill" });
    const existing = await store.getBillBySession(req.params.id);
    if (existing && existing.status === "paid") return res.json({ bill: existing });
    const billId = `bill_${req.params.id}`;
    const payment = createPayment(PAYMENT_PROVIDER, {
      billId,
      amountCents: total,
      returnUrl: `${getBaseUrl(req)}/#/pay/return`,
    });
    const bill = await store.upsertBill({
      sessionId: req.params.id,
      tableId: req.guest.tableId,
      totalCents: total,
      provider: PAYMENT_PROVIDER,
      providerRef: payment.providerRef,
      status: "unpaid",
    });
    res.json({ bill, checkoutUrl: payment.checkoutUrl });
  });

  // Simulates the provider redirecting back (mock) / webhook confirm.
  // Real providers: confirm via webhook signature in payments.js.
  api.post("/payments/:ref/confirm", async (req, res) => {
    const bill = await store.getBillByRef(req.params.ref);
    if (!bill) return res.status(404).json({ error: "not_found" });
    if (bill.status === "paid") return res.json({ bill });
    bill.status = "paid";
    await store.upsertBill(bill);
    // The access code dies with its session, but the table's QR code
    // NEVER rotates on payment: it is printed on the table and must
    // work for the next guests. Only an admin manual rotation (Admin
    // page) ever changes a QR token.
    const session = await store.getSession(bill.sessionId);
    if (session) await store.closeSession(session.id);
    const table = await store.getTable(bill.tableId);
    if (table) {
      table.status = "free";
      await store.updateTable(table);
    }
    broadcastAll({ type: "bill_paid", tableId: bill.tableId, sessionId: bill.sessionId });
    res.json({ bill, message: "Payment confirmed. The table session is closed. The QR code stays the same for the next guests." });
  });

  // ---- admin ----
  api.get("/admin/tables", async (req, res) => {
    const tables = await store.listTables();
    const out = [];
    for (const t of tables) {
      out.push({
        ...t,
        qrUrl: `${getBaseUrl(req)}/#/t/${t.qrToken}`,
        hasActiveSession: !!(await store.getActiveSessionByTable(t.id)),
        locked: store.isLocked(t),
      });
    }
    res.json({ tables: out });
  });

  api.get("/admin/tables/:id/qr.png", async (req, res) => {
    const table = await store.getTable(req.params.id);
    if (!table) return res.status(404).json({ error: "not_found" });
    const png = await QRCode.toBuffer(`${getBaseUrl(req)}/#/t/${table.qrToken}`, { width: 512, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  });

  api.post("/admin/tables/:id/regenerate-qr", async (req, res) => {
    const table = await store.getTable(req.params.id);
    if (!table) return res.status(404).json({ error: "not_found" });
    table.qrToken = newToken();
    await store.updateTable(table);
    res.json({ table: { ...table, qrUrl: `${getBaseUrl(req)}/#/t/${table.qrToken}` } });
  });

  api.get("/admin/orders", async (req, res) => res.json({ orders: await store.listAllOrders() }));

  api.post("/admin/menu", async (req, res) => {
    const item = await store.createMenuItem(req.body);
    broadcastAll({ type: "menu_updated", items: await store.listMenu() });
    res.status(201).json({ item });
  });
  api.patch("/admin/menu/:id", async (req, res) => {
    if (!await store.getMenuItem(req.params.id)) return res.status(404).json({ error: "not_found" });
    const item = await store.updateMenuItem(req.params.id, req.body);
    broadcastAll({ type: "menu_updated", items: await store.listMenu() });
    res.json({ item });
  });
  api.delete("/admin/menu/:id", async (req, res) => {
    await store.deleteMenuItem(req.params.id);
    broadcastAll({ type: "menu_updated", items: await store.listMenu() });
    res.json({ ok: true });
  });

  app.use("/api", api);

  return app;
}

module.exports = { buildApp };
