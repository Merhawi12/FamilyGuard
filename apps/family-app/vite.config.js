import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, '../../packages/shared/src');

/**
 * `/` serves the static marketing page. In production the bucket's
 * main_page_suffix does the same rewrite (see infrastructure/gcp/storage.tf), so
 * dev and prod behave identically.
 */
const landingAtRoot = {
  name: 'landing-at-root',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/?') req.url = '/landing.html';
      else if (req.url === '/contact') req.url = '/contact.html';
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), landingAtRoot],
  resolve: {
    // Alias straight at the source so Vite compiles the shared JSX as project
    // code rather than treating it as a pre-built dependency.
    alias: {
      '@parentix/shared': sharedSrc,
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 3000,
    fs: { allow: [here, sharedSrc] },
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5000', ws: true },
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          maps: ['@react-google-maps/api'],
        },
      },
    },
  },
});
