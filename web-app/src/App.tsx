import { Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import CallbackPage from './pages/CallbackPage';
import DesktopAuthPage from './pages/DesktopAuthPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import CheckoutPage from './pages/CheckoutPage';
import PricingPage from './pages/PricingPage';
import DownloadPage from './pages/DownloadPage';
import AdminLayout from './pages/admin/AdminLayout';
import AdminUsersList from './pages/admin/UsersListPage';
import AdminUserDetail from './pages/admin/UserDetailPage';
import AdminPacks from './pages/admin/PacksPage';
import AdminWelcomeOffer from './pages/admin/WelcomeOfferPage';
import AdminProviderKeys from './pages/admin/ProviderKeysPage';
import AdminAuditLog from './pages/admin/AuditLogPage';
import AdminRateLimits from './pages/admin/RateLimitsPage';
import AdminModelRouting from './pages/admin/ModelRoutingPage';
import AdminUsageAnalytics from './pages/admin/UsageAnalyticsPage';
import { isAuthSession, isAdminSession } from './api/client';

function ProtectedRoute({ children, requireAdmin = false }: { children: React.ReactNode; requireAdmin?: boolean }) {
  if (requireAdmin && !isAdminSession()) return <Navigate to="/login" replace />;
  if (!requireAdmin && !isAuthSession()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      <Route path="/desktop-auth" element={<DesktopAuthPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/checkout" element={<CheckoutPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/download" element={<DownloadPage />} />

      {/* Admin routes */}
      <Route path="/admin" element={<ProtectedRoute requireAdmin><AdminLayout /></ProtectedRoute>}>
        <Route index element={<Navigate to="/admin/users" replace />} />
        <Route path="users" element={<AdminUsersList />} />
        <Route path="users/:id" element={<AdminUserDetail />} />
        <Route path="packs" element={<AdminPacks />} />
        <Route path="welcome-offer" element={<AdminWelcomeOffer />} />
        <Route path="provider-keys" element={<AdminProviderKeys />} />
        <Route path="audit-log" element={<AdminAuditLog />} />
        <Route path="rate-limits" element={<AdminRateLimits />} />
        <Route path="model-routing" element={<AdminModelRouting />} />
        <Route path="usage-analytics" element={<AdminUsageAnalytics />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
