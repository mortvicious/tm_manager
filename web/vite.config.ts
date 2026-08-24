import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin rewrites Host to the target so the server's
      // DNS-rebinding Host allowlist passes in dev.
      '/api': { target: 'http://127.0.0.1:5175', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5175', ws: true, changeOrigin: true },
    },
  },
});
