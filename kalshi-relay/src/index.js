// Kalshi official-index relay.
// Holds one signed connection to Kalshi's CF Benchmarks value feed (the index Kalshi's crypto
// markets settle on) and passes the values to the Live Walls Chart app over a plain WebSocket.
// The Kalshi key never leaves Cloudflare; apps authenticate with RELAY_CODE.
import { DurableObject } from "cloudflare:workers";

const KEEP_SEC = 2 * 3600;          // per-second history kept for each index
const BACKLOG_SEC = 20 * 60;         // history sent to an app when it connects

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return stub.fetch(req);
    }
    if (url.pathname === "/status") return stub.fetch(req);
    return new Response("Kalshi relay is running. Connect the app to /ws.\n", { headers: { "content-type": "text/plain" } });
  },
};

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.up = null;                 // upstream Kalshi socket
    this.upState = "idle";
    this.upError = "";
    this.hist = new Map();          // index id -> [[sec, value]]
    this.last = new Map();          // index id -> latest message for apps
    this.connecting = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    await this.ensureUpstream();
    if (url.pathname === "/status") {
      const ages = {};
      for (const [id, m] of this.last) ages[id] = Math.round((Date.now() - m.ts) / 1000) + "s ago";
      return json({ upstream: this.upState, error: this.upError || undefined, latest: ages, apps: this.ctx.getWebSockets().length });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ ok: false, ids: [] });
    // drop sockets that never send the access code
    setTimeout(() => { try { const a = pair[1].deserializeAttachment(); if (!a || !a.ok) pair[1].close(4001, "no access code"); } catch {} }, 8000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (!a.ok) {
      if (!this.env.RELAY_CODE || m.auth !== this.env.RELAY_CODE) { ws.send(JSON.stringify({ t: "error", error: "wrong access code" })); ws.close(4003, "wrong access code"); return; }
      const ids = Array.isArray(m.ids) && m.ids.length ? m.ids.map(String) : this.indices();
      ws.serializeAttachment({ ok: true, ids });
      ws.send(JSON.stringify({ t: "status", upstream: this.upState, error: this.upError || undefined }));
      const since = Math.floor(Date.now() / 1000) - BACKLOG_SEC;
      for (const id of ids) {
        const h = (this.hist.get(id) || []).filter(p => p[0] >= since);
        if (h.length) ws.send(JSON.stringify({ t: "hist", id, pts: h }));
        if (this.last.has(id)) ws.send(JSON.stringify(this.last.get(id)));
      }
      return;
    }
    if (m.ping) ws.send(JSON.stringify({ t: "pong" }));
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {} }
  webSocketError() {}

  indices() { return String(this.env.INDICES || "BRTI").split(",").map(s => s.trim()).filter(Boolean); }

  broadcast(obj, id) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.ok && (!id || a.ids.includes(id))) { try { ws.send(s); } catch {} }
    }
  }
  setState(state, err = "") {
    this.upState = state; this.upError = err;
    this.broadcast({ t: "status", upstream: state, error: err || undefined });
  }

  // keep the upstream connection alive; the alarm re-checks every 30 s
  async alarm() { await this.ensureUpstream(); }
  async ensureUpstream() {
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    if (this.up || this.connecting) return this.connecting;
    this.connecting = this.connectUpstream().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async connectUpstream() {
    const env = this.env;
    if (!env.KALSHI_KEY_ID || !env.KALSHI_PRIVATE_KEY) { this.setState("error", "KALSHI_KEY_ID or KALSHI_PRIVATE_KEY secret is missing"); return; }
    this.setState("connecting");
    try {
      const wsUrl = new URL(env.KALSHI_WS_URL);
      const headers = await kalshiHeaders(env.KALSHI_KEY_ID, env.KALSHI_PRIVATE_KEY, "GET", wsUrl.pathname);
      const resp = await fetch(wsUrl.toString(), { headers: { ...headers, Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) {
        let body = ""; try { body = (await resp.text()).slice(0, 200); } catch {}
        throw new Error(`Kalshi refused the connection (HTTP ${resp.status}) ${body}`);
      }
      ws.accept();
      this.up = ws;
      ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["cfbenchmarks_value"], index_ids: this.indices() } }));
      ws.addEventListener("message", e => this.onUpstream(e.data));
      const drop = reason => { if (this.up === ws) { this.up = null; this.setState("reconnecting", reason); } };
      ws.addEventListener("close", e => drop(`Kalshi closed the feed (${e.code}${e.reason ? " " + e.reason : ""})`));
      ws.addEventListener("error", () => drop("Kalshi feed error"));
      this.setState("connected");
    } catch (err) {
      this.up = null;
      this.setState("error", String(err && err.message || err));
    }
  }
  onUpstream(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "error") { this.setState("error", `Kalshi: ${m.msg && (m.msg.msg || m.msg.code) || JSON.stringify(m.msg)}`); return; }
    if (m.type !== "cfbenchmarks_value" || !m.msg) return;
    const x = m.msg, id = x.index_id;
    let frame = x.data; if (typeof frame === "string") { try { frame = JSON.parse(frame); } catch { frame = null; } }
    const v = num(frame && (frame.value ?? frame.v ?? frame.price));
    const ts = num(frame && frame.time) || x.received_at || Date.now();
    if (v == null) return;
    const out = { t: "v", id, ts, v, a60: num(x.avg_60s_data && x.avg_60s_data.value) };
    const q = x.last_60s_windowed_average_15min;
    if (q && num(q.value) != null) out.q15 = { v: num(q.value), start: q.window_start_ts_ms, end: q.window_end_ts_exclusive };
    this.last.set(id, out);
    const sec = Math.floor(ts / 1000);
    let h = this.hist.get(id); if (!h) this.hist.set(id, h = []);
    if (!h.length || h[h.length - 1][0] !== sec) h.push([sec, v]); else h[h.length - 1][1] = v;
    while (h.length && h[0][0] < sec - KEEP_SEC) h.shift();
    if (this.upState !== "connected") this.setState("connected");
    this.broadcast(out, id);
  }
}

function num(x) { const n = typeof x === "string" ? parseFloat(x) : x; return typeof n === "number" && isFinite(n) ? n : null; }
function json(o) { return new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } }); }

// ---------------- Kalshi request signing ----------------
// Signature = base64( sign(timestamp_ms + METHOD + path) ) with RSA-PSS/SHA-256 (salt 32) or Ed25519.
let keyCache = null;
async function kalshiHeaders(keyId, pem, method, path) {
  if (!keyCache || keyCache.pem !== pem) keyCache = { pem, key: await importKalshiKey(pem) };
  const ts = String(Date.now());
  const data = new TextEncoder().encode(ts + method + path);
  const k = keyCache.key;
  const sig = k.algorithm.name === "Ed25519"
    ? await crypto.subtle.sign("Ed25519", k, data)
    : await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, data);
  return { "KALSHI-ACCESS-KEY": keyId.trim(), "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": b64(sig) };
}
export async function importKalshiKey(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
  let der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  if (isPkcs1) der = pkcs1ToPkcs8(der);
  try { return await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]); }
  catch (e) {
    try { return await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]); }
    catch { throw new Error("Could not read KALSHI_PRIVATE_KEY (paste the whole key file, including the BEGIN/END lines)"); }
  }
}
// Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo so WebCrypto can import it.
export function pkcs1ToPkcs8(pkcs1) {
  const len = n => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  const tlv = (tag, bytes) => [tag, ...len(bytes.length), ...bytes];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL
  const inner = [0x02, 0x01, 0x00, ...algId, ...tlv(0x04, [...pkcs1])];
  return new Uint8Array(tlv(0x30, inner));
}
function b64(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
