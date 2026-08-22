/**
 * The one entry point both web apps import from.
 *
 * Every line below is a re-export, and a barrel is only cheap if the bundler is
 * allowed to drop the parts an app does not use. That permission is the
 * `"sideEffects": ["**\/*.css"]` field in this package's package.json, and it is
 * load-bearing: without it Rollup has to keep any module whose top level does
 * something it cannot prove is inert, and `const Ctx = createContext(null)` is
 * such a statement. So `realtime/SocketContext.jsx` survived tree-shaking
 * anywhere the barrel was touched at all — and it imports socket.io-client. The
 * Admin Dashboard, which has no realtime feature and never names SocketProvider
 * or useSocket, was shipping the entire socket.io client in its entry chunk.
 *
 * The rule that keeps this true: nothing in this package may *do* anything at
 * import time. Register listeners, read storage and start timers from a hook or
 * an effect, never from a module body. A module that breaks that rule has to be
 * named in the `sideEffects` array or it will be silently dropped — and only
 * from production builds, where it is hardest to notice.
 */
export { default as api, setTokenKey, setLoginPath, getToken, setToken, clearToken, errorMessage } from './api/client.js';
export * from './api/endpoints.js';
export { uploadChildAvatar } from './api/upload.js';
export { default as Avatar } from './components/Avatar.jsx';
export { default as BrandLogo } from './components/BrandLogo.jsx';
export { AuthProvider, useAuth } from './auth/AuthContext.jsx';
export { SocketProvider, useSocket } from './realtime/SocketContext.jsx';
export { default as ErrorBoundary } from './components/ErrorBoundary.jsx';
export { default as EmptyState } from './components/EmptyState.jsx';
export { default as Icon } from './components/Icon.jsx';
export { default as Modal } from './components/Modal.jsx';
export { default as StatsCard } from './components/StatsCard.jsx';
export { default as Spinner } from './components/Spinner.jsx';
export { default as Pagination } from './components/Pagination.jsx';
export { default as Toggle } from './components/Toggle.jsx';
export { default as TwoFactorSetup } from './components/TwoFactorSetup.jsx';
export { default as GoogleSignInButton } from './components/GoogleSignInButton.jsx';
export { useBodyScrollLock } from './hooks/useBodyScrollLock.js';
export { useDismissable } from './hooks/useDismissable.js';
export { API_ORIGIN, API_BASE_URL, SOCKET_URL } from './config.js';
export { localDateKey, lastLocalDays, timeAgo, formatMinutes } from './dates.js';
export * from './constants.js';
