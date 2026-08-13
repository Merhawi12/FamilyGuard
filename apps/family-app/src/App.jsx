import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, SocketProvider, useAuth, ErrorBoundary, Spinner, getToken } from '@parentix/shared';
import Layout from './components/Layout';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Welcome from './pages/Welcome';
import { welcomeSeen } from './services/welcome';

// Everything behind the login is split out of the entry chunk — a visitor on
// /login should not download the charting and mapping libraries.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Children = lazy(() => import('./pages/Children'));
const ScreenTime = lazy(() => import('./pages/ScreenTime'));
const AppBlocking = lazy(() => import('./pages/AppBlocking'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const WebHistory = lazy(() => import('./pages/WebHistory'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Alerts = lazy(() => import('./pages/Alerts'));
const LocationPage = lazy(() => import('./pages/Location'));
const Messages = lazy(() => import('./pages/Messages'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Profile = lazy(() => import('./pages/Profile'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const Terms = lazy(() => import('./pages/Terms'));

/**
 * The marketing site is the static `public/landing.html`, not a React route.
 * Firebase Hosting rewrites `/` to it (and the Vite dev middleware does the same
 * locally), so this only runs if the SPA is entered at `/` some other way — e.g.
 * the catch-all below.
 */
function GoToLanding() {
  useEffect(() => {
    window.location.replace('/landing.html');
  }, []);
  return null;
}

/**
 * `/` inside the Android build.
 *
 * There is no marketing page in the app — it is not shipped, and someone who
 * installed Parentix has already been sold it. Redirecting to landing.html there
 * would open a file that does not exist. `PrivateRoute` sends a signed-out
 * visitor on to /login, so this lands on the dashboard or the sign-in screen
 * depending on whether there is a session, which is what launching an app should
 * do. `__NATIVE__` is set by vite.config.js.
 *
 * The introduction comes before all of that, and only on a launch that has both
 * never seen it *and* has no session. The token check is what stops it appearing
 * for parents who installed the app before this screen existed: they have used
 * Parentix for months and do not need telling what it is. `getToken` rather than
 * `useAuth` because this decision has to be made before the session is
 * revalidated — waiting on the network to find out whether to show a splash is
 * how a splash becomes a spinner.
 */
const Home = () => {
  if (!__NATIVE__) return <GoToLanding />;
  if (!welcomeSeen() && !getToken()) return <Navigate to="/welcome" replace />;
  return <Navigate to="/dashboard" replace />;
};

const PrivateRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <Spinner full label="Loading your dashboard…" />;
  return user ? children : <Navigate to="/login" replace />;
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<Spinner full />}>
            <Routes>
              <Route path="/" element={<Home />} />
              {/* Routed rather than only reachable from `/` so it can be linked
                  to, screenshotted and driven by the browser harness — and so a
                  parent who wants to see it again can. */}
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/login" element={<Login />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/terms" element={<Terms />} />

              <Route
                path="/dashboard"
                element={
                  <PrivateRoute>
                    <SocketProvider>
                      <Layout />
                    </SocketProvider>
                  </PrivateRoute>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="children" element={<Children />} />
                <Route path="screen-time" element={<ScreenTime />} />
                <Route path="blocking" element={<AppBlocking />} />
                <Route path="activity" element={<ActivityLog />} />
                <Route path="web-history" element={<WebHistory />} />
                <Route path="reports" element={<Reports />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="location" element={<LocationPage />} />
                <Route path="messages" element={<Messages />} />
                <Route path="contacts" element={<Contacts />} />
                <Route path="profile" element={<Profile />} />
                <Route path="settings" element={<Settings />} />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
