# TableOrder — QR Table Ordering System

A web-based restaurant ordering system. **No app download required** — guests
scan a QR code (or tap NFC) with their phone camera and order from the mobile
browser. Real-time updates run over WebSockets. The stack is **React (Vite) +
Node.js (Express + ws) + PostgreSQL** (or the zero-config in-memory store).

**Live demo (free Vercel hosting): https://prosohotel.vercel.app** (project domain, added 2026-10-30; the older tableorder-infantjerome12-2920.vercel.app address still works too)
— open it on a phone, pick a demo table, and tap through the whole flow.

> **Free-tier limitation, read this:** Vercel's free serverless functions
> do not share memory, so each function instance keeps its own copy of
> the demo state. One person tapping through the flow sequentially works
> (verified end to end on the live site), but if several people use it
> at once, requests can land on different instances and a session or
> order can appear to vanish. **The permanent fix is a free Postgres
> database:** set `DATABASE_URL` (Neon or Supabase free tier) on the
> project and redeploy — the app then uses `pgStore.js` (same interface,
> shared state) and the problem goes away entirely. Until then, treat
> the live link as a demo, not a production restaurant system. No code
> change is needed for the upgrade, only the env var.

## Quick start (demo, 2 minutes)

```bash
cd qr-order/server && npm install
cd ../client && npm install && npm run build
cd ../server && PUBLIC_URL=http://localhost:4000 PORT=4000 npm start
```

Open http://localhost:4000 — the home page lists demo tables (simulated QR
scans). For development with hot reload, run the client separately:

```bash
cd client && npm run dev   # http://localhost:5173 (proxies /api and /ws)
```

## The guest flow

1. **Scan** — the printed table QR points to `https://your-domain/t/<qrToken>`
   (NFC tags can carry the same URL).
2. **Request to order** — the guest taps the button. This only creates a
   *pending request*. It grants nothing by itself.
3. **Waiter approves** — the request appears live on the waiter tablet
   (`/waiter`). The waiter physically checks the table, then approves.
   Approval creates the session and a **one-time 4-digit access code**,
   shown to the guest (and the waiter).
4. **Friends join** — they scan the same QR and enter the code on the page
   that appears after scanning.
5. **Order** — everyone at the table browses the menu, adds to cart, and
   sends orders straight to the kitchen display (`/kitchen`), with live
   status updates (received → preparing → ready → served).
6. **Pay at table** — the bill totals the session's orders. Payment goes
   through the configured provider; on success the session closes, the
   access code dies. The table's QR code itself NEVER expires — it is
   printed and stuck on the table, so it works bill after bill. The
   next guests scan the same QR and get a fresh code.

## The 5 security layers

| # | Requirement | How it is implemented |
|---|-------------|----------------------|
| 1 | **Shared-link protection** | A QR link alone can only *request*. Ordering requires an approved session, and approval requires the waiter to physically see guests at the table. If someone shares the link remotely, the waiter sees the request, finds an empty table, and denies it with the first-class reason `empty_table` (the guest sees exactly that explanation). |
| 2 | **Code-guessing protection** | Wrong codes are counted server-side per table. After **3** wrong attempts the table locks for **10 minutes** (HTTP 423). Even the right code is refused while locked. The waiter can unlock it after verifying in person. |
| 3 | **Permanent QR, one-time code** | A table's QR token never rotates on payment — printed QRs must keep working. What dies with the session is the 4-digit access code and the guest tokens (401 after close), so an old code can never join a new session. Only an admin can rotate a QR manually from `/admin` (“New QR”), e.g. if a printed code is damaged; that retired token then returns HTTP 410. |
| 4 | **Payment security** | All pages are served over HTTPS in production (HSTS header + HTTP→HTTPS redirect behind the TLS terminator). Checkout happens on the provider's hosted page (Stripe Checkout / Razorpay Checkout). **Card details never touch this server and are never stored** — only the provider's payment reference and status are kept (see `bills` table). |
| 5 | **Location-spoofing protection** | There is **no GPS, no geofencing, no location code anywhere** in the app — nothing to spoof. Physical waiter approval is the only trust mechanism, by design. |

## Pages

| Route | Who | What |
|---|---|---|
| `/` | Guest | How it works + demo table links |
| `/t/:qrToken` | Guest | Request to order / join with code |
| `/menu` | Guest | Menu, cart, live orders, bill, pay |
| `/waiter` | Staff | Approve/deny requests, unlock tables |
| `/kitchen` | Staff | Live kitchen display, order status flow |
| `/admin` | Staff | Menu CRUD, printable table QR codes, orders |
| `/pay/return` | Guest | Payment confirmation landing page |

## QR code generation

- Server-side: `GET /api/admin/tables/:id/qr.png` renders a PNG with the
  `qrcode` package for the URL `${PUBLIC_URL}/t/<qrToken}`. The Admin page
  shows every table's QR ready to print.
- QR content is just the table URL — the token is a random 128-bit value,
  not a guessable table number. Rotating the token (after payment, or from
  Admin) invalidates every previously printed QR for that table.
- NFC: program an NFC tag with the same URL and it behaves identically.

## Real-time updates (WebSockets)

`GET /ws` (WebSocket). Clients subscribe with
`{"type":"subscribe","channel":"waiter"|"kitchen"|"admin"|"table:<id>"|"session:<id>"|"request:<id>"}`.
The server broadcasts `request_created`, `request_approved`,
`request_denied`, `table_locked`, `table_unlocked`, `order_created`,
`order_status`, `menu_updated`, and `bill_paid`. The API itself stays
REST; WebSockets are purely for live push (clients also poll as a fallback).

## API reference (key endpoints)

```
GET    /api/tables/by-token/:token      resolve a scanned QR (410 only if admin-rotated)
POST   /api/calls                       guest calls the waiter (guest token)
GET    /api/waiter/calls                open waiter calls
POST   /api/waiter/calls/:id/dismiss    waiter dismisses a call
GET    /api/waiter/sessions             active sessions with codes + guest counts
POST   /api/waiter/tables/:id/close-session  waiter ends a session without payment
POST   /api/tables/by-token/:token/request   guest requests to order
GET    /api/requests/:id/result         requester polls approval + code
POST   /api/waiter/requests/:id/approve waiter approves -> session + code
POST   /api/waiter/requests/:id/deny    { reason: empty_table|occupied|other }
POST   /api/tables/:id/join             { code, name } (423 when locked)
GET    /api/menu
POST   /api/orders                      x-guest-token required
GET    /api/sessions/:id/orders         x-guest-token required
GET    /api/kitchen/orders
PATCH  /api/kitchen/orders/:id          { status } (validated transitions)
GET    /api/sessions/:id/bill
POST   /api/sessions/:id/pay            creates provider payment
POST   /api/payments/:ref/confirm       provider return / webhook confirm
GET    /api/admin/tables                tables + QR URLs + lock state
GET    /api/admin/tables/:id/qr.png     printable QR PNG
POST   /api/admin/tables/:id/regenerate-qr
GET|POST|PATCH|DELETE /api/admin/menu  menu management
```

## Database

- **Zero-config demo:** no database needed — the server uses an in-memory
  store (data resets on restart).
- **PostgreSQL / Supabase:** run `schema.sql` once
  (`psql "$DATABASE_URL" -f schema.sql`, or paste it into the Supabase SQL
  editor), then start with `DATABASE_URL=... SEED=true`. The server
  automatically switches to the Postgres adapter (`server/src/pgStore.js`),
  which implements the same store interface.
- Schema: `tables`, `table_sessions`, `join_requests`, `guests`,
  `menu_items`, `orders`, `bills`. See `schema.sql` for the full DDL.

## Payments (Stripe / Razorpay)

Set `PAYMENT_PROVIDER` (default `mock`, for demos only):

- **Stripe:** `PAYMENT_PROVIDER=stripe`, `npm i stripe`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. The drop-in code is in
  `server/src/payments.js` — it creates a Stripe Checkout session and
  confirms via webhook signature verification.
- **Razorpay:** `PAYMENT_PROVIDER=razorpay`, `npm i razorpay`,
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. Same file: creates a Razorpay
  order, pays in Razorpay Checkout, signature verified server-side.
- In both cases the guest pays on the provider's page; this server only
  records `provider_ref` + `status`. Never add card fields to this app.

## Hosting on Vercel (free)

The `vercel/` directory is the deployable unit: `api/` holds the same
Express app as a serverless function (no WebSocket — the client polls
every 3 s as a fallback), the built client is served as static files,
and `vercel.json` rewrites `/api/*` to the function. The client uses
hash routing (`/#/menu`, `/#/t/<token>`), so no SPA fallback rewrite is
needed, and React is loaded from a CDN import map so the app's own
bundle stays small. A fresh deploy resets the in-memory demo state
(new seed, new QR tokens).

## Hosting with SSL (production)

The app is one Node process serving the API and the built React PWA, so it
deploys anywhere Node runs:

```bash
# Example: Render / Fly.io / Railway / any VPS
PUBLIC_URL=https://order.your-restaurant.com NODE_ENV=production \
  DATABASE_URL=postgres://... PAYMENT_PROVIDER=stripe npm start
```

- Put a TLS terminator in front (the platform's automatic SSL, Cloudflare,
  or Caddy). The server already sends HSTS and redirects HTTP → HTTPS when
  `NODE_ENV=production` and the proxy reports `x-forwarded-proto`.
- Set `PUBLIC_URL` to the public HTTPS origin — QR codes encode it.
- **Before going live:** put `/waiter`, `/kitchen`, and `/admin` behind
  staff authentication (the demo leaves them open for testing), add rate
  limiting on `/join` and `/request` at the edge, and switch off the mock
  payment provider.

## Project layout

```
qr-order/
  README.md
  schema.sql
  server/
    src/server.js      Express API + WebSocket hub + security rules
    src/store.js       in-memory store (default)
    src/pgStore.js     PostgreSQL adapter (DATABASE_URL)
    src/seed.js        demo restaurant: 8 tables + 27 menu items (incl. Indian kitchen)
    src/payments.js    provider abstraction (mock/stripe/razorpay)
  client/
    src/pages/         Home, TableGate, Menu, Waiter, Kitchen, Admin, PayReturn
    src/api.js         fetch wrapper + WebSocket hook + session helpers
    public/            PWA manifest + service worker (app shell cached, API live)
```

## Verified

`tests/e2e.js` (40 checks, 2026-10-30) exercised the full flow against
the running server: request → approve → code → friend joins → 3 wrong
codes lock the table → waiter unlocks → waiter sessions + codes →
guest calls waiter → call dismissed → order with kitchen note + guest
name → kitchen sees it live over WebSocket → status transitions
validated → bill → pay → confirm → SAME QR still works after payment
(fresh request succeeds) → only a manual admin rotation retires a QR
(410) → old guest token returns 401 → empty-table denial → waiter
closes a session without payment. All 40 checks passed locally.

## Features (2026-10-30 release)

- **Permanent QR codes**: a table's QR never expires on payment; it
  works bill after bill. Only a manual Admin rotation retires one.
- **Mobile app view**: guest menu is a bottom-tabbed app screen
  (Menu / Orders / Bill), fixed tab bar with safe-area insets,
  touch-sized buttons, standalone PWA display + Install button.
- **Call waiter**: guests send a message from the menu; waiters see
  and dismiss calls on their tablet.
- **Order notes**: a per-item note ("no onions") travels to the kitchen.
- **Guest names on orders**: the kitchen sees who ordered what.
- **Waiter session control**: active sessions with codes + guest
  counts, and closing a session without payment.
- **Print receipt**: the Bill tab prints a clean receipt only.
- **Indian kitchen**: 15 Indian dishes (Butter Chicken, Biryanis,
  Masala Dosa, Naans, Gulab Jamun, Mango Lassi, Masala Chai, Filter
  Coffee) alongside the original menu. Prices in ₹ throughout.
