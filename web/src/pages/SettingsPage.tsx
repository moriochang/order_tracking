// 設定（admin 專用）：門市、帳號、角色與門市指派
import { useState } from 'react';
import { useAuth, useMe } from '../auth/AuthProvider';
import { ALLOWED_EMAIL_DOMAIN } from '../lib/clients';
import { adminCreateUser, listAdminAudit, listProfiles, listStores, listUserStores, rpc } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ACTION_LABEL, FIELD_LABEL, ROLE_LABEL } from '../lib/labels';
import type { Profile, Role, Store } from '../lib/types';
import { Dialog, ErrorBanner, useAsync } from '../components/ui';

export function SettingsPage() {
  const stores = useAsync(listStores, []);
  const users = useAsync(async () => {
    const [profiles, links] = await Promise.all([listProfiles(), listUserStores()]);
    return profiles.map((p) => ({ ...p, stores: links.filter((l) => l.user_id === p.user_id).map((l) => l.store_code) }));
  }, []);
  const audit = useAsync(() => listAdminAudit(50), []);
  const { refresh } = useAuth();
  const reloadAll = () => { stores.reload(); users.reload(); audit.reload(); refresh(); };

  return (
    <div className="stack">
      <h1>設定</h1>
      <StoresSection stores={stores.data ?? []} error={stores.error} onSaved={reloadAll} />
      <UsersSection users={users.data ?? []} stores={stores.data ?? []} error={users.error} onSaved={reloadAll} />
      <section className="card stack">
        <h2>帳號與門市異動紀錄（最近 50 筆）</h2>
        <ErrorBanner error={audit.error} />
        <ul className="plain small">
          {(audit.data ?? []).map((l) => (
            <li key={l.id}>
              {fmtDateTime(l.occurred_at)}｜{l.actor_display_name ?? l.actor_db_role}｜{ACTION_LABEL[l.action] ?? l.action}
              {(l.changed_fields ?? []).length > 0 && `｜${(l.changed_fields ?? []).map((f) => `${FIELD_LABEL[f] ?? f}：${String(l.before_data?.[f] ?? '空白')} → ${String(l.after_data?.[f] ?? '空白')}`).join('；')}`}
              {l.operation === 'INSERT' && `｜新增 ${l.entity_type === 'user_store' ? `門市指派 ${l.after_data?.store_code}` : String(l.after_data?.email ?? l.after_data?.code ?? '')}`}
              {l.operation === 'DELETE' && `｜移除 ${l.entity_type === 'user_store' ? `門市指派 ${l.before_data?.store_code}` : ''}`}
              {l.reason && `｜原因：${l.reason}`}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StoresSection({ stores, error, onSaved }: { stores: Store[]; error: unknown; onSaved: () => void }) {
  const [editing, setEditing] = useState<Store | null>(null);
  return (
    <section className="card stack">
      <div className="row between">
        <h2>門市</h2>
        <button className="secondary" onClick={() => setEditing({ code: '', name: '', is_active: true })}>＋ 新增門市</button>
      </div>
      <ErrorBanner error={error} />
      <ul className="plain">
        {stores.map((s) => (
          <li key={s.code} className="row between">
            <span className={s.is_active ? '' : 'dim'}>{s.code} {s.name}{s.is_active ? '' : '（停用）'}</span>
            <button className="link" onClick={() => setEditing(s)}>修改</button>
          </li>
        ))}
      </ul>
      {editing && <StoreDialog store={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </section>
  );
}

function StoreDialog({ store, onClose, onSaved }: { store: Store; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(store);
  const [error, setError] = useState<unknown>(null);
  const isNew = !store.code;
  async function save() {
    try {
      await rpc('admin_upsert_store', { p_code: form.code, p_name: form.name, p_is_active: form.is_active });
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Dialog title={isNew ? '新增門市' : `修改門市 ${store.code}`} onClose={onClose}>
      <div className="stack">
        <label>門市代碼（英數字）<input value={form.code} disabled={!isNew} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label>門市名稱<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="radio"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />啟用</label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={!form.code.trim() || !form.name.trim()} onClick={save}>儲存</button>
        </div>
      </div>
    </Dialog>
  );
}

type UserRow = Profile & { stores: string[] };

function UsersSection({ users, stores, error, onSaved }: { users: UserRow[]; stores: Store[]; error: unknown; onSaved: () => void }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  return (
    <section className="card stack">
      <div className="row between">
        <h2>帳號</h2>
        <button className="secondary" onClick={() => setCreating(true)}>＋ 開通帳號</button>
      </div>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>姓名</th><th>Email</th><th>角色</th><th>門市</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id} className={u.is_active ? '' : 'dim'}>
                <td data-label="姓名">{u.display_name}</td>
                <td data-label="Email">{u.email}</td>
                <td data-label="角色">{ROLE_LABEL[u.role]}</td>
                <td data-label="門市">{u.role === 'admin' ? '全部' : u.stores.join('、') || '—'}</td>
                <td data-label="狀態">{u.is_active ? '啟用' : '停用'}</td>
                <td data-label=""><button className="link" onClick={() => setEditing(u)}>修改</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <CreateUserDialog stores={stores} onClose={() => setCreating(false)} onSaved={onSaved} />}
      {editing && <EditUserDialog user={editing} stores={stores} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </section>
  );
}

function StorePicker({ stores, value, onChange }: { stores: Store[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend>可存取門市</legend>
      <div className="row gap wrap">
        {stores.map((s) => (
          <label key={s.code} className="radio">
            <input type="checkbox" checked={value.includes(s.code)}
              onChange={(e) => onChange(e.target.checked ? [...value, s.code] : value.filter((c) => c !== s.code))} />
            {s.code} {s.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CreateUserDialog({ stores, onClose, onSaved }: { stores: Store[]; onClose: () => void; onSaved: () => void }) {
  // 顯示名稱自動使用 Email @ 前段
  const [form, setForm] = useState({ email: '', display_name: '', role: 'staff' as Role, store_codes: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminCreateUser(form);
      setDone(r.email);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog title="帳號已開通" onClose={onClose}>
        <div className="stack">
          <p>已開通 {done}。請同仁開啟系統網址，按「使用 Google 帳號登入」並選擇這個公司帳號。</p>
          <div className="row end"><button onClick={onClose}>完成</button></div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="開通帳號" onClose={onClose}>
      <div className="stack">
        <label>公司 Email（@{ALLOWED_EMAIL_DOMAIN}）<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        {form.email.includes('@') && <p className="small muted">顯示名稱：{form.email.split('@')[0].trim().toLowerCase()}</p>}
        <label>角色
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {form.role !== 'admin' && <StorePicker stores={stores} value={form.store_codes} onChange={(v) => setForm({ ...form, store_codes: v })} />}
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !form.email.trim()} onClick={create}>{busy ? '開通中…' : '開通帳號'}</button>
        </div>
      </div>
    </Dialog>
  );
}

function EditUserDialog({ user, stores, onClose, onSaved }: { user: UserRow; stores: Store[]; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const [form, setForm] = useState({ display_name: user.display_name, role: user.role, is_active: user.is_active, store_codes: user.stores });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const self = user.user_id === me.user_id;

  const patch: Record<string, unknown> = {};
  if (form.display_name.trim() !== user.display_name) patch.display_name = form.display_name.trim();
  if (form.role !== user.role) patch.role = form.role;
  if (form.is_active !== user.is_active) patch.is_active = form.is_active;
  if ([...form.store_codes].sort().join() !== [...user.stores].sort().join()) patch.store_codes = form.store_codes;
  const highRisk = 'role' in patch || 'is_active' in patch || 'store_codes' in patch;

  async function save() {
    try {
      await rpc('admin_update_user', { p_user_id: user.user_id, p_patch: patch, p_reason: reason.trim() || null });
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Dialog title={`修改帳號：${user.email}`} onClose={onClose}>
      <div className="stack">
        <label>角色
          <select value={form.role} disabled={self} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {form.role !== 'admin' && <StorePicker stores={stores} value={form.store_codes} onChange={(v) => setForm({ ...form, store_codes: v })} />}
        <label className="radio"><input type="checkbox" disabled={self} checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />帳號啟用</label>
        {self && <p className="small muted">不能變更自己的角色或停用自己。</p>}
        <label>原因{highRisk ? '（角色、門市、啟用變更必填）' : '（選填）'}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={!Object.keys(patch).length || (highRisk && !reason.trim())} onClick={save}>儲存</button>
        </div>
      </div>
    </Dialog>
  );
}
