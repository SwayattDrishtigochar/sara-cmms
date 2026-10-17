import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '..',
  server: {
    port: 5173,
    proxy: {
      // ws: the voice assistant's WebSocket (/api/voice) rides the same proxy.
      '/api': { target: `http://localhost:${process.env.PORTS || 5080}`, changeOrigin: true, ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
