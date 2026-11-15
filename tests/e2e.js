// End-to-end test of the QR ordering flow (memory adapter).
// Usage: BASE=http://localhost:4000 node tests/e2e.js
const WebSocket = require("../server/node_modules/ws");
const BASE = (process.env.BASE || "http://localhost:4000") + "/api";

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    method: opts.method || "GET",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const assert = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); console.log("ok -", msg); };

(async () => {
  const tables = (await api("/admin/tables")).data.tables;
  assert(tables.length === 8, "8 demo tables");
  const t1 = tables[0], t2 = tables[1];

  const menu = (await api("/menu")).data.items;
  assert(menu.length === 27, "27 menu items (incl. Indian dishes)");
  assert(menu.some((i) => i.name === "Butter Chicken"), "Indian dishes on the menu (Butter Chicken)");

  const req1 = await api(`/tables/by-token/${t1.qrToken}/request`, { method: "POST" });
  assert(req1.status === 201 && req1.data.request.status === "pending", "request created (pending)");

  const appr = await api(`/waiter/requests/${req1.data.request.id}/approve`, { method: "POST" });
  assert(appr.status === 200 && /^\d{4}$/.test(appr.data.code), "approval issues 4-digit code: " + appr.data.code);
  const code1 = appr.data.code;

  const result = await api(`/requests/${req1.data.request.id}/result`);
  assert(result.data.status === "approved" && result.data.code === code1 && result.data.guestToken, "requester gets code + guest token");

  const join = await api(`/tables/${t1.id}/join`, { method: "POST", body: { code: code1, name: "Friend" } });
  assert(join.status === 200 && join.data.guestToken, "friend joins with code");

  const req2 = await api(`/tables/by-token/${t2.qrToken}/request`, { method: "POST" });
  const appr2 = await api(`/waiter/requests/${req2.data.request.id}/approve`, { method: "POST" });
  assert(appr2.status === 200, "table 2 approved");
  for (let i = 1; i <= 3; i++) {
    const bad = await api(`/tables/${t2.id}/join`, { method: "POST", body: { code: "0000" } });
    if (i < 3) assert(bad.status === 401 && bad.data.attemptsLeft === 3 - i, `wrong code ${i} -> attempts left ${3 - i}`);
    else assert(bad.status === 423 && bad.data.error === "table_locked", "3rd wrong code locks table (423)");
  }
  const lockedJoin = await api(`/tables/${t2.id}/join`, { method: "POST", body: { code: appr2.data.code } });
  assert(lockedJoin.status === 423, "even the right code is refused while locked");
  const unlock = await api(`/waiter/tables/${t2.id}/unlock`, { method: "POST" });
  assert(unlock.status === 200, "waiter unlocks table");
  const join2 = await api(`/tables/${t2.id}/join`, { method: "POST", body: { code: appr2.data.code } });
  assert(join2.status === 200, "right code works after unlock");

  // Waiter sees active sessions with their codes.
  const sessions = (await api("/waiter/sessions")).data.sessions;
  assert(sessions.some((s) => s.tableId === t1.id && s.code === code1), "waiter sees table 1 session + code");

  // Call waiter flow.
  const call = await api("/calls", {
    method: "POST",
    headers: { "x-guest-token": join2.data.guestToken },
    body: { message: "Extra napkins please" },
  });
  assert(call.status === 201 && call.data.call.tableId === t2.id, "guest calls waiter");
  const calls = (await api("/waiter/calls")).data.calls;
  assert(calls.some((c) => c.id === call.data.call.id && c.message === "Extra napkins please"), "waiter sees the call");
  const dismiss = await api(`/waiter/calls/${call.data.call.id}/dismiss`, { method: "POST" });
  assert(dismiss.status === 200, "waiter dismisses the call");
  const callsAfter = (await api("/waiter/calls")).data.calls;
  assert(!callsAfter.some((c) => c.id === call.data.call.id), "dismissed call leaves the open list");

  const wsEvents = [];
  let ws = null, wsOk = false;
  try {
    ws = new WebSocket((process.env.BASE || "http://localhost:4000").replace("http", "ws") + "/ws");
    await new Promise((r) => { ws.on("open", () => { wsOk = true; r(); }); ws.on("error", r); });
    ws.send(JSON.stringify({ type: "subscribe", channel: "kitchen" }));
    ws.on("message", (m) => wsEvents.push(JSON.parse(m)));
    await new Promise((r) => setTimeout(r, 300));
  } catch { /* WS unavailable on serverless: skip live check */ }
  // Item 3 = Margherita ₹299, item 10 = Fresh Lemonade ₹129.
  const order = await api("/orders", {
    method: "POST",
    headers: { "x-guest-token": join.data.guestToken },
    body: { items: [{ id: 3, qty: 1, note: "no onions" }, { id: 10, qty: 2 }] },
  });
  assert(order.status === 201 && order.data.order.totalCents === 29900 + 2 * 12900, "order placed, total correct (₹557)");
  assert(order.data.order.items[0].note === "no onions", "order note stored");
  assert(order.data.order.guestName === "Friend", "order carries guest name");
  if (ws && wsOk) {
    await new Promise((r) => setTimeout(r, 500));
    assert(wsEvents.some((e) => e.type === "order_created"), "kitchen got order_created via WebSocket");
  }
  const kitchen = await api("/kitchen/orders");
  const kitchenOrder = kitchen.data.orders.find((o) => o.id === order.data.order.id);
  assert(kitchenOrder && kitchenOrder.items[0].note === "no onions", "order + note visible on kitchen display");
  const adv = await api(`/kitchen/orders/${order.data.order.id}`, { method: "PATCH", body: { status: "preparing" } });
  assert(adv.data.order.status === "preparing", "kitchen advances order to preparing");
  const badTransition = await api(`/kitchen/orders/${order.data.order.id}`, { method: "PATCH", body: { status: "served" } });
  assert(badTransition.status === 400, "invalid status jump rejected");

  const bill = await api(`/sessions/${join.data.sessionId}/bill`, { headers: { "x-guest-token": join.data.guestToken } });
  assert(bill.data.totalCents === 55700, "bill total matches orders (₹557)");
  const pay = await api(`/sessions/${join.data.sessionId}/pay`, { method: "POST", headers: { "x-guest-token": join.data.guestToken } });
  assert(pay.status === 200 && pay.data.bill.providerRef, "payment created via provider");
  const confirm = await api(`/payments/${pay.data.bill.providerRef}/confirm`, { method: "POST" });
  assert(confirm.data.bill.status === "paid", "payment confirmed");

  // QR codes NEVER expire on payment now: the same printed QR must
  // still resolve and accept a fresh request for the next guests.
  const sameQr = await api(`/tables/by-token/${t1.qrToken}`);
  assert(sameQr.status === 200, "QR still works after payment (no expiry)");
  const freshReq = await api(`/tables/by-token/${t1.qrToken}/request`, { method: "POST" });
  assert(freshReq.status === 201, "fresh request on the same QR after payment");
  await api(`/waiter/requests/${freshReq.data.request.id}/deny`, { method: "POST", body: { reason: "other" } });

  // Only a MANUAL admin rotation retires a QR token.
  const regen = await api(`/admin/tables/${t1.id}/regenerate-qr`, { method: "POST" });
  assert(regen.status === 200 && regen.data.table.qrToken !== t1.qrToken, "admin manually rotates QR");
  const rotatedQr = await api(`/tables/by-token/${t1.qrToken}`);
  assert(rotatedQr.status === 410 && rotatedQr.data.error === "qr_expired", "manually rotated QR returns 410");
  const newQr = await api(`/tables/by-token/${regen.data.table.qrToken}`);
  assert(newQr.status === 200, "new QR token resolves");

  const deadGuest = await api("/orders", {
    method: "POST",
    headers: { "x-guest-token": join.data.guestToken },
    body: { items: [{ id: 3, qty: 1 }] },
  });
  assert(deadGuest.status === 401, "old guest token refused after session closed");
  const qrPng = await fetch(`${process.env.BASE || "http://localhost:4000"}/api/admin/tables/${t1.id}/qr.png`);
  assert(qrPng.status === 200 && qrPng.headers.get("content-type") === "image/png", "QR PNG generates");

  const tablesAfter = (await api("/admin/tables")).data.tables;
  const t3 = tablesAfter[2];
  const req3 = await api(`/tables/by-token/${t3.qrToken}/request`, { method: "POST" });
  const deny = await api(`/waiter/requests/${req3.data.request.id}/deny`, { method: "POST", body: { reason: "empty_table" } });
  assert(deny.data.request.status === "denied" && deny.data.request.reason === "empty_table", "waiter denies with empty_table reason");
  const res3 = await api(`/requests/${req3.data.request.id}/result`);
  assert(res3.data.status === "denied" && res3.data.reason === "empty_table", "requester sees empty-table denial");

  // Waiter can close a session without payment (guests left).
  const close = await api(`/waiter/tables/${t2.id}/close-session`, { method: "POST" });
  assert(close.status === 200, "waiter closes table 2 session");
  const deadGuest2 = await api("/orders", {
    method: "POST",
    headers: { "x-guest-token": join2.data.guestToken },
    body: { items: [{ id: 3, qty: 1 }] },
  });
  assert(deadGuest2.status === 401, "guest token refused after waiter closed session");

  if (ws) { try { ws.close(); } catch {} }
  console.log("\nALL QR ORDER TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
