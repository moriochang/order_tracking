import { useState } from 'react';
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect } from 'firebase/auth';
import { ALLOWED_EMAIL_DOMAIN, auth } from '../lib/clients';

function loginError(code: string): string | null {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null;
    case 'auth/admin-restricted-operation':
      return '這個 Google 帳號尚未被管理者開通，請聯絡管理者。';
    case 'auth/account-exists-with-different-credential':
      return '帳號連結失敗（此 Email 已有其他登入方式），請聯絡管理者。';
    case 'auth/unauthorized-domain':
      return '目前網址未被授權登入，請聯絡系統管理者。';
    case 'auth/network-request-failed':
      return '網路連線失敗。';
    default:
      return `登入失敗（${code}）`;
  }
}

export function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const provider = new GoogleAuthProvider();
    // hd 只是讓 Google 帳號選擇畫面優先顯示公司帳號；真正的網域檢查在資料庫
    provider.setCustomParameters({ hd: ALLOWED_EMAIL_DOMAIN, prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider);
        return;
      }
      setError(loginError(code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" />
          </svg>
        </div>
        <h1 className="login-title">預購商品追蹤</h1>
        <p className="login-subtitle">登入以繼續使用</p>
        {error && <div className="alert error">{error}</div>}
        <button type="button" className="login-button" disabled={busy} onClick={signIn}>
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {busy ? '登入中…' : '使用 Google 帳號繼續'}
        </button>
        <p className="login-note">請使用公司帳號 @{ALLOWED_EMAIL_DOMAIN}<br />帳號由管理者開通後才能使用</p>
      </div>
      <footer className="login-footer">TC © 2026</footer>
    </div>
  );
}
