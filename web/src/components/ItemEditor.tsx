// 商品草稿編輯：完整商品名稱、國際條碼、型號、數量、備註，以及每台單機的初始狀態。
import type { DraftDevice, DraftItem } from '../lib/types';
import { isValidGtin } from '../lib/format';

export function emptyDraftItem(): DraftItem {
  return {
    key: crypto.randomUUID(),
    full_product_name: '', barcode: '', model: '', item_note: '',
    devices: [{ initial_status: 'pending_arrival', exclusion_reason: '' }],
  };
}

type Mode = 'all_pending' | 'all_excluded' | 'per_unit';

function modeOf(devices: DraftDevice[]): Mode {
  if (devices.every((d) => d.initial_status === 'pending_arrival')) return 'all_pending';
  if (devices.every((d) => d.initial_status === 'excluded')
      && devices.every((d) => d.exclusion_reason === devices[0].exclusion_reason)) return 'all_excluded';
  return 'per_unit';
}

export function draftItemProblems(item: DraftItem): string[] {
  const problems: string[] = [];
  if (!item.full_product_name.trim()) problems.push('請填寫完整商品名稱');
  if (item.barcode.trim() && !isValidGtin(item.barcode.replace(/\s/g, ''))) problems.push('國際條碼格式或檢查碼不正確');
  if (item.devices.length < 1 || item.devices.length > 999) problems.push('數量必須是 1–999');
  if (item.devices.some((d) => d.initial_status === 'excluded' && !d.exclusion_reason.trim())) {
    problems.push('「已取走／不追蹤」必須填寫原因');
  }
  return problems;
}

export function draftItemPayload(item: DraftItem) {
  return {
    full_product_name: item.full_product_name.trim(),
    barcode: item.barcode.replace(/\s/g, '') || null,
    model: item.model.trim() || null,
    item_note: item.item_note.trim() || null,
    product_code: item.product_code || null,
    source: item.source ?? 'manual',
    devices: item.devices.map((d) => ({
      initial_status: d.initial_status,
      exclusion_reason: d.initial_status === 'excluded' ? d.exclusion_reason.trim() : null,
    })),
  };
}

export function ItemEditor({ value, onChange }: { value: DraftItem; onChange: (v: DraftItem) => void }) {
  const mode = modeOf(value.devices);
  const set = (patch: Partial<DraftItem>) => onChange({ ...value, ...patch });

  function setQty(raw: string) {
    const qty = Math.max(1, Math.min(999, Math.floor(Number(raw) || 1)));
    const template = mode === 'per_unit' ? { initial_status: 'pending_arrival' as const, exclusion_reason: '' } : value.devices[0];
    const devices = value.devices.slice(0, qty);
    while (devices.length < qty) devices.push({ ...template });
    set({ devices });
  }

  function setMode(next: Mode) {
    if (next === 'all_pending') set({ devices: value.devices.map(() => ({ initial_status: 'pending_arrival', exclusion_reason: '' })) });
    if (next === 'all_excluded') {
      const reason = value.devices.find((d) => d.exclusion_reason)?.exclusion_reason ?? '';
      set({ devices: value.devices.map(() => ({ initial_status: 'excluded', exclusion_reason: reason })) });
    }
    if (next === 'per_unit') set({ devices: value.devices.map((d) => ({ ...d })) });
  }

  function setDevice(i: number, patch: Partial<DraftDevice>) {
    set({ devices: value.devices.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  }

  return (
    <div className="stack">
      <label>
        完整商品名稱（必填，請依單據完整輸入）
        <input value={value.full_product_name} placeholder="依單據上的完整品名輸入，不要只填型號"
          onChange={(e) => set({ full_product_name: e.target.value })} />
      </label>
      <div className="grid3">
        <label>國際條碼（選填）<input inputMode="numeric" value={value.barcode} onChange={(e) => set({ barcode: e.target.value })} /></label>
        <label>型號<input value={value.model} onChange={(e) => set({ model: e.target.value })} /></label>
        <label>
          數量（台）
          <input type="number" inputMode="numeric" min={1} max={999} value={value.devices.length}
            onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>
      <label>商品備註<input value={value.item_note} onChange={(e) => set({ item_note: e.target.value })} /></label>

      <fieldset>
        <legend>單機初始狀態</legend>
        <div className="row gap wrap">
          <label className="radio"><input type="radio" checked={mode === 'all_pending'} onChange={() => setMode('all_pending')} />全部待到貨</label>
          <label className="radio"><input type="radio" checked={mode === 'all_excluded'} onChange={() => setMode('all_excluded')} />全部已取走／不追蹤</label>
          {value.devices.length > 1 && (
            <label className="radio"><input type="radio" checked={mode === 'per_unit'} onChange={() => setMode('per_unit')} />逐台設定</label>
          )}
        </div>
        {mode === 'all_excluded' && (
          <label>
            原因（必填）
            <input value={value.devices[0].exclusion_reason} placeholder="例：顧客結帳時已當場取走"
              onChange={(e) => set({ devices: value.devices.map(() => ({ initial_status: 'excluded', exclusion_reason: e.target.value })) })} />
          </label>
        )}
        {mode === 'per_unit' && (
          <div className="stack tight">
            {value.devices.map((d, i) => (
              <div key={i} className="row gap wrap unit-row">
                <span className="unit-no">第 {i + 1} 台</span>
                <select value={d.initial_status}
                  onChange={(e) => setDevice(i, { initial_status: e.target.value as DraftDevice['initial_status'] })}>
                  <option value="pending_arrival">待到貨</option>
                  <option value="excluded">已取走／不追蹤</option>
                </select>
                {d.initial_status === 'excluded' && (
                  <input className="grow" placeholder="原因（必填）" value={d.exclusion_reason}
                    onChange={(e) => setDevice(i, { exclusion_reason: e.target.value })} />
                )}
              </div>
            ))}
          </div>
        )}
        <p className="muted small">建立時只能選擇「待到貨」或「已取走／不追蹤」。到貨、通知、交付須於建立後依流程登記。</p>
      </fieldset>
    </div>
  );
}
