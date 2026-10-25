// 訂單詳情頁的修改對話框。所有變更都透過 RPC，並由資料庫寫入異動紀錄。
import { useState } from 'react';
import { ApiError, rpc } from '../lib/api';
import { todayTaipei } from '../lib/format';
import { FIELD_LABEL, STATUS_LABEL } from '../lib/labels';
import type { Device, OrderItem, OrderSummary } from '../lib/types';
import { Dialog, ErrorBanner } from './ui';
import { CatalogNameHint, ItemEditor, draftItemPayload, draftItemProblems, emptyDraftItem, useModelNameSuggest } from './ItemEditor';

function useSubmit(onDone: () => void) {
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

const ORDER_FIELDS = ['customer_name', 'customer_phone', 'purchase_date',
  'register_no', 'receipt_seq', 'receipt_no', 'order_note'] as const;

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
          {input('purchase_date', { type: 'date', max: todayTaipei() })}
          {input('register_no')}
          {input('receipt_seq')}
          {input('receipt_no')}
        </div>
        <label>{FIELD_LABEL.order_note}<textarea rows={2} value={form.order_note} onChange={(e) => setForm((p) => ({ ...p, order_note: e.target.value }))} /></label>
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

export function AddItemDialog({ orderId, onClose, onSaved }: { orderId: string; onClose: () => void; onSaved: () => void }) {
  const [item, setItem] = useState(emptyDraftItem);
  const [requestId] = useState(() => crypto.randomUUID());
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const problems = draftItemProblems(item);
  return (
    <Dialog title="新增商品" onClose={onClose}>
      <div className="stack">
        <ItemEditor value={item} onChange={setItem} />
        {problems.map((p) => <div key={p} className="small danger-text">・{p}</div>)}
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || problems.length > 0}
            onClick={() => run(() => rpc('add_order_item', { p_order_id: orderId, p_item: { ...draftItemPayload(item), client_request_id: requestId } }))}>
            {busy ? '新增中…' : `新增 ${item.devices.length} 台`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const ITEM_FIELDS = ['model', 'barcode', 'full_product_name', 'item_note'] as const;

export function EditItemDialog({ item, onClose, onSaved }: { item: OrderItem; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(() => Object.fromEntries(ITEM_FIELDS.map((f) => [f, item[f] ?? ''])) as Record<string, string>);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const patch: Record<string, string | null> = {};
  for (const f of ITEM_FIELDS) if (form[f].trim() !== (item[f] ?? '')) patch[f] = form[f].trim() || null;
  const { names, pick } = useModelNameSuggest(form.model, form.full_product_name, (n) => setForm((p) => ({ ...p, full_product_name: n })));

  return (
    <Dialog title={`修改商品 ${item.line_no}`} onClose={onClose}>
      <div className="stack">
        {ITEM_FIELDS.map((f) => (
          <div key={f} className="stack tight">
            <label>{FIELD_LABEL[f]}
              <input value={form[f]} onChange={(e) => {
                const v = f === 'model' ? e.target.value.toUpperCase() : e.target.value;
                setForm((p) => ({ ...p, [f]: v }));
              }} />
            </label>
            {f === 'full_product_name' && <CatalogNameHint names={names} model={form.model} name={form.full_product_name} onPick={pick} />}
          </div>
        ))}
        <label>修改原因（選填）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="small muted">數量請使用「修改數量」。</p>
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

export function ChangeQtyDialog({ item, devices, onClose, onSaved }: {
  item: OrderItem; devices: Device[]; onClose: () => void; onSaved: () => void;
}) {
  const [qty, setQty] = useState(item.ordered_qty);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(() => { onSaved(); onClose(); });
  const decrease = item.ordered_qty - qty;
  const cancellable = devices.filter((d) => d.order_item_id === item.id && ['pending_arrival', 'excluded'].includes(d.status));

  return (
    <Dialog title={`修改數量：商品 ${item.line_no}`} onClose={onClose}>
      <div className="stack">
        <div className="product-name">{item.full_product_name}</div>
        <label>新數量（目前 {item.ordered_qty} 台）
          <input type="number" min={1} max={999} value={qty} onChange={(e) => { setQty(Math.max(1, Math.floor(Number(e.target.value) || 1))); setPicked([]); }} />
        </label>
        {qty > item.ordered_qty && <p className="small">將新增 {qty - item.ordered_qty} 台「待到貨」單機。</p>}
        {decrease > 0 && (
          <fieldset>
            <legend>請勾選要取消的 {decrease} 台（只能選待到貨或已取走）</legend>
            {cancellable.length < decrease && <p className="small danger-text">可取消的機器不足；已到貨的機器請用單機「取消」。</p>}
            {cancellable.map((d) => (
              <label key={d.id} className="radio">
                <input type="checkbox" checked={picked.includes(d.id)}
                  disabled={!picked.includes(d.id) && picked.length >= decrease}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))} />
                第 {d.unit_no} 台・{STATUS_LABEL[d.status]}
              </label>
            ))}
          </fieldset>
        )}
        <label>原因（必填）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={onClose}>取消</button>
          <button disabled={busy || qty === item.ordered_qty || !reason.trim() || (decrease > 0 && picked.length !== decrease)}
            onClick={() => run(() => rpc('change_item_quantity', {
              p_item_id: item.id, p_expected_version: item.version, p_new_qty: qty,
              p_cancel_device_ids: decrease > 0 ? picked : [], p_reason: reason.trim(),
            }))}>
            {busy ? '處理中…' : '確認修改'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
