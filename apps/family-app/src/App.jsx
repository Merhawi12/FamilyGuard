import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, SocketProvider, useAuth, ErrorBoundary, Spinner } from '@parentix/shared';
import Layout from './components/Layout';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';

// Everything behind the login is split out of the entry chunk — a visitor on
// /login should not download the charting and mapping libraries.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Children = lazy(() => import('./pages/Children'));
const ScreenTime = lazy(() => import('./pages/ScreenTime'));
const AppBlocking = lazy(() => import('./pages/AppBlocking'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Alerts = lazy(() => import('./pages/Alerts'));
const LocationPage = lazy(() => import('./pages/Location'));
const Messages = lazy(() => import('./pages/Messages'));
const Contacts = lazy(() => import('./pages/Contacts'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const Terms = lazy(() => import('./pages/Terms'));

/**
 * The marketing site is the static `public/landing.html`, not a React route.
 * CloudFront (and the Vite dev middleware) rewrite `/` to it, so this only runs
 * if the SPA is entered at `/` some other way — e.g. the catch-all below.
 */
function GoToLanding() {
  useEffect(() => {
    window.location.replace('/landing.html');
  }, []);
  return null;
}

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
              <Route path="/" element={<GoToLanding />} />
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
                <Route path="reports" element={<Reports />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="location" element={<LocationPage />} />
                <Route path="messages" element={<Messages />} />
                <Route path="contacts" element={<Contacts />} />
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
