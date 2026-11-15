import fs from "fs"; import crypto from "crypto";
let src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8")
  .replace(/^import .*$/m, "class DurableObject {}");
fs.writeFileSync("/tmp/relay_mod_sign.mjs", src);
const mod = await import("/tmp/relay_mod_sign.mjs");
// expose private helper via re-eval
const { importKalshiKey } = mod;
const msg = "1700000000000GET/trade-api/ws/v2";
async function check(name, pem, verifyKey, alg) {
  const k = await importKalshiKey(pem);
  const sig = k.algorithm.name === "Ed25519" ? await crypto.webcrypto.subtle.sign("Ed25519", k, Buffer.from(msg))
    : await crypto.webcrypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, k, Buffer.from(msg));
  const ok = alg === "ed" ? crypto.verify(null, Buffer.from(msg), verifyKey, Buffer.from(sig))
    : crypto.verify("sha256", Buffer.from(msg), { key: verifyKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig));
  console.log(name.padEnd(28), k.algorithm.name, ok ? "VERIFIED" : "FAILED");
}
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
await check("RSA PKCS#1 (BEGIN RSA ...)", rsa.privateKey.export({ type: "pkcs1", format: "pem" }), rsa.publicKey, "rsa");
await check("RSA PKCS#8 (BEGIN PRIVATE)", rsa.privateKey.export({ type: "pkcs8", format: "pem" }), rsa.publicKey, "rsa");
const flat = rsa.privateKey.export({ type: "pkcs1", format: "pem" }).replace(/\n/g, " ");
await check("RSA PKCS#1, newlines lost", flat, rsa.publicKey, "rsa");
const rsa4 = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
await check("RSA 4096 PKCS#1", rsa4.privateKey.export({ type: "pkcs1", format: "pem" }), rsa4.publicKey, "rsa");
const ed = crypto.generateKeyPairSync("ed25519");
await check("Ed25519 PKCS#8", ed.privateKey.export({ type: "pkcs8", format: "pem" }), ed.publicKey, "ed");
