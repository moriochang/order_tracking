import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useMe } from '../auth/AuthProvider';
import { ROLE_LABEL } from '../lib/labels';

export function Layout() {
  const me = useMe();
  const { logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">預購追蹤</div>
        <nav>
          <NavLink to="/" end>首頁</NavLink>
          <NavLink to="/orders/new">新增訂單</NavLink>
          <NavLink to="/orders" end>訂單查詢</NavLink>
          <span className="nav-disabled" title="第三階段開放">待辦清單</span>
          {me.role === 'admin' && <NavLink to="/settings">設定</NavLink>}
        </nav>
        <div className="who">
          <span>{me.display_name}</span>
          <span className="muted small">{ROLE_LABEL[me.role]}</span>
          <button className="link" onClick={logout}>登出</button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
