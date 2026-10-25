// 登入狀態：Firebase 登入 → 確認 token 帶有 role claim → 向資料庫查詢帳號是否開通
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from '../lib/clients';
import { getMe } from '../lib/api';
import { errorMessage } from '../lib/labels';
import type { Me } from '../lib/types';

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'not_provisioned'; email: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; user: User; me: Me };

type AuthContextValue = { state: AuthState; me: Me | null; refresh: () => Promise<void>; logout: () => Promise<void> };

const AuthContext = createContext<AuthContextValue | null>(null);

async function resolve(user: User | null): Promise<AuthState> {
  if (!user) return { kind: 'signed_out' };
  // 帳號剛開通時舊 token 還沒有 role claim，強制更新一次
  const token = await user.getIdTokenResult();
  if (token.claims.role !== 'authenticated') {
    const fresh = await user.getIdTokenResult(true);
    if (fresh.claims.role !== 'authenticated') return { kind: 'not_provisioned', email: user.email };
  }
  const me = await getMe();
  return me ? { kind: 'ready', user, me } : { kind: 'not_provisioned', email: user.email };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  const apply = useCallback(async (user: User | null) => {
    try {
      setState(await resolve(user));
    } catch (e) {
      setState({ kind: 'error', message: errorMessage(e) });
    }
  }, []);

  useEffect(() => onAuthStateChanged(auth, apply), [apply]);

  const value: AuthContextValue = {
    state,
    me: state.kind === 'ready' ? state.me : null,
    refresh: () => apply(auth.currentUser),
    logout: () => signOut(auth),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

// 只能在登入完成的頁面中使用
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe used outside a signed-in page');
  return me;
}
