import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const landingAtRoot = {
  name: 'landing-at-root',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/?') req.url = '/landing.html';
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), landingAtRoot],
  optimizeDeps: {
    include: ['leaflet'],
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5000', ws: true },
    },
  },
});
