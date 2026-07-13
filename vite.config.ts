import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    allowedHosts: [
      'localhost',
      'hue-interseminal-hydrothermally.ngrok-free.dev',
      '.ngrok-free.dev',
    ],
    proxy: {
      '/v1': {
        target: process.env.VITE_PLATFORM_PROXY ?? 'https://hue-interseminal-hydrothermally.ngrok-free.dev',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
