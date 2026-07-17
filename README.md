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

**API base URL (one place):** `src/config.ts` reads `VITE_PLATFORM_URL`
(defaults to Railway). Login, `@sentinel/sdk`, and HLS all use the session
`baseUrl` derived from that. To retarget: change `.env.production` /
`.env.development` / Vercel `VITE_PLATFORM_URL`, rebuild.

Sign in with:

| Field | Example |
|-------|---------|
| Control plane URL | `https://kallon-sentry-production.up.railway.app` (pre-filled) |
| API key | Your `KALLON_PLATFORM_API_KEY` |
| Customer ID | `cust_lab` |

## Production (Vercel)

```bash
# Vercel project env (Production):
#   VITE_PLATFORM_URL=https://kallon-sentry-production.up.railway.app
git push origin main   # or merge — Vercel builds with .env.production
```

## Features (v1)

- Registry-backed tower list + drawer (filter/search)
- Per-tower: **live HLS** feeds via Platform API (`/v1/towers/{id}/live/camN/...`),
  PTZ, sensors, alerts (SSE)
- Continuous NVR **recording toggle** (`GET`/`PUT /v1/towers/{id}/recording`) —
  same control as the Jetson sentinel-console
- One-shot snapshot download (toolbar) — continuous JPEG polling removed
- REC indicator from Platform recording status

## Live video

Tiles play HLS from the control plane (hub MediaMTX remux — see kallon-sentry
`docs/customer-live-video.md`). Requires hub HLS agent (`:8768`) cut over and
Artemis Platform live routes deployed.

## Not in v1

- Claim-code add tower UI
- Per-customer API key scoping
