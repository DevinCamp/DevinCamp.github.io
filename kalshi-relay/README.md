# Kalshi relay for Live Walls Chart

A tiny Cloudflare Worker that holds a **read-only** Kalshi API key, connects to Kalshi's
CF Benchmarks value feed (the official index Kalshi's crypto markets settle on), and passes
the values to the Live Walls Chart app. Your Kalshi key stays in Cloudflare secrets.

Secrets to add in Cloudflare (Settings → Variables and Secrets, type "Secret"):

| Name | Value |
|---|---|
| `KALSHI_KEY_ID` | your Kalshi API key ID |
| `KALSHI_PRIVATE_KEY` | the entire private key file, including the BEGIN/END lines |
| `RELAY_CODE` | any access code you choose; enter the same code in the app |

Check it at `https://<your-worker>.workers.dev/status`.
