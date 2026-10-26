import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { devicesForOrders, itemsForOrders, rpc, searchBacklog, searchOrders, type SearchField } from '../lib/api';
import { fmtDate, todayTaipei } from '../lib/format';
import { ORDER_STATUS_LABEL } from '../lib/labels';
import type { BacklogRow, Device, OrderSummary } from '../lib/types';
import { ArrivalDialog, DeliveryDialog, NotifyDialog } from '../components/DeviceDialogs';
import { ErrorBanner, StatusBadge, useAsync } from '../components/ui';

const PERIODS = [
  { key: '', label: '任何時間' },
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'month', label: '本月' },
];
const STATUS_FILTERS = [
  { key: '', label: '全部狀態' },
  { key: 'in_progress', label: '進行中' },
  { key: 'pending_arrival', label: '有待到貨' },
  { key: 'arrived_pending_notify', label: '有待通知' },
  { key: 'notified_pending_pickup', label: '有待取貨' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
];
const FIELDS: { key: SearchField; label: string; placeholder: string }[] = [
  { key: 'all', label: '全部欄位', placeholder: '姓名、電話、訂單編號、預結號碼、序號、型號、SN' },
  { key: 'order_no', label: '訂單編號', placeholder: '例：75-011-00348' },
  { key: 'customer_name', label: '顧客姓名', placeholder: '顧客姓名' },
  { key: 'customer_phone', label: '電話', placeholder: '電話號碼' },
  { key: 'receipt_no', label: '預結號碼', placeholder: '例：75022765' },
  { key: 'receipt_seq', label: '序號', placeholder: '收據序號' },
  { key: 'model', label: '型號／品名', placeholder: '例：MD3Y4' },
  { key: 'sn', label: 'SN', placeholder: 'SN' },
];

// 依結帳日期（台北時間）計算起始日
function sinceOf(period: string): string | undefined {
  const today = todayTaipei();
  const back = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  if (period === 'today') return today;
  if (period === '7d') return back(6);
  if (period === '30d') return back(29);
  if (period === 'month') return `${today.slice(0, 8)}01`;
  return undefined;
}

export function OrdersPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const store = params.get('store') ?? '';
  const byModel = params.get('mode') === 'model';
  const all = params.get('all') === '1';   // 型號查詢：也列出沒有欠貨的
  const [input, setInput] = useState(q);
  const period = params.get('period') ?? '';
  const status = params.get('status') ?? '';
  const field = (params.get('field') ?? 'all') as SearchField;
  const result = useAsync(() => (byModel ? Promise.resolve(null)
    : searchOrders({ q, field, storeCode: store || undefined, status, since: sinceOf(period) })), [q, field, store, status, period, byModel]);
  const backlog = useAsync(() => (byModel ? searchBacklog({ q, storeCode: store || undefined, onlyBacklog: false }) : Promise.resolve(null)),
    [q, store, byModel, all]);
  const setParam = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; });

  function submit(e: FormEvent) {
    e.preventDefault();
    setParams((p) => { p.set('q', input.trim()); return p; });
  }

  return (
    <div className="stack">
      <h1>訂單查詢</h1>
      <div className="row gap">
        <button type="button" className={byModel ? 'secondary' : ''} onClick={() => setParam('mode', '')}>依訂單</button>
        <button type="button" className={byModel ? '' : 'secondary'} onClick={() => setParam('mode', 'model')}>依型號查欠貨</button>
      </div>
      <form className="filter-bar" onSubmit={submit}>
        {!byModel && (
          <select value={period} onChange={(e) => setParam('period', e.target.value)} aria-label="結帳日期">
            {PERIODS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        )}
        {me.stores.length > 1 && (
          <select value={store} onChange={(e) => setParam('store', e.target.value)} aria-label="門市">
            <option value="">全部門市</option>
            {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        )}
        {!byModel && (
          <select value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="狀態">
            {STATUS_FILTERS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        )}
        <div className="input-group grow">
          {!byModel && (
            <select value={field} onChange={(e) => setParam('field', e.target.value === 'all' ? '' : e.target.value)} aria-label="搜尋欄位">
              {FIELDS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          )}
          <input className="grow" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={byModel ? '型號或品名，例：MFYN4' : FIELDS.find((x) => x.key === field)?.placeholder}
            autoCapitalize={byModel || field === 'model' || field === 'sn' ? 'characters' : undefined} />
        </div>
        <button type="submit">查詢</button>
      </form>
      {byModel ? (
        <>
          <label className="radio small">
            <input type="checkbox" checked={all} onChange={(e) => setParam('all', e.target.checked ? '1' : '')} />顯示全部（含已到貨）
          </label>
          <ErrorBanner error={backlog.error} />
          {backlog.loading && <div className="muted">載入中…</div>}
          {!q && <div className="muted">輸入型號或品名後搜尋。欠貨＝尚未到貨的台數，依結帳日期由舊到新排列。</div>}
          {q && backlog.data && (backlog.data.length ? <BacklogTable rows={backlog.data} all={all} /> : <div className="muted">沒有符合的商品。</div>)}
        </>
      ) : (
        <>
          {result.data && <p className="muted small">共 {result.data.length} 筆{result.data.length >= 100 ? '（只顯示最近 100 筆，請縮小條件）' : ''}</p>}
          <ErrorBanner error={result.error} />
          {result.loading && <div className="muted">載入中…</div>}
          {result.data && (result.data.length ? <OrderTable orders={result.data} /> : <div className="muted">沒有符合的訂單。</div>)}
        </>
      )}
    </div>
  );
}

// 先合併同訂單同商品再篩選欠貨，訂購數才會是整張單的數量
function BacklogTable({ rows: raw, all }: { rows: BacklogRow[]; all: boolean }) {
  const rows = groupByProduct(raw).filter((r) => all || r.pending_arrival > 0);
  if (!rows.length) return <div className="muted">目前沒有欠貨。勾選「顯示全部（含已到貨）」可查看已到貨的訂單。</div>;
  const totalBacklog = rows.reduce((s, r) => s + r.pending_arrival, 0);
  const orders = new Set(rows.filter((r) => r.pending_arrival > 0).map((r) => r.order_id)).size;
  return (
    <div className="stack">
      <div><strong>欠貨 {totalBacklog} 台</strong>（{orders} 張訂單）</div>
      <div className="table-wrap table-card">
        <table className="list">
          <thead>
            <tr>
              <th>結帳日期</th><th>訂單編號</th><th>顧客</th><th>品名</th><th>訂購</th><th>欠貨</th><th>已到貨未交付</th><th>已交付</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_id} className={r.pending_arrival ? '' : 'dim'}>
                <td data-label="結帳日期">{fmtDate(r.purchase_date)}</td>
                <td data-label="訂單編號"><Link to={`/orders/${r.order_id}`}>{r.order_no}</Link></td>
                <td data-label="顧客">{r.customer_name}</td>
                <td data-label="品名" className="product-name">{r.full_product_name}</td>
                <td data-label="訂購">{r.ordered_qty}</td>
                <td data-label="欠貨"><strong>{r.pending_arrival}</strong></td>
                <td data-label="已到貨未交付">{r.arrived_pending_notify + r.notified_pending_pickup}</td>
                <td data-label="已交付">{r.delivered + r.excluded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 商品各狀態台數（只列有台數的狀態）
const ITEM_STATUSES = ['pending_arrival', 'arrived_pending_notify', 'notified_pending_pickup', 'delivered', 'excluded'] as const;

// 同一張訂單裡相同商品（一次訂多台或分開加入）合併為一列，數量與各狀態台數相加（保持原本順序）
type GroupRow = BacklogRow & { item_ids: string[] };
function groupByProduct(rows: BacklogRow[]): GroupRow[] {
  const out: GroupRow[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.order_id === r.order_id
      && x.full_product_name === r.full_product_name && x.model === r.model && x.barcode === r.barcode);
    if (!g) { out.push({ ...r, item_ids: [r.item_id] }); continue; }
    g.item_ids.push(r.item_id);
    g.ordered_qty += r.ordered_qty;
    for (const s of ITEM_STATUSES) g[s] += r[s];
  }
  return out;
}

// 下一步操作：每一步不同顏色
type StepKey = 'arrival' | 'label' | 'notify' | 'deliver';
const STEP_LABEL: Record<StepKey, string> = { arrival: '登記到貨', label: '已貼', notify: '通知顧客', deliver: '完成交付' };
function stepsOf(d: Device): StepKey[] {
  const unlabeled = !d.is_labeled ? ['label' as const] : [];
  if (d.status === 'pending_arrival') return ['arrival'];
  if (d.status === 'arrived_pending_notify') return [...unlabeled, 'notify'];
  if (d.status === 'notified_pending_pickup') return [...unlabeled, 'deliver'];
  return [];
}

// 每台單機各佔一行（同商品相鄰排列），登記到貨等操作才知道是哪一台；數量只顯示在同商品的第一行
type UnitLine = { device: Device; name: string; groupQty: number | null };

export function OrderTable({ orders, onChanged }: { orders: OrderSummary[]; onChanged?: () => void }) {
  const ids = orders.map((o) => o.id);
  const items = useAsync(() => itemsForOrders(ids), [ids.join(',')]);
  const devices = useAsync(() => devicesForOrders(ids), [ids.join(',')]);
  const [action, setAction] = useState<{ step: StepKey; device: Device; label: string } | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const reload = () => { items.reload(); devices.reload(); onChanged?.(); };

  function linesOf(orderId: string): UnitLine[] {
    const its = (items.data ?? []).filter((i) => i.order_id === orderId);
    const groups = groupByProduct(its);
    const lines: UnitLine[] = [];
    for (const g of groups) {
      const devs = (devices.data ?? [])
        .filter((d) => g.item_ids.includes(d.order_item_id))
        .sort((x, y) => g.item_ids.indexOf(x.order_item_id) - g.item_ids.indexOf(y.order_item_id) || x.unit_no - y.unit_no);
      devs.forEach((d, i) => lines.push({ device: d, name: g.full_product_name, groupQty: i === 0 ? devs.length : null }));
    }
    return lines;
  }

  async function start(step: StepKey, device: Device, label: string) {
    setOpError(null);
    if (step !== 'label') { setAction({ step, device, label }); return; }
    try {
      await rpc('set_labeled', { p_device_id: device.id, p_expected_version: device.version, p_labeled: true });
      reload();
    } catch (e) {
      setOpError(e);
    }
  }

  return (
    <div className="table-wrap table-card">
      <ErrorBanner error={opError} />
      <table className="list">
        <thead>
          <tr>
            <th>訂單編號</th><th>顧客</th><th>電話</th><th>結帳日期</th><th>機號</th><th>序號</th><th>預結號碼</th>
            <th>商品明細</th><th>數量</th><th>狀態</th><th>操作</th><th>備註</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const lines = o.order_status === 'cancelled' ? [] : linesOf(o.id);
            const cell = (render: (l: UnitLine, i: number) => ReactNode) => (o.order_status === 'cancelled' ? '—' : (
              <div className="item-lines">{lines.map((l, i) => <div key={l.device.id}>{render(l, i)}</div>)}</div>
            ));
            return (
              <tr key={o.id} className={o.order_status === 'cancelled' ? 'dim' : ''}>
                <td data-label="訂單編號" className="nowrap"><Link to={`/orders/${o.id}`}>{o.order_no}</Link></td>
                <td data-label="顧客" className="nowrap">{o.customer_name}</td>
                <td data-label="電話" className="nowrap">{o.customer_phone}</td>
                <td data-label="結帳日期" className="nowrap">{fmtDate(o.purchase_date)}</td>
                <td data-label="機號">{o.register_no}</td>
                <td data-label="序號">{o.receipt_seq}</td>
                <td data-label="預結號碼">{o.receipt_no ?? '—'}</td>
                <td data-label="商品明細">
                  {cell((l) => (
                    <span className="product-name">{l.name}{l.device.sn && <span className="small muted">（{l.device.sn}）</span>}</span>
                  ))}
                </td>
                <td data-label="數量">{cell((l) => l.groupQty ?? '')}</td>
                <td data-label="狀態">
                  {o.order_status === 'cancelled' ? <span>{ORDER_STATUS_LABEL.cancelled}</span> : cell((l) => <StatusBadge status={l.device.status} />)}
                </td>
                <td data-label="操作">
                  {cell((l) => stepsOf(l.device).map((step) => (
                    <button key={step} type="button" className={`step step-${step}`}
                      onClick={() => start(step, l.device, `${o.order_no}・${l.name}${l.device.sn ? `（${l.device.sn}）` : ''}`)}>
                      {STEP_LABEL[step]}
                    </button>
                  )))}
                </td>
                <td data-label="備註" className="clip">{o.order_note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {action?.step === 'arrival' && <ArrivalDialog device={action.device} label={action.label} onClose={() => setAction(null)} onSaved={reload} />}
      {action?.step === 'deliver' && <DeliveryDialog device={action.device} label={action.label} onClose={() => setAction(null)} onSaved={reload} />}
      {action?.step === 'notify' && (
        <NotifyDialog device={action.device} label={action.label} onClose={() => setAction(null)} onSaved={reload}
          others={(devices.data ?? [])
            .filter((d) => d.order_id === action.device.order_id && d.id !== action.device.id
              && ['arrived_pending_notify', 'notified_pending_pickup'].includes(d.status))
            .map((d) => ({ device: d, label: `${(items.data ?? []).find((i) => i.item_id === d.order_item_id)?.full_product_name ?? ''}${d.sn ? `（${d.sn}）` : ''}` }))} />
      )}
    </div>
  );
}

export function OrderProgress({ o }: { o: OrderSummary }) {
  if (o.order_status !== 'in_progress') return <span>{ORDER_STATUS_LABEL[o.order_status]}</span>;
  const parts = [
    o.pending_arrival && `待到貨 ${o.pending_arrival}`,
    o.arrived_pending_notify && `待通知 ${o.arrived_pending_notify}`,
    o.notified_pending_pickup && `待取貨 ${o.notified_pending_pickup}`,
    o.delivered && `已交付 ${o.delivered}`,
    o.excluded && `已取走 ${o.excluded}`,
  ].filter(Boolean);
  return <span className="small">{parts.join('・')}</span>;
}
