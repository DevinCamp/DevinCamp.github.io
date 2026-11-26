// Candle strategies: 1-min candles from the index, each pattern, the betting rule, paper records, settlement and the
// LIVE_STRATEGY switch. Offline, mocked Kalshi.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert"; import crypto from "crypto";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_candles.mjs"); fs.writeFileSync(f, src);
const M = await import(f);
const { candles1m, CANDLE_STRATS, candleDecide, luckCheck, dailyStandings, Relay } = M;
M._setLiveRetryMs(0);

// ---- 1-minute candles: closed minutes only, oldest first
const sec = []; for (let t = 600; t < 840; t++) sec.push([t, 100 + (t - 600)]);   // a steady climb over 4 minutes
const c4 = candles1m(sec, 835, 10);
assert.equal(c4.length, 3, "the minute still in progress is left out");
assert.deepEqual(c4[0], { t: 600, o: 100, h: 159, l: 100, c: 159 });

// candle helpers: [open, high, low, close]
const C = (o, h, l, c, t = 0) => ({ t, o, h, l, c });
const S = CANDLE_STRATS;
// momentum
assert.deepEqual(S.momentum.fn([C(1, 3, 1, 2), C(2, 4, 2, 3), C(3, 5, 3, 4)]).dir, 1);
assert.deepEqual(S.momentum.fn([C(4, 4, 2, 3), C(3, 3, 1, 2), C(2, 2, 0, 1)]).dir, -1);
assert.equal(S.momentum.fn([C(1, 3, 1, 2), C(2, 4, 1, 1), C(3, 5, 3, 4)]), null);
// engulfing
assert.equal(S.engulfing.fn([C(10, 10.5, 8.5, 9), C(8.8, 10.6, 8.7, 10.4)]).dir, 1, "bullish engulfing");
assert.equal(S.engulfing.fn([C(9, 10.5, 8.8, 10), C(10.2, 10.3, 8.5, 8.7)]).dir, -1, "bearish engulfing");
assert.equal(S.engulfing.fn([C(10, 10.5, 8.5, 9), C(9.2, 9.8, 9.1, 9.6)]), null, "not engulfing");
// hammer / shooting star
assert.equal(S.hammer.fn([C(10, 10.1, 7, 10.05)]).dir, 1, "hammer");
assert.equal(S.hammer.fn([C(10, 13, 9.95, 9.97)]).dir, -1, "shooting star");
assert.equal(S.hammer.fn([C(10, 11, 9, 10.8)]), null, "ordinary candle");
// breakout
const flat5 = [C(10, 11, 9, 10), C(10, 11, 9, 10.2), C(10, 11, 9, 9.9), C(10, 11, 9, 10.1), C(10, 11, 9, 10)];
assert.equal(S.breakout.fn([...flat5, C(10, 11.6, 10, 11.5)]).dir, 1);
assert.equal(S.breakout.fn([...flat5, C(10, 10, 8.5, 8.6)]).dir, -1);
assert.equal(S.breakout.fn([...flat5, C(10, 10.9, 9.2, 10.5)]), null);
// fade
const quiet10 = Array.from({ length: 10 }, () => C(10, 10.5, 9.5, 10.2));
assert.equal(S.fade.fn([...quiet10, C(10, 13.2, 10, 13)]).dir, -1, "big green: fade down");
assert.equal(S.fade.fn([...quiet10, C(10, 10, 7, 7.2)]).dir, 1, "big red: fade up");
assert.equal(S.fade.fn([...quiet10, C(10, 11, 9.8, 10.9)]), null);

// ---- betting rule: needs a signal AND a 3-pt edge on the signal's side after the 8-pt tilt
const up3 = [C(1, 3, 1, 2), C(2, 4, 2, 3), C(3, 5, 3, 4)];
let r = candleDecide("momentum", up3, 0.50, { bid: 0.49, ask: 0.51, askSize: 100, bidSize: 100 });
assert(r.d && r.d.side === "yes" && Math.abs(r.p - 0.58) < 1e-9, "tilted to 58% vs a 52c all-in cost: bet UP");
r = candleDecide("momentum", up3, 0.50, { bid: 0.60, ask: 0.62, askSize: 100, bidSize: 100 });
assert.equal(r.d, null, "signal UP but UP costs too much: no bet"); assert(r.sig);
r = candleDecide("momentum", up3, 0.10, { bid: 0.49, ask: 0.51, askSize: 100, bidSize: 100 });
assert.equal(r.d, null, "the model says DOWN strongly: an UP signal can't override it into a DOWN bet");
assert.equal(candleDecide("momentum", [C(1, 2, 0, 1)], 0.5, { bid: 0.49, ask: 0.51 }), null, "no signal");

// ---- relay flow
const pem = k => k.export({ type: "pkcs8", format: "pem" });
const env = { LIVE_TRADING: "on", KALSHI_TRADE_KEY_ID: "t", KALSHI_TRADE_PRIVATE_KEY: pem(crypto.generateKeyPairSync("ed25519").privateKey), RELAY_CODE: "c" };
const cl = Math.ceil(Date.now() / 1000 / 900) * 900 + 900, now = cl - 300;
// flat at the target, then three rising 1-minute candles ending right at the target: model ~50%, momentum UP
const series = () => { const pts = []; for (let t = cl - 900 - 200; t <= now; t++) {
  let v = 100000; const m = Math.floor((now - t) / 60);                    // whole minutes before now
  if (t >= now - 240 && t < now - 60) v = 99994 + ((t - (now - 240)) / 180) * 6;     // 3 closed minutes climbing to the target
  pts.push([t, v + (t % 2) * 0.3]); } return pts; };
const mk = e2 => { const mem = new Map(), r2 = Object.create(Relay.prototype); r2.env = e2; r2.bootAt = Date.now() - 3600e3; r2.hist = new Map([["BRTI", series()]]);
  r2.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } }; return [r2, mem]; };
let calls = [];
const kalshi = (o = {}) => async (url, opt = {}) => {
  const u = String(url), method = opt.method || "GET", J = (x, s = 200) => new Response(JSON.stringify(x), { status: s }); calls.push({ u, method, body: opt.body ? JSON.parse(opt.body) : null });
  if (u.includes("/portfolio/events/orders") && method === "POST") { const n = JSON.parse(opt.body).count; return J({ order_id: "o", fill_count: n + ".00", remaining_count: "0.00", average_fill_price: "0.5200" }, 201); }
  if (u.includes("/portfolio/balance")) return J({ balance: 5000 });
  if (u.includes("/portfolio/fills")) return J({ fills: [] });
  if (u.includes("/orderbook")) return J({ orderbook_fp: { yes_dollars: [["0.4900", "500"]], no_dollars: [["0.4900", "500"]] } });   // Up 51c, Down 51c
  if (u.includes("/markets/trades")) return J({ trades: [] });
  if (u.includes("status=settled")) return J({ markets: [{ close_time: new Date((o.settledClose || cl) * 1000).toISOString(), result: "yes" }] });
  return J({ markets: [{ ticker: "KXBTC15M-T", exchange_index: 2, close_time: new Date(cl * 1000).toISOString() }] });
};
const posts = () => calls.filter(c => c.method === "POST");

// paper: momentum bets UP; the model alone has no edge at ~50% vs 51c, so it doesn't
let [rr, mem] = mk({}); globalThis.fetch = kalshi();
const cs = candles1m(rr.hist.get("BRTI"), now, 12);
assert.equal(S.momentum.fn(cs) && S.momentum.fn(cs).dir, 1, "the test series shows 3 green minutes");
await rr.checkpoints("BTC-USD", now);
const mb = mem.get("cpaper:momentum"); assert(mb && mb.length === 1 && mb[0].side === "yes", JSON.stringify(mb));
assert.match(mb[0].why, /3 green 1-min candles/);
assert.equal(mem.get("paper3:BTC-USD"), undefined, "the model alone didn't bet");
const lg = (mem.get("desklog") || []).filter(x => x.kind === "CANDLE"); assert.equal(lg.length, 1); assert.match(lg[0].what, /^3-candle momentum: UP @ 52¢ · 5-min check$/);
await rr.checkpoints("BTC-USD", now + 120);   // a later checkpoint in the same round: no second bet
assert.equal(mem.get("cpaper:momentum").length, 1);

// settle + report
const past = Math.floor(Date.now() / 1000 / 900) * 900 - 900, b0 = mem.get("cpaper:momentum"); b0[0].close = past; mem.set("cpaper:momentum", b0);
globalThis.fetch = kalshi({ settledClose: past });
const rep = await rr.paperReport();
const mrow = rep.strategies.find(x => x.name === "momentum"); assert.equal(mrow.bets, 1); assert.equal(mrow.wins, 1); assert(mrow.pnl > 0);
assert.equal(rep.strategies[0].name, "model"); assert.equal(rep.strategies.length, 6); assert.equal(rep.liveStrategy, "model");
assert.equal(mrow.verdict, "too few", "1 bet is too few to judge"); assert(mrow.breakEven > 0 && mrow.breakEven < 1);
assert.equal(rep.strategies[0].baseline, true); assert.equal(rep.strategies[0].verdict, "no bets");

// luck check: break-even = average price + fee; |z| < 2 is luck, 30+ bets needed for a verdict
const LB = (n, wins, price) => Array.from({ length: n }, (_, i) => ({ close: 1000 + i * 900, side: "yes", price, fee: 0.07 * price * (1 - price), out: i < wins ? "up" : "down" }));
assert.equal(luckCheck([]).verdict, "no bets");
assert.equal(luckCheck(LB(20, 20, 0.5)).verdict, "too few");
let lc = luckCheck(LB(100, 52, 0.5)); assert.equal(lc.verdict, "luck"); assert(Math.abs(lc.breakEven - 0.5175) < 0.001);
lc = luckCheck(LB(100, 75, 0.5)); assert.equal(lc.verdict, "edge"); assert(lc.z >= 2);
lc = luckCheck(LB(100, 30, 0.5)); assert.equal(lc.verdict, "losing"); assert(lc.z <= -2);
lc = luckCheck(LB(200, 40, 0.2)); assert.equal(lc.verdict, "luck", "cheap contracts winning about as often as priced");
assert.equal(luckCheck([...LB(40, 40, 0.5), { close: 1, side: "yes", price: 0.5, fee: 0.0175, out: null }]).verdict, "edge", "open bets are ignored");

// live: default (model) places nothing here; LIVE_STRATEGY=momentum places the candle bet with real money
[rr, mem] = mk(env); calls = []; globalThis.fetch = kalshi(); await rr.checkpoints("BTC-USD", now);
assert.equal(posts().length, 0, "model-driven live bot: no edge, no order");
[rr, mem] = mk({ ...env, LIVE_STRATEGY: "momentum" }); calls = []; globalThis.fetch = kalshi(); await rr.checkpoints("BTC-USD", now);
assert.equal(posts().length, 1); assert.equal(posts()[0].body.side, "bid", "buys UP");
const lo = mem.get("live").orders[0]; assert.equal(lo.strategy, "momentum");
assert.match((mem.get("desklog") || []).find(x => x.kind === "BET").why, /3-candle momentum/);
[rr, mem] = mk({ ...env, LIVE_STRATEGY: "nonsense" }); assert.equal(rr.liveConfig().strategy, "model", "unknown names fall back to the model");
// ---- daily standings push: yesterday's flat-stake P&L per strategy, best first, once per UTC day
const D0 = Date.UTC(2026, 10, 25) / 1000, bet = (close, side, price, out) => ({ close, side, price, fee: 0.07 * price * (1 - price), out });
const sets = { model: { label: "settle model", bets: [bet(D0 + 900, "yes", 0.5, "down")] },
  fade: { label: "big-candle fade", bets: [bet(D0 + 900, "yes", 0.2, "up"), bet(D0 + 1800, "no", 0.3, "down"), bet(D0 - 900, "yes", 0.5, "up")] },
  hammer: { label: "hammer / shooting star", bets: [] } };
let ds = dailyStandings(sets, "2026-11-25");
assert.equal(ds.rows[0].name, "fade"); assert.equal(ds.rows[0].bets, 2, "only that UTC day's bets count"); assert.equal(ds.rows[2].name, "hammer", "no bets go last");
assert.match(ds.title, /big-candle fade leads \+\$/); assert.match(ds.body, /settle model −\$/); assert(!/hammer/.test(ds.body));
assert.equal(dailyStandings({ hammer: sets.hammer }, "2026-11-25").title, "Paper 2026-11-25: no settled bets");
{
  const [r3, m3] = mk({}); const pushed = [];
  r3.ctx.storage.list = async () => new Map([["sub:a", { sub: {}, coin: "BTC-USD", sens: "med" }]]);
  r3.push = async (rec, msg) => { pushed.push(msg); return { ok: true, status: 201 }; };
  m3.set("paper3:BTC-USD", sets.model.bets); m3.set("cpaper:fade", sets.fade.bets);
  const t = D0 + 86400;                                      // 2026-11-26 00:00 UTC
  assert.equal(await r3.dailySummary(t + 300), null, "waits until 10 minutes past the hour");
  const got = await r3.dailySummary(t + 700); assert.equal(got.day, "2026-11-25"); assert.equal(pushed.length, 1); assert.equal(pushed[0].tag, "walls-daily");
  assert.equal(await r3.dailySummary(t + 4000), null, "once per day"); assert.equal(pushed.length, 1);
  assert.equal(m3.get("dailysum").day, "2026-11-25"); assert((m3.get("desklog") || []).some(x => x.kind === "DAILY"));
  const [r4] = mk({ DAILY_SUMMARY: "off" }); assert.equal(await r4.dailySummary(t + 700), null, "DAILY_SUMMARY=off");
  const [r5] = mk({ DAILY_SUMMARY_UTC_HOUR: "14" }); assert.equal(await r5.dailySummary(t + 700), null, "moved to 14:10 UTC");
}
console.log("candle strategy tests passed");
