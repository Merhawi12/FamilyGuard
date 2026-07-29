import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth, ErrorBoundary, Spinner, isStaff } from '@parentix/shared';
import AdminLayout from './components/AdminLayout.jsx';
import Login from './pages/Login.jsx';

// Console screens load on demand so the sign-in page stays lightweight.
const Overview = lazy(() => import('./pages/Overview.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Sessions = lazy(() => import('./pages/Sessions.jsx'));
const Billing = lazy(() => import('./pages/Billing.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const AuditLogs = lazy(() => import('./pages/AuditLogs.jsx'));

const RequireStaff = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <Spinner full label="Checking your session…" />;
  return isStaff(user) ? children : <Navigate to="/login" replace />;
};

export default function App() {
  return (
    <ErrorBoundary>
      {/* A parent token authenticates fine but must never mount this console. */}
      <AuthProvider allowRole={isStaff}>
        <BrowserRouter>
          <Suspense fallback={<Spinner full />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/"
                element={
                  <RequireStaff>
                    <AdminLayout />
                  </RequireStaff>
                }
              >
                <Route index element={<Overview />} />
                <Route path="users" element={<Users />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="billing" element={<Billing />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="settings" element={<Settings />} />
                <Route path="audit-logs" element={<AuditLogs />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
