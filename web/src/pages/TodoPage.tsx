// 待辦清單：依「該做的下一步」分頁列出每台機器，最久的排最前面，直接在列上操作。
// 待到貨、待通知、待貼分頁可勾選多列批次處理（一次最多 BATCH_LIMIT 台／張）。
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { listTodo, rpc } from '../lib/api';
import { fmtDate, todayTaipei } from '../lib/format';
import { canEdit } from '../lib/labels';
import type { Device, TodoRow } from '../lib/types';
import { ArrivalDialog, BATCH_LIMIT, BatchDialog, DeliveryDialog, NotifyDialog, notesOf, type BatchKind } from '../components/DeviceDialogs';
import { ErrorBanner, StatusBadge, useAsync } from '../components/ui';

const PICKUP_OVERDUE_DAYS = 14;   // 通知後超過幾天未取貨標紅

type TabKey = 'all' | 'arrival' | 'notify' | 'label' | 'pickup';
const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'all', label: '全部', hint: '所有尚未完成的機器，依結帳日期由舊到新。' },
  { key: 'arrival', label: '待到貨', hint: '依結帳日期由舊到新，先訂的先給。可勾選多台批次登記到貨。' },
  { key: 'label', label: '待貼', hint: '已到貨、尚未貼標留貨的機器。可勾選多台批次標記已貼。' },
  { key: 'notify', label: '待通知', hint: '已到貨、尚未聯絡顧客，依到貨時間排序。同一張訂單合併成一列，一次通知；可勾選多張批次通知。' },
  { key: 'pickup', label: '待取貨', hint: `已通知、顧客尚未取貨，依通知時間排序；超過 ${PICKUP_OVERDUE_DAYS} 天標紅。同一張訂單合併成一列，一次取貨。` },
];

// 通知與取貨是對顧客、以訂單為單位：同一張訂單合併成一列；其他分頁每台一列
const byOrder = (tab: TabKey) => tab === 'notify' || tab === 'pickup';

const BATCH_OF: Partial<Record<TabKey, { kind: BatchKind; label: string }>> = {
  arrival: { kind: 'arrival', label: '批次登記到貨' },
  notify: { kind: 'notify', label: '批次通知顧客' },
  label: { kind: 'label', label: '批次標記已貼' },
};
// 每列的勾選代號：通知以訂單為單位，其他每台一列
const groupKey = (g: TodoRow[], tab: TabKey) => (byOrder(tab) ? g[0].order_id : g[0].device_id);

function groupRows(rows: TodoRow[], tab: TabKey): TodoRow[][] {
  if (!byOrder(tab)) return rows.map((r) => [r]);
  const groups = new Map<string, TodoRow[]>();
  for (const r of rows) groups.set(r.order_id, [...(groups.get(r.order_id) ?? []), r]);
  return [...groups.values()];
}

const inTab = (r: TodoRow, tab: TabKey) => (
  tab === 'all' ? true
  : tab === 'arrival' ? r.status === 'pending_arrival'
    : tab === 'notify' ? r.status === 'arrived_pending_notify'
      : tab === 'label' ? r.status !== 'pending_arrival' && !r.is_labeled
        : r.status === 'notified_pending_pickup');

// 依各分頁的等待起點排序，最久的在前
const since = (r: TodoRow, tab: TabKey) => (
  tab === 'arrival' || tab === 'all' ? r.purchase_date
    : tab === 'pickup' ? (r.last_notified_at ?? r.arrived_at ?? '')
      : (r.arrived_at ?? ''));

// 台北時間的日期（YYYY-MM-DD）；結帳日期本身已是日期
const taipeiDay = (iso: string) => (iso.length === 10 ? iso
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(iso)));

function daysSince(iso: string) {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.parse(todayTaipei()) - Date.parse(taipeiDay(iso))) / 86400000));
}

// 對話框只用到單機的部分欄位
const toDevice = (r: TodoRow) => ({
  id: r.device_id, order_id: r.order_id, order_item_id: r.order_item_id, unit_no: r.unit_no, sn: r.sn,
  status: r.status, is_labeled: r.is_labeled, note: r.note, version: r.version,
}) as Device;

export function TodoPage() {
  const me = useMe();
  const editable = canEdit(me.role);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'all') as TabKey;
  const store = params.get('store') ?? '';
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const data = useAsync(() => listTodo({ storeCode: store || undefined, q }), [store, q]);
  // ids：合併列一起處理的機器，對話框預設全部勾選
  const [action, setAction] = useState<{ kind: 'arrival' | 'notify' | 'deliver'; row: TodoRow; ids?: string[] } | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  useEffect(() => setPicked([]), [tab, store, q]);
  const setParam = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; });

  const all = data.data ?? [];
  const rows = all.filter((r) => inTab(r, tab))
    .sort((a, b) => since(a, tab).localeCompare(since(b, tab)) || a.order_no.localeCompare(b.order_no) || a.unit_no - b.unit_no);
  const groups = groupRows(rows, tab);
  const tabCount = (t: TabKey) => {
    const inT = all.filter((r) => inTab(r, t));
    return byOrder(t) ? new Set(inT.map((r) => r.order_id)).size : inT.length;
  };
  const batch = editable ? BATCH_OF[tab] : undefined;
  const keys = groups.map((g) => groupKey(g, tab));
  const pickedGroups = groups.filter((g) => picked.includes(groupKey(g, tab)));
  const togglePick = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= BATCH_LIMIT ? p : [...p, k]));
  const allPicked = keys.length > 0 && keys.slice(0, BATCH_LIMIT).every((k) => picked.includes(k));
  const label = (r: TodoRow) => `${r.full_product_name}${r.sn ? `（${r.sn}）` : ''}`;
  const orderOf = (r: TodoRow) => ({ no: r.order_no, customer: r.customer_name, phone: r.customer_phone });

  async function markLabeled(r: TodoRow) {
    setOpError(null);
    try {
      await rpc('set_labeled', { p_device_id: r.device_id, p_expected_version: r.version, p_labeled: true });
      data.reload();
    } catch (e) {
      setOpError(e);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setParam('q', input.trim());
  }

  return (
    <div className="stack">
      <h1>待辦清單</h1>
      <div className="row gap wrap">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`todo-tab todo-tab-${t.key} ${tab === t.key ? 'active' : ''}`} onClick={() => setParam('tab', t.key === 'all' ? '' : t.key)}>
            {t.label}（{tabCount(t.key)}）
          </button>
        ))}
      </div>
      <form className="filter-bar" onSubmit={submit}>
        {me.stores.length > 1 && (
          <select value={store} onChange={(e) => setParam('store', e.target.value)} aria-label="門市">
            <option value="">全部門市</option>
            {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        )}
        <div className="input-group">
          <input className="grow" value={input} placeholder="型號、品名、顧客、訂單編號" autoCapitalize="characters"
            onChange={(e) => setInput(e.target.value)} />
        </div>
        <button type="submit">篩選</button>
      </form>
      <p className="muted small">{TABS.find((t) => t.key === tab)?.hint}{byOrder(tab) && rows.length > 0 && ` 共 ${groups.length} 張訂單、${rows.length} 台。`}</p>
      <ErrorBanner error={data.error ?? opError} />
      {data.loading && !data.data && <div className="muted">載入中…</div>}
      {data.data && (rows.length === 0 ? <div className="muted">目前沒有待辦。</div> : (
        <div className="table-wrap table-card">
          <table className="list">
            <thead>
              <tr>
                {batch && <th className="check-col">
                  <input type="checkbox" aria-label="全選" checked={allPicked}
                    onChange={() => setPicked(allPicked ? [] : keys.slice(0, BATCH_LIMIT))} />
                </th>}
                <th>{tab === 'arrival' || tab === 'all' ? '結帳日期' : tab === 'pickup' ? '通知時間' : '到貨時間'}</th><th>等待時間</th>
                <th>訂單編號</th><th>顧客</th><th>電話</th><th>品名</th><th>SN</th><th>狀態</th>{editable && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const r = g[0];   // 已依等待時間排序，第一台等最久
                const ids = g.map((x) => x.device_id);
                const start = since(r, tab);
                const days = daysSince(start);
                const overdue = tab === 'pickup' && days > PICKUP_OVERDUE_DAYS;
                return (
                  <tr key={r.device_id} className={overdue ? 'overdue' : ''}>
                    {batch && <td data-label="" className="check-col">
                      <input type="checkbox" aria-label="勾選" checked={picked.includes(groupKey(g, tab))} onChange={() => togglePick(groupKey(g, tab))} />
                    </td>}
                    <td data-label={tab === 'arrival' || tab === 'all' ? '結帳日期' : tab === 'pickup' ? '通知時間' : '到貨時間'} className="nowrap">
                      {start ? fmtDate(taipeiDay(start)) : '—'}
                    </td>
                    <td data-label="等待時間" className="nowrap"><span className={overdue ? 'overdue-days' : ''}>{days} 天</span></td>
                    <td data-label="訂單編號" className="nowrap"><Link to={`/orders/${r.order_id}`}>{r.order_no}</Link></td>
                    <td data-label="顧客" className="nowrap">{r.customer_name}</td>
                    <td data-label="電話" className="nowrap">{r.customer_phone}</td>
                    <td data-label={g.length > 1 ? `品名（${g.length} 台）` : '品名'}>
                      {g.map((x) => (
                        <div key={x.device_id}>
                          <span className="product-name">{x.full_product_name}</span>
                          {notesOf(x.item_note, x.note) && <div className="device-note block">⚠ {notesOf(x.item_note, x.note)}</div>}
                        </div>
                      ))}
                    </td>
                    <td data-label="SN">{g.map((x) => <div key={x.device_id}>{x.sn ?? '—'}</div>)}</td>
                    <td data-label="狀態"><StatusBadge status={r.status} /></td>
                    {editable && <td data-label="操作">
                      <div className="row gap">
                        {(tab === 'arrival' || (tab === 'all' && r.status === 'pending_arrival')) && (
                          <button type="button" className="step step-arrival" onClick={() => setAction({ kind: 'arrival', row: r })}>登記到貨</button>
                        )}
                        {(tab === 'label' || (tab === 'all' && r.status !== 'pending_arrival' && !r.is_labeled)) && (
                          <button type="button" className="step step-label" onClick={() => markLabeled(r)}>已貼</button>
                        )}
                        {(tab === 'notify' || tab === 'pickup' || (tab === 'all' && r.status === 'arrived_pending_notify')) && (
                          <button type="button" className="step step-notify" onClick={() => setAction({ kind: 'notify', row: r, ids })}>{r.status === 'notified_pending_pickup' ? '再次通知' : '通知顧客'}</button>
                        )}
                        {(tab === 'pickup' || tab === 'notify' || (tab === 'all' && r.status !== 'pending_arrival')) && (
                          <button type="button" className="step step-deliver" onClick={() => setAction({ kind: 'deliver', row: r, ids })}>完成取貨</button>
                        )}
                      </div>
                    </td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {batch && picked.length > 0 && (
        <div className="batch-bar">
          <span>已勾選 {byOrder(tab) ? `${pickedGroups.length} 張訂單（${pickedGroups.flat().length} 台）` : `${pickedGroups.length} 台`}
            {picked.length >= BATCH_LIMIT && <span className="small muted">（一次最多 {BATCH_LIMIT}）</span>}</span>
          <span className="grow" />
          <button type="button" className="secondary" onClick={() => setPicked([])}>取消勾選</button>
          <button type="button" onClick={() => setBatchOpen(true)}>{batch.label}</button>
        </div>
      )}
      {batch && batchOpen && (
        <BatchDialog kind={batch.kind} onClose={() => { setBatchOpen(false); setPicked([]); }} onSaved={data.reload}
          entries={pickedGroups.map((g) => ({
            key: groupKey(g, tab),
            title: `${g[0].order_no} ${g[0].customer_name}`,
            detail: g.map((x) => x.full_product_name).join('、'),
            devices: g.map(toDevice),
          }))} />
      )}

      {action?.kind === 'arrival' && (
        <ArrivalDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} onClose={() => setAction(null)} onSaved={data.reload} />
      )}
      {action?.kind === 'deliver' && (
        <DeliveryDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} itemNote={action.row.item_note} preselected={action.ids}
          others={all
            .filter((r) => r.order_id === action.row.order_id && r.device_id !== action.row.device_id && r.status !== 'pending_arrival')
            .map((r) => ({ device: toDevice(r), label: label(r), note: notesOf(r.item_note, r.note) }))}
          onClose={() => setAction(null)} onSaved={data.reload} />
      )}
      {action?.kind === 'notify' && (
        <NotifyDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} preselected={action.ids} onClose={() => setAction(null)} onSaved={data.reload}
          others={all
            .filter((r) => r.order_id === action.row.order_id && r.device_id !== action.row.device_id && r.status !== 'pending_arrival')
            .map((r) => ({ device: toDevice(r), label: label(r) }))} />
      )}
    </div>
  );
}
