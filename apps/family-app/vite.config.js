import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, '../../packages/shared/src');
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

/**
 * `/` serves the static marketing page. In production Firebase Hosting rewrites
 * `/` to landing.html and `/contact` to contact.html (see firebase.json), so dev
 * and prod behave identically.
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

/**
 * Emits the SPA shell as `app.html` instead of `index.html`.
 *
 * Firebase Hosting resolves static files before it consults any rewrite, and a
 * request for `/` is answered by `index.html` when one exists. Leaving the shell
 * under that name would therefore make the React app — not the marketing page —
 * the response at `https://parentix.ca/`, and no rewrite could override it. With
 * no `index.html` in the deployed directory the `/` rewrite below it wins, so
 * the apex serves the real marketing HTML with a 200 rather than an empty shell
 * that redirects itself afterwards. That matters for the crawler reading
 * public/sitemap.xml, which names `https://parentix.ca/` as the home page.
 *
 * Renaming after the build rather than moving the source keeps `index.html` in
 * place for the dev server, whose history fallback is hard-wired to that name.
 */
const shellAsAppHtml = {
  name: 'spa-shell-as-app-html',
  apply: 'build',
  closeBundle() {
    const dist = path.join(here, 'dist');
    const built = path.join(dist, 'index.html');
    if (fs.existsSync(built)) fs.renameSync(built, path.join(dist, 'app.html'));
  },
};

/**
 * The Android build, via Capacitor.
 *
 * Two things differ from the hosted build, and both come from the same fact:
 * there is no marketing site inside an app. Someone who has installed Parentix
 * has already been sold it.
 *
 *   - The shell keeps the name `index.html`. Capacitor's WebView loads that file
 *     from the bundled assets and has no rewrite layer to redirect it, so the
 *     rename that keeps the marketing page at `/` on Firebase Hosting would
 *     leave the app with no entry point at all.
 *   - `/` renders the app rather than the landing page — see __NATIVE__ in
 *     src/App.jsx.
 *
 *   VITE_BUILD_TARGET=capacitor npm run build:family
 */
const NATIVE = process.env.VITE_BUILD_TARGET === 'capacitor';

export default defineConfig({
  plugins: NATIVE ? [react()] : [react(), landingAtRoot, shellAsAppHtml],
  define: {
    // Settings → About reports which build a parent is looking at, which is the
    // first thing a support conversation needs and nothing else can supply.
    __APP_VERSION__: JSON.stringify(version),
    __NATIVE__: JSON.stringify(NATIVE),
  },
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
