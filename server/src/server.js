// Local / self-hosted entry point: same app as the Vercel function,
// plus static file serving and the WebSocket hub for live updates.
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const { MemoryStore } = require("./store");
const { seed } = require("./seed");
const { buildApp } = require("./app");

const PORT = process.env.PORT || 4000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { PgStore } = require("./pgStore");
    const store = new PgStore(process.env.DATABASE_URL);
    await store.init();
    if (process.env.SEED === "true") await seed(store);
    return store;
  }
  const store = new MemoryStore();
  await seed(store);
  return store;
}

// ---------- WebSocket hub ----------
const channels = new Map(); // channel -> Set<ws>
function broadcast(channel, event) {
  const subs = channels.get(channel);
  if (!subs) return;
  const msg = JSON.stringify(event);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
function broadcastAll(event) {
  broadcast("waiter", event);
  broadcast("kitchen", event);
  broadcast("admin", event);
  if (event.tableId) broadcast(`table:${event.tableId}`, event);
  if (event.sessionId) broadcast(`session:${event.sessionId}`, event);
  if (event.requestId) broadcast(`request:${event.requestId}`, event);
}

async function main() {
  const store = await initStore();
  const app = buildApp(store, broadcastAll);

  // Serve the built React PWA in production.
  const clientDist = path.join(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
    res.sendFile(path.join(clientDist, "index.html"), (err) => err && next());
  });

  const server = app.listen(PORT, () => {
    console.log(`QR ordering server on :${PORT} (db=${process.env.DATABASE_URL ? "postgres" : "memory"})`);
    console.log(`Public URL: ${PUBLIC_URL}`);
  });

  const wss = new WebSocket.Server({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "subscribe" && typeof msg.channel === "string") {
          if (!channels.has(msg.channel)) channels.set(msg.channel, new Set());
          channels.get(msg.channel).add(ws);
          ws.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
        }
      } catch { /* ignore malformed frames */ }
    });
    ws.on("close", () => {
      for (const subs of channels.values()) subs.delete(ws);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
