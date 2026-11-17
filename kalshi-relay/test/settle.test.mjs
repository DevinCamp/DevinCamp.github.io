// Settle model: sanity checks, and the relay and app copies must be identical.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const grab = f => { const t = fs.readFileSync(new URL(f, import.meta.url), "utf8"); const a = t.indexOf("// --- settle model"), b = t.indexOf("// --- end settle model"); assert(a >= 0 && b > a, f); return t.slice(a, b); };
const relay = grab("../src/index.js"), app = grab("../../walls/index.html");
assert.equal(relay, app, "relay and app settle models differ");
const f = path.join(os.tmpdir(), "settle_mod.mjs"); fs.writeFileSync(f, relay + "\nexport { settleModel, normCdf };");
const { settleModel, normCdf } = await import(f);
assert(Math.abs(normCdf(0) - 0.5) < 1e-6 && Math.abs(normCdf(1.96) - 0.975) < 1e-3);
const close = 900 * 1000, now = close - 60, open = close - 900;
const series = (level, wob = 1, end = now) => { const p = []; for (let t = open - 120; t <= end; t++) p.push([t, (t < open ? 100000 : level) + Math.sin(t) * wob]); return p; };
const hi = settleModel(series(100050), close, now, 0), lo = settleModel(series(99950), close, now, 0);
assert(hi.p > 0.99 && lo.p < 0.01, "far above/below target should be near certain");
const flat = settleModel(series(100000), close, now, 0); assert(Math.abs(flat.p - 0.5) < 0.1);
assert(settleModel(series(100000), close, now, 1).pc > flat.pc, "buy lean raises odds");
assert.equal(settleModel(series(100000).slice(-50), close, now, 0), null, "too little data");
assert(settleModel(series(100001, 3, close - 5), close, close - 5, 0).sd < settleModel(series(100001, 3), close, now, 0).sd, "less time left, less uncertainty");
console.log("settle tests passed");
