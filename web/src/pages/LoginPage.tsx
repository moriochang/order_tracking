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
    <div className="center-card card stack">
      <h1>預購商品追蹤</h1>
      <p className="muted">請使用公司 Google 帳號（@{ALLOWED_EMAIL_DOMAIN}）登入。</p>
      {error && <div className="alert error">{error}</div>}
      <button type="button" disabled={busy} onClick={signIn}>{busy ? '登入中…' : '使用 Google 帳號登入'}</button>
      <p className="muted small">帳號由管理者開通，未開通的帳號無法使用。</p>
    </div>
  );
}
