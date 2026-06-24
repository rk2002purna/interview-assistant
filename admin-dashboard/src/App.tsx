import { Routes, Route, Navigate } from 'react-router-dom';
import { isAdminSession } from './api/client';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import UsersListPage from './pages/UsersListPage';
import UserDetailPage from './pages/UserDetailPage';
import AuditLogPage from './pages/AuditLogPage';
import PacksPage from './pages/PacksPage';
import WelcomeOfferPage from './pages/WelcomeOfferPage';
import RateLimitsPage from './pages/RateLimitsPage';
import ProviderKeysPage from './pages/ProviderKeysPage';
import ModelRoutingPage from './pages/ModelRoutingPage';
import UsageAnalyticsPage from './pages/UsageAnalyticsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!isAdminSession()) {
    return <Navigate to="/login" replace />;
  }
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route path="/users" element={<ProtectedRoute><UsersListPage /></ProtectedRoute>} />
      <Route path="/users/:id" element={<ProtectedRoute><UserDetailPage /></ProtectedRoute>} />
      <Route path="/audit-log" element={<ProtectedRoute><AuditLogPage /></ProtectedRoute>} />
      <Route path="/packs" element={<ProtectedRoute><PacksPage /></ProtectedRoute>} />
      <Route path="/welcome-offer" element={<ProtectedRoute><WelcomeOfferPage /></ProtectedRoute>} />
      <Route path="/rate-limits" element={<ProtectedRoute><RateLimitsPage /></ProtectedRoute>} />
      <Route path="/provider-keys" element={<ProtectedRoute><ProviderKeysPage /></ProtectedRoute>} />
      <Route path="/model-routing" element={<ProtectedRoute><ModelRoutingPage /></ProtectedRoute>} />
      <Route path="/usage-analytics" element={<ProtectedRoute><UsageAnalyticsPage /></ProtectedRoute>} />

      <Route path="/" element={<ProtectedRoute><Navigate to="/users" replace /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
