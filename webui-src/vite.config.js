import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is built directly into the Express server's static folder so the
// plugin container ships a single Node image (no nginx, no second stage).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/webui/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8341',
    },
  },
});
