import fs from "fs"; import crypto from "crypto"; import http from "http"; import ece from "http_ece";
let src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
fs.writeFileSync("/tmp/relay_mod_push.mjs", src);
const { sendWebPush } = await import("/tmp/relay_mod_push.mjs");
// "phone" keys, as a browser creates for a push subscription
const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const auth = crypto.randomBytes(16);
// relay VAPID key
const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapid = { key: kp.privateKey, pub: Buffer.from(await crypto.webcrypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url") };
const got = await new Promise(resolve => {
  const srv = http.createServer((req, res) => { const ch = []; req.on("data", c => ch.push(c)); req.on("end", () => { res.writeHead(201).end(); srv.close(); resolve({ headers: req.headers, body: Buffer.concat(ch) }); }); });
  srv.listen(8811, async () => {
    const sub = { endpoint: "http://127.0.0.1:8811/push/abc", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
    const r = await sendWebPush(sub, JSON.stringify({ title: "▲ UP · BTC $74,400.00", body: "Buyers took over" }), vapid);
    console.log("push service replied", r.status);
  });
});
const plain = ece.decrypt(got.body, { version: "aes128gcm", privateKey: ua, dh: undefined, authSecret: auth.toString("base64url") });
console.log("decrypted payload:", plain.toString());
const m = /vapid t=([^,]+), k=(.+)/.exec(got.headers.authorization);
const [h, p, s] = m[1].split(".");
const pubKey = await crypto.webcrypto.subtle.importKey("raw", Buffer.from(m[2], "base64url"), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
const ok = await crypto.webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, Buffer.from(s, "base64url"), Buffer.from(h + "." + p));
console.log("VAPID JWT signature:", ok ? "VALID" : "INVALID", JSON.parse(Buffer.from(p, "base64url")));
console.log("headers:", got.headers["content-encoding"], "ttl", got.headers.ttl, "urgency", got.headers.urgency);
