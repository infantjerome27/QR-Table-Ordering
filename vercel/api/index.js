// Vercel serverless entry point for the same Express app.
// No WebSocket here (serverless functions can't hold sockets) — the
// client polls every few seconds as a fallback, so live updates keep
// working. State lives in the function instance's memory store unless
// DATABASE_URL is set (then Postgres, via pgStore.js).
const { MemoryStore } = require("./store");
const { seed } = require("./seed");
const { buildApp } = require("./app");

let appPromise = null;
async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      let store;
      if (process.env.DATABASE_URL) {
        const { PgStore } = require("./pgStore");
        store = new PgStore(process.env.DATABASE_URL);
        await store.init();
        if (process.env.SEED === "true") await seed(store);
      } else {
        store = new MemoryStore();
        await seed(store);
      }
      return buildApp(store, () => {}); // no-op broadcast on serverless
    })();
    // A failed cold start (e.g. a transient database stall) must NOT
    // poison this instance forever: drop the rejected promise so the
    // next request retries init instead of failing instantly.
    appPromise.catch(() => { appPromise = null; });
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await getApp();
  app(req, res);
};
