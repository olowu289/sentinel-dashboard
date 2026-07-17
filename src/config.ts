/**
 * Single place to change the Platform API origin for the whole dashboard.
 *
 * Build-time: set VITE_PLATFORM_URL (Vercel / .env.production).
 * Dev proxy: vite.config.ts proxies `/v1` to the same host via VITE_PLATFORM_PROXY.
 * Runtime session: Login stores baseUrl in sessionStorage; SDK + HLS use that.
 */
const RAW =
  (import.meta.env.VITE_PLATFORM_URL as string | undefined)?.trim() ||
  'https://kallon-sentry-production.up.railway.app';

/** Canonical control-plane origin (no trailing slash). */
export const PLATFORM_URL = RAW.replace(/\/$/, '');

export const DEFAULT_CUSTOMER_ID = 'cust_lab';
