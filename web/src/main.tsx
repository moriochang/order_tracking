import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ALLOWED_EMAIL_DOMAIN, missingConfig } from './lib/clients';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { NewOrderPage } from './pages/NewOrderPage';
import { OrdersPage } from './pages/OrdersPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import './styles.css';

function Gate() {
  const { state, logout, refresh } = useAuth();

  if (missingConfig.length) {
    return (
      <div className="center-card card">
        <h1>尚未設定</h1>
        <p>缺少環境變數：{missingConfig.join('、')}</p>
      </div>
    );
  }
  if (state.kind === 'loading') return <div className="center-card muted">載入中…</div>;
  if (state.kind === 'signed_out') return <LoginPage />;
  if (state.kind === 'not_provisioned' || state.kind === 'error') {
    return (
      <div className="center-card card">
        <h1>{state.kind === 'error' ? '無法載入帳號' : '帳號尚未開通'}</h1>
        <p>
          {state.kind === 'error'
            ? state.message
            : !state.email?.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)
              ? `${state.email ?? '此帳號'} 不是公司帳號，請登出後改用 @${ALLOWED_EMAIL_DOMAIN} 帳號登入。`
              : `${state.email} 已登入，但尚未被管理者開通或已停用。請聯絡管理者。`}
        </p>
        <div className="row gap">
          <button onClick={refresh}>重新檢查</button>
          <button className="secondary" onClick={logout}>登出</button>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/new" element={<NewOrderPage />} />
        <Route path="orders/:orderId" element={<OrderDetailPage />} />
        <Route path="settings" element={state.me.role === 'admin' ? <SettingsPage /> : <Navigate to="/" />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
    </AuthProvider>
  </StrictMode>,
);
