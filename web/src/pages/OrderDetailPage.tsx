import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listProfiles, loadOrder, rpc } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { METHOD_LABEL, ORDER_STATUS_LABEL, OUTCOME_LABEL, STATUS_LABEL } from '../lib/labels';
import type { Device, OrderItem } from '../lib/types';
import { ErrorBanner, ReasonDialog, StatusBadge, useAsync } from '../components/ui';
import { AuditTimeline } from '../components/AuditTimeline';
import { EditItemDialog, EditOrderDialog } from '../components/OrderDialogs';
import { unitNumbers } from '../lib/units';
import { OrderProgress } from './OrdersPage';
import { ArrivalDialog, CorrectSnDialog, DeliveryDialog, DeviceNoteDialog, NotifyDialog } from '../components/DeviceDialogs';

type Modal =
  | { kind: 'edit_order' }
  | { kind: 'cancel_order' }
  | { kind: 'edit_item'; item: OrderItem }
  | { kind: 'cancel_device'; device: Device; item: OrderItem }
  | { kind: 'arrival' | 'notify' | 'deliver' | 'note' | 'sn' | 'correct_status'; device: Device; item: OrderItem };

// 更正狀態：只能退回一格（原因必填）
const CORRECT_TO: Partial<Record<Device['status'], Device['status']>> = {
  delivered: 'notified_pending_pickup',
  notified_pending_pickup: 'arrived_pending_notify',
  arrived_pending_notify: 'pending_arrival',
  excluded: 'pending_arrival',
};

export function OrderDetailPage() {
  const { orderId = '' } = useParams();
  const data = useAsync(() => loadOrder(orderId), [orderId]);
  const profiles = useAsync(listProfiles, []);
  const [modal, setModal] = useState<Modal | null>(null);
  const [deviceFilter, setDeviceFilter] = useState<string | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const names = useMemo(() => new Map((profiles.data ?? []).map((p) => [p.user_id, p.display_name])), [profiles.data]);

  if (data.loading && !data.data) return <div className="muted">載入中…</div>;
  if (data.error) return <ErrorBanner error={data.error} />;
  const d = data.data;
  if (!d?.summary) return <div className="card">找不到這張訂單，或你沒有查看權限。<Link to="/orders">回訂單查詢</Link></div>;

  const o = d.summary;
  const active = o.order_status !== 'cancelled';
  const close = () => setModal(null);
  const reload = data.reload;
  const itemById = new Map(d.items.map((i) => [i.id, i]));
  const lastSuccess = (deviceId: string) => d.notifications.find((n) => n.device_id === deviceId && n.is_success);
  // 單機一律依流水號 1、2、3… 顯示，同一商品一次訂多台或分開加入都一樣
  const unitNo = unitNumbers(d.items, d.devices);
  const units = [...d.devices].sort((a, b) => unitNo.get(a.id)! - unitNo.get(b.id)!);
  const unitName = (dev: Device) => `${unitNo.get(dev.id)}. ${itemById.get(dev.order_item_id)!.full_product_name}${dev.sn ? `（${dev.sn}）` : ''}`;
  const unitsOfItem = (itemId: string) => d.devices.filter((x) => x.order_item_id === itemId && x.status !== 'cancelled').length;

  async function toggleLabeled(dev: Device) {
    setOpError(null);
    try {
      await rpc('set_labeled', { p_device_id: dev.id, p_expected_version: dev.version, p_labeled: !dev.is_labeled });
      reload();
    } catch (e) {
      setOpError(e);
    }
  }

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h1>{o.order_no}</h1>
          <div className="muted small">{o.store_code}・建立於 {fmtDateTime(o.created_at)}・<span className="operator">{names.get(o.created_by) ?? ''}</span></div>
        </div>
        <div className="row gap">
          <span className={`badge order-${o.order_status}`}>{ORDER_STATUS_LABEL[o.order_status]}</span>
          <button className="secondary" onClick={reload}>重新載入</button>
        </div>
      </div>

      {o.cancelled_at && <div className="alert error">此訂單已於 {fmtDateTime(o.cancelled_at)} 取消。原因：{o.cancellation_reason}</div>}

      {/* 1. 訂單基本資料與備註 */}
      <section className="card stack">
        <div className="row between">
          <h2>訂單資料</h2>
          {active && (
            <div className="row gap">
              <button className="secondary" onClick={() => setModal({ kind: 'edit_order' })}>修改</button>
              <button className="danger" onClick={() => setModal({ kind: 'cancel_order' })}>取消訂單</button>
            </div>
          )}
        </div>
        <dl className="grid-dl">
          <dt>顧客</dt><dd>{o.customer_name}</dd>
          <dt>電話</dt><dd>{o.customer_phone}</dd>
          <dt>結帳日期</dt><dd>{fmtDate(o.purchase_date)}</dd>
          <dt>收銀機號／序號</dt><dd>{o.register_no}／{o.receipt_seq}</dd>
          <dt>預結號碼</dt><dd>{o.receipt_no ?? '—'}</dd>
          <dt>進度</dt><dd><OrderProgress o={o} /></dd>
          <dt>訂單備註</dt><dd className="prewrap">{o.order_note ?? '—'}</dd>
        </dl>
      </section>

      {/* 2. 商品明細 */}
      <section className="card stack">
        <div className="row between">
          <h2>商品明細</h2>
        </div>
        {units.filter((dev) => dev.status !== 'cancelled').map((dev) => {
          const it = itemById.get(dev.order_item_id)!;
          return (
            <div key={dev.id} className="draft-item">
              <div className="grow">
                <div className="product-name">{unitNo.get(dev.id)}. {it.full_product_name}</div>
                <div className="small muted">
                  {[it.model, it.barcode && `條碼 ${it.barcode}`, it.source === 'ocr' && '掃描匯入'].filter(Boolean).join('・')}
                </div>
                {it.item_note && <div className="small">備註：{it.item_note}</div>}
              </div>
              {active && (
                <div className="row gap wrap">
                  <button className="link" onClick={() => setModal({ kind: 'edit_item', item: it })}>修改</button>
                  {dev.status !== 'delivered' && (
                    <button className="link danger-text" onClick={() => setModal({ kind: 'cancel_device', device: dev, item: it })}>取消</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {units.some((dev) => dev.status === 'cancelled') && (
          <details className="small">
            <summary>已取消 {units.filter((dev) => dev.status === 'cancelled').length} 台</summary>
            <ul className="plain">
              {units.filter((dev) => dev.status === 'cancelled').map((dev) => (
                <li key={dev.id} className="dim">{unitName(dev)}・{dev.cancellation_reason}</li>
              ))}
            </ul>
          </details>
        )}
        {d.scans.map((s) => (
          <details key={s.id} className="small">
            <summary>掃描原文（{fmtDateTime(s.created_at)}）</summary>
            <pre className="scan-text">{s.raw_text}</pre>
          </details>
        ))}
      </section>

      {/* 3. 單機狀態 */}
      <section className="card stack">
        <h2>單機（共 {o.device_total} 台{o.cancelled ? `，另有已取消 ${o.cancelled} 台` : ''}）</h2>
        <div className="table-wrap">
          <table className="list devices">
            <thead>
              <tr><th>單機</th><th>商品</th><th>SN</th><th>狀態</th><th>已通知</th><th>已貼</th><th>到貨</th><th>交付</th><th>下一步</th><th></th></tr>
            </thead>
            <tbody>
              {units.map((dev) => {
                  const it = itemById.get(dev.order_item_id)!;
                  const notified = lastSuccess(dev.id);
                  return (
                    <tr key={dev.id} className={dev.status === 'cancelled' ? 'dim' : ''}>
                      <td data-label="單機">{unitNo.get(dev.id)}</td>
                      <td data-label="商品">
                        <span className="product-name">{it.full_product_name}</span>
                        {dev.note && <div className="small">備註：{dev.note}</div>}
                        {dev.delivery_note && <div className="small muted">交付：{dev.delivery_note}</div>}
                      </td>
                      <td data-label="SN">
                        {dev.sn ?? <span className="muted">{dev.status === 'pending_arrival' ? '尚未登記' : '無'}</span>}
                        {active && ['arrived_pending_notify', 'notified_pending_pickup', 'delivered'].includes(dev.status) && (
                          <button className="link small" onClick={() => setModal({ kind: 'sn', device: dev, item: it })}>{dev.sn ? '更正' : '補登'}</button>
                        )}
                      </td>
                      <td data-label="狀態">
                        <StatusBadge status={dev.status} />
                        {dev.exclusion_reason && dev.status === 'excluded' && <div className="small muted">{dev.exclusion_reason}</div>}
                        {dev.status === 'cancelled' && <div className="small muted">{dev.cancellation_reason}</div>}
                      </td>
                      <td data-label="已通知">{notified ? fmtDateTime(notified.notified_at) : '—'}</td>
                      <td data-label="已貼">
                        {active && ['arrived_pending_notify', 'notified_pending_pickup'].includes(dev.status)
                          ? <label className="radio"><input type="checkbox" checked={dev.is_labeled} onChange={() => toggleLabeled(dev)} />{dev.is_labeled ? '是' : '否'}</label>
                          : dev.is_labeled ? '是' : '否'}
                      </td>
                      <td data-label="到貨">{fmtDateTime(dev.arrived_at)}</td>
                      <td data-label="交付">{fmtDateTime(dev.delivered_at)}</td>
                      <td data-label="下一步">
                        {!active ? '—'
                          : dev.status === 'pending_arrival' ? <button className="step step-arrival" onClick={() => setModal({ kind: 'arrival', device: dev, item: it })}>登記到貨</button>
                          : dev.status === 'arrived_pending_notify' ? (
                            <div className="row gap wrap">
                              <button className="step step-notify" onClick={() => setModal({ kind: 'notify', device: dev, item: it })}>通知顧客</button>
                              <button className="link small text-deliver" onClick={() => setModal({ kind: 'deliver', device: dev, item: it })}>直接交付</button>
                            </div>
                          )
                          : dev.status === 'notified_pending_pickup' ? (
                            <div className="row gap wrap">
                              <button className="step step-deliver" onClick={() => setModal({ kind: 'deliver', device: dev, item: it })}>完成交付</button>
                              <button className="link small text-notify" onClick={() => setModal({ kind: 'notify', device: dev, item: it })}>再次通知</button>
                            </div>
                          )
                          : '—'}
                      </td>
                      <td data-label="">
                        <div className="row gap">
                          <button className="link" onClick={() => { setDeviceFilter(dev.id); document.getElementById('audit')?.scrollIntoView({ behavior: 'smooth' }); }}>歷史</button>
                          {active && dev.status !== 'cancelled' && (
                            <button className="link" onClick={() => setModal({ kind: 'note', device: dev, item: it })}>備註</button>
                          )}
                          {active && CORRECT_TO[dev.status] && (
                            <button className="link" onClick={() => setModal({ kind: 'correct_status', device: dev, item: it })}>更正狀態</button>
                          )}
                          {active && !['delivered', 'cancelled'].includes(dev.status) && (
                            <button className="link danger-text" onClick={() => setModal({ kind: 'cancel_device', device: dev, item: it })}>取消</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <ErrorBanner error={opError} />
        <p className="small muted">「已貼」只有已到貨、尚未交付的機器可以勾選。客人在通知前到店，可直接按「直接交付」。</p>
      </section>

      {/* 4. 通知紀錄 */}
      <section className="card stack">
        <h2>通知紀錄</h2>
        {d.notifications.length === 0 ? <p className="muted">尚無通知紀錄。</p> : (
          <ul className="plain">
            {d.notifications.map((n) => {
              const dev = d.devices.find((x) => x.id === n.device_id);
              return (
                <li key={n.id}>
                  {fmtDateTime(n.notified_at)}・<span className="operator">{names.get(n.operator_id)}</span>・{METHOD_LABEL[n.method] ?? n.method}・{OUTCOME_LABEL[n.outcome] ?? n.outcome}
                  {dev && <span className="small muted">・{unitName(dev)}</span>}
                  {n.note ? `・${n.note}` : ''}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 5. 異動紀錄 */}
      <section className="card stack" id="audit">
        <h2>異動紀錄</h2>
        <AuditTimeline logs={d.audit} items={d.items} devices={d.devices} deviceFilter={deviceFilter} onClearDevice={() => setDeviceFilter(null)} />
      </section>

      {modal?.kind === 'edit_order' && <EditOrderDialog order={o} onClose={close} onSaved={reload} />}
      {modal?.kind === 'arrival' && <ArrivalDialog device={modal.device} label={unitName(modal.device)} onClose={close} onSaved={reload} />}
      {modal?.kind === 'deliver' && <DeliveryDialog device={modal.device} label={unitName(modal.device)} itemNote={modal.item.item_note} onClose={close} onSaved={reload} />}
      {modal?.kind === 'note' && <DeviceNoteDialog device={modal.device} label={unitName(modal.device)} onClose={close} onSaved={reload} />}
      {modal?.kind === 'sn' && <CorrectSnDialog device={modal.device} label={unitName(modal.device)} onClose={close} onSaved={reload} />}
      {modal?.kind === 'notify' && (
        <NotifyDialog device={modal.device} label={unitName(modal.device)} onClose={close} onSaved={reload}
          others={d.devices
            .filter((x) => x.id !== modal.device.id && ['arrived_pending_notify', 'notified_pending_pickup'].includes(x.status))
            .map((x) => ({ device: x, label: `${unitName(x)}・${STATUS_LABEL[x.status]}` }))} />
      )}
      {modal?.kind === 'correct_status' && (
        <ReasonDialog title="更正單機狀態" confirmLabel="確認更正" onClose={close}
          description={<p>{unitName(modal.device)}：{STATUS_LABEL[modal.device.status]} → <strong>{STATUS_LABEL[CORRECT_TO[modal.device.status]!]}</strong>
            {modal.device.status === 'arrived_pending_notify' && '（會清除 SN 與已貼）'}</p>}
          onConfirm={async (reason) => { await rpc('correct_device_status', { p_device_id: modal.device.id, p_expected_version: modal.device.version, p_reason: reason }); reload(); }} />
      )}
      {modal?.kind === 'edit_item' && <EditItemDialog item={modal.item} unitCount={unitsOfItem(modal.item.id)} onClose={close} onSaved={reload} />}
      {modal?.kind === 'cancel_order' && (
        <ReasonDialog title="取消整張訂單" danger confirmLabel="確認取消訂單" onClose={close}
          description={<p>將取消此訂單所有尚未交付的 {o.device_total} 台機器。已交付的機器存在時無法整筆取消。紀錄會保留，不會刪除。</p>}
          onConfirm={async (reason) => { await rpc('cancel_order', { p_order_id: o.id, p_expected_version: o.version, p_reason: reason }); reload(); }} />
      )}
      {modal?.kind === 'cancel_device' && (
        <ReasonDialog title={`取消單機 ${unitNo.get(modal.device.id)}`} danger confirmLabel="確認取消這台" onClose={close}
          description={<p>{modal.item.full_product_name}。取消後此商品數量減 1；若是最後一台，商品（及訂單）會一併取消。</p>}
          onConfirm={async (reason) => { await rpc('cancel_device', { p_device_id: modal.device.id, p_expected_version: modal.device.version, p_reason: reason }); reload(); }} />
      )}
    </div>
  );
}
