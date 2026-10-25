import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { searchOrders } from '../lib/api';
import { fmtDate, receiptLabel } from '../lib/format';
import { ORDER_STATUS_LABEL } from '../lib/labels';
import type { OrderSummary } from '../lib/types';
import { ErrorBanner, useAsync } from '../components/ui';

export function OrdersPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const store = params.get('store') ?? '';
  const [input, setInput] = useState(q);
  const result = useAsync(() => searchOrders({ q, storeCode: store || undefined }), [q, store]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setParams((p) => { p.set('q', input.trim()); return p; });
  }

  return (
    <div className="stack">
      <h1>訂單查詢</h1>
      <form className="row gap wrap" onSubmit={submit}>
        <input className="grow" placeholder="姓名、電話、訂單編號、預結號碼" value={input}
          onChange={(e) => setInput(e.target.value)} />
        {me.stores.length > 1 && (
          <select value={store} onChange={(e) => setParams((p) => { p.set('store', e.target.value); return p; })}>
            <option value="">全部門市</option>
            {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        )}
        <button type="submit">搜尋</button>
      </form>
      <p className="muted small">
        第一階段：可依姓名、電話、訂單編號、預結號碼搜尋，顯示最近 50 筆。依商品名稱／SN 搜尋與狀態篩選為第三階段功能。
      </p>
      <ErrorBanner error={result.error} />
      {result.loading && <div className="muted">載入中…</div>}
      {result.data && (result.data.length ? <OrderTable orders={result.data} /> : <div className="muted">沒有符合的訂單。</div>)}
    </div>
  );
}

export function OrderTable({ orders }: { orders: OrderSummary[] }) {
  return (
    <div className="table-wrap">
      <table className="list">
        <thead>
          <tr>
            <th>訂單編號</th><th>顧客</th><th>電話</th><th>結帳日期</th><th>預結號碼／序號</th>
            <th>商品／台數</th><th>進度</th><th>備註</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className={o.order_status === 'cancelled' ? 'dim' : ''}>
              <td data-label="訂單編號"><Link to={`/orders/${o.id}`}>{o.order_no}</Link></td>
              <td data-label="顧客">{o.customer_name}</td>
              <td data-label="電話">{o.customer_phone}</td>
              <td data-label="結帳日期">{fmtDate(o.purchase_date)}</td>
              <td data-label="預結號碼／序號">{receiptLabel(o)}</td>
              <td data-label="商品／台數">{o.item_count} 項／{o.device_total} 台</td>
              <td data-label="進度"><OrderProgress o={o} /></td>
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
