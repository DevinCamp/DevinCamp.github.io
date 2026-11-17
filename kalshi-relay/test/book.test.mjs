// fetchBook: Coinbase first, 429 -> 2 min backoff + Kraken fallback. Fully offline (fetch is mocked).
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const tmp = path.join(os.tmpdir(), "relay_mod_book.mjs"); fs.writeFileSync(tmp, src);
const { fetchBook } = await import(tmp);

const calls = [];
let cb = "ok";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
globalThis.fetch = async (url) => {
  calls.push(String(url).includes("coinbase") ? "coinbase" : "kraken");
  if (String(url).includes("coinbase")) {
    if (cb === "429") return json({}, 429);
    return json({ pricebook: { bids: [{ price: "100", size: "2" }], asks: [{ price: "101", size: "3" }] } });
  }
  return json({ error: [], result: { XBTUSD: { bids: [["99", "1", 0]], asks: [["102", "1", 0]] } } });
};

let b = await fetchBook("BTC-USD");
assert.equal(b.src, "coinbase"); assert.equal(b.mid, 100.5);

cb = "429";
b = await fetchBook("BTC-USD");                      // 429 -> falls back to Kraken and starts backoff
assert.equal(b.src, "kraken"); assert.equal(b.mid, 100.5);

calls.length = 0; cb = "ok";
b = await fetchBook("BTC-USD");                      // inside backoff: Coinbase must not be called
assert.equal(b.src, "kraken"); assert.deepEqual(calls, ["kraken"]);

await assert.rejects(() => fetchBook("FOO-USD"));    // no source for unknown coin
console.log("book tests passed");
