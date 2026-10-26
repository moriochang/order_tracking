// 待辦清單：依「該做的下一步」分頁列出每台機器，最久的排最前面，直接在列上操作。
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { listTodo, rpc } from '../lib/api';
import { fmtDate, todayTaipei } from '../lib/format';
import type { Device, TodoRow } from '../lib/types';
import { ArrivalDialog, DeliveryDialog, NotifyDialog, notesOf } from '../components/DeviceDialogs';
import { ErrorBanner, StatusBadge, useAsync } from '../components/ui';

const PICKUP_OVERDUE_DAYS = 14;   // 通知後超過幾天未取貨標紅

type TabKey = 'all' | 'arrival' | 'notify' | 'label' | 'pickup';
const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'all', label: '全部', hint: '所有尚未完成的機器，依結帳日期由舊到新。' },
  { key: 'arrival', label: '待到貨', hint: '依結帳日期由舊到新，先訂的先給。' },
  { key: 'notify', label: '待通知', hint: '已到貨、尚未聯絡顧客，依到貨時間排序。' },
  { key: 'label', label: '待貼', hint: '已到貨、尚未貼標留貨的機器。' },
  { key: 'pickup', label: '待取貨', hint: `已通知、顧客尚未取貨，依通知時間排序；超過 ${PICKUP_OVERDUE_DAYS} 天標紅。` },
];

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
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'all') as TabKey;
  const store = params.get('store') ?? '';
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const data = useAsync(() => listTodo({ storeCode: store || undefined, q }), [store, q]);
  const [action, setAction] = useState<{ kind: 'arrival' | 'notify' | 'deliver'; row: TodoRow } | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const setParam = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; });

  const all = data.data ?? [];
  const rows = all.filter((r) => inTab(r, tab))
    .sort((a, b) => since(a, tab).localeCompare(since(b, tab)) || a.order_no.localeCompare(b.order_no) || a.unit_no - b.unit_no);
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
            {t.label}（{all.filter((r) => inTab(r, t.key)).length}）
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
      <p className="muted small">{TABS.find((t) => t.key === tab)?.hint}</p>
      <ErrorBanner error={data.error ?? opError} />
      {data.loading && !data.data && <div className="muted">載入中…</div>}
      {data.data && (rows.length === 0 ? <div className="muted">目前沒有待辦。</div> : (
        <div className="table-wrap table-card">
          <table className="list">
            <thead>
              <tr>
                <th>{tab === 'arrival' || tab === 'all' ? '結帳日期' : tab === 'pickup' ? '通知時間' : '到貨時間'}</th><th>等待時間</th>
                <th>訂單編號</th><th>顧客</th><th>電話</th><th>品名</th><th>SN</th><th>狀態</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const start = since(r, tab);
                const days = daysSince(start);
                const overdue = tab === 'pickup' && days > PICKUP_OVERDUE_DAYS;
                return (
                  <tr key={r.device_id} className={overdue ? 'overdue' : ''}>
                    <td data-label={tab === 'arrival' || tab === 'all' ? '結帳日期' : tab === 'pickup' ? '通知時間' : '到貨時間'} className="nowrap">
                      {start ? fmtDate(taipeiDay(start)) : '—'}
                    </td>
                    <td data-label="等待時間" className="nowrap"><span className={overdue ? 'overdue-days' : ''}>{days} 天</span></td>
                    <td data-label="訂單編號" className="nowrap"><Link to={`/orders/${r.order_id}`}>{r.order_no}</Link></td>
                    <td data-label="顧客" className="nowrap">{r.customer_name}</td>
                    <td data-label="電話" className="nowrap">{r.customer_phone}</td>
                    <td data-label="品名"><span className="product-name">{r.full_product_name}</span>
                      {notesOf(r.item_note, r.note) && <div className="device-note block">⚠ {notesOf(r.item_note, r.note)}</div>}</td>
                    <td data-label="SN">{r.sn ?? '—'}</td>
                    <td data-label="狀態"><StatusBadge status={r.status} /></td>
                    <td data-label="操作">
                      <div className="row gap">
                        {(tab === 'arrival' || (tab === 'all' && r.status === 'pending_arrival')) && (
                          <button type="button" className="step step-arrival" onClick={() => setAction({ kind: 'arrival', row: r })}>登記到貨</button>
                        )}
                        {(tab === 'label' || (tab === 'all' && r.status !== 'pending_arrival' && !r.is_labeled)) && (
                          <button type="button" className="step step-label" onClick={() => markLabeled(r)}>已貼</button>
                        )}
                        {(tab === 'notify' || tab === 'pickup' || (tab === 'all' && r.status === 'arrived_pending_notify')) && (
                          <button type="button" className="step step-notify" onClick={() => setAction({ kind: 'notify', row: r })}>{r.status === 'notified_pending_pickup' ? '再次通知' : '通知顧客'}</button>
                        )}
                        {(tab === 'pickup' || tab === 'notify' || (tab === 'all' && r.status !== 'pending_arrival')) && (
                          <button type="button" className="step step-deliver" onClick={() => setAction({ kind: 'deliver', row: r })}>完成交付</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {action?.kind === 'arrival' && (
        <ArrivalDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} onClose={() => setAction(null)} onSaved={data.reload} />
      )}
      {action?.kind === 'deliver' && (
        <DeliveryDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} itemNote={action.row.item_note}
          others={all
            .filter((r) => r.order_id === action.row.order_id && r.device_id !== action.row.device_id && r.status !== 'pending_arrival')
            .map((r) => ({ device: toDevice(r), label: label(r), note: notesOf(r.item_note, r.note) }))}
          onClose={() => setAction(null)} onSaved={data.reload} />
      )}
      {action?.kind === 'notify' && (
        <NotifyDialog device={toDevice(action.row)} label={label(action.row)} order={orderOf(action.row)} onClose={() => setAction(null)} onSaved={data.reload}
          others={all
            .filter((r) => r.order_id === action.row.order_id && r.device_id !== action.row.device_id && r.status !== 'pending_arrival')
            .map((r) => ({ device: toDevice(r), label: label(r) }))} />
      )}
    </div>
  );
}
