// Paper trading: decision, fills (slippage + depth), flat and compounding replay, breakdown, and relay plumbing. Offline.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_paper.mjs"); fs.writeFileSync(f, src);
const { paperDecide, paperSim, paperBreakdown, paperDaily, yesFromMarket, quoteFromBook, lastTrade, histGap, packHist, unpackHist, Relay } = await import(f);

// ---- decision
assert.equal(paperDecide(0.5, 0.49, 0.51), null, "no edge, no bet");
assert.equal(paperDecide(0.95, 0.94, 0.96), null, "market already prices it: fee + slippage eat the edge");
const y = paperDecide(0.80, 0.55, 0.57, 40, 90); assert.equal(y.side, "yes"); assert.equal(y.price, 0.58, "fills at ask + 1 cent"); assert.equal(y.depth, 40);
const n = paperDecide(0.20, 0.55, 0.57, 40, 90); assert.equal(n.side, "no"); assert.equal(n.price, 0.46); assert.equal(n.depth, 90, "No side is limited by the Yes bid size");
assert.equal(paperDecide(0.8, null, 0.5), null, "needs a two-sided quote");

// ---- replay
const bet = (close, out, o = {}) => ({ close, t: 180, side: "yes", price: 0.5, fee: 0.0175, q: 0.7, edge: 0.18, kelly: 0.5, depth: 1000, out, ...o });
const cost = 0.5175;
const flatWin = paperSim([bet(1e9, "up"), bet(1e9 + 900, null)], { flat: 25 });          // unsettled ignored
assert.equal(flatWin.bets, 1); assert(Math.abs(flatWin.pnl - 25 / cost * (1 - cost)) < 0.01);
const flatLoss = paperSim([bet(1e9, "down")], { flat: 25 }); assert(Math.abs(flatLoss.pnl + 25) < 0.01);
const thin = paperSim([bet(1e9, "up", { depth: 5 })], { flat: 25 });                       // only 5 contracts on offer
assert(Math.abs(thin.pnl - 5 * (1 - cost)) < 0.01, "displayed depth caps the fill");
const unk = paperSim([bet(1e9, "up", { depth: null })], { flat: 1000 }); assert(Math.abs(unk.pnl - 20 * (1 - cost)) < 0.01, "unknown depth assumes 20 contracts");
const big = paperSim([bet(1e9, "up", { depth: 30 })], { cap: 0.2 }, 100000); assert(big.pnl < 30 * (1 - cost) + 0.01, "a huge account can't buy more than is displayed");
const l = paperSim([bet(1e9, "down")], { cap: 0.20 }); assert(Math.abs(l.equity - 800) < 1e-6 && Math.abs(l.maxDD - 0.2) < 1e-6);
const stop = paperSim([bet(1e9, "down"), bet(1e9 + 900, "down"), bet(1e9 + 1800, "down")], { cap: 0.20 });
assert.equal(stop.bets, 2, "daily 20% loss stop");

// ---- breakdown
const bd = paperBreakdown([bet(1e9, "up", { t: 300, price: 0.2 }), bet(1e9 + 900, "down", { t: 60, price: 0.9 })]);
assert.deepEqual(bd.map(r => r.key).sort(), ["p<30", "p>70", "t300", "t60"]);
assert.equal(bd.find(r => r.key === "p<30").wins, 1);
assert.equal(yesFromMarket({ yes_bid: 40, yes_ask: 44 }), 0.42);

// ---- relay plumbing with fake storage and mocked Kalshi
const mem = new Map();
const relay = Object.create(Relay.prototype);
relay.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } };
const close = Math.floor(Date.now() / 1000 / 900) * 900 - 900;               // a window that closed ~10-25 min ago
const quote = { yes: 0.56, bid: 0.55, ask: 0.57, askSize: 80, bidSize: 60 };
await relay.paperBet(close, 180, 0.85, quote);
await relay.paperBet(close, 120, 0.85, quote);                                // same window: ignored
await relay.paperBet(close + 900, 180, 0.50, { yes: 0.50, bid: 0.49, ask: 0.51 });   // no edge: no bet
assert.equal(mem.get("paper3:BTC-USD").length, 1);
globalThis.fetch = async () => new Response(JSON.stringify({ markets: [{ close_time: new Date(close * 1000).toISOString(), result: "yes" }] }));
const rep = await relay.paperReport();
assert.equal(rep.open, 0); assert.equal(rep.settled, 1);
const flat = rep.sims.find(x => x.flat); assert.equal(flat.bets, 1); assert(flat.pnl > 0 && flat.pnl <= 80 * 0.42 + 0.01);

// ---- order book parsing: bids only; Yes ask = 1 - best No bid; cents or dollars; quantities at the best price add up
const qb = quoteFromBook({ orderbook: { yes: [[40, 10], [55, 30], [55, 5]], no: [[30, 20], [43, 80]] } });
assert.deepEqual([qb.bid, qb.ask, qb.bidSize, qb.askSize, qb.yes], [0.55, 0.57, 35, 80, 0.56]);
const qd = quoteFromBook({ orderbook_fp: { yes_dollars: [["0.5500", "60"]], no_dollars: [["0.4300", "80"]] } });
assert.deepEqual([qd.bid, qd.ask, qd.bidSize, qd.askSize], [0.55, 0.57, 60, 80]);
const q1 = quoteFromBook({ orderbook: { yes: [[20, 5]], no: null } }); assert.equal(q1.ask, null); assert.equal(q1.bid, 0.2);
assert.equal(quoteFromBook({ orderbook: { yes: null, no: null } }), null);

// ---- checkpoint flow: market list for the ticker and comparison, live order book for the paper bet
const mkRelay = () => { const m = new Map(), r = Object.create(Relay.prototype); r.env = {};
  r.ctx = { storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } } }; return [r, m]; };
const cl = Math.ceil(Date.now() / 1000 / 900) * 900 + 900, now = cl - 180, pts = [];
for (let t = cl - 900 - 200; t <= now; t++) pts.push([t, (t < cl - 900 ? 100000 : 100060) + Math.sin(t)]);
const listJson = { markets: [{ ticker: "KXBTC15M-TEST", close_time: new Date(cl * 1000).toISOString(), yes_bid_dollars: "0.3000", yes_ask_dollars: "0.3200" }] };
const bookJson = { orderbook: { yes: [[55, 60]], no: [[43, 80]] } };
const route = (delay = 0) => async url => { if (delay) await new Promise(r => setTimeout(r, delay));
  return new Response(JSON.stringify(String(url).includes("/orderbook") ? bookJson : listJson)); };

let [r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts]]); r2.bootAt = Date.now() - 3600e3;
globalThis.fetch = route();
await r2.checkpoints("BTC-USD", now);
const cp = mem2.get("cp:BTC-USD"); assert(cp && cp.length === 1 && cp[0].t === 180 && cp[0].yes === 0.31, "checkpoint row keeps the market-list price");
let st = mem2.get("paperstat3"); assert.deepEqual([st.cps, st.book, st.sized, st.stale, st.warmup, st.diffN, st.diff5], [1, 1, 1, 0, 0, 1, 1]);
const pb = mem2.get("paper3:BTC-USD");
assert(pb && pb.length === 1 && pb[0].side === "yes", "bets on the live book");
assert.equal(pb[0].price, 0.58, "live ask 57c + 1c, not the list's 32c"); assert.equal(pb[0].depth, 80); assert.equal(pb[0].listYes, 0.31);

[r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts.filter(p => p[0] < cl - 400 || p[0] > cl - 330)]]);   // restarted mid-round: a 70 s hole
globalThis.fetch = route(); await r2.checkpoints("BTC-USD", now);
assert.equal(mem2.get("paperstat3").warmup, 1); assert.equal(mem2.get("paper3:BTC-USD"), undefined, "no bets with a hole in this round's history");
[r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts.filter(p => p[0] < cl - 1500 || p[0] > cl - 1000)]]);  // a hole before this round doesn't matter
globalThis.fetch = route(); await r2.checkpoints("BTC-USD", now);
assert.equal(mem2.get("paperstat3").warmup, 0); assert.equal(mem2.get("paper3:BTC-USD").length, 1, "bets right after a restart once the round is covered");

// histGap: largest hole between from and to, edges included; small steps (<= 10 s) are fine
const ser = (a, b, step = 1) => { const o = []; for (let t = a; t <= b; t += step) o.push([t, 1]); return o; };
assert.equal(histGap(ser(0, 1000), 100, 900), 0);
assert.equal(histGap(ser(0, 1000, 5), 100, 900), 0, "a tick every 5 s is unbroken");
assert.equal(histGap([...ser(0, 400), ...ser(460, 1000)], 100, 900), 60);
assert.equal(histGap(ser(300, 1000), 100, 900), 200, "history starting late = a hole at the start");
assert.equal(histGap(ser(0, 850), 100, 900), 50, "history ending early = a hole at the end");
assert.equal(histGap([], 100, 900), 800);
// packHist / unpackHist round-trip
const hh = [[1795700000, 60537.26], [1795700001, 60537.5], [1795700003, 60538]];
assert.deepEqual(unpackHist(packHist(hh)), hh); assert.deepEqual(unpackHist(packHist([])), []); assert.deepEqual(unpackHist(null), []);
// saveHist / loadHist: a restarted relay picks the saved hour back up, merged in front of fresh points
{
  const store = new Map(), mkS = () => { const r = Object.create(Relay.prototype); r.env = {}; r.hist = new Map();
    r.ctx = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))) } }; return r; };
  const n0 = Math.floor(Date.now() / 1000), a = mkS(); a.hist.set("BRTI", ser(n0 - 5000, n0 - 100).map(([t]) => [t, t % 97]));
  await a.saveHist(); assert(store.has("ixh:BRTI")); const savedLen = unpackHist(store.get("ixh:BRTI")).length;
  assert(savedLen >= 3500 && savedLen <= 3601, "keeps about the last hour: " + savedLen);
  a.hist.get("BRTI").push([n0 - 99, 1]); await a.saveHist(); assert.equal(unpackHist(store.get("ixh:BRTI")).length, savedLen, "at most once a minute");
  const b = mkS(); b.hist.set("BRTI", [[n0 - 10, 5], [n0 - 9, 6]]); await b.loadHist();
  const h = b.hist.get("BRTI"); assert.equal(h.length, savedLen + 2); assert.deepEqual(h.slice(-2), [[n0 - 10, 5], [n0 - 9, 6]]);
  assert(h.every((p, i) => !i || p[0] > h[i - 1][0]), "ascending"); await b.loadHist(); assert.equal(b.hist.get("BRTI").length, savedLen + 2, "loads once");
}

[r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts]]); r2.bootAt = Date.now() - 3600e3;
globalThis.fetch = route(1600); await r2.checkpoints("BTC-USD", now);                       // slow quote
assert.equal(mem2.get("paperstat3").stale, 1); assert.equal(mem2.get("paper3:BTC-USD"), undefined, "no bets on slow quotes");

[r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts]]); r2.bootAt = Date.now() - 3600e3;
globalThis.fetch = async url => String(url).includes("/orderbook") ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(listJson));
await r2.checkpoints("BTC-USD", now);
st = mem2.get("paperstat3"); assert.equal(st.bookFail, 1); assert(/500/.test(st.lastErr)); assert.equal(mem2.get("cp:BTC-USD").length, 1, "checkpoint still recorded");
[r2, mem2] = mkRelay(); r2.hist = new Map([["BRTI", pts]]);                                 // decided round: no offers left on Yes
globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes("/orderbook") ? { orderbook: { yes: [[99, 500]], no: [] } } : listJson));
await r2.checkpoints("BTC-USD", now);
st = mem2.get("paperstat3"); assert.equal(st.oneSided, 1); assert.equal(st.bookFail, 0, "a one-sided book isn't a failure");

// ---- trades check: which quote matches Kalshi's most recent trade
{
  const iso = s => new Date(s * 1000).toISOString(), n0 = Date.now() / 1000;
  assert.deepEqual(lastTrade({ trades: [{ created_time: iso(n0 - 50), yes_price: 40 }, { created_time: iso(n0 - 5), yes_price_dollars: "0.5600" }, { created_time: iso(n0 - 20), yes_price: 50 }] }), { yes: 0.56, at: Math.floor((n0 - 5) * 1000) / 1000 });
  assert.equal(lastTrade({ trades: [] }), null);
  const runWith = async tradesJson => {
    const [rt, mt] = mkRelay(); rt.hist = new Map([["BRTI", pts]]); rt.bootAt = Date.now() - 3600e3;
    globalThis.fetch = async url => { const u = String(url);
      if (u.includes("/markets/trades")) return tradesJson === "fail" ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(tradesJson));
      return new Response(JSON.stringify(u.includes("/orderbook") ? bookJson : listJson)); };
    await rt.checkpoints("BTC-USD", now); return mt.get("paperstat3");
  };
  let s1 = await runWith({ trades: [{ created_time: iso(Date.now() / 1000 - 5), yes_price: 56 }] });     // trades at 56c: the book (56c) is right, the list (31c) is not
  assert.equal(s1.trN, 1); assert.equal(s1.trBookCloser, 1); assert.equal(s1.trListCloser || 0, 0);
  assert(Math.abs(s1.trBook - 0) < 1e-9 && Math.abs(s1.trList - 0.25) < 1e-9);
  assert.equal(s1.cmps[0].trade, 0.56); assert(s1.cmps[0].tradeAge <= 6);
  assert.equal(s1.cps, 1, "checkpoint still counted once");
  s1 = await runWith({ trades: [{ created_time: iso(Date.now() / 1000 - 300), yes_price: 31 }] });     // old trade: shown, not scored
  assert.equal(s1.trN || 0, 0); assert.equal(s1.cmps[0].trade, 0.31); assert(s1.cmps[0].tradeAge >= 299);
  s1 = await runWith("fail");                                                                          // trades feed down: noted, nothing else breaks
  assert.match(s1.tradeErr, /503/); assert.equal(s1.book, 1);
}
console.log("paper tests passed");

// ---- daily P&L: grouped by UTC day, newest first, unsettled ignored
const D = 86400, d0 = Math.floor(Date.UTC(2026, 10, 18) / 1000);
const dly = paperDaily([bet(d0 + 3600, "up"), bet(d0 + 7200, "down"), bet(d0 + D + 100, "up"), bet(d0 + D + 200, null)]);
assert.deepEqual(dly.map(x => x.day), ["2026-11-19", "2026-11-18"]);
assert.equal(dly[0].bets, 1); assert(dly[0].pnl > 0);
assert.equal(dly[1].bets, 2); assert.equal(dly[1].wins, 1);
assert(Math.abs(dly[1].pnl - (25 / 0.5175 * (1 - 0.5175) - 25)) < 0.02);
console.log("paper daily tests passed");
