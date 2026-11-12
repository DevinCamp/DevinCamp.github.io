// Kalshi official-index relay + up/down push alerts.
// Holds one signed connection to Kalshi's CF Benchmarks value feed (the index Kalshi's crypto
// markets settle on) and passes the values to the Live Walls Chart app over a plain WebSocket.
// The Kalshi key never leaves Cloudflare; apps authenticate with RELAY_CODE.
import { DurableObject } from "cloudflare:workers";

const KEEP_SEC = 2 * 3600;          // per-second history kept for each index
const BACKLOG_SEC = 20 * 60;         // history sent to an app when it connects

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (err) { return json({ error: "relay error: " + String(err && err.message || err) }, 500); }
  },
};
async function route(req, env) {
  {
    const url = new URL(req.url);
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return stub.fetch(req);
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (["/status", "/vapid", "/subscribe", "/unsubscribe", "/signals", "/test-push", "/results"].includes(url.pathname)) return stub.fetch(req);
    return new Response("Kalshi relay is running. Connect the app to /ws.\n", { headers: { "content-type": "text/plain" } });
  }
}

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
    this.subs = null;               // push subscriptions (loaded from storage)
    this.sigState = new Map();      // "coin:sens" -> { ema, armed, last }
    this.sigErr = "";
  }

  async getSubs() {
    if (!this.subs) this.subs = new Map(await this.ctx.storage.list({ prefix: "sub:" }));
    return this.subs;
  }
  async vapid() {
    if (this.vk) return this.vk;
    let v = await this.ctx.storage.get("vapid");
    if (!v) {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      v = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
      await this.ctx.storage.put("vapid", v);
    }
    this.vk = { pub: v.pub, key: await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
    return this.vk;
  }

  // Same rules as the app: buyers vs sellers within ±0.25% of mid on Coinbase, smoothed; fire on a clear
  // takeover, re-arm when the book crosses back toward balance, 5-minute cooldown per direction.
  async signalTick() {
    const subs = await this.getSubs();
    const coins = new Map();
    for (const c of String(this.env.PRED_COINS || "BTC-USD").split(",").map(x => x.trim()).filter(Boolean)) coins.set(c, new Set());
    for (const r of subs.values()) { if (!coins.has(r.coin)) coins.set(r.coin, new Set()); coins.get(r.coin).add(r.sens); }
    const now = Math.floor(Date.now() / 1000);
    for (const [coin, senses] of coins) {
      const bk = await fetchBook(coin); if (!bk) continue;
      const ratio = bookRatio(bk.bids, bk.asks, bk.mid, SIG_BAND); if (ratio == null) continue;
      await this.recordPrediction(coin, ratio, now, bk.mid);
      for (const sens of senses) {
        const k = coin + ":" + sens; let st = this.sigState.get(k);
        if (!st) this.sigState.set(k, st = { ema: null, armed: { up: true, down: true }, last: { up: 0, down: 0 } });
        st.ema = st.ema == null ? ratio : st.ema + 0.4 * (ratio - st.ema);
        const e = st.ema, [UP, DN] = SIG_LEVELS[sens];
        if (e <= 0.5) st.armed.up = true;
        if (e >= 0.5) st.armed.down = true;
        let dir = null;
        if (e >= UP && st.armed.up && now - st.last.up > SIG_COOLDOWN) dir = "up";
        else if (e <= DN && st.armed.down && now - st.last.down > SIG_COOLDOWN) dir = "down";
        if (!dir) continue;
        st.armed[dir] = false; st.last[dir] = now;
        const m = { t: now, dir, price: bk.mid, pct: Math.round((dir === "up" ? e : 1 - e) * 100), src: "relay" };
        const hk = `sig:${coin}:${sens}`, hist = (await this.ctx.storage.get(hk)) || [];
        hist.push(m); await this.ctx.storage.put(hk, hist.filter(x => x.t > now - 2 * 86400).slice(-500));
        const up = dir === "up", baseSym = coin.split("-")[0];
        const msg = { title: `${up ? "▲ UP" : "▼ DOWN"} · ${baseSym} ${fmtUsd(bk.mid)}`, body: `${up ? "Buyers" : "Sellers"} took over: ${m.pct}% of orders within 0.25% of price are ${up ? "buy" : "sell"} orders.`, tag: "walls-" + coin };
        for (const [key, r] of subs) {
          if (r.coin !== coin || r.sens !== sens) continue;
          const res = await this.push(r, msg);
          if (res.status === 404 || res.status === 410) { subs.delete(key); await this.ctx.storage.delete(key); }
        }
      }
    }
  }
  // The app's "prediction" for a 15-min window = which side the order book leaned to (smoothed, ±0.25%)
  // at the start of the window's final minute, i.e. right before Kalshi's settlement averaging begins.
  async recordPrediction(coin, ratio, now, mid) {
    const k = "pred:" + coin; let st = this.predState && this.predState.get(k);
    if (!this.predState) this.predState = new Map();
    if (!st) this.predState.set(k, st = { ema: null });
    st.ema = st.ema == null ? ratio : st.ema + 0.4 * (ratio - st.ema);
    const close = Math.ceil((now + 1) / 900) * 900, left = close - now;
    if (left > 75 || left < 45 || st.saved === close) return;           // first tick inside the last ~minute's start
    st.saved = close;
    const hist = (await this.ctx.storage.get(k)) || [];
    if (hist.some(x => x.close === close)) return;
    hist.push({ close, buyPct: Math.round(st.ema * 100), dir: st.ema >= 0.5 ? "up" : "down", price: mid });
    await this.ctx.storage.put(k, hist.filter(x => x.close > now - 7 * 86400).slice(-800));
  }
  async results(coin, limit) {
    const series = SERIES[coin]; if (!series) throw new Error("No Kalshi 15-minute series for " + coin);
    const now = Date.now();
    if (!this.resCache) this.resCache = new Map();
    let c = this.resCache.get(series);
    if (!c || now - c.at > 60000) {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=settled&limit=${Math.max(limit, 100)}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`Kalshi markets HTTP ${r.status}`);
      const j = await r.json();
      c = { at: now, markets: j.markets || [] }; this.resCache.set(series, c);
    }
    const preds = new Map(((await this.ctx.storage.get("pred:" + coin)) || []).map(p => [p.close, p]));
    const rows = c.markets.map(m => {
      const close = Math.round(Date.parse(m.close_time) / 1000);
      const target = num(m.floor_strike), final = num(m.expiration_value);
      const res = String(m.result || "").toLowerCase();
      const outcome = res === "yes" ? "up" : res === "no" ? "down" : null;
      const p = preds.get(close);
      return { close, ticker: m.ticker, target, final, outcome, volume: num(m.volume ?? m.volume_fp),
        pred: p ? { dir: p.dir, buyPct: p.buyPct } : null, hit: p && outcome ? p.dir === outcome : null };
    }).filter(r => r.close && r.outcome).sort((a, b) => b.close - a.close).slice(0, limit);
    return { coin, series, rows, trackedSince: preds.size ? Math.min(...preds.keys()) : null };
  }
  async push(rec, msg) {
    try { return await sendWebPush(rec.sub, JSON.stringify({ ...msg, url: "https://devincamp.github.io/walls/" }), await this.vapid()); }
    catch (err) { return { ok: false, status: 0, error: String(err) }; }
  }

  async fetch(req) {
    try { return await this.handle(req); }
    catch (err) { return json({ error: "relay error: " + String(err && err.stack || err).slice(0, 600) }, 500); }
  }
  async handle(req) {
    const url = new URL(req.url);
    await this.ensureUpstream();
    if (url.pathname === "/status") {
      const ages = {};
      for (const [id, m] of this.last) ages[id] = Math.round((Date.now() - m.ts) / 1000) + "s ago";
      const subs = await this.getSubs();
      return json({ upstream: this.upState, error: this.upError || undefined, latest: ages, apps: this.ctx.getWebSockets().length,
        pushDevices: subs.size, signals: this.sigErr ? { error: this.sigErr } : Object.fromEntries([...this.sigState].map(([k, v]) => [k, v.ema != null ? Math.round(v.ema * 100) + "% buyers" : "–"])) });
    }
    if (url.pathname === "/vapid") return json({ key: (await this.vapid()).pub });
    if (url.pathname === "/subscribe" || url.pathname === "/unsubscribe" || url.pathname === "/signals" || url.pathname === "/test-push" || url.pathname === "/results") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!this.env.RELAY_CODE || auth !== this.env.RELAY_CODE) return json({ error: "wrong access code" }, 403);
      if (url.pathname === "/results") {
        const coin = url.searchParams.get("coin") || "BTC-USD";
        try { return json(await this.results(coin, Math.min(200, +url.searchParams.get("limit") || 96))); }
        catch (err) { return json({ error: String(err && err.message || err) }, 502); }
      }
      if (url.pathname === "/signals") {
        const coin = url.searchParams.get("coin") || "BTC-USD", sens = url.searchParams.get("sens") || "med";
        return json({ signals: (await this.ctx.storage.get(`sig:${coin}:${sens}`)) || [] });
      }
      let body = {}; try { body = await req.json(); } catch {}
      const sub = body.sub; if (!sub || !sub.endpoint) return json({ error: "missing subscription" }, 400);
      const key = "sub:" + await sha(sub.endpoint), subs = await this.getSubs();
      if (url.pathname === "/unsubscribe") { subs.delete(key); await this.ctx.storage.delete(key); return json({ ok: true }); }
      const rec = { sub, coin: String(body.coin || "BTC-USD"), sens: SIG_LEVELS[body.sens] ? body.sens : "med", since: Date.now() };
      subs.set(key, rec); await this.ctx.storage.put(key, rec);
      if (url.pathname === "/test-push") { const r = await this.push(rec, { title: "✅ Push alerts are on", body: `You'll get ▲ / ▼ alerts for ${rec.coin} here.`, tag: "walls-test" }); return json({ ok: r.ok, status: r.status }); }
      return json({ ok: true, devices: subs.size });
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

  // the alarm runs every 15 s: keeps the Kalshi feed alive and checks order-book pressure for push alerts
  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    await this.ensureUpstream();
    try { await this.signalTick(); this.sigErr = ""; } catch (err) { this.sigErr = String(err && err.message || err); }
  }
  async ensureUpstream() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 15000);
    if (!this.env.KALSHI_KEY_ID || !this.env.KALSHI_PRIVATE_KEY) { if (this.upState !== "off") this.setState("off", "Kalshi key not set (push alerts still work)"); return; }
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

const SIG_LEVELS = { low: [0.70, 0.30], med: [0.64, 0.36], high: [0.58, 0.42] };
const SIG_BAND = 0.0025, SIG_COOLDOWN = 300;
const SERIES = { "BTC-USD": "KXBTC15M", "ETH-USD": "KXETH15M", "SOL-USD": "KXSOL15M", "XRP-USD": "KXXRP15M", "DOGE-USD": "KXDOGE15M" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" };
function bookRatio(bids, asks, mid, band) {
  let b = 0, a = 0; const lo = mid * (1 - band), hi = mid * (1 + band);
  for (const [p, q] of bids) if (p >= lo && p <= mid) b += q;
  for (const [p, q] of asks) if (p <= hi && p >= mid) a += q;
  return b + a > 0 ? b / (b + a) : null;
}
// Coinbase order book near the price (public endpoint, no key)
export async function fetchBook(coin) {
  const r = await fetch(`https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${encodeURIComponent(coin)}&limit=1000`, { headers: { "user-agent": "kalshi-relay" } });
  if (!r.ok) throw new Error(`Coinbase book HTTP ${r.status}`);
  const j = await r.json(), pb = j.pricebook || j;
  const bids = (pb.bids || []).map(l => [+l.price, +l.size]), asks = (pb.asks || []).map(l => [+l.price, +l.size]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}
function fmtUsd(x) { return "$" + x.toLocaleString("en-US", { minimumFractionDigits: x < 10 ? 4 : 2, maximumFractionDigits: x < 10 ? 4 : 2 }); }
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 22); }

// ---------------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ----------------
export async function sendWebPush(sub, payload, vapid) {
  const endpoint = new URL(sub.endpoint);
  const uaPub = b64uDec(sub.keys.p256dh), authSecret = b64uDec(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(utf8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(utf8(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPub.length; header.set(asPub, 21);
  const jwt = await vapidJwt(endpoint.origin, vapid.key);
  const res = await fetch(sub.endpoint, { method: "POST", body: concat(header, ct), headers: {
    "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "600", urgency: "high",
    authorization: `vapid t=${jwt}, k=${vapid.pub}` } });
  return { ok: res.ok, status: res.status };
}
export async function vapidJwt(aud, key) {
  const h = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://devincamp.github.io/walls/" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(h + "." + p));
  return h + "." + p + "." + b64u(sig);
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
const utf8 = s => new TextEncoder().encode(s);
function concat(...a) { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; }
function b64u(buf) { return b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64uDec(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

function num(x) { const n = typeof x === "string" ? parseFloat(x) : x; return typeof n === "number" && isFinite(n) ? n : null; }
function json(o, status = 200) { return new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json", ...CORS } }); }

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
