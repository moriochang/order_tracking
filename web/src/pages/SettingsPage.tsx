// 設定（admin 專用）：門市、帳號、角色與門市指派
import { useState } from 'react';
import { useAuth, useMe } from '../auth/AuthProvider';
import { ALLOWED_EMAIL_DOMAIN } from '../lib/clients';
import { adminCreateUser, catalogCount, listAdminAudit, listExportLogs, listProfiles, listStores, listUserStores, rpc } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ACTION_LABEL, EXTERNAL_ROLES, FIELD_LABEL, ROLE_LABEL, errorMessage } from '../lib/labels';
import type { Profile, Role, Store } from '../lib/types';
import { Dialog, ErrorBanner, Operator, useAsync } from '../components/ui';

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
      <CatalogSection onSaved={reloadAll} />
      <ExportLogSection />
      <section className="card stack">
        <h2>帳號與門市異動紀錄（最近 50 筆）</h2>
        <ErrorBanner error={audit.error} />
        <ul className="plain small">
          {(audit.data ?? []).map((l) => (
            <li key={l.id}>
              {fmtDateTime(l.occurred_at)}｜<Operator name={l.actor_display_name ?? l.actor_db_role} />｜{ACTION_LABEL[l.action] ?? l.action}
              {(l.changed_fields ?? []).length > 0 && `｜${(l.changed_fields ?? []).map((f) => `${FIELD_LABEL[f] ?? f}：${String(l.before_data?.[f] ?? '空白')} → ${String(l.after_data?.[f] ?? '空白')}`).join('；')}`}
              {l.operation === 'INSERT' && `｜新增 ${l.entity_type === 'user_store' ? `門市指派 ${l.after_data?.store_code}` : String(l.after_data?.email ?? l.after_data?.code ?? '')}`}
              {l.operation === 'DELETE' && `｜移除 ${l.entity_type === 'user_store' ? `門市指派 ${l.before_data?.store_code}` : ''}`}
              {l.action === 'admin_import_catalog' && `｜${Number(l.after_data?.rows ?? 0).toLocaleString()} 筆`}
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
            <span className={s.is_active ? '' : 'dim'}>
              {s.code} {s.name}{s.is_active ? '' : '（停用）'}
            </span>
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
      await rpc('admin_upsert_store', {
        p_code: form.code, p_name: form.name, p_is_active: form.is_active, p_receipt_prefix: form.receipt_prefix ?? null,
      });
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
  const [batch, setBatch] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  return (
    <section className="card stack">
      <div className="row between">
        <h2>帳號</h2>
        <div className="row gap">
          <button className="secondary" onClick={() => setBatch(true)}>批次開通</button>
          <button className="secondary" onClick={() => setCreating(true)}>＋ 開通帳號</button>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="list">
          <thead><tr><th>姓名</th><th>Email</th><th>角色</th><th>門市</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id} className={u.is_active ? '' : 'dim'}>
                <td data-label="姓名">{u.display_name}</td>
                <td data-label="Email">{u.email}{u.is_external && <span className="badge external">外部</span>}</td>
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
      {batch && <BatchCreateDialog stores={stores} existing={users.map((u) => u.email.toLowerCase())} onClose={() => setBatch(false)} onSaved={onSaved} />}
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
  // 顯示名稱預設為 Email @ 前段；外部帳號（個人 Google 帳號）可以另外填名字
  const [form, setForm] = useState({ email: '', display_name: '', role: 'staff' as Role, store_codes: [] as string[] });
  const email = form.email.trim().toLowerCase();
  const external = email.includes('@') && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
  const roles = external ? EXTERNAL_ROLES : (Object.keys(ROLE_LABEL) as Role[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminCreateUser({ ...form, email, display_name: form.display_name.trim() });
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
          <p>已開通 {done}。請對方開啟系統網址，按「使用 Google 帳號繼續」並選擇這個帳號登入。</p>
          <div className="row end"><button onClick={onClose}>完成</button></div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="開通帳號" onClose={onClose}>
      <div className="stack">
        <label>Email（公司 @{ALLOWED_EMAIL_DOMAIN}，或工讀生的個人 Google 帳號）
          <input type="email" value={form.email} onChange={(e) => {
            const v = e.target.value;
            const ext = v.includes('@') && !v.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
            setForm({ ...form, email: v, role: ext && !EXTERNAL_ROLES.includes(form.role) ? 'staff' : form.role });
          }} /></label>
        {external && (
          <p className="small warn-text">這是外部帳號（個人 Google 帳號），只能設為門市同仁或門市檢視。離職時請記得停用。</p>
        )}
        <label>顯示名稱<input value={form.display_name} placeholder={email.includes('@') ? email.split('@')[0] : '預設為 Email @ 前段'}
          onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
        <label>角色
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
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
            {(user.is_external ? EXTERNAL_ROLES : (Object.keys(ROLE_LABEL) as Role[])).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {user.is_external && <p className="small muted">外部帳號（個人 Google 帳號）只能設為門市同仁或門市檢視。</p>}
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

// 產品資料：上傳公司建檔的 Excel（欄位 Code、product_name、大分類、中分類、小分類、14.EAN、manufacture_style），整批取代
type CatalogRow = { code: string; product_name: string; category: string; sub_category: string; detail_category: string; ean: string; manufacture_style: string };

async function readCatalogFile(file: File): Promise<CatalogRow[]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const rows: CatalogRow[] = [];
  for (const { data } of await readXlsxFile(file)) {
    const header = (data[0] ?? []).map((c) => String(c ?? '').trim());
    const col = (name: string) => header.indexOf(name);
    if (col('Code') < 0 || col('product_name') < 0) continue;
    const cell = (row: unknown[], name: string) => (col(name) < 0 ? '' : String(row[col(name)] ?? '').trim());
    const eanCol = header.findIndex((h) => /EAN$/i.test(h));
    const styleCol = header.findIndex((h) => /^manufacture_style$/i.test(h));
    for (const row of data.slice(1)) {
      const raw = row[col('Code')];
      // 代碼若被 Excel 存成數字，補回前導 0（建檔代碼為 10 碼）
      const code = typeof raw === 'number' ? String(raw).padStart(10, '0') : String(raw ?? '').trim();
      const name = cell(row, 'product_name');
      if (code && name) {
        rows.push({ code, product_name: name, category: cell(row, '大分類'), sub_category: cell(row, '中分類'), detail_category: cell(row, '小分類'),
          ean: eanCol < 0 ? '' : String(row[eanCol] ?? '').trim(),
          manufacture_style: styleCol < 0 ? '' : String(row[styleCol] ?? '').trim() });
      }
    }
  }
  return rows;
}

function CatalogSection({ onSaved }: { onSaved: () => void }) {
  const count = useAsync(catalogCount, []);
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');
  const [ackShrink, setAckShrink] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null); setDone(''); setRows(null); setAckShrink(false); setBusy(true);
    try {
      const parsed = await readCatalogFile(file);
      if (!parsed.length) throw new Error('檔案中找不到「Code」與「product_name」欄位');
      setRows(parsed);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function importRows() {
    if (!rows) return;
    setBusy(true); setError(null);
    try {
      const r = await rpc<{ rows: number }>('admin_import_catalog', { p_rows: rows });
      setDone(`已匯入 ${r.rows.toLocaleString()} 筆`);
      setRows(null);
      count.reload();
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // 新檔案比現有資料少一半以上，多半是篩選沒清掉或漏複製；要勾選確認才能匯入
  const current = count.data ?? 0;
  const shrink = rows && current > 0 && rows.length < current / 2 ? Math.round((1 - rows.length / current) * 100) : 0;

  const byCategory = rows && Object.entries(rows.reduce<Record<string, number>>((m, r) => {
    m[r.category || '（無）'] = (m[r.category || '（無）'] ?? 0) + 1;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]);

  return (
    <section className="card stack">
      <h2>產品資料</h2>
      <p className="small muted">
        拍照辨識時用型號比對建檔品名，自動校正辨識錯字。目前 {count.data?.toLocaleString() ?? '…'} 筆。
        上傳 Excel（需有 Code、product_name 欄位；有「14.EAN」欄會一併匯入國際條碼；有「manufacture_style」欄時，型號以原廠型號去掉地區碼為準）會整批取代現有資料。
      </p>
      <label className={`button secondary ${busy ? 'disabled' : ''}`}>
        {busy && !rows ? '讀取中…' : '選擇 Excel 檔'}
        <input type="file" accept=".xlsx" className="hidden" disabled={busy}
          onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      <ErrorBanner error={error} />
      {done && <div className="alert info">{done}</div>}
      {rows && byCategory && (
        <div className="card inset stack">
          <div>讀到 {rows.length.toLocaleString()} 筆：{byCategory.map(([c, n]) => `${c} ${n.toLocaleString()}`).join('、')}</div>
          {shrink > 0 && (
            <div className="alert error stack">
              <div>⚠ 這份檔案有 {rows.length.toLocaleString()} 筆，比現有的 {current.toLocaleString()} 筆少了 {shrink}%。
                匯入會整批取代，少掉的產品之後將帶不出品名。請確認檔案沒有篩選、沒有漏掉資料。</div>
              <label className="radio">
                <input type="checkbox" checked={ackShrink} onChange={(e) => setAckShrink(e.target.checked)} />
                我確認要用這份檔案取代全部產品資料
              </label>
            </div>
          )}
          <div className="row gap end">
            <button className="secondary" onClick={() => setRows(null)} disabled={busy}>取消</button>
            <button onClick={importRows} disabled={busy || (shrink > 0 && !ackShrink)}>{busy ? '匯入中…' : '確認匯入（取代現有資料）'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// 匯出紀錄（只有管理者看得到；紀錄不可修改）
function ExportLogSection() {
  const logs = useAsync(() => listExportLogs(100), []);
  return (
    <section className="card stack">
      <h2>匯出紀錄（最近 100 筆）</h2>
      <ErrorBanner error={logs.error} />
      {logs.data?.length === 0 && <p className="muted">尚無匯出紀錄。</p>}
      <ul className="plain small">
        {(logs.data ?? []).map((l) => {
          const a = (l.after_data ?? {}) as { format?: string; orders?: number; rows?: number; filters?: Record<string, string> };
          return (
            <li key={l.id}>
              {fmtDateTime(l.occurred_at)}｜<Operator name={l.actor_display_name ?? l.actor_db_role} />｜
              {a.format === 'csv' ? 'CSV' : 'Excel'}｜{a.orders} 張訂單／{a.rows} 列｜
              {Object.entries(a.filters ?? {}).map(([k, v]) => `${k}：${v}`).join('・')}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// 批次開通：貼上多個 Email（一行一個或用逗號分隔），同一角色與門市，逐一開通並顯示每筆結果
function BatchCreateDialog({ stores, existing, onClose, onSaved }: {
  stores: Store[]; existing: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [storeCodes, setStoreCodes] = useState<string[]>(stores.length === 1 ? [stores[0].code] : []);
  const [results, setResults] = useState<{ email: string; ok: boolean; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const emails = [...new Set(text.split(/[\s,;，、]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((e) => !e.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`) || !/^[^@\s]+@[^@\s]+$/.test(e));
  const already = emails.filter((e) => existing.includes(e));
  const todo = emails.filter((e) => !invalid.includes(e) && !already.includes(e));

  async function run() {
    setBusy(true);
    const out: typeof results = [];
    for (const email of todo) {
      try {
        await adminCreateUser({ email, display_name: '', role, store_codes: role === 'admin' ? [] : storeCodes });
        out.push({ email, ok: true, message: '已開通' });
      } catch (e) {
        out.push({ email, ok: false, message: errorMessage(e) });
      }
      setResults([...out]);
    }
    setBusy(false);
    onSaved();
  }

  const done = results.length > 0 && !busy;
  return (
    <Dialog title="批次開通帳號" onClose={onClose}>
      <div className="stack">
        <label>Email（一行一個，或用逗號分隔）
          <textarea rows={6} value={text} disabled={busy || done} onChange={(e) => setText(e.target.value)}
            placeholder={`name@${ALLOWED_EMAIL_DOMAIN}`} />
        </label>
        <label>角色
          <select value={role} disabled={busy || done} onChange={(e) => setRole(e.target.value as Role)}>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {role !== 'admin' && <StorePicker stores={stores} value={storeCodes} onChange={setStoreCodes} />}
        {emails.length > 0 && !done && (
          <div className="small">
            將開通 {todo.length} 個帳號，顯示名稱自動使用 Email @ 前段。
            {already.length > 0 && <div className="muted">已存在、略過：{already.join('、')}</div>}
            {invalid.length > 0 && <div className="danger-text">不是 @{ALLOWED_EMAIL_DOMAIN} 的 Email、略過：{invalid.join('、')}</div>}
          </div>
        )}
        {results.length > 0 && (
          <ul className="plain small">
            {results.map((r) => <li key={r.email} className={r.ok ? 'ok-text' : 'danger-text'}>{r.ok ? '✓' : '✗'} {r.email}：{r.message}</li>)}
          </ul>
        )}
        <div className="row gap end">
          <button className="secondary" onClick={onClose} disabled={busy}>{done ? '關閉' : '取消'}</button>
          {!done && (
            <button disabled={busy || !todo.length || (role !== 'admin' && !storeCodes.length)} onClick={run}>
              {busy ? `開通中…（${results.length}/${todo.length}）` : `開通 ${todo.length} 個帳號`}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
