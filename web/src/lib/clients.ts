// Firebase（登入）與 Supabase（資料）連線。
// Supabase 不使用自己的登入，而是透過 accessToken 帶入 Firebase ID token（Third-Party Auth）。
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;

export const missingConfig = [
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
].filter((k) => !env[k]);

// 未設定時用佔位值初始化，讓畫面能顯示「尚未設定」而不是直接崩潰
const firebaseApp = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'missing',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'missing',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'missing',
});

export const ALLOWED_EMAIL_DOMAIN = env.VITE_ALLOWED_EMAIL_DOMAIN ?? 'istore.com.tw';

export const auth = getAuth(firebaseApp);
auth.languageCode = 'zh-TW';

export const supabase = createClient(env.VITE_SUPABASE_URL ?? 'http://invalid', env.VITE_SUPABASE_ANON_KEY ?? 'invalid', {
  accessToken: async () => (await auth.currentUser?.getIdToken()) ?? null,
});
