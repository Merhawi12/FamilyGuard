/**
 * Runtime configuration shared by the web apps.
 *
 * `VITE_API_URL` is the origin of the Parentix API (e.g. https://api.parentix.ca).
 * Leaving it empty makes every request same-origin, which is what the Vite dev
 * proxy relies on locally.
 */
export const API_ORIGIN = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

export const API_BASE_URL = `${API_ORIGIN}/api`;

/** Socket.IO connects to the API origin; '/' keeps it same-origin behind the dev proxy. */
export const SOCKET_URL = API_ORIGIN || '/';
