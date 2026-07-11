import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  // Served at the site root (increment 5 swap). The old AngularJS UI moved to
  // /legacy; the backend also keeps serving this same build at /v2 as an alias.
  base: '/',
  plugins: [preact()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
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
