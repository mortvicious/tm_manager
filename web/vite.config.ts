import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// LAN mode (docs/mobile.md) — opt-in, so the dev server stays on loopback by
// default exactly like the API server. `npm run dev:lan` sets it for both.
const lan = process.env.TM_LAN === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned: the server's own help text points people at 5173, and a silent
    // hop to 5174 makes that advice wrong.
    port: 5173,
    // `true` = every interface, so a phone on the same Wi-Fi reaches :5173.
    host: lan ? true : 'localhost',
    // Vite refuses non-IP Host headers by default; `.local` (Bonjour) is how
    // iOS resolves this machine, and the proxy target below is fixed anyway.
    ...(lan ? { allowedHosts: true as const } : {}),
    proxy: {
      // changeOrigin rewrites Host to the target so the server's
      // DNS-rebinding Host allowlist passes in dev. It does NOT rewrite
      // Origin — a LAN phone's non-GET and WS traffic still arrives with its
      // own origin, which is why the server needs TM_LAN too.
      '/api': { target: 'http://127.0.0.1:5175', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5175', ws: true, changeOrigin: true },
      // The front door (docs/host.md), not the API — it is the process that
      // stops and starts the API, so it has to answer when the API does not.
      // `npm run dev:web` alone leaves this unanswered and the header simply
      // shows no Start button; nothing else in the page depends on it.
      '/host': { target: 'http://127.0.0.1:5176', changeOrigin: true },
    },
  },
});
