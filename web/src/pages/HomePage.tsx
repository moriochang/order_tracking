import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { canEdit, canExport } from '../lib/labels';
import { getSheetLink, searchOrders, todoCounts } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ErrorBanner, useAsync } from '../components/ui';
import { OrderTable } from './OrdersPage';

const TILES = [
  { key: 'pending_arrival', label: '待到貨', tab: 'arrival' },
  { key: 'pending_label', label: '待貼', tab: 'label' },
  { key: 'arrived_pending_notify', label: '待通知', tab: 'notify' },
  { key: 'notified_pending_pickup', label: '待取貨', tab: 'pickup' },
  { key: 'delivered', label: '已取貨', stat: true },
];

export function HomePage() {
  const me = useMe();
  const [store, setStore] = useState('');
  const counts = useAsync(() => todoCounts(store || undefined), [store]);
  const recent = useAsync(() => searchOrders({ storeCode: store || undefined, limit: 10 }), [store]);
  // 試算表同步狀態：只有能匯出的人（門市檢視、主管、管理者）看得到
  const sheet = useAsync(() => (canExport(me.role) ? getSheetLink() : Promise.resolve(null)), [me.role]);
  const syncedAt = sheet.data?.last_synced_at;
  const stale = syncedAt ? Date.now() - Date.parse(syncedAt) > 30 * 60000 : false;

  return (
    <div className="stack">
      <div className="row between wrap">
        <h1>首頁</h1>
        {me.stores.length > 1 && (
          <select value={store} onChange={(e) => setStore(e.target.value)} aria-label="門市">
            <option value="">全部門市</option>
            {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
        )}
      </div>

      <ErrorBanner error={counts.error} />
      <section className="tiles">
        {TILES.map((t) => {
          const body = (
            <>
              <div className="tile-num">{counts.loading ? '…' : counts.data?.[t.key] ?? 0}</div>
              <div className="tile-label">{t.label}{t.stat ? '（統計）' : ''}</div>
            </>
          );
          return t.tab
            ? <Link key={t.key} to={`/todo?tab=${t.tab}`} className={`tile tile-link tile-${t.key}`}>{body}</Link>
            : <div key={t.key} className={`tile stat tile-${t.key}`}>{body}</div>;
        })}
      </section>
      <p className="muted small">數字依每台機器的實際狀態即時計算，不含已取消。點數字可進入待辦清單。</p>
      {sheet.data?.url && (
        <p className="small">
          Google 試算表最後同步：{syncedAt ? `${fmtDateTime(syncedAt)}（${sheet.data.last_rows ?? 0} 列）` : '尚無紀錄'}
          {stale && <span className="error-text">　⚠ 已超過 30 分鐘沒有同步</span>}
          　<a href={sheet.data.url} target="_blank" rel="noreferrer">開啟試算表</a>
        </p>
      )}

      <section className="stack">
        <div className="row between">
          <h2>最近建立的訂單</h2>
          {canEdit(me.role) && <Link to="/orders/new" className="button">＋ 新增訂單</Link>}
        </div>
        <ErrorBanner error={recent.error} />
        {recent.data && <OrderTable orders={recent.data} onChanged={counts.reload} />}
      </section>
    </div>
  );
}
