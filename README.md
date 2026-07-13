# Sentinel Dashboard

Buyer-facing Terra dashboard: multi-tower Sentinel console over the **Kallon Platform API**.

## Stack

- Vite + React + TypeScript
- [`@sentinel/sdk`](https://github.com/Yaqcodes/sentinel-sdk) — Platform API client (installed from GitHub on `npm install`)

## Development

**Standalone clone** (Artemis, CI, or one-repo checkout):

```bash
git clone https://github.com/olowu289/sentinel-dashboard.git
cd sentinel-dashboard
npm install   # pulls @sentinel/sdk from GitHub and builds it
npm run dev
```

**Local sibling checkout** (faster SDK iteration — optional):

```bash
# package.json uses the git dependency by default; for live SDK edits:
npm install ../sentinel-sdk/typescript
npm run dev
```

Open http://localhost:5174 — Vite proxies `/v1` to the control plane (see `vite.config.ts`).

Sign in with:

| Field | Example |
|-------|---------|
| Control plane URL | `https://hue-interseminal-hydrothermally.ngrok-free.dev` or leave blank in dev (uses proxy) |
| API key | Your `KALLON_PLATFORM_API_KEY` |
| Customer ID | `cust_acme` |

## Production (Artemis)

```bash
git pull
npm install
npm run build
# Serve dist/ behind nginx on Artemis; proxy /v1 to enrollment-api
```

Set `VITE_PLATFORM_URL` at build time for the API base URL, or serve dashboard and API on the same origin.

## Features (v1)

- Registry-backed tower list + drawer (filter/search)
- Per-tower: snapshot polling feeds, PTZ, sensors, alerts (SSE)
- REC indicator from stream readiness (no playback API yet)
- Screenshot download via Platform API snapshot

## Not in v1

- Live RTSP in browser (requires video relay + WG peer)
- Claim-code add tower UI
- Per-customer API key scoping
