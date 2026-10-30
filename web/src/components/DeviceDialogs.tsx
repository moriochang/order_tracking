// 單機作業對話框：登記到貨（SN 選填）、通知顧客、完成取貨、更正 SN；待辦清單的批次作業
import { useState } from 'react';
import { ocrReceipt, rpc } from '../lib/api';
import { compressImage } from '../lib/image';
import { linesFromWords } from '../lib/ocrLayout';
import { extractSerials, looksLikeSn, normalizeSn } from '../lib/serial';
import { METHOD_LABEL, OUTCOME_LABEL, errorMessage } from '../lib/labels';
import type { Device } from '../lib/types';
import { Dialog, ErrorBanner } from './ui';
import { useSubmit } from './OrderDialogs';

// 視窗上方的訂單資訊（訂單編號、顧客），與下方的商品分開顯示
export type OrderRef = { no: string; customer: string; phone: string };
function OrderHeader({ order }: { order?: OrderRef }) {
  if (!order) return null;
  return (
    <div className="dialog-order">
      訂單 <b>{order.no}</b>　顧客 <b>{order.customer}</b>　電話 <a href={`tel:${order.phone}`}><b>{order.phone}</b></a>
    </div>
  );
}

type Props = { device: Device; label: string; order?: OrderRef; onClose: () => void; onSaved: () => void };

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


export function ArrivalDialog({ device, label, order, onClose, onSaved }: Props) {
  const [sn, setSn] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title="登記到貨" onClose={onClose}>
      <div className="stack">
        <OrderHeader order={order} />
        <p className="product-name">{label}</p>
        <SnInput label="SN（選填，之後可補登）" value={sn} onChange={setSn} />
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

// 通知：預設只通知這一台（或 preselected 指定的機器），可勾選同訂單其他已到貨的機器一起記錄
export function NotifyDialog({ device, others, label, order, preselected, onClose, onSaved }: {
  device: Device; others: { device: Device; label: string }[]; label: string; order?: OrderRef;
  preselected?: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(preselected ?? [device.id]);
  const [method, setMethod] = useState('phone');
  const [outcome, setOutcome] = useState('contacted');
  const [note, setNote] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Dialog title="通知顧客" onClose={onClose}>
      <div className="stack">
        <OrderHeader order={order} />
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
        <p className="small muted">有聯繫就算已通知，機器會轉為「已通知」。</p>
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

// 可一起取貨的其他機器（同一張訂單、已登記到貨；待到貨的不會列入）
export type DeliveryOther = { device: Device; label: string; note?: string };

export function DeliveryDialog({ device, label, order, itemNote, others = [], preselected, onClose, onSaved }: Props & {
  itemNote?: string | null; others?: DeliveryOther[]; preselected?: string[];
}) {
  const [note, setNote] = useState('');
  // 經手同仁員編：A＋5 碼數字（例：A12652），只輸入數字
  const [staffDigits, setStaffDigits] = useState('');
  const staffOk = /^\d{5}$/.test(staffDigits);
  const [picked, setPicked] = useState<string[]>(preselected ?? [device.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string[]>([]);
  const all: DeliveryOther[] = [{ device, label, note: notesOf(itemNote, device.note) }, ...others];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // 逐台取貨；中途失敗時已完成的保留，畫面顯示失敗原因
  async function deliver() {
    setBusy(true); setError(null);
    const ok: string[] = [...done];
    try {
      for (const o of all.filter((x) => picked.includes(x.device.id) && !ok.includes(x.device.id))) {
        await rpc('complete_delivery', { p_device_id: o.device.id, p_expected_version: o.device.version, p_staff_no: `A${staffDigits}`, p_note: note.trim() || null });
        ok.push(o.device.id);
        setDone([...ok]);
      }
      onSaved(); onClose();
    } catch (e) {
      setError(e);
      if (ok.length) onSaved();
    } finally {
      setBusy(false);
    }
  }

  const remaining = picked.filter((id) => !done.includes(id)).length;
  return (
    <Dialog title="完成取貨" onClose={onClose}>
      <div className="stack">
        <OrderHeader order={order} />
        <div className="stack tight">
          {all.map((o) => (
            <label key={o.device.id} className="radio delivery-pick">
              <input type="checkbox" checked={picked.includes(o.device.id)} disabled={busy || done.includes(o.device.id)}
                onChange={() => toggle(o.device.id)} />
              <span>
                <span className="product-name">{o.label}</span>
                {done.includes(o.device.id) && <span className="ok-text small">　✓ 已取貨</span>}
                <span className="small">　SN：<b>{o.device.sn ?? '無'}</b></span>
                {o.note && <span className="device-note">⚠ {o.note}</span>}
                {o.device.status === 'arrived_pending_notify' && <span className="small muted">（尚未通知，會自動記「顧客到店」）</span>}
              </span>
            </label>
          ))}
        </div>
        <p className="small muted">請與實機核對 SN；有 ⚠ 備註的請先處理再交機。</p>
        <label className={`staff-no ${staffOk ? 'ok' : ''}`}>經手同仁員編（必填）
          <span className="row gap staff-no-input">
            <b>A</b>
            <input inputMode="numeric" pattern="[0-9]*" maxLength={5} autoComplete="off" placeholder="12652" value={staffDigits}
              disabled={busy} onChange={(e) => setStaffDigits(e.target.value.replace(/\D/g, '').slice(0, 5))} />
          </span>
          <span className="small">{staffOk ? `✓ A${staffDigits}` : '輸入 A 後面的 5 碼數字'}</span>
        </label>
        <label>取貨備註（選填，套用到勾選的每一台）<input value={note} placeholder="例：本人取貨、代領人姓名、黑貓單號" onChange={(e) => setNote(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="confirm" disabled={busy || remaining === 0 || !staffOk} onClick={deliver}>
            {busy ? '處理中…' : `確認取貨（${remaining} 台）`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function CorrectSnDialog({ device, label, order, onClose, onSaved }: Props) {
  const [sn, setSn] = useState(device.sn ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  return (
    <Dialog title={device.sn ? '更正 SN' : '補登 SN'} onClose={onClose}>
      <div className="stack">
        <OrderHeader order={order} />
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

// 批次作業（待辦清單勾選後）：逐筆送出，某一筆失敗不影響其他筆；每筆照常留下自己的異動紀錄
export const BATCH_LIMIT = 50;
export type BatchKind = 'arrival' | 'label' | 'notify';
// arrival、label 每台一筆；notify 每張訂單一筆（同訂單的機器一起記錄）
export type BatchEntry = { key: string; title: string; detail: string; devices: Device[] };

const BATCH_TITLE: Record<BatchKind, string> = { arrival: '批次登記到貨', label: '批次標記已貼', notify: '批次通知顧客' };

export function BatchDialog({ kind, entries, onClose, onSaved }: {
  kind: BatchKind; entries: BatchEntry[]; onClose: () => void; onSaved: () => void;
}) {
  const [method, setMethod] = useState('sms');
  const [outcome, setOutcome] = useState('contacted');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, string>>({});   // key → 'ok' 或錯誤訊息
  const units = entries.reduce((n, e) => n + e.devices.length, 0);
  const pending = entries.filter((e) => result[e.key] !== 'ok');
  const failed = entries.filter((e) => result[e.key] && result[e.key] !== 'ok').length;

  async function runOne(e: BatchEntry) {
    if (kind === 'notify') {
      await rpc('record_notification', { p_device_ids: e.devices.map((d) => d.id), p_method: method, p_outcome: outcome, p_note: note.trim() || null });
    } else {
      const d = e.devices[0];
      await rpc(kind === 'arrival' ? 'register_arrival' : 'set_labeled', kind === 'arrival'
        ? { p_device_id: d.id, p_expected_version: d.version, p_sn: null }
        : { p_device_id: d.id, p_expected_version: d.version, p_labeled: true });
    }
  }

  async function runAll() {
    setBusy(true);
    const next = { ...result };
    for (const e of pending) {
      try {
        await runOne(e);
        next[e.key] = 'ok';
      } catch (err) {
        next[e.key] = errorMessage(err);
      }
      setResult({ ...next });
    }
    setBusy(false);
    onSaved();
    if (entries.every((e) => next[e.key] === 'ok')) onClose();
  }

  return (
    <Dialog title={BATCH_TITLE[kind]} onClose={onClose}>
      <div className="stack">
        <p>即將為 <b>{kind === 'notify' ? `${entries.length} 張訂單（${units} 台）` : `${units} 台`}</b>
          {kind === 'arrival' ? '登記到貨（不登記 SN，之後可補登）' : kind === 'label' ? '標記已貼' : '記錄通知'}：</p>
        <ul className="plain small batch-list">
          {entries.map((e) => (
            <li key={e.key}>
              <b>{e.title}</b>　{e.detail}
              {result[e.key] === 'ok' && <span className="ok-text">　✓ 完成</span>}
              {result[e.key] && result[e.key] !== 'ok' && <div className="error-text">✗ {result[e.key]}</div>}
            </li>
          ))}
        </ul>
        {kind === 'notify' && (
          <>
            <div className="grid2">
              <label>方式
                <select value={method} onChange={(ev) => setMethod(ev.target.value)} disabled={busy}>
                  {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label>結果
                <select value={outcome} onChange={(ev) => setOutcome(ev.target.value)} disabled={busy}>
                  {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </div>
            <label>備註（套用到每一張）<input value={note} onChange={(ev) => setNote(ev.target.value)} disabled={busy} /></label>
            <p className="small muted">同一種方式與結果套用到所有勾選的訂單，適合群發簡訊或 LINE；逐一打電話時請單筆記錄。</p>
          </>
        )}
        {failed > 0 && !busy && <div className="alert error">有 {failed} 筆沒有完成（原因如上），其他已完成。可修正後按「重送未完成的」。</div>}
        <div className="row gap end">
          <button className="secondary" onClick={onClose} disabled={busy}>{Object.keys(result).length ? '關閉' : '取消'}</button>
          <button disabled={busy || !pending.length} onClick={runAll}>
            {busy ? '處理中…' : failed ? `重送未完成的（${pending.length}）` : `確認（${kind === 'notify' ? `${entries.length} 張` : `${units} 台`}）`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
