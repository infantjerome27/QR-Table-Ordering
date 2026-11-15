import { useEffect, useRef } from "react";

export async function api(path, { method = "GET", body, guest = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (guest) {
    const token = localStorage.getItem("qo_guest_token");
    if (token) headers["x-guest-token"] = token;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Prices are stored in paise; format as whole rupees when exact.
export function money(cents) {
  const rupees = cents / 100;
  return `₹${Number.isInteger(rupees) ? rupees : rupees.toFixed(2)}`;
}

export function saveSession({ guestToken, sessionId, tableId, code }) {
  if (guestToken) localStorage.setItem("qo_guest_token", guestToken);
  if (sessionId) localStorage.setItem("qo_session_id", sessionId);
  if (tableId) localStorage.setItem("qo_table_id", String(tableId));
  if (code) localStorage.setItem("qo_code", code);
}

export function clearSession() {
  ["qo_guest_token", "qo_session_id", "qo_table_id", "qo_code"].forEach((k) =>
    localStorage.removeItem(k)
  );
}

export function getSession() {
  return {
    guestToken: localStorage.getItem("qo_guest_token"),
    sessionId: localStorage.getItem("qo_session_id"),
    tableId: localStorage.getItem("qo_table_id"),
    code: localStorage.getItem("qo_code"),
  };
}

// Subscribe to a WebSocket channel; reconnects automatically.
// onEvent receives parsed server events for that channel.
// If the socket can never open (e.g. a serverless host with no /ws),
// stop after 3 failed attempts instead of retrying forever — the
// pages already poll every 3s, so nothing is lost.
export function useWs(channel, onEvent) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!channel) return undefined;
    let ws;
    let closed = false;
    let timer;
    let failures = 0;
    let everOpened = false;
    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => {
        everOpened = true;
        failures = 0;
        ws.send(JSON.stringify({ type: "subscribe", channel }));
      };
      ws.onmessage = (e) => {
        try {
          cb.current(JSON.parse(e.data));
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (closed) return;
        if (!everOpened) {
          failures += 1;
          if (failures >= 3) return; // no socket here; polling covers it
        }
        timer = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws && ws.close();
    };
  }, [channel]);
}
