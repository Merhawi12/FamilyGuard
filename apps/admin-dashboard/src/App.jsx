import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import {
  AuthProvider, useAuth, ErrorBoundary, Spinner,
  isStaff, isSuperAdmin, hasPermission, PERMISSIONS,
} from '@parentix/shared';
import AdminLayout from './components/AdminLayout.jsx';
import Login from './pages/Login.jsx';

// Console screens load on demand so the sign-in page stays lightweight.
const Overview = lazy(() => import('./pages/Overview.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Devices = lazy(() => import('./pages/Devices.jsx'));
const ContentFiltering = lazy(() => import('./pages/ContentFiltering.jsx'));
const Sessions = lazy(() => import('./pages/Sessions.jsx'));
const Billing = lazy(() => import('./pages/Billing.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const AuditLogs = lazy(() => import('./pages/AuditLogs.jsx'));
const Staff = lazy(() => import('./pages/Staff.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

const RequireStaff = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <Spinner full label="Checking your session…" />;
  return isStaff(user) ? children : <Navigate to="/login" replace />;
};

/**
 * Keeps an account off a screen its role does not grant. The API refuses the
 * calls regardless — this is so a Finance account that types /users lands
 * somewhere useful instead of on a page of permission errors.
 */
const RequirePermission = ({ permission, superAdmin, children }) => {
  const { user } = useAuth();
  const allowed = superAdmin ? isSuperAdmin(user) : hasPermission(user, permission);
  return allowed ? children : <Navigate to="/" replace />;
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
                {/* Aggregate analytics — every department sees the overview. */}
                <Route index element={<Overview />} />
                <Route path="profile" element={<Profile />} />

                <Route path="users" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_USERS}><Users /></RequirePermission>
                } />
                <Route path="devices" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_USERS}><Devices /></RequirePermission>
                } />
                <Route path="content-filtering" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_SETTINGS}><ContentFiltering /></RequirePermission>
                } />
                <Route path="sessions" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_SESSIONS}><Sessions /></RequirePermission>
                } />
                <Route path="billing" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_BILLING}><Billing /></RequirePermission>
                } />
                <Route path="notifications" element={
                  <RequirePermission permission={PERMISSIONS.SEND_NOTIFICATIONS}><Notifications /></RequirePermission>
                } />
                <Route path="settings" element={
                  <RequirePermission permission={PERMISSIONS.MANAGE_SETTINGS}><Settings /></RequirePermission>
                } />
                <Route path="audit-logs" element={
                  <RequirePermission permission={PERMISSIONS.VIEW_AUDIT_LOGS}><AuditLogs /></RequirePermission>
                } />
                <Route path="staff" element={
                  <RequirePermission superAdmin><Staff /></RequirePermission>
                } />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
