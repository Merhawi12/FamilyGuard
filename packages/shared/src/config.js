/**
 * Runtime configuration shared by the web apps.
 *
 * `VITE_API_URL` is the origin of the Parentix API — https://api.parentix.ca in
 * production, where the static apps are served by Firebase Hosting and the API
 * by Cloud Run, so the two are genuinely different origins and every call is
 * cross-origin. The API answers them by name: see `corsOrigins` in
 * services/api/src/config/env.js.
 *
 * Leaving it empty makes every request same-origin, which is what the Vite dev
 * proxy relies on locally. Baked in at build time, so changing it means a
 * rebuild and a redeploy, not just a restart.
 */
export const API_ORIGIN = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

export const API_BASE_URL = `${API_ORIGIN}/api`;

/** Socket.IO connects to the API origin; '/' keeps it same-origin behind the dev proxy. */
export const SOCKET_URL = API_ORIGIN || '/';
