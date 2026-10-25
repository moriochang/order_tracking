// 單機作業對話框：登記到貨（SN）、通知顧客、完成交付、單機備註、更正 SN
import { useState } from 'react';
import { rpc } from '../lib/api';
import { METHOD_LABEL, OUTCOME_LABEL } from '../lib/labels';
import type { Device, OrderItem } from '../lib/types';
import { Dialog, ErrorBanner } from './ui';
import { useSubmit } from './OrderDialogs';

type Props = { device: Device; item: OrderItem; onClose: () => void; onSaved: () => void };

const unitLabel = (item: OrderItem, device: Device) => `${item.line_no}-${device.unit_no} ${item.full_product_name}`;

export function ArrivalDialog({ device, item, onClose, onSaved }: Props) {
  const [sn, setSn] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="登記到貨" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{unitLabel(item, device)}</p>
        <label>SN（必填）
          <input autoFocus autoCapitalize="characters" autoComplete="off" value={sn}
            onChange={(e) => setSn(e.target.value.toUpperCase())} />
        </label>
        <p className="small muted">請核對機器上的序號，系統會檢查 SN 是否已登記在其他機器。</p>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !sn.trim()}
            onClick={() => run(() => rpc('register_arrival', { p_device_id: device.id, p_expected_version: device.version, p_sn: sn }))}>
            {busy ? '登記中…' : '確認到貨'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// 通知：預設只通知這一台，可勾選同訂單其他已到貨的機器一起記錄
export function NotifyDialog({ device, others, label, onClose, onSaved }: {
  device: Device; others: { device: Device; label: string }[]; label: string; onClose: () => void; onSaved: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([device.id]);
  const [method, setMethod] = useState('phone');
  const [outcome, setOutcome] = useState('contacted');
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Dialog title="通知顧客" onClose={onClose}>
      <div className="stack">
        <div className="stack tight">
          <label className="radio"><input type="checkbox" checked={picked.includes(device.id)} onChange={() => toggle(device.id)} />{label}</label>
          {others.map((o) => (
            <label key={o.device.id} className="radio"><input type="checkbox" checked={picked.includes(o.device.id)} onChange={() => toggle(o.device.id)} />{o.label}</label>
          ))}
        </div>
        <div className="grid2">
          <label>方式
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>結果
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <label>備註<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <p className="small muted">有聯繫就算已通知，機器會轉為「已通知待取貨」。</p>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !picked.length}
            onClick={() => run(() => rpc('record_notification', { p_device_ids: picked, p_method: method, p_outcome: outcome, p_note: note.trim() || null }))}>
            {busy ? '記錄中…' : `記錄通知（${picked.length} 台）`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function DeliveryDialog({ device, item, onClose, onSaved }: Props) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="完成交付" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{unitLabel(item, device)}</p>
        <p>SN：<strong>{device.sn}</strong>（請與實機核對）</p>
        {device.status === 'arrived_pending_notify' && <p className="small muted">這台尚未通知，交付時會自動記一筆「顧客到店」通知。</p>}
        <label>交付備註（選填）<input value={note} placeholder="例：本人取貨、代領人姓名" onChange={(e) => setNote(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy}
            onClick={() => run(() => rpc('complete_delivery', { p_device_id: device.id, p_expected_version: device.version, p_note: note.trim() || null }))}>
            {busy ? '處理中…' : '確認交付'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function DeviceNoteDialog({ device, item, onClose, onSaved }: Props) {
  const [note, setNote] = useState(device.note ?? '');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="單機備註" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{unitLabel(item, device)}</p>
        <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || note.trim() === (device.note ?? '')}
            onClick={() => run(() => rpc('update_device_note', { p_device_id: device.id, p_expected_version: device.version, p_note: note.trim() || null }))}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function CorrectSnDialog({ device, item, onClose, onSaved }: Props) {
  const [sn, setSn] = useState(device.sn ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="更正 SN" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{unitLabel(item, device)}</p>
        <label>正確的 SN<input autoCapitalize="characters" value={sn} onChange={(e) => setSn(e.target.value.toUpperCase())} /></label>
        <label>更正原因（必填）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !sn.trim() || sn.trim() === device.sn || !reason.trim()}
            onClick={() => run(() => rpc('correct_sn', { p_device_id: device.id, p_expected_version: device.version, p_sn: sn, p_reason: reason.trim() }))}>
            {busy ? '儲存中…' : '更正'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
