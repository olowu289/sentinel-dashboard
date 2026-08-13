import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server no longer proxies anything.
 *
 * It used to forward /v1 to the Railway control plane so the browser could
 * talk to it same-origin. There is no control plane now: the app calls the
 * tower's gateway directly at VITE_LOCAL_CONTROL_HOST, and the gateway sets
 * permissive CORS itself (see gateway.py's CORS_ALLOW_ORIGIN), so there is
 * nothing to work around.
 *
 * That means the dev machine has to actually be on the camera segment. It is
 * the same requirement the built app has, which is the point - dev and
 * production now fail in the same way for the same reason, instead of dev
 * quietly working through a proxy that will not exist in the field.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
  },
});
