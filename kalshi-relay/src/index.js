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
    if (["/status", "/vapid", "/subscribe", "/unsubscribe", "/signals", "/test-push", "/results", "/paper"].includes(url.pathname)) return stub.fetch(req);
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
    const now = Math.floor(Date.now() / 1000), toClose = 900 - (now % 900);
    // Keep book reads light (Coinbase rate-limits shared Cloudflare IPs): BTC + subscribed coins every tick,
    // other tracked coins only in the ~2 minutes before each 15-min close, when their "read" is recorded.
    const pred = String(this.env.PRED_COINS || "BTC-USD").split(",").map(x => x.trim()).filter(Boolean);
    for (const c of pred) if (c === "BTC-USD" || toClose <= 120) coins.set(c, new Set());
    for (const r of subs.values()) { if (!coins.has(r.coin)) coins.set(r.coin, new Set()); coins.get(r.coin).add(r.sens); }
    const errs = [];
    for (const [coin, senses] of coins) {
      let bk = null;
      try { bk = await fetchBook(coin); } catch (err) { errs.push(`${coin}: ${err.message}`); }
      if (!bk) continue;
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
    for (const c of pred) { try { await this.checkpoints(c, now); } catch (err) { errs.push(`checkpoint ${c}: ${err.message}`); } }
    try { await this.paperSettle(); } catch (err) { errs.push("paper settle: " + err.message); }
    if (errs.length) throw new Error(errs.join("; "));
  }
  // Earlier reads at 5, 3, 2 and 1 minute before each close, with Kalshi's own Yes price at the same moment, so the
  // model can be judged against the market and at horizons where the answer isn't already obvious.
  async checkpoints(coin, now) {
    const close = Math.ceil((now + 1) / 900) * 900, left = close - now;
    const T = [300, 180, 120, 60].find(t => left <= t && left > t - 20);
    if (!T) return;
    if (!this.cpDone) this.cpDone = new Set();
    const key = `${coin}:${close}:${T}`; if (this.cpDone.has(key)) return;
    this.cpDone.add(key); if (this.cpDone.size > 200) this.cpDone = new Set([...this.cpDone].slice(-100));
    const ps = this.predState && this.predState.get("pred:" + coin);
    const book = !!(ps && ps.ema != null && ps.at && now - ps.at < 60);
    const sm = settleModel(this.hist.get(IDX_OF[coin]) || [], close, now, book ? (ps.ema - 0.5) * 2 : 0);
    if (!sm) return;
    let q = null; try { q = await this.kalshiYes(coin, close); } catch {}
    const yes = q ? q.yes : null;
    const k = "cp:" + coin, hist = (await this.ctx.storage.get(k)) || [];
    hist.push({ close, t: T, p: +sm.p.toFixed(3), pc: +sm.pc.toFixed(3), yes, book });
    await this.ctx.storage.put(k, hist.filter(x => x.close > now - 7 * 86400).slice(-1600));
    if (coin === "BTC-USD") await this.paperCheckpoint(close, T, sm, q);
  }
  // Paper bets use Kalshi's live order book for this market (not the market list, which can lag), and only when
  // both the quote and the index are fresh and the relay has been up long enough to have clean history.
  async paperCheckpoint(close, T, sm, listQ) {
    if (!this.bootAt) this.bootAt = Date.now();
    const st = (await this.ctx.storage.get("paperstat3")) || { cps: 0, book: 0, bookFail: 0, stale: 0, warmup: 0, sized: 0, diffN: 0, diffSum: 0, diff5: 0 };
    st.cps++; st.at = Math.floor(Date.now() / 1000);
    let bq = null, err = "";
    try { bq = await this.kalshiBook("BTC-USD", close); } catch (e) { err = String(e.message || e); }
    if (!bq || bq.bid == null || bq.ask == null) { st.bookFail++; if (err) st.lastErr = err.slice(0, 160); await this.ctx.storage.put("paperstat3", st); return; }
    st.book++; if (bq.bidSize != null && bq.askSize != null) st.sized++;
    if (listQ && listQ.yes != null) { const d = Math.abs(listQ.yes - bq.yes); st.diffN++; st.diffSum = +(st.diffSum + d).toFixed(4); if (d > 0.05) st.diff5++; }
    const pts = this.hist.get("BRTI") || [], ixAge = pts.length ? Date.now() / 1000 - pts[pts.length - 1][0] : 1e9;
    let skip = null;
    if (Date.now() - this.bootAt < PAPER_WARMUP_MS) { st.warmup++; skip = "warmup"; }
    else if (bq.ms > PAPER_MAX_QUOTE_MS || ixAge > PAPER_MAX_INDEX_AGE) { st.stale++; skip = "stale"; }
    await this.ctx.storage.put("paperstat3", st);
    if (skip) return;
    await this.paperBet(close, T, sm.p, bq, { listYes: listQ ? listQ.yes : null, ms: bq.ms, ixAge: +ixAge.toFixed(1) });   // model only
  }
  async openMarket(coin, close) {
    const series = SERIES[coin]; if (!series) return null;
    if (!this.yesCache) this.yesCache = new Map();
    let c = this.yesCache.get(series);
    if (!c || Date.now() - c.at > 3000) {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=10`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`Kalshi open markets HTTP ${r.status}`);
      c = { at: Date.now(), markets: (await r.json()).markets || [] }; this.yesCache.set(series, c);
    }
    return c.markets.find(x => Math.round(Date.parse(x.close_time) / 1000) === close) || null;
  }
  async kalshiYes(coin, close) { const m = await this.openMarket(coin, close); return m ? quoteFromMarket(m) : null; }
  // Live order book for the market closing at `close`. Public endpoint; signs the request with the relay's key if Kalshi asks.
  async kalshiBook(coin, close) {
    const m = await this.openMarket(coin, close); if (!m || !m.ticker) return null;
    const path = `/trade-api/v2/markets/${encodeURIComponent(m.ticker)}/orderbook`, url = "https://api.elections.kalshi.com" + path, t0 = Date.now();
    let r = await fetch(url, { headers: { accept: "application/json" } });
    if ((r.status === 401 || r.status === 403) && this.env && this.env.KALSHI_KEY_ID && this.env.KALSHI_PRIVATE_KEY)
      r = await fetch(url, { headers: { accept: "application/json", ...(await kalshiHeaders(this.env.KALSHI_KEY_ID, this.env.KALSHI_PRIVATE_KEY, "GET", path)) } });
    if (!r.ok) throw new Error(`Kalshi orderbook HTTP ${r.status}`);
    const q = quoteFromBook(await r.json()); if (!q) return null;
    q.ms = Date.now() - t0; return q;
  }
  // ---- paper trading (BTC only, no real money): what a bot following the model would have done, with Kalshi fees.
  async paperBet(close, T, q, quote, audit = {}) {
    const d = paperDecide(q, quote.bid, quote.ask, quote.askSize, quote.bidSize);
    if (!d) return;
    const k = PAPER_KEY, bets = (await this.ctx.storage.get(k)) || [];
    if (bets.some(b => b.close === close)) return;                       // at most one bet per window: the first checkpoint with an edge
    bets.push({ close, t: T, ...d, bid: quote.bid, ask: quote.ask, ...audit, out: null });
    await this.ctx.storage.put(k, bets.filter(b => b.close > Date.now() / 1000 - 14 * 86400).slice(-1500));
  }
  async paperSettle() {
    const k = PAPER_KEY, bets = (await this.ctx.storage.get(k)) || [], now = Date.now() / 1000;
    if (!bets.some(b => !b.out && b.close < now - 20)) return;
    const done = new Map(); for (const m of await this.settled("KXBTC15M", 100)) { const res = String(m.result || "").toLowerCase(); if (res === "yes" || res === "no") done.set(Math.round(Date.parse(m.close_time) / 1000), res === "yes" ? "up" : "down"); }
    let ch = false; for (const b of bets) if (!b.out && done.has(b.close)) { b.out = done.get(b.close); ch = true; }
    if (ch) await this.ctx.storage.put(k, bets);
  }
  async paperReport() {
    try { await this.paperSettle(); } catch {}
    const bets = (await this.ctx.storage.get(PAPER_KEY)) || [], prev = (await this.ctx.storage.get("paper2:BTC-USD")) || [];
    return { stats: (await this.ctx.storage.get("paperstat3")) || { cps: 0, book: 0, bookFail: 0, stale: 0, warmup: 0, sized: 0, diffN: 0, diffSum: 0, diff5: 0 },
      prev: prev.length ? paperSim(prev, { flat: PAPER_FLAT }) : null, open: bets.filter(b => !b.out).length, settled: bets.filter(b => b.out).length,
      sims: [{ flat: PAPER_FLAT }, { cap: 0.10 }, { cap: 0.20 }].map(o => paperSim(bets, o)), breakdown: paperBreakdown(bets), daily: paperDaily(bets).slice(0, 30),
      assumed: { slip: PAPER_SLIP, depth: PAPER_DEPTH, minEdge: PAPER_MIN_EDGE, flat: PAPER_FLAT } };
  }
  async settled(series, limit) {
    if (!this.resCache) this.resCache = new Map();
    let c = this.resCache.get(series);
    if (!c || Date.now() - c.at > 60000) {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=settled&limit=${Math.max(limit, 100)}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`Kalshi markets HTTP ${r.status}`);
      c = { at: Date.now(), markets: (await r.json()).markets || [] }; this.resCache.set(series, c);
    }
    return c.markets;
  }
  // The app's "prediction" for a 15-min window = which side the order book leaned to (smoothed, ±0.25%)
  // at the start of the window's final minute, i.e. right before Kalshi's settlement averaging begins.
  async recordPrediction(coin, ratio, now, mid) {
    const k = "pred:" + coin; let st = this.predState && this.predState.get(k);
    if (!this.predState) this.predState = new Map();
    if (!st) this.predState.set(k, st = { ema: null });
    st.ema = st.ema == null ? ratio : st.ema + 0.4 * (ratio - st.ema); st.at = now;
    const close = Math.ceil((now + 1) / 900) * 900, left = close - now;
    if (left > 75 || left < 45 || st.saved === close) return;           // first tick inside the last ~minute's start
    st.saved = close;
    const hist = (await this.ctx.storage.get(k)) || [];
    if (hist.some(x => x.close === close)) return;
    const e = { close, buyPct: Math.round(st.ema * 100), dir: st.ema >= 0.5 ? "up" : "down", price: mid };
    // settlement-aware read: distance to the target, time left and volatility, plus the book lean (p = without book, pc = with)
    const sm = settleModel(this.hist.get(IDX_OF[coin]) || [], close, now, (st.ema - 0.5) * 2);
    if (sm) e.m = { target: +sm.target.toPrecision(9), idx: +sm.idx.toPrecision(9), sd: +sm.sd.toPrecision(4), p: +sm.p.toFixed(3), pc: +sm.pc.toFixed(3) };
    hist.push(e);
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
    const cps = new Map(); for (const x of ((await this.ctx.storage.get("cp:" + coin)) || [])) { if (!cps.has(x.close)) cps.set(x.close, []); cps.get(x.close).push({ t: x.t, p: x.p, pc: x.pc, yes: x.yes }); }
    const rows = c.markets.map(m => {
      const close = Math.round(Date.parse(m.close_time) / 1000);
      const target = num(m.floor_strike), final = num(m.expiration_value);
      const res = String(m.result || "").toLowerCase();
      const outcome = res === "yes" ? "up" : res === "no" ? "down" : null;
      const p = preds.get(close);
      return { close, ticker: m.ticker, target, final, outcome, volume: num(m.volume ?? m.volume_fp),
        cps: cps.get(close) || [], pred: p ? { dir: p.dir, buyPct: p.buyPct, ...(p.m ? { p: p.m.p, pc: p.m.pc } : {}) } : null, hit: p && outcome ? p.dir === outcome : null,
        hitM: p && p.m && outcome ? (p.m.p >= 0.5 ? "up" : "down") === outcome : null, hitC: p && p.m && outcome ? (p.m.pc >= 0.5 ? "up" : "down") === outcome : null };
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
    if (url.pathname === "/subscribe" || url.pathname === "/unsubscribe" || url.pathname === "/signals" || url.pathname === "/test-push" || url.pathname === "/results" || url.pathname === "/paper") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!this.env.RELAY_CODE || auth !== this.env.RELAY_CODE) return json({ error: "wrong access code" }, 403);
      if (url.pathname === "/paper") return json(await this.paperReport());
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

// --- settle model (shared with walls/index.html; keep identical; test/settle.test.mjs checks they match)
// Odds that the final-60s average of the index ends above the 15-min target. pts = ascending [sec, value].
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function settleModel(pts, close, now, lean) {
  const open = close - 900, n = pts.length;
  if (n < 120 || now - pts[n - 1][0] > 10 || now >= close) return null;
  let ts = 0, tn = 0, os = 0, on = 0, s2 = 0, sn = 0;
  for (let i = 0; i < n; i++) {
    const t = pts[i][0], v = pts[i][1];
    if (t >= open - 60 && t < open) { ts += v; tn++; }
    if (t >= close - 60 && t <= now) { os += v; on++; }
    if (i && t >= now - 600) { const dt = t - pts[i - 1][0]; if (dt > 0 && dt <= 5) { const d = (v - pts[i - 1][1]) / Math.sqrt(dt); s2 += d * d; sn++; } }
  }
  if (tn < 50 || sn < 60) return null;
  const target = ts / tn, sig = Math.sqrt(s2 / sn), last = pts[n - 1][1];
  const L = close - now, r = Math.min(L, 60), a = Math.max(0, L - 60);
  const mean = (os + r * last) / (on + r);
  const sd = Math.max(1e-9, sig * (r / (on + r)) * Math.sqrt(a + r / 3));
  const z = (mean - target) / sd;
  return { target, idx: last, sd, z, p: normCdf(z), pc: normCdf(z + 0.5 * lean) };   // pc adds the book lean (-1..1) as up to ±0.5 sd
}
// --- end settle model
// Kalshi's Yes price (0..1) from a market object: mid of bid/ask, else last trade. Handles dollar or cent fields.
function quoteFromMarket(m) {
  const px = (d, c) => d != null && num(d) != null ? num(d) : c != null && num(c) != null ? num(c) / 100 : null;
  const bid = px(m.yes_bid_dollars, m.yes_bid), ask = px(m.yes_ask_dollars, m.yes_ask), last = px(m.last_price_dollars, m.last_price);
  const y = bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : last;
  const sz = (...vs) => { for (const v of vs) { const n = num(v); if (n != null && n >= 0) return n; } return null; };
  return y == null ? null : { yes: +y.toFixed(3), bid: bid != null && ask > 0 ? bid : null, ask: ask != null && ask > 0 ? ask : null,
    askSize: sz(m.yes_ask_size_fp, m.yes_ask_size, m.yes_ask_quantity), bidSize: sz(m.yes_bid_size_fp, m.yes_bid_size, m.yes_bid_quantity) };
}
function yesFromMarket(m) { const q = quoteFromMarket(m); return q ? q.yes : null; }
// ---- paper trading maths. Fee per contract ~ 0.07 * P * (1 - P) (Kalshi's taker fee; check the current schedule).
// Deliberately pessimistic: fills at the ask plus 1 cent of slippage, limited to the quantity actually shown at that price.
const PAPER_MIN_EDGE = 0.03, PAPER_SLIP = 0.01, PAPER_DEPTH = 20, PAPER_FLAT = 25;
const PAPER_KEY = "paper3:BTC-USD";                       // record using live order-book quotes (paper2 = market-list quotes)
const PAPER_WARMUP_MS = 20 * 60000, PAPER_MAX_QUOTE_MS = 1500, PAPER_MAX_INDEX_AGE = 5;
// Kalshi order book -> Yes quote. The book lists bids only: best Yes ask = 1 - best No bid. Dollar or cent fields.
function quoteFromBook(j) {
  const ob = (j && (j.orderbook_fp || j.orderbook)) || {};
  const lv = (d, c) => { const out = [];
    if (Array.isArray(d)) { for (const l of d) { const p = num(l[0]), q = num(l[1]); if (p != null && q != null && q > 0) out.push([p, q]); } }
    else if (Array.isArray(c)) { for (const l of c) { const p = num(l[0]), q = num(l[1]); if (p != null && q != null && q > 0) out.push([p / 100, q]); } }
    return out; };
  const best = a => { let b = null; for (const l of a) { if (!b || l[0] > b[0]) b = [l[0], l[1]]; else if (l[0] === b[0]) b[1] += l[1]; } return b; };
  const yb = best(lv(ob.yes_dollars, ob.yes)), nb = best(lv(ob.no_dollars, ob.no));
  const bid = yb ? yb[0] : null, ask = nb ? +(1 - nb[0]).toFixed(4) : null;
  if (bid == null && ask == null) return null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : bid != null ? bid : ask;
  return { yes: +mid.toFixed(3), bid, ask, bidSize: yb ? yb[1] : null, askSize: nb ? nb[1] : null, src: "book" };
}
const kalshiFee = p => 0.07 * p * (1 - p);
// q = our chance of Yes. Buy whichever side has the bigger edge after fee and slippage; skip if the edge is small.
function paperDecide(q, bid, ask, askSize, bidSize) {
  if (bid == null || ask == null || !(ask > 0) || !(bid >= 0) || bid > ask) return null;
  const yesP = Math.min(0.99, ask + PAPER_SLIP), noP = Math.min(0.99, 1 - bid + PAPER_SLIP);
  const y = { side: "yes", price: yesP, fee: kalshiFee(yesP), q, depth: askSize }, n = { side: "no", price: noP, fee: kalshiFee(noP), q: 1 - q, depth: bidSize };
  for (const o of [y, n]) { o.cost = o.price + o.fee; o.edge = o.q - o.cost; }
  const b = y.edge >= n.edge ? y : n;
  if (!(b.edge >= PAPER_MIN_EDGE) || b.cost >= 1) return null;
  return { side: b.side, price: +b.price.toFixed(3), fee: +b.fee.toFixed(4), q: +b.q.toFixed(3), edge: +b.edge.toFixed(3), kelly: +(b.edge / (1 - b.cost) / 2).toFixed(4), depth: b.depth };   // half Kelly
}
function paperFill(b, stake) {            // contracts bought and resulting profit for one settled bet
  const cost = b.price + b.fee, depth = b.depth != null ? b.depth : PAPER_DEPTH;
  const contracts = Math.max(0, Math.min(stake / cost, depth)), won = (b.side === "yes") === (b.out === "up");
  return { contracts, spent: contracts * cost, pnl: contracts * (won ? 1 - cost : -cost), won };
}
// Replay settled bets. opts.flat = fixed dollar stake per bet; opts.cap = min(cap, half Kelly) of equity, compounding.
// Both are limited by displayed depth; the compounding run stops for the UTC day after losing dayStop.
function paperSim(bets, opts, start = 1000, dayStop = 0.2) {
  let eq = start, peak = start, maxDD = 0, wins = 0, n = 0, spent = 0, dayKey = null, dayStart = start;
  for (const b of bets.filter(x => x.out).sort((a, c) => a.close - c.close)) {
    const day = new Date(b.close * 1000).toISOString().slice(0, 10);
    if (day !== dayKey) { dayKey = day; dayStart = eq; }
    let stake;
    if (opts.flat) stake = opts.flat;
    else { if (eq < dayStart * (1 - dayStop)) continue; const f = Math.min(opts.cap, b.kelly); if (!(f > 0)) continue; stake = eq * f; }
    const r = paperFill(b, stake); if (!(r.contracts > 0)) continue;
    eq += r.pnl; n++; spent += r.spent; if (r.won) wins++;
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / (opts.flat ? start : peak));
  }
  return { ...opts, bets: n, wins, equity: +eq.toFixed(2), pnl: +(eq - start).toFixed(2), ret: +(eq / start - 1).toFixed(4), roi: spent ? +((eq - start) / spent).toFixed(4) : 0, maxDD: +maxDD.toFixed(4) };
}
// Flat-stake P&L per UTC day (newest first), so one lucky day can't hide behind a total.
function paperDaily(bets) {
  const days = new Map();
  for (const b of bets.filter(x => x.out)) {
    const r = paperFill(b, PAPER_FLAT); if (!(r.contracts > 0)) continue;
    const day = new Date(b.close * 1000).toISOString().slice(0, 10), o = days.get(day) || { day, bets: 0, wins: 0, pnl: 0 };
    o.bets++; if (r.won) o.wins++; o.pnl = +(o.pnl + r.pnl).toFixed(2); days.set(day, o);
  }
  return [...days.values()].sort((a, c) => a.day < c.day ? 1 : -1);
}
// Where the money comes from: flat-stake P&L by checkpoint and by price paid.
function paperBreakdown(bets) {
  const rows = new Map(), add = (k, b) => { const r = paperFill(b, PAPER_FLAT); if (!(r.contracts > 0)) return; const o = rows.get(k) || { key: k, bets: 0, wins: 0, pnl: 0 }; o.bets++; if (r.won) o.wins++; o.pnl = +(o.pnl + r.pnl).toFixed(2); rows.set(k, o); };
  for (const b of bets.filter(x => x.out)) { add("t" + b.t, b); add(b.price < 0.3 ? "p<30" : b.price <= 0.7 ? "p30-70" : "p>70", b); }
  return [...rows.values()].sort((a, c) => a.key < c.key ? -1 : 1);
}
const IDX_OF = { "BTC-USD": "BRTI", "ETH-USD": "ETHUSD_RTI", "SOL-USD": "SOLUSD_RTI", "XRP-USD": "XRPUSD_RTI", "DOGE-USD": "DOGEUSD_RTI" };
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
// Order book near the price: Coinbase public endpoint (same book the app uses); if Coinbase rate-limits
// or fails, fall back to Kraken's public depth so alerts and reads keep running.
const KRAKEN_PAIR = { "BTC-USD": "XBTUSD", "ETH-USD": "ETHUSD", "SOL-USD": "SOLUSD", "XRP-USD": "XRPUSD", "DOGE-USD": "XDGUSD" };
const cbBackoff = { until: 0 };
export { yesFromMarket, quoteFromBook, paperDecide, paperSim, paperBreakdown, paperDaily };
export async function fetchBook(coin) {
  if (Date.now() >= cbBackoff.until) {
    try {
      const r = await fetch(`https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${encodeURIComponent(coin)}&limit=1000`, { headers: { "user-agent": "kalshi-relay" } });
      if (r.status === 429) cbBackoff.until = Date.now() + 120000;               // rest Coinbase for 2 min
      if (!r.ok) throw new Error(`Coinbase book HTTP ${r.status}`);
      const j = await r.json(), pb = j.pricebook || j;
      const bids = (pb.bids || []).map(l => [+l.price, +l.size]), asks = (pb.asks || []).map(l => [+l.price, +l.size]);
      if (bids.length && asks.length) return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2, src: "coinbase" };
    } catch (err) { if (!KRAKEN_PAIR[coin]) throw err; }
  }
  const pair = KRAKEN_PAIR[coin]; if (!pair) throw new Error("no book source for " + coin);
  const r = await fetch(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=500`);
  if (!r.ok) throw new Error(`Kraken depth HTTP ${r.status}`);
  const j = await r.json(); if (j.error && j.error.length) throw new Error("Kraken: " + j.error.join(","));
  const book = Object.values(j.result || {})[0]; if (!book) return null;
  const bids = book.bids.map(l => [+l[0], +l[1]]), asks = book.asks.map(l => [+l[0], +l[1]]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2, src: "kraken" };
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
