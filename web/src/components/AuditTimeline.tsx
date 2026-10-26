// 異動紀錄時間軸：同一筆交易的事件合併顯示，新到舊排序，可依類別或單機篩選。
import { useMemo, useState } from 'react';
import { unitNumbers } from '../lib/units';
import type { AuditLog, Device, DeviceStatus, OrderItem } from '../lib/types';
import { ACTION_LABEL, AUDIT_FILTERS, FIELD_LABEL, STATUS_LABEL } from '../lib/labels';
import { fmtDateTime } from '../lib/format';

function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '空白';
  if (field === 'status' || field === 'status_before_cancel') return STATUS_LABEL[v as DeviceStatus] ?? String(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
  return String(v);
}

// 不顯示的技術欄位
const HIDDEN = new Set(['id', 'order_id', 'order_item_id', 'created_by', 'created_at', 'client_request_id',
  'cancelled_by', 'excluded_by', 'arrived_by', 'delivered_by', 'labeled_by', 'status_before_cancel',
  'excluded_at', 'labeled_at', 'import_draft_id', 'source', 'store_code', 'line_no', 'unit_no']);

type Props = {
  logs: AuditLog[];
  items: OrderItem[];
  devices: Device[];
  deviceFilter: string | null;
  onClearDevice: () => void;
};

export function AuditTimeline({ logs, items, devices, deviceFilter, onClearDevice }: Props) {
  const [filter, setFilter] = useState('all');
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const unitNo = useMemo(() => unitNumbers(items, devices), [items, devices]);

  const describe = (l: AuditLog): string => {
    if (l.entity_type === 'order') return '訂單';
    if (l.entity_type === 'order_item') return `商品 ${itemById.get(l.entity_id)?.full_product_name ?? ''}`;
    if (l.entity_type === 'device' || l.entity_type === 'notification') {
      const d = l.device_id ? deviceById.get(l.device_id) : undefined;
      const unit = d ? `單機 ${unitNo.get(d.id) ?? '?'}` : '單機';
      return l.entity_type === 'notification' ? `${unit} 通知紀錄` : unit;
    }
    return l.entity_type;
  };

  const groups = useMemo(() => {
    const actions = AUDIT_FILTERS.find((f) => f.key === filter)?.actions ?? [];
    const visible = logs.filter((l) => (!actions.length || actions.includes(l.action))
      && (!deviceFilter || l.device_id === deviceFilter));
    const map = new Map<number, AuditLog[]>();
    for (const l of visible) map.set(l.txn_id, [...(map.get(l.txn_id) ?? []), l]);
    return [...map.values()].map((g) => g.sort((a, b) => a.id - b.id));
  }, [logs, filter, deviceFilter]);

  return (
    <div className="stack">
      <div className="chips">
        {AUDIT_FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>
      {deviceFilter && (
        <div className="alert info row between">
          <span>只顯示 {describe({ entity_type: 'device', device_id: deviceFilter } as AuditLog)} 的紀錄</span>
          <button className="link" onClick={onClearDevice}>顯示全部</button>
        </div>
      )}
      {groups.length === 0 && <p className="muted">沒有符合的異動紀錄。</p>}
      <ol className="timeline">
        {groups.map((g) => {
          const head = g[0];
          return (
            <li key={head.txn_id} className={head.action === 'direct_db_change' ? 'warn' : ''}>
              <div className="tl-head">
                <span>{fmtDateTime(head.occurred_at)}</span>
                <span>｜{head.actor_display_name ?? `資料庫帳號 ${head.actor_db_role}`}</span>
                <span>｜<strong>{ACTION_LABEL[head.action] ?? head.action}</strong></span>
              </div>
              {head.reason && <div className="tl-reason">原因：{head.reason}</div>}
              <ul className="tl-lines">
                {g.map((l) => <AuditLine key={l.id} log={l} label={describe(l)} />)}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AuditLine({ log, label }: { log: AuditLog; label: string }) {
  if (log.operation === 'INSERT') {
    const a = log.after_data ?? {};
    let text = '建立';
    if (log.entity_type === 'order_item') text = `新增「${a.full_product_name}」× ${a.ordered_qty}`;
    if (log.entity_type === 'device') {
      text = `建立，狀態：${fmtValue('status', a.status)}`;
      if (a.exclusion_reason) text += `（${a.exclusion_reason}）`;
    }
    return <li><span className="tl-entity">{label}</span>{text}</li>;
  }
  if (log.operation === 'DELETE') return <li><span className="tl-entity">{label}</span>刪除</li>;
  const fields = (log.changed_fields ?? []).filter((f) => !HIDDEN.has(f));
  if (!fields.length) return null;
  return (
    <li>
      <span className="tl-entity">{label}</span>
      {fields.map((f) => (
        <div key={f} className="tl-change">
          {FIELD_LABEL[f] ?? f}：{fmtValue(f, log.before_data?.[f])} → {fmtValue(f, log.after_data?.[f])}
        </div>
      ))}
    </li>
  );
}
