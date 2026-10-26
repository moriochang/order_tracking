// 單機作業對話框：登記到貨（SN）、通知顧客、完成交付、單機備註、更正 SN
import { useState } from 'react';
import { ocrReceipt, rpc } from '../lib/api';
import { compressImage } from '../lib/image';
import { linesFromWords } from '../lib/ocrLayout';
import { extractSerials, looksLikeSn, normalizeSn } from '../lib/serial';
import { METHOD_LABEL, OUTCOME_LABEL } from '../lib/labels';
import type { Device } from '../lib/types';
import { Dialog, ErrorBanner } from './ui';
import { useSubmit } from './OrderDialogs';

type Props = { device: Device; label: string; onClose: () => void; onSaved: () => void };

// 商品備註與單機備註合併成一則提示（例如「AC+」）
export const notesOf = (itemNote: string | null | undefined, deviceNote: string | null | undefined) =>
  [itemNote, deviceNote].filter(Boolean).join('・');

// SN 輸入：可手動輸入或拍包裝盒標籤辨識；英文 O 自動改為 0
function SnInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [ocrText, setOcrText] = useState('');

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null); setCandidates(null);
    try {
      const { base64 } = await compressImage(file, 2000);
      const result = await ocrReceipt(base64);
      // 版面重組與 Vision 原始文字各找一次，合併結果
      const layout = linesFromWords(result.words);
      const found = [...new Set([...extractSerials(layout), ...extractSerials(result.text)])];
      setOcrText(layout || result.text);
      setCandidates(found);
      if (found.length === 1) onChange(found[0]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const sn = normalizeSn(value);
  return (
    <div className="stack tight">
      <div className="stack tight">
        <span>{label}</span>
        <div className="row gap">
          <input className="grow" aria-label={label} autoCapitalize="characters" autoComplete="off" value={value}
            onChange={(e) => onChange(normalizeSn(e.target.value))} />
          <label className={`button secondary ${busy ? 'disabled' : ''}`}>
            {busy ? '辨識中…' : '拍照辨識'}
            <input type="file" accept="image/*" className="hidden" disabled={busy}
              onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      </div>
      <ErrorBanner error={error} />
      {candidates?.length === 0 && (
        <div className="stack tight">
          <div className="small warn-text">照片中找不到 SN，請靠近一點、對準標籤上「(S) Serial No.」那一行重拍，或手動輸入。</div>
          <details className="small">
            <summary>辨識出的文字</summary>
            <pre className="scan-text">{ocrText || '（沒有辨識到任何文字）'}</pre>
          </details>
        </div>
      )}
      {candidates && candidates.length > 1 && (
        <div className="row gap wrap small">找到多個可能的 SN，請點選：
          {candidates.map((c) => <button key={c} type="button" className="secondary small-btn" onClick={() => onChange(c)}>{c}</button>)}
        </div>
      )}
      {sn && !looksLikeSn(sn) && <div className="small warn-text">SN 一般是 10–12 碼英數字，請再核對一次。</div>}
    </div>
  );
}


export function ArrivalDialog({ device, label, onClose, onSaved }: Props) {
  const [sn, setSn] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="登記到貨" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{label}</p>
        <SnInput label="SN（配件沒有 SN 可留空）" value={sn} onChange={setSn} />
        <p className="small muted">可拍包裝盒標籤自動辨識，辨識後請與標籤核對。系統會檢查 SN 是否已登記在其他機器。</p>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy}
            onClick={() => run(() => rpc('register_arrival', { p_device_id: device.id, p_expected_version: device.version, p_sn: sn.trim() || null }))}>
            {busy ? '登記中…' : sn.trim() ? '確認到貨' : '確認到貨（無 SN）'}
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

export function DeliveryDialog({ device, label, itemNote, onClose, onSaved }: Props & { itemNote?: string | null }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="完成交付" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{label}</p>
        {device.sn ? <p>SN：<strong>{device.sn}</strong>（請與實機核對）</p> : <p className="small muted">這台沒有登記 SN。</p>}
        {notesOf(itemNote, device.note) && <div className="alert warn">⚠ 備註：{notesOf(itemNote, device.note)}</div>}
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

export function DeviceNoteDialog({ device, label, onClose, onSaved }: Props) {
  const [note, setNote] = useState(device.note ?? '');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="單機備註" onClose={onClose}>
      <div className="stack">
        <p className="product-name">{label}</p>
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

export function CorrectSnDialog({ device, label, onClose, onSaved }: Props) {
  const [sn, setSn] = useState(device.sn ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title={device.sn ? '更正 SN' : '補登 SN'} onClose={onClose}>
      <div className="stack">
        <p className="product-name">{label}</p>
        <SnInput label="正確的 SN" value={sn} onChange={setSn} />
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
