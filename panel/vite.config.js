import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built panel is served by the seemore API process (app/public). No CDN: fonts and code are bundled.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: '../app/public', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': { target: process.env.SEEMORE_API || 'http://localhost:3902', changeOrigin: false } } },
});
