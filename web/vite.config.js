import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Served at the site root (increment 5 swap). The old AngularJS UI moved to
  // /legacy; the backend also keeps serving this same build at /v2 as an alias.
  base: '/',
  plugins: [preact()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page build: the mobile-first dashboard (index.html ->
      // src/next/main.jsx, served at `/`) plus the classic split-view
      // dashboard (classic.html -> src/main.jsx, see src/webServer.js's
      // `/classic` route). Both share the same state layer and output dir.
      input: {
        main: resolve(__dirname, 'index.html'),
        classic: resolve(__dirname, 'classic.html'),
      },
    },
  },
  server: {
    proxy: {
      // "npm run dev" expects a backend on this Mac; "npm run dev:pi" points
      // the proxy at the live Pi instead (read-only hydration works fine).
      '/api': process.env.APOLLO_API_TARGET || 'http://localhost:80',
      '/list': process.env.APOLLO_API_TARGET || 'http://localhost:80',
    },
  },
});
