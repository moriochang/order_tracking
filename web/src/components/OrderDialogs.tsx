// 訂單詳情頁的修改對話框。所有變更都透過 RPC，並由資料庫寫入異動紀錄。
import { useState } from 'react';
import { ApiError, rpc } from '../lib/api';
import { FIELD_LABEL } from '../lib/labels';
import type { OrderItem, OrderSummary } from '../lib/types';
import { Dialog, ErrorBanner } from './ui';
import { CatalogNameHint, useModelNameSuggest } from './ItemEditor';

export function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

// 結帳／預購日期固定為建單當天，不提供修改（決策 2026-10-27）
const ORDER_FIELDS = ['customer_name', 'customer_phone',
  'register_no', 'receipt_seq', 'receipt_no', 'order_note'] as const;
const DIGITS = { inputMode: 'numeric', pattern: '[0-9]*' };

export function EditOrderDialog({ order, onClose, onSaved }: { order: OrderSummary; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(() => Object.fromEntries(ORDER_FIELDS.map((f) => [f, order[f] ?? ''])) as Record<string, string>);
  const [reason, setReason] = useState('');
  const [needAck, setNeedAck] = useState<string | null>(null);
  const [ack, setAck] = useState('');
  const { busy, error, setError, run } = useSubmit(() => { onSaved(); onClose(); });

  const patch: Record<string, string | null> = {};
  for (const f of ORDER_FIELDS) {
    const before = order[f] ?? '';
    if (form[f].trim() !== String(before)) patch[f] = form[f].trim() || null;
  }

  const save = () => run(async () => {
    try {
      await rpc('update_order_info', {
        p_order_id: order.id, p_expected_version: order.version,
        p_patch: needAck ? { ...patch, duplicate_ack_reason: ack.trim() } : patch,
        p_reason: reason.trim() || null,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
        setNeedAck(e.detail);
        setError(null);
        throw new ApiError('POSSIBLE_DUPLICATE', `既有訂單：${e.detail}`);
      }
      throw e;
    }
  });

  const input = (f: string, props: Record<string, unknown> = {}) => (
    <label key={f}>
      {FIELD_LABEL[f]}
      <input value={form[f]} onChange={(e) => setForm((p) => ({ ...p, [f]: e.target.value }))} {...props} />
    </label>
  );

  return (
    <Dialog title="修改訂單資料" onClose={onClose}>
      <div className="stack">
        <div className="grid2">
          {input('customer_name')}
          {input('customer_phone', { type: 'tel' })}
          {input('register_no', DIGITS)}
          {input('receipt_seq', DIGITS)}
          {input('receipt_no', DIGITS)}
        </div>
        <label>{FIELD_LABEL.order_note}<textarea rows={2} value={form.order_note} onChange={(e) => setForm((p) => ({ ...p, order_note: e.target.value }))} /></label>
        <p className="small muted">需要寄送請寫在這裡（收件人、電話、地址）；寄出後請在「完成取貨」的取貨備註輸入黑貓單號。</p>
        <label>修改原因（選填）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {needAck && (
          <label>與既有訂單 {needAck} 的收銀機號、序號、日期相同。確認不是重複的原因（必填）
            <input value={ack} onChange={(e) => setAck(e.target.value)} />
          </label>
        )}
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !Object.keys(patch).length || (!!needAck && !ack.trim())} onClick={save}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const ITEM_FIELDS = ['model', 'barcode', 'full_product_name', 'item_note'] as const;

export function EditItemDialog({ item, unitCount = 1, onClose, onSaved }: {
  item: OrderItem; unitCount?: number; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState(() => Object.fromEntries(ITEM_FIELDS.map((f) => [f, item[f] ?? ''])) as Record<string, string>);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const patch: Record<string, string | null> = {};
  for (const f of ITEM_FIELDS) if (form[f].trim() !== (item[f] ?? '')) patch[f] = form[f].trim() || null;
  const { lookup, pick } = useModelNameSuggest(form.model, form.barcode, form.full_product_name, (n) => setForm((p) => ({ ...p, full_product_name: n })));

  return (
    <Dialog title="修改商品" onClose={onClose}>
      <div className="stack">
        {unitCount > 1 && <div className="alert info small">這筆商品共 {unitCount} 台是一起建立的，修改會套用到這 {unitCount} 台。</div>}
        {ITEM_FIELDS.map((f) => (
          <div key={f} className="stack tight">
            <label>{FIELD_LABEL[f]}
              <input value={form[f]} onChange={(e) => {
                const v = f === 'model' ? e.target.value.toUpperCase() : e.target.value;
                setForm((p) => ({ ...p, [f]: v }));
              }} />
            </label>
            {f === 'full_product_name' && <CatalogNameHint lookup={lookup} name={form.full_product_name} onPick={pick} />}
          </div>
        ))}
        <label>修改原因（選填）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || !Object.keys(patch).length || !form.full_product_name.trim()}
            onClick={() => run(() => rpc('update_order_item', { p_item_id: item.id, p_expected_version: item.version, p_patch: patch, p_reason: reason.trim() || null }))}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

