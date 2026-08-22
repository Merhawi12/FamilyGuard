import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { vendorChunks } from '@parentix/shared/vendor-chunks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, '../../packages/shared/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Alias straight at the source so Vite compiles the shared JSX as project
    // code rather than treating it as a pre-built dependency.
    alias: {
      '@parentix/shared': sharedSrc,
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 3001,
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
        // No `maps` group — the console has no map screen. See
        // packages/shared/vendor-chunks.mjs for why this is a function.
        manualChunks: vendorChunks(['react', 'charts']),
      },
    },
  },
});
