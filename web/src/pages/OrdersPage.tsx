import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { itemsForOrders, searchBacklog, searchOrders } from '../lib/api';
import { fmtDate } from '../lib/format';
import { ORDER_STATUS_LABEL } from '../lib/labels';
import type { BacklogRow, OrderSummary } from '../lib/types';
import { ErrorBanner, StatusBadge, useAsync } from '../components/ui';

export function OrdersPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const store = params.get('store') ?? '';
  const byModel = params.get('mode') === 'model';
  const all = params.get('all') === '1';   // 型號查詢：也列出沒有欠貨的
  const [input, setInput] = useState(q);
  const result = useAsync(() => (byModel ? Promise.resolve(null) : searchOrders({ q, storeCode: store || undefined })), [q, store, byModel]);
  const backlog = useAsync(() => (byModel ? searchBacklog({ q, storeCode: store || undefined, onlyBacklog: !all }) : Promise.resolve(null)),
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
      <form className="row gap wrap" onSubmit={submit}>
        <input className="grow" placeholder={byModel ? '型號或品名，例：MFYN4' : '姓名、電話、訂單編號、預結號碼'} value={input}
          autoCapitalize={byModel ? 'characters' : undefined} onChange={(e) => setInput(e.target.value)} />
        {me.stores.length > 1 && (
          <select value={store} onChange={(e) => setParam('store', e.target.value)}>
            <option value="">全部門市</option>
            {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        )}
        <button type="submit">搜尋</button>
      </form>
      {byModel ? (
        <>
          <label className="radio small">
            <input type="checkbox" checked={all} onChange={(e) => setParam('all', e.target.checked ? '1' : '')} />顯示全部（含已到貨）
          </label>
          <ErrorBanner error={backlog.error} />
          {backlog.loading && <div className="muted">載入中…</div>}
          {!q && <div className="muted">輸入型號或品名後搜尋。欠貨＝尚未到貨的台數，依結帳日期由舊到新排列。</div>}
          {q && backlog.data && (backlog.data.length ? <BacklogTable rows={backlog.data} /> : <div className="muted">沒有符合的商品。</div>)}
        </>
      ) : (
        <>
          <p className="muted small">可依姓名、電話、訂單編號、預結號碼搜尋，顯示最近 50 筆。</p>
          <ErrorBanner error={result.error} />
          {result.loading && <div className="muted">載入中…</div>}
          {result.data && (result.data.length ? <OrderTable orders={result.data} /> : <div className="muted">沒有符合的訂單。</div>)}
        </>
      )}
    </div>
  );
}

function BacklogTable({ rows }: { rows: BacklogRow[] }) {
  const totalBacklog = rows.reduce((s, r) => s + r.pending_arrival, 0);
  const orders = new Set(rows.filter((r) => r.pending_arrival > 0).map((r) => r.order_id)).size;
  return (
    <div className="stack">
      <div><strong>欠貨 {totalBacklog} 台</strong>（{orders} 張訂單）</div>
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              <th>結帳日期</th><th>訂單編號</th><th>顧客</th><th>品名</th><th>訂購</th><th>欠貨</th><th>已到貨未交付</th><th>已交付／取走</th>
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
                <td data-label="已交付／取走">{r.delivered + r.excluded}</td>
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

export function OrderTable({ orders }: { orders: OrderSummary[] }) {
  const ids = orders.map((o) => o.id);
  const items = useAsync(() => itemsForOrders(ids), [ids.join(',')]);
  const itemsOf = (orderId: string) => (items.data ?? []).filter((i) => i.order_id === orderId);
  return (
    <div className="table-wrap">
      <table className="list">
        <thead>
          <tr>
            <th>訂單編號</th><th>顧客</th><th>電話</th><th>結帳日期</th><th>機號</th><th>序號</th><th>預結號碼</th>
            <th>商品明細</th><th>狀態</th><th>備註</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className={o.order_status === 'cancelled' ? 'dim' : ''}>
              <td data-label="訂單編號"><Link to={`/orders/${o.id}`}>{o.order_no}</Link></td>
              <td data-label="顧客">{o.customer_name}</td>
              <td data-label="電話">{o.customer_phone}</td>
              <td data-label="結帳日期">{fmtDate(o.purchase_date)}</td>
              <td data-label="機號">{o.register_no}</td>
              <td data-label="序號">{o.receipt_seq}</td>
              <td data-label="預結號碼">{o.receipt_no ?? '—'}</td>
              <td data-label="商品明細">
                {o.order_status === 'cancelled' ? '—' : (
                  <div className="item-lines">
                    {itemsOf(o.id).map((i) => <div key={i.item_id} className="product-name">{i.full_product_name} × {i.ordered_qty}</div>)}
                  </div>
                )}
              </td>
              <td data-label="狀態">
                {o.order_status === 'cancelled' ? <span>{ORDER_STATUS_LABEL.cancelled}</span> : (
                  <div className="item-lines">
                    {itemsOf(o.id).map((i) => (
                      <div key={i.item_id} className="row gap">
                        {ITEM_STATUSES.filter((s) => i[s] > 0).map((s) => (
                          <span key={s}><StatusBadge status={s} />{i[s] > 1 ? ` ×${i[s]}` : ''}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </td>
              <td data-label="備註" className="clip">{o.order_note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
