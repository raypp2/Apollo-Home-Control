import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: '/v2/',
  plugins: [preact()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:80',
      '/list': 'http://localhost:80',
    },
  },
});
