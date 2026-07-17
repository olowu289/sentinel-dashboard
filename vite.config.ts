import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    allowedHosts: [
      'localhost',
      'kallon-sentry-production.up.railway.app',
      '.up.railway.app',
      '.ngrok-free.dev',
    ],
    proxy: {
      // Dev-only same-origin /v1 → control plane. Target = VITE_PLATFORM_PROXY or Railway.
      '/v1': {
        target:
          process.env.VITE_PLATFORM_PROXY ??
          process.env.VITE_PLATFORM_URL ??
          'https://kallon-sentry-production.up.railway.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
