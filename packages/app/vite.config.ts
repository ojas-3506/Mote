import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The PWA's build.
 *
 * **The app always talks to its own origin.** It never knows where the host
 * is. In production the host serves this bundle itself, so relative URLs are
 * the host. In development Vite runs on its own port and forwards
 * `/ccr/v1/*` to the daemon, so the same relative URLs reach the same place.
 *
 * That means the app code is identical in both modes, and there is no
 * "which host am I talking to?" setting to get wrong on a phone.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    // A phone on the LAN has to reach the dev server, so bind wider than
    // localhost. The proxy still points at the daemon on this machine.
    host: true,
    port: 5173,
    proxy: {
      '/ccr/v1': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // The session stream is a WebSocket, and the upgrade has to be
        // forwarded too.
        ws: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
