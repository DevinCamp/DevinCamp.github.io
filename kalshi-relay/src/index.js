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
    if (["/status", "/vapid", "/subscribe", "/unsubscribe", "/signals", "/test-push", "/results", "/paper", "/live", "/live/stop", "/live/resume", "/quote", "/trade", "/manual", "/desklog"].includes(url.pathname)) return stub.fetch(req);
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
    try { await this.liveSettle(); } catch (err) { errs.push("live settle: " + err.message); }
    try { await this.settleOrders("manual"); } catch (err) { errs.push("app orders settle: " + err.message); }
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
    if (coin === "BTC-USD") await this.paperCheckpoint(close, T, sm, q, now);
  }
  // Paper bets use Kalshi's live order book for this market (not the market list, which can lag), and only when
  // both the quote and the index are fresh and the relay has been up long enough to have clean history.
  async paperCheckpoint(close, T, sm, listQ, nowS = Date.now() / 1000) {
    const bq = await this.paperCheckpointInner(close, T, sm, listQ, nowS);
    if (bq && bq.ticker) { try { await this.tradeCheck(bq, listQ); } catch (e) { const st = await this.ctx.storage.get("paperstat3"); if (st) { st.tradeErr = String(e.message || e).slice(0, 120); await this.ctx.storage.put("paperstat3", st); } } }
  }
  // Which quote matches real trading? Compare both against Kalshi's most recent trade (public trades feed).
  async tradeCheck(bq, listQ) {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(bq.ticker)}&limit=10`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Kalshi trades HTTP ${r.status}`);
    const t = lastTrade(await r.json()), st = await this.ctx.storage.get("paperstat3");
    if (!t || !st) return;
    const age = Math.max(0, Math.round(Date.now() / 1000 - t.at));
    if (st.lastCmp) { st.lastCmp.trade = t.yes; st.lastCmp.tradeAge = age; }
    if (st.cmps && st.cmps.length) { const c = st.cmps[st.cmps.length - 1]; c.trade = t.yes; c.tradeAge = age; }
    if (age <= TRADE_FRESH_S && listQ && listQ.yes != null) {
      const dl = Math.abs(listQ.yes - t.yes), db = Math.abs(bq.yes - t.yes);
      st.trN = (st.trN || 0) + 1; st.trList = +((st.trList || 0) + dl).toFixed(4); st.trBook = +((st.trBook || 0) + db).toFixed(4);
      if (db < dl) st.trBookCloser = (st.trBookCloser || 0) + 1; else if (dl < db) st.trListCloser = (st.trListCloser || 0) + 1;
    }
    delete st.tradeErr;
    await this.ctx.storage.put("paperstat3", st);
  }
  async paperCheckpointInner(close, T, sm, listQ, nowS = Date.now() / 1000) {
    if (!this.bootAt) this.bootAt = Date.now();
    const st = (await this.ctx.storage.get("paperstat3")) || { cps: 0, book: 0, bookFail: 0, stale: 0, warmup: 0, sized: 0, diffN: 0, diffSum: 0, diff5: 0 };
    st.cps++; st.at = Math.floor(Date.now() / 1000);
    let bq = null, err = "";
    try { bq = await this.kalshiBook("BTC-USD", close); } catch (e) { err = String(e.message || e); }
    if (!bq || bq.bid == null || bq.ask == null) { st.bookFail++; if (err) st.lastErr = err.slice(0, 160); await this.ctx.storage.put("paperstat3", st);
      await this.deskLog({ kind: "ERROR", what: `${T / 60}-min check`, why: "no live Kalshi quote" + (err ? ": " + err.slice(0, 80) : "") }); return null; }
    st.book++; if (bq.bidSize != null && bq.askSize != null) st.sized++;
    if (listQ && listQ.yes != null) { const d = Math.abs(listQ.yes - bq.yes); st.diffN++; st.diffSum = +(st.diffSum + d).toFixed(4); if (d > 0.05) st.diff5++;
      st.lastCmp = { at: Math.floor(Date.now() / 1000), t: T, list: [listQ.bid, listQ.ask], book: [bq.bid, bq.ask], bookSize: [bq.bidSize, bq.askSize] };
      st.cmps = [...(st.cmps || []), st.lastCmp].slice(-5); }
    const pts = this.hist.get("BRTI") || [], ixAge = pts.length ? Date.now() / 1000 - pts[pts.length - 1][0] : 1e9;
    let skip = null;
    if (Date.now() - this.bootAt < PAPER_WARMUP_MS) { st.warmup++; skip = "warmup"; }
    else if (bq.ms > PAPER_MAX_QUOTE_MS || ixAge > PAPER_MAX_INDEX_AGE) { st.stale++; skip = "stale"; }
    await this.ctx.storage.put("paperstat3", st);
    const chk = `${T / 60}-min check`;
    if (skip === "warmup") { await this.deskLog({ kind: "SKIP", what: chk, why: "relay warming up (20 min after a restart)" }); return bq; }
    if (skip) { await this.deskLog({ kind: "SKIP", what: chk, why: bq.ms > PAPER_MAX_QUOTE_MS ? `quote too slow (${bq.ms} ms)` : `index data ${Math.round(ixAge)} s old` }); return bq; }
    const pb = await this.paperBet(close, T, sm.p, bq, { listYes: listQ ? listQ.yes : null, ms: bq.ms, ixAge: +ixAge.toFixed(1) });   // model only
    if (pb && pb.status === "noedge") await this.deskLog({ kind: "SKIP", what: `${chk} · model ${fmtPct(sm.p)} UP`,
      why: `best edge ${fmtPts(pb.e.edge)} (${pb.e.side.toUpperCase()} @ ${fmtC(pb.e.price)}) after fee + slippage < ${fmtPts(PAPER_MIN_EDGE)}` });
    if (pb && pb.status === "bet") await this.deskLog({ kind: "PAPER", what: `${pb.d.side.toUpperCase()} @ ${fmtC(pb.d.price)} · ${chk}`,
      why: `model ${fmtPct(pb.d.q)} vs market ${fmtC(pb.d.price)} · edge +${fmtPts(pb.d.edge)}` });
    const cs = candles1m(pts, nowS, 12), cands = {};
    for (const name of Object.keys(CANDLE_STRATS)) {
      const r = candleDecide(name, cs, sm.p, bq); cands[name] = r;
      if (r && r.d && await this.candleBet(name, close, T, r, bq)) await this.deskLog({ kind: "CANDLE", what: `${CANDLE_STRATS[name].label}: ${r.d.side === "yes" ? "UP" : "DOWN"} @ ${fmtC(r.d.price)} · ${chk}`,
        why: `${r.sig.why} · model ${fmtPct(sm.p)} → ${fmtPct(r.p)} UP · edge +${fmtPts(r.d.edge)}` });
    }
    const strat = this.liveConfig().strategy;
    try { await this.liveMaybeTrade(close, T, sm.p, bq, strat === "model" ? undefined : (cands[strat] && cands[strat].d) || null, strat); } catch (e) { const ls = await this.liveState(); ls.lastErr = "trade: " + String(e.message || e).slice(0, 200); ls.lastErrAt = Math.floor(Date.now() / 1000); await this.ctx.storage.put("live", ls); }
    return bq;
  }
  // ---------------- LIVE TRADING (real money, BTC only) ----------------
  // Off unless the Cloudflare secret LIVE_TRADING is "on" AND a separate trading key is set. Same signal and
  // guards as the paper bot, plus a hard budget, per-bet cap, daily loss stop, order cap and a stop button.
  liveConfig() {
    const e = this.env || {}, n = (v, d) => { const x = num(v); return x == null ? d : x; };
    return { on: String(e.LIVE_TRADING || "").toLowerCase() === "on", hasKey: !!(e.KALSHI_TRADE_KEY_ID && e.KALSHI_TRADE_PRIVATE_KEY),
      budget: n(e.LIVE_BUDGET, 25), maxStake: Math.min(0.2, n(e.LIVE_MAX_STAKE, 0.10)), dailyLoss: n(e.LIVE_DAILY_LOSS, 0.20),
      floor: n(e.LIVE_FLOOR, 10), maxOrdersDay: n(e.LIVE_MAX_ORDERS_DAY, 30),
      horizons: String(e.LIVE_HORIZONS || "300").split(",").map(x => +x.trim()).filter(Boolean),
      strategy: CANDLE_STRATS[String(e.LIVE_STRATEGY || "").trim()] ? String(e.LIVE_STRATEGY).trim() : "model" };
  }
  async liveState() { return (await this.ctx.storage.get("live")) || { halted: false, orders: [] }; }
  async kalshiTrade(method, path, body) {           // signed request with the TRADING key (never the feed key)
    const e = this.env, url = "https://api.elections.kalshi.com" + path;
    const headers = { accept: "application/json", ...(await kalshiHeaders(e.KALSHI_TRADE_KEY_ID, e.KALSHI_TRADE_PRIVATE_KEY, method, path.split("?")[0])) };
    if (body) headers["content-type"] = "application/json";
    let r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) {                           // Kalshi rate limit: wait a moment and try once more, freshly signed
      await new Promise(res => setTimeout(res, LIVE_RETRY_MS));
      const h2 = { ...headers, ...(await kalshiHeaders(e.KALSHI_TRADE_KEY_ID, e.KALSHI_TRADE_PRIVATE_KEY, method, path.split("?")[0])) };
      r = await fetch(url, { method, headers: h2, body: body ? JSON.stringify(body) : undefined });
    }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    if (!r.ok) throw new Error(`Kalshi ${method} ${path.split("?")[0]} HTTP ${r.status}: ${txt.slice(0, 160)}`);
    return j || {};
  }
  // Kalshi balance, cached for a minute; after a rate-limit error, back off and keep using a recent value.
  async liveBalance() {
    const now = Date.now(), c = this.balCache;
    if (c && now - c.at < 60000) return c.value;
    if (this.balBackoff && now < this.balBackoff) { if (c && now - c.at < 600000) return c.value; throw new Error("Kalshi balance rate-limited; retrying shortly"); }
    try { const j = await this.kalshiTrade("GET", "/trade-api/v2/portfolio/balance"), v = { total: parseBalance(j), shards: parseShardBalances(j) }; this.balCache = { at: now, value: v }; this.balBackoff = 0; return v; }
    catch (e) { if (/HTTP 429/.test(String(e.message))) this.balBackoff = now + 60000; if (c && now - c.at < 600000) return c.value; throw e; }
  }
  async liveMaybeTrade(close, T, q, quote, dOverride, strategy = "model") {
    const cfg = this.liveConfig();
    if (!cfg.on || !cfg.hasKey || !cfg.horizons.includes(T) || !quote.ticker) return;
    const d = dOverride !== undefined ? dOverride : paperDecide(q, quote.bid, quote.ask, quote.askSize, quote.bidSize); if (!d) return;
    const st = await this.liveState();
    if (st.orders.some(o => o.close === close)) return;                                   // one order per window
    const block = liveGate(st, cfg, Date.now()); if (block) { st.lastSkip = block; await this.ctx.storage.put("live", st); await this.deskLog({ kind: "HOLD", what: `live ${d.side.toUpperCase()} @ ${fmtC(d.price)}`, why: block }); return; }
    const acct = liveAccount(st, cfg);
    let balance = null; try { balance = shardBalance(await this.liveBalance(), quote.shard); } catch (e) { st.lastErr = "balance: " + String(e.message || e).slice(0, 160); st.lastErrAt = Math.floor(Date.now() / 1000); }
    const count = liveSize(acct.equity, Math.min(acct.available, balance == null ? 0 : balance), d, cfg.maxStake);
    if (count < 1) {
      st.lastSkip = balance == null ? "couldn't read the Kalshi balance"
        : balance < d.price + kalshiFee(d.price) ? `only $${balance.toFixed(2)} on Kalshi's ${shardName(quote.shard)} shard, not enough for one contract` : "stake too small for one contract";
      await this.ctx.storage.put("live", st); await this.deskLog({ kind: "HOLD", what: `live ${d.side.toUpperCase()} @ ${fmtC(d.price)}`, why: st.lastSkip }); return;
    }
    const id = `walls-${close}-${T}`, body = liveOrderBody(quote.ticker, id, d.side, d.price, count, quote.ranges);
    const o = { id, close, t: T, ticker: quote.ticker, side: d.side, limit: body.limitOurSide, count, q: d.q, edge: d.edge, strategy, at: Math.floor(Date.now() / 1000), status: "sending" };
    delete body.limitOurSide;
    st.orders.push(o); st.orders = st.orders.slice(-500); await this.ctx.storage.put("live", st);   // record before sending: no double orders
    try {
      const res = await this.kalshiTrade("POST", "/trade-api/v2/portfolio/events/orders", body);
      Object.assign(o, liveOrderResult(res, d.side)); st.lastErr = ""; st.lastErrAt = 0;
    } catch (e) { o.status = "error"; o.error = String(e.message || e).slice(0, 200); o.filled = 0; st.lastErr = o.error; st.lastErrAt = Math.floor(Date.now() / 1000); }
    await this.ctx.storage.put("live", st);
    const what = `${o.side.toUpperCase()} ×${o.count} @ ${fmtC(o.limit)}`;
    if (o.status === "error") await this.deskLog({ kind: "ERROR", what: "live " + what, why: o.error.replace(/^Kalshi POST \S+ /, "") });
    else if (o.filled > 0) await this.deskLog({ kind: "BET", what: `${o.side.toUpperCase()} ×${o.filled} @ ${fmtC(o.avg != null ? o.avg : o.limit)}`, why: `${strategy === "model" ? "model" : CANDLE_STRATS[strategy].label + " ·"} ${fmtPct(o.q)} · edge +${fmtPts(o.edge)} · real money` });
    else await this.deskLog({ kind: "MISS", what: "live " + what, why: "not filled: price moved past the limit · nothing spent" });
  }
  async liveSettle() { return this.settleOrders("live"); }
  async settleOrders(key) {            // settle "live" (bot) or "manual" (app) orders from Kalshi's results and our fills
    const st = (await this.ctx.storage.get(key)) || { orders: [] }, now = Date.now() / 1000;
    const due = st.orders.filter(o => o.out == null && o.status !== "error" && o.close < now - 20); if (!due.length) return;
    const bySeries = new Map();
    for (const o of due) {
      const series = SERIES[o.coin || "BTC-USD"]; if (!series) continue;
      if (!bySeries.has(series)) { const done = new Map(); for (const m of await this.settled(series, 100)) { const res = String(m.result || "").toLowerCase(); if (res === "yes" || res === "no") done.set(Math.round(Date.parse(m.close_time) / 1000), res === "yes" ? "up" : "down"); } bySeries.set(series, done); }
      const done = bySeries.get(series);
      if (!done.has(o.close)) continue;
      try { const f = parseFills(await this.kalshiTrade("GET", `/trade-api/v2/portfolio/fills?ticker=${encodeURIComponent(o.ticker)}`), o.side); if (f) { o.filled = f.count; o.avg = f.avg; if (f.fee != null) o.feeTotal = f.fee; } } catch (e) { o.fillErr = String(e.message || e).slice(0, 120); }
      o.out = done.get(o.close); Object.assign(o, liveResult(o));
      if (o.filled > 0) await this.deskLog({ kind: "SETTLE", what: `${key === "manual" ? "app " : ""}${o.side.toUpperCase()} ×${o.filled} · closed ${o.out.toUpperCase()}`,
        why: `${o.won ? "won" : "lost"} · Kalshi fee $${(o.fee || 0).toFixed(2)}`, pnl: o.pnl });
    }
    await this.ctx.storage.put(key, st);
  }
  // ---------------- APP: live quote + manual trades (real money) ----------------
  // The app shows Kalshi's live Up/Down prices and can buy with a tap. Uses the trading key, with a per-tap cap, a
  // daily cap and a price guard (no fill above what the user saw + 2c). MANUAL_TRADING=off (Secret) turns it off.
  manualConfig() {
    const e = this.env || {}, n = (v, d) => { const x = num(v); return x == null ? d : x; };
    return { on: String(e.MANUAL_TRADING || "on").toLowerCase() !== "off", hasKey: !!(e.KALSHI_TRADE_KEY_ID && e.KALSHI_TRADE_PRIVATE_KEY),
      maxSpend: Math.min(50, n(e.MANUAL_MAX_SPEND, 10)), dailyMax: n(e.MANUAL_DAILY_MAX, 50) };
  }
  async appQuote(coin) {
    if (!SERIES[coin]) return { error: "unknown coin" };
    const now = Math.floor(Date.now() / 1000), close = Math.ceil((now + 1) / 900) * 900;
    if (!this.qCache) this.qCache = new Map();
    const c = this.qCache.get(coin); if (c && Date.now() - c.at < 1500 && c.q.close === close) return c.q;
    let bq = null; try { bq = await this.kalshiBook(coin, close); } catch (e) { return { close, error: String(e.message || e).slice(0, 120) }; }
    if (!bq) return { close, error: "no open market" };
    const cfg = this.manualConfig();
    const q = { close, ticker: bq.ticker, up: bq.ask, down: bq.bid != null ? +(1 - bq.bid).toFixed(4) : null, upSize: bq.askSize, downSize: bq.bidSize,
      canTrade: cfg.on && cfg.hasKey, maxSpend: cfg.maxSpend, at: Date.now() };
    this.qCache.set(coin, { at: Date.now(), q }); return q;
  }
  async manualState() { return (await this.ctx.storage.get("manual")) || { orders: [] }; }
  async manualTrade(b) {
    const cfg = this.manualConfig();
    if (!cfg.hasKey) return { ok: false, error: "No trading key is set in Cloudflare." };
    if (!cfg.on) return { ok: false, error: "Buying from the app is turned off (MANUAL_TRADING=off)." };
    const coin = String(b.coin || "BTC-USD"), side = b.side === "yes" || b.side === "no" ? b.side : null;
    const spend = num(b.spend), seen = num(b.price), close = num(b.close);
    if (!SERIES[coin] || !side || !(spend > 0) || !(seen > 0 && seen < 1) || !close) return { ok: false, error: "Bad request." };
    if (spend > cfg.maxSpend) return { ok: false, error: `The most per tap is $${cfg.maxSpend}.` };
    const now = Date.now() / 1000;
    if (close - now < MANUAL_MIN_LEFT_S) return { ok: false, error: "This round is about to close." };
    const st = await this.manualState(), spent = manualSpentToday(st, now);
    if (spent + spend > cfg.dailyMax + 1e-9) return { ok: false, error: `Daily limit for app buys is $${cfg.dailyMax} ($${spent.toFixed(2)} used today).` };
    let bq = null; try { bq = await this.kalshiBook(coin, close); } catch (e) { return { ok: false, error: "Couldn't read Kalshi's order book." }; }
    if (!bq || bq.bid == null || bq.ask == null || !bq.ticker) return { ok: false, error: "Couldn't read Kalshi's order book." };
    const ask = side === "yes" ? bq.ask : +(1 - bq.bid).toFixed(4), limit = Math.min(0.99, +(seen + MANUAL_SLIP).toFixed(4));
    if (ask > limit + 1e-9) return { ok: false, error: `The price moved to ${Math.round(ask * 100)}¢. Check it and tap again.` };
    const count = Math.floor(spend / (limit + kalshiFee(limit)));
    if (count < 1) return { ok: false, error: "That's less than one contract at this price." };
    let bal = null; try { bal = shardBalance(await this.liveBalance(), bq.shard); } catch (e) { return { ok: false, error: "Couldn't read your Kalshi balance." }; }
    if (bal != null && bal < count * (limit + kalshiFee(limit))) return { ok: false, error: `Only $${bal.toFixed(2)} on Kalshi's ${shardName(bq.shard)} shard.` };
    const id = `app-${close}-${Date.now()}`, body = liveOrderBody(bq.ticker, id, side, limit, count, bq.ranges);
    const o = { id, close, coin, ticker: bq.ticker, side, limit: body.limitOurSide, count, seen, at: Math.floor(now), status: "sending" };
    delete body.limitOurSide;
    st.orders.push(o); st.orders = st.orders.slice(-300); await this.ctx.storage.put("manual", st);   // record before sending
    try { Object.assign(o, liveOrderResult(await this.kalshiTrade("POST", "/trade-api/v2/portfolio/events/orders", body), side)); }
    catch (e) { o.status = "error"; o.error = String(e.message || e).slice(0, 200); o.filled = 0; }
    this.balCache = null;                       // money moved (or may have): read the balance fresh next time
    await this.ctx.storage.put("manual", st);
    await this.deskLog(o.status === "error" ? { kind: "ERROR", what: `app BUY ${side === "yes" ? "UP" : "DOWN"}`, why: String(o.error || "").replace(/^Kalshi POST \S+ /, "") }
      : { kind: "APP", what: `BUY ${side === "yes" ? "UP" : "DOWN"} ×${o.filled || 0} @ ${fmtC(o.avg != null ? o.avg : o.limit)}`, why: o.filled > 0 ? "your tap · filled" : "your tap · not filled, nothing spent" });
    return { ok: o.status !== "error", order: o, error: o.error };
  }
  async manualReport() {
    try { await this.settleOrders("manual"); } catch {}
    const st = await this.manualState(), cfg = this.manualConfig(), now = Date.now() / 1000;
    const settled = st.orders.filter(o => o.out != null && o.filled > 0);
    return { canTrade: cfg.on && cfg.hasKey, maxSpend: cfg.maxSpend, dailyMax: cfg.dailyMax, spentToday: +manualSpentToday(st, now).toFixed(2),
      realized: +settled.reduce((a, o) => a + (o.pnl || 0), 0).toFixed(2), wins: settled.filter(o => o.won).length, bets: settled.length,
      orders: st.orders.slice(-10).reverse() };
  }
  async liveReport() {
    try { await this.liveSettle(); } catch (e) { const s2 = await this.liveState(); s2.lastErr = "settle: " + String(e.message || e).slice(0, 160); s2.lastErrAt = Math.floor(Date.now() / 1000); await this.ctx.storage.put("live", s2); }
    const cfg = this.liveConfig(), st = await this.liveState(), acct = liveAccount(st, cfg);
    let balance = null, balErr = "";
    let shard = null;
    if (cfg.hasKey) { try { const b = await this.liveBalance(); balance = b.total; shard = b.shards && b.shards[CRYPTO_SHARD] != null ? b.shards[CRYPTO_SHARD] : null; } catch (e) { balErr = String(e.message || e).slice(0, 160); } }
    return { on: cfg.on, hasKey: cfg.hasKey, halted: !!st.halted, haltReason: st.haltReason || "", gate: liveGate(st, cfg, Date.now()),
      budget: cfg.budget, maxStake: cfg.maxStake, dailyLoss: cfg.dailyLoss, floor: cfg.floor, horizons: cfg.horizons, strategy: cfg.strategy,
      strategyLabel: cfg.strategy === "model" ? "settle model" : CANDLE_STRATS[cfg.strategy].label, ...acct, balance, shardBalance: shard, shardIndex: CRYPTO_SHARD, balErr,
      lastErr: st.lastErr || "", lastErrAt: st.lastErrAt || 0, lastSkip: st.lastSkip || "", orders: st.orders.slice(-20).reverse() };
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
    q.ms = Date.now() - t0; q.ticker = m.ticker; q.ranges = Array.isArray(m.price_ranges) ? m.price_ranges : null; q.shard = num(m.exchange_index); return q;
  }
  // ---- paper trading (BTC only, no real money): what a bot following the model would have done, with Kalshi fees.
  async paperBet(close, T, q, quote, audit = {}) {
    const d = paperDecide(q, quote.bid, quote.ask, quote.askSize, quote.bidSize);
    if (!d) { const e = paperEdge(q, quote.bid, quote.ask); return e ? { status: "noedge", e } : null; }
    const k = PAPER_KEY, bets = (await this.ctx.storage.get(k)) || [];
    if (bets.some(b => b.close === close)) return { status: "dup" };     // at most one bet per window: the first checkpoint with an edge
    bets.push({ close, t: T, ...d, bid: quote.bid, ask: quote.ask, ...audit, out: null });
    await this.ctx.storage.put(k, bets.filter(b => b.close > Date.now() / 1000 - 14 * 86400).slice(-1500));
    return { status: "bet", d };
  }
  async deskLog(e) {                   // the Desk's decision log: every bet, skip, fill and settlement, with the reason
    const l = (await this.ctx.storage.get("desklog")) || [];
    l.push({ t: Math.floor(Date.now() / 1000), ...e });
    await this.ctx.storage.put("desklog", l.slice(-300));
  }
  async candleBet(name, close, T, r, quote) {   // one paper bet per round per strategy: the first checkpoint with a signal and an edge
    const k = "cpaper:" + name, bets = (await this.ctx.storage.get(k)) || [];
    if (bets.some(b => b.close === close)) return false;
    bets.push({ close, t: T, ...r.d, why: r.sig.why, p: +r.p.toFixed(3), bid: quote.bid, ask: quote.ask, out: null });
    await this.ctx.storage.put(k, bets.filter(b => b.close > Date.now() / 1000 - 14 * 86400).slice(-1500));
    return true;
  }
  async paperSettle() {
    const now = Date.now() / 1000; let done = null;
    for (const k of [PAPER_KEY, ...Object.keys(CANDLE_STRATS).map(n => "cpaper:" + n)]) {
      const bets = (await this.ctx.storage.get(k)) || [];
      if (!bets.some(b => !b.out && b.close < now - 20)) continue;
      if (!done) { done = new Map(); for (const m of await this.settled("KXBTC15M", 100)) { const res = String(m.result || "").toLowerCase(); if (res === "yes" || res === "no") done.set(Math.round(Date.parse(m.close_time) / 1000), res === "yes" ? "up" : "down"); } }
      let ch = false; for (const b of bets) if (!b.out && done.has(b.close)) { b.out = done.get(b.close); ch = true; }
      if (ch) await this.ctx.storage.put(k, bets);
    }
  }
  async paperReport() {
    try { await this.paperSettle(); } catch {}
    const bets = (await this.ctx.storage.get(PAPER_KEY)) || [], prev = (await this.ctx.storage.get("paper2:BTC-USD")) || [];
    return { stats: (await this.ctx.storage.get("paperstat3")) || { cps: 0, book: 0, bookFail: 0, stale: 0, warmup: 0, sized: 0, diffN: 0, diffSum: 0, diff5: 0 },
      prev: prev.length ? paperSim(prev, { flat: PAPER_FLAT }) : null, open: bets.filter(b => !b.out).length, settled: bets.filter(b => b.out).length,
      sims: [{ flat: PAPER_FLAT }, { cap: 0.10 }, { cap: 0.20 }].map(o => paperSim(bets, o)), breakdown: paperBreakdown(bets), daily: paperDaily(bets).slice(0, 30),
      assumed: { slip: PAPER_SLIP, depth: PAPER_DEPTH, minEdge: PAPER_MIN_EDGE, flat: PAPER_FLAT },
      strategies: await this.candleReport(), liveStrategy: this.liveConfig().strategy };
  }
  async candleReport() {
    const mb = (await this.ctx.storage.get(PAPER_KEY)) || [];
    const out = [{ name: "model", label: "settle model", baseline: true, ...paperSim(mb, { flat: PAPER_FLAT }), ...luckCheck(mb) }];
    for (const [name, S] of Object.entries(CANDLE_STRATS)) {
      const bets = (await this.ctx.storage.get("cpaper:" + name)) || [];
      out.push({ name, label: S.label, about: S.about, open: bets.filter(b => !b.out).length, ...paperSim(bets, { flat: PAPER_FLAT }), ...luckCheck(bets) });
    }
    return out;
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
      return json({ version: RELAY_VERSION, upstream: this.upState, error: this.upError || undefined, latest: ages, apps: this.ctx.getWebSockets().length,
        pushDevices: subs.size, signals: this.sigErr ? { error: this.sigErr } : Object.fromEntries([...this.sigState].map(([k, v]) => [k, v.ema != null ? Math.round(v.ema * 100) + "% buyers" : "–"])) });
    }
    if (url.pathname === "/vapid") return json({ key: (await this.vapid()).pub });
    if (url.pathname === "/subscribe" || url.pathname === "/unsubscribe" || url.pathname === "/signals" || url.pathname === "/test-push" || url.pathname === "/results" || url.pathname === "/paper" || url.pathname.startsWith("/live") || url.pathname === "/quote" || url.pathname === "/trade" || url.pathname === "/manual" || url.pathname === "/desklog") {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!this.env.RELAY_CODE || auth !== this.env.RELAY_CODE) return json({ error: "wrong access code" }, 403);
      if (url.pathname === "/paper") return json(await this.paperReport());
      if (url.pathname === "/live") return json(await this.liveReport());
      if (url.pathname === "/quote") return json(await this.appQuote(url.searchParams.get("coin") || "BTC-USD"));
      if (url.pathname === "/manual") return json(await this.manualReport());
      if (url.pathname === "/desklog") { const l = (await this.ctx.storage.get("desklog")) || []; return json({ log: l.slice(-60).reverse() }); }
      if (url.pathname === "/trade") {
        if (req.method !== "POST") return json({ error: "use POST" }, 405);
        let b = {}; try { b = await req.json(); } catch {}
        return json(await this.manualTrade(b));
      }
      if (url.pathname === "/live/stop" || url.pathname === "/live/resume") {
        if (req.method !== "POST") return json({ error: "use POST" }, 405);
        const st = await this.liveState(); st.halted = url.pathname === "/live/stop"; st.haltReason = st.halted ? "stopped from the app" : "";
        await this.ctx.storage.put("live", st); return json(await this.liveReport());
      }
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
const PAPER_WARMUP_MS = 20 * 60000, PAPER_MAX_QUOTE_MS = 1500, PAPER_MAX_INDEX_AGE = 5, TRADE_FRESH_S = 30;
// Most recent trade in a Kalshi trades response: Yes price (dollars) and time (unix s). Dollar or cent fields.
function lastTrade(j) {
  let best = null;
  for (const t of (j && j.trades) || []) {
    const at = Date.parse(t.created_time || t.ts || ""); if (!isFinite(at)) continue;
    const d = num(t.yes_price_dollars ?? t.yes_price_fixed), c = num(t.yes_price), y = d != null ? d : c != null ? c / 100 : null;
    if (y == null) continue;
    if (!best || at > best.at * 1000) best = { yes: y, at: at / 1000 };
  }
  return best;
}
let LIVE_RETRY_MS = 1000;
const RELAY_VERSION = "2026-11-26.luck";   // shown on /status; bump on relay changes
export function _setLiveRetryMs(ms) { LIVE_RETRY_MS = ms; }   // tests only
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
// ---- candle strategies (1-minute candles built from the official index the relay records each second)
function candles1m(pts, nowS, n) {           // the last n CLOSED 1-minute candles, oldest first
  const end = Math.floor(nowS / 60) * 60, start = end - n * 60, out = []; let cur = null;
  for (const [t, v] of pts) {
    if (t < start || t >= end) continue;
    const m = Math.floor(t / 60) * 60;
    if (!cur || cur.t !== m) { cur = { t: m, o: v, h: v, l: v, c: v }; out.push(cur); } else { cur.h = Math.max(cur.h, v); cur.l = Math.min(cur.l, v); cur.c = v; }
  }
  return out;
}
const green = c => c.c > c.o, red = c => c.c < c.o, body = c => Math.abs(c.c - c.o);
const CANDLE_STRATS = {
  momentum: { label: "3-candle momentum", about: "three 1-min candles the same color: bet it continues",
    fn: cs => { const l = cs.slice(-3); if (l.length < 3) return null;
      return l.every(green) ? { dir: 1, why: "3 green 1-min candles in a row" } : l.every(red) ? { dir: -1, why: "3 red 1-min candles in a row" } : null; } },
  engulfing: { label: "engulfing", about: "last candle's body swallows the one before, opposite color",
    fn: cs => { if (cs.length < 2) return null; const a = cs[cs.length - 2], b = cs[cs.length - 1];
      if (red(a) && green(b) && b.o <= a.c && b.c >= a.o && body(b) > body(a)) return { dir: 1, why: "bullish engulfing on the last 1-min candle" };
      if (green(a) && red(b) && b.o >= a.c && b.c <= a.o && body(b) > body(a)) return { dir: -1, why: "bearish engulfing on the last 1-min candle" };
      return null; } },
  hammer: { label: "hammer / shooting star", about: "long wick rejecting a move: bet the other way",
    fn: cs => { const c = cs[cs.length - 1]; if (!c) return null; const r = c.h - c.l, b = body(c); if (!(r > 0)) return null;
      const lo = Math.min(c.o, c.c) - c.l, up = c.h - Math.max(c.o, c.c);
      if (lo >= 2 * b && lo >= 0.6 * r && up <= 0.15 * r) return { dir: 1, why: "hammer: long lower wick on the last 1-min candle" };
      if (up >= 2 * b && up >= 0.6 * r && lo <= 0.15 * r) return { dir: -1, why: "shooting star: long upper wick on the last 1-min candle" };
      return null; } },
  breakout: { label: "5-candle breakout", about: "close beyond the last 5 candles' range: bet it keeps going",
    fn: cs => { if (cs.length < 6) return null; const c = cs[cs.length - 1], prev = cs.slice(-6, -1);
      const hi = Math.max(...prev.map(x => x.h)), lo = Math.min(...prev.map(x => x.l));
      return c.c > hi ? { dir: 1, why: "closed above the last 5 candles' high" } : c.c < lo ? { dir: -1, why: "closed below the last 5 candles' low" } : null; } },
  fade: { label: "big-candle fade", about: "a candle 2.5× the usual size: bet it snaps back",
    fn: cs => { if (cs.length < 11) return null; const c = cs[cs.length - 1], prev = cs.slice(-11, -1);
      const avg = prev.reduce((s, x) => s + (x.h - x.l), 0) / prev.length;
      if (!(avg > 0) || c.h - c.l < 2.5 * avg || body(c) === 0) return null;
      return green(c) ? { dir: -1, why: `big green candle (${((c.h - c.l) / avg).toFixed(1)}× usual): fade it` } : { dir: 1, why: `big red candle (${((c.h - c.l) / avg).toFixed(1)}× usual): fade it` }; } }
};
const CANDLE_TILT = 0.08;                   // a signal moves the model's odds 8 points its way
// A strategy bets only when it has a signal AND, after tilting the model's odds its way, its side has the usual 3-pt edge.
function candleDecide(name, cs, modelP, quote) {
  const S = CANDLE_STRATS[name]; if (!S || modelP == null || !quote) return null;
  const sig = S.fn(cs); if (!sig) return null;
  const p = Math.min(0.99, Math.max(0.01, modelP + CANDLE_TILT * sig.dir));
  const d = paperDecide(p, quote.bid, quote.ask, quote.askSize, quote.bidSize);
  return { sig, p, d: d && d.side === (sig.dir > 0 ? "yes" : "no") ? d : null };
}
// The best side and its edge even when it's too small to bet (for the Desk's log).
function paperEdge(q, bid, ask) {
  if (bid == null || ask == null || !(ask > 0) || !(bid >= 0) || bid > ask) return null;
  const yesP = Math.min(0.99, ask + PAPER_SLIP), noP = Math.min(0.99, 1 - bid + PAPER_SLIP);
  const ey = q - (yesP + kalshiFee(yesP)), en = (1 - q) - (noP + kalshiFee(noP));
  return ey >= en ? { side: "yes", edge: +ey.toFixed(3), price: +yesP.toFixed(3) } : { side: "no", edge: +en.toFixed(3), price: +noP.toFixed(3) };
}
const fmtPct = x => Math.round(x * 100) + "%", fmtC = x => (Math.round(x * 1000) / 10) + "¢", fmtPts = x => (Math.round(x * 1000) / 10).toFixed(1) + " pts";
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
// Is a record better than luck? Break-even = the average cost (price + fee) of the settled bets, which is the win rate
// needed to make $0. z = (win rate - break-even) / standard error; |z| < 2 is indistinguishable from luck.
const LUCK_MIN_BETS = 30;
function luckCheck(bets) {
  let n = 0, w = 0, cost = 0;
  for (const b of bets.filter(x => x.out)) { const r = paperFill(b, PAPER_FLAT); if (!(r.contracts > 0)) continue; n++; if (r.won) w++; cost += b.price + b.fee; }
  if (!n) return { breakEven: null, z: null, verdict: "no bets" };
  const wr = w / n, be = cost / n, se = Math.sqrt(Math.max(wr * (1 - wr), be * (1 - be)) / n), z = se > 0 ? (wr - be) / se : 0;
  const verdict = n < LUCK_MIN_BETS ? "too few" : z >= 2 ? "edge" : z <= -2 ? "losing" : "luck";
  return { breakEven: +be.toFixed(3), z: +z.toFixed(2), verdict };
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
// ---- live trading maths (pure, tested offline)
function liveResult(o) {             // P&L of a settled order: filled contracts at the average (or limit) price; Kalshi's fee if known
  const n = o.filled || 0, px = o.avg != null ? o.avg : o.limit, won = (o.side === "yes") === (o.out === "up");
  const fee = !n ? 0 : o.feeTotal != null ? o.feeTotal : o.feeEach != null ? o.feeEach * n : Math.ceil(kalshiFee(px) * n * 100) / 100;
  return { won, fee: +fee.toFixed(2), pnl: n ? +((won ? n * (1 - px) : -n * px) - fee).toFixed(2) : 0 };
}
function liveAccount(st, cfg) {      // the bot's own $ pot: budget + settled P&L; open orders are tied up
  const settled = st.orders.filter(o => o.out != null), open = st.orders.filter(o => o.out == null && o.status !== "error" && (o.filled || 0) > 0);
  const realized = +settled.reduce((a, o) => a + (o.pnl || 0), 0).toFixed(2);
  const openCost = +open.reduce((a, o) => a + o.filled * (o.limit + kalshiFee(o.limit)), 0).toFixed(2);
  const day = new Date().toISOString().slice(0, 10), today = settled.filter(o => new Date(o.close * 1000).toISOString().slice(0, 10) === day);
  return { realized, openCost, equity: +(cfg.budget + realized).toFixed(2), available: +(cfg.budget + realized - openCost).toFixed(2),
    todayPnl: +today.reduce((a, o) => a + (o.pnl || 0), 0).toFixed(2), wins: settled.filter(o => o.won && o.filled).length, filledBets: settled.filter(o => o.filled).length };
}
function liveGate(st, cfg, nowMs) {  // reason the bot must not trade right now, or null
  if (!cfg.on) return "LIVE_TRADING is not on";
  if (!cfg.hasKey) return "no trading key set";
  if (st.halted) return "stopped" + (st.haltReason ? ": " + st.haltReason : "");
  const a = liveAccount(st, cfg), day = new Date(nowMs).toISOString().slice(0, 10);
  if (a.equity < cfg.floor) return `pot is down to $${a.equity}, below the $${cfg.floor} floor`;
  if (a.todayPnl <= -cfg.dailyLoss * cfg.budget) return `daily loss limit hit ($${a.todayPnl})`;
  if (st.orders.filter(o => new Date(o.at * 1000).toISOString().slice(0, 10) === day).length >= cfg.maxOrdersDay) return "daily order limit hit";
  return null;
}
function liveSize(equity, available, d, maxStake) {   // whole contracts: min(maxStake, half Kelly) of the pot, never more than is free or on offer
  const cost = d.price + kalshiFee(d.price), stake = Math.min(equity * Math.min(maxStake, d.kelly), available);
  let n = Math.floor(stake / cost); if (d.depth != null) n = Math.min(n, Math.floor(d.depth));
  return Math.max(0, n);
}
function parseBalance(j) { const c = num(j.balance); if (c != null) return c / 100; const d = num(j.balance_dollars); return d; }   // dollars
// Kalshi splits money across exchange shards; crypto markets trade on shard 2. API orders draw only on their market's shard.
const CRYPTO_SHARD = 2;
function parseShardBalances(j) {   // {exchange_index: dollars} from balance_breakdown, or null if absent
  const b = Array.isArray(j.balance_breakdown) ? j.balance_breakdown : null; if (!b) return null;
  const out = {}; for (const x of b) { const i = num(x.exchange_index), v = num(x.balance); if (i != null && v != null) out[i] = v; } return out;
}
function shardBalance(bal, shard) { // money usable for an order on `shard`; the total if Kalshi gave no breakdown
  if (bal == null) return null; if (typeof bal === "number") return bal;
  return shard != null && bal.shards && bal.shards[shard] != null ? bal.shards[shard] : bal.total;
}
const MANUAL_SLIP = 0.02, MANUAL_MIN_LEFT_S = 10;
function manualSpentToday(st, nowS) {  // dollars actually spent (filled contracts) on app buys today (UTC); sending orders count at their limit
  const day = new Date(nowS * 1000).toISOString().slice(0, 10);
  return st.orders.filter(o => new Date(o.at * 1000).toISOString().slice(0, 10) === day && o.status !== "error")
    .reduce((a, o) => { const n = o.status === "sending" ? o.count : (o.filled || 0), px = o.avg != null ? o.avg : o.limit; return a + n * (px + kalshiFee(px)); }, 0);
}
function shardName(i) { return i === 2 ? "crypto" : i === 0 ? "default" : `#${i}`; }
function parseFilled(od, count) {
  for (const k of ["fill_count", "fill_count_fp", "taker_fill_count"]) { const v = num(od[k]); if (v != null) return v; }
  const rem = num(od.remaining_count ?? od.remaining_count_fp), init = num(od.initial_count ?? od.initial_count_fp) ?? count;
  if (rem != null) return Math.max(0, init - rem);
  return String(od.status || "") === "executed" ? count : 0;
}
function parseFills(j, side) {       // fills that put us long `side` ("yes"/"no") in one market: contracts, average price, fees
  let n = 0, cost = 0, fee = 0, anyFee = false;
  for (const f of (j.fills || [])) {
    let dir = f.outcome_side || (f.book_side ? (f.book_side === "bid" ? "yes" : "no") : null);
    if (!dir && f.side) dir = String(f.action || "buy") === "buy" ? f.side : (f.side === "yes" ? "no" : "yes");     // legacy fields
    if (dir !== side) continue;
    const c = num(f.count_fp ?? f.count); const pd = num(side === "yes" ? f.yes_price_dollars ?? f.yes_price_fixed : f.no_price_dollars ?? f.no_price_fixed);
    const pc = num(side === "yes" ? f.yes_price : f.no_price); const p = pd != null ? pd : pc != null ? pc / 100 : null;
    if (c == null || p == null) continue; n += c; cost += c * p;
    const fc = num(f.fee_cost); if (fc != null) { fee += fc; anyFee = true; }
  }
  return n ? { count: n, avg: +(cost / n).toFixed(4), fee: anyFee ? +fee.toFixed(4) : null } : null;
}
// Kalshi's price grid (market.price_ranges); default = this series' tapered grid: 0.1c below 10c and above 90c, 1c between.
const DEFAULT_RANGES = [{ start: "0.0000", end: "0.1000", step: "0.0010" }, { start: "0.1000", end: "0.9000", step: "0.0100" }, { start: "0.9000", end: "1.0000", step: "0.0010" }];
function snapPrice(p, ranges, dir) {  // nearest valid price at or below (dir "down") or at or above ("up") p, kept inside (0, 1)
  const rs = (ranges && ranges.length ? ranges : DEFAULT_RANGES).map(r => ({ a: num(r.start), b: num(r.end), st: num(r.step) })).filter(r => r.a != null && r.b != null && r.st > 0);
  const r = rs.find(x => p >= x.a - 1e-9 && p <= x.b + 1e-9) || rs[0]; if (!r) return p;
  const k = (p - r.a) / r.st, n = dir === "up" ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9);
  let v = +(r.a + n * r.st).toFixed(4);
  const lo = rs.length ? Math.min(...rs.map(x => x.st)) : 0.001;
  return Math.min(1 - lo, Math.max(lo, v));
}
// V2 order body. Our side's limit (max we pay per contract) is converted to the YES book and snapped so we never pay more.
function liveOrderBody(ticker, id, side, limit, count, ranges) {
  const yesPx = side === "yes" ? snapPrice(limit, ranges, "down") : snapPrice(1 - limit, ranges, "up");
  return { ticker, client_order_id: id, side: side === "yes" ? "bid" : "ask", count: String(count), price: yesPx.toFixed(4),
    time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", limitOurSide: +(side === "yes" ? yesPx : 1 - yesPx).toFixed(4) };
}
function liveOrderResult(res, side) { // V2 create-order response -> our order record (prices on our side)
  const filled = num(res.fill_count) ?? 0, rem = num(res.remaining_count), avgYes = num(res.average_fill_price), fee = num(res.average_fee_paid);
  return { orderId: res.order_id || null, filled, status: filled > 0 ? (rem > 0 ? "partly filled" : "filled") : "not filled",
    ...(avgYes != null && filled > 0 ? { avg: +(side === "yes" ? avgYes : 1 - avgYes).toFixed(4) } : {}), ...(fee != null && filled > 0 ? { feeEach: fee } : {}) };
}
export { candles1m, luckCheck, CANDLE_STRATS, candleDecide, paperEdge, lastTrade, yesFromMarket, quoteFromBook, paperDecide, paperSim, paperBreakdown, paperDaily, liveResult, liveAccount, liveGate, liveSize, parseBalance, parseShardBalances, shardBalance, manualSpentToday, parseFilled, parseFills, snapPrice, liveOrderBody, liveOrderResult };
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
