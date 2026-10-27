// 商品草稿編輯：型號、國際條碼、數量、完整商品名稱、備註。單機建立時一律為待到貨。
// 輸入國際條碼或型號後依產品資料帶入品名；有多筆品名時讓同仁選擇。
import { useEffect, useState } from 'react';
import type { DraftItem } from '../lib/types';
import { gtin14, isValidGtin } from '../lib/format';
import { catalogByEan, catalogByModels } from '../lib/api';
import type { CatalogEntry } from '../lib/catalogMatch';

export function emptyDraftItem(): DraftItem {
  return {
    key: crypto.randomUUID(),
    full_product_name: '', barcode: '', model: '', item_note: '',
    devices: [{ initial_status: 'pending_arrival', exclusion_reason: '' }],
  };
}

// 相同商品（品名、型號、國際條碼、商品備註都相同）應合併成同一項、增加數量
type ProductKey = { full_product_name: string; model: string | null; barcode: string | null; item_note: string | null };
const keyOf = (p: ProductKey) => [p.full_product_name, p.model, (p.barcode ?? '').replace(/\s/g, ''), p.item_note]
  .map((x) => (x ?? '').trim().toUpperCase()).join('|');
export const sameProduct = (a: ProductKey, b: ProductKey) => keyOf(a) === keyOf(b);

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

// 依國際條碼或型號查產品資料（輸入停頓 300ms 後查詢）。有條碼時以條碼為準（3rd Party 配件），否則用型號。
// null 表示尚未查詢、條碼格式不對且型號太短
export function useCatalogLookup(model: string, barcode: string) {
  const ean = gtin14(barcode);
  const m = model.trim().toUpperCase();
  const key = ean ? `ean:${ean}` : m.length >= 4 ? `model:${m}` : '';
  const [result, setResult] = useState<{ key: string; names: string[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      (ean ? catalogByEan(ean) : catalogByModels([m]))
        .then((rows: CatalogEntry[]) => { if (!cancelled) setResult({ key, names: [...new Set(rows.map((r) => r.product_name))] }); })
        .catch(() => { if (!cancelled) setResult(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key]);
  if (!key || result?.key !== key) return null;
  return { names: result.names, by: ean ? `國際條碼 ${barcode.replace(/\s/g, '')}` : `型號 ${model.trim()}` };
}

// 條碼／型號對應品名：只有一筆時自動帶入，但不覆蓋同仁自己輸入的品名。
// 可覆蓋的情況：品名空白、仍是先前自動帶入的值，或條碼／型號已改而品名還是開啟時的原值。
export function useModelNameSuggest(model: string, barcode: string, name: string, setName: (name: string) => void) {
  const lookup = useCatalogLookup(model, barcode);
  const names = lookup?.names ?? null;
  const [autoName, setAutoName] = useState('');
  const sig = `${model.trim().toUpperCase()}|${barcode.replace(/\s/g, '')}`;
  const [initial] = useState({ sig, name });
  useEffect(() => {
    if (names?.length !== 1 || names[0] === name) return;
    const changed = sig !== initial.sig;
    if (!name.trim() || name === autoName || (changed && name === initial.name)) {
      setAutoName(names[0]);
      setName(names[0]);
    }
  }, [names]);  // 只在查詢結果變動時執行
  return { lookup, pick: (n: string) => { setAutoName(n); setName(n); } };
}

export function CatalogNameHint({ lookup, name, onPick }: {
  lookup: { names: string[]; by: string } | null; name: string; onPick: (name: string) => void;
}) {
  if (!lookup) return null;
  const { names, by } = lookup;
  if (names.length === 0) return <div className="small muted">產品資料中沒有{by}，請手動輸入品名。</div>;
  if (names.length === 1) {
    return name === names[0]
      ? <div className="small ok-text">✓ 已依產品資料帶入品名</div>
      : <div className="small">產品資料品名：{names[0]} <button type="button" className="link" onClick={() => onPick(names[0])}>套用</button></div>;
  }
  return (
    <div className="stack tight">
      <div className="small">{by} 有 {names.length} 筆品名，請依單據選擇：</div>
      {names.map((n) => (
        <label key={n} className="radio small">
          <input type="radio" checked={name === n} onChange={() => onPick(n)} />{n}
        </label>
      ))}
    </div>
  );
}

export function ItemEditor({ value, onChange }: { value: DraftItem; onChange: (v: DraftItem) => void }) {
  const set = (patch: Partial<DraftItem>) => onChange({ ...value, ...patch });
  const { lookup, pick } = useModelNameSuggest(value.model, value.barcode, value.full_product_name, (n) => set({ full_product_name: n }));

  // 每台單機建立時都是「待到貨」
  function setQty(raw: string) {
    const qty = Math.max(1, Math.min(999, Math.floor(Number(raw) || 1)));
    set({ devices: Array.from({ length: qty }, () => ({ initial_status: 'pending_arrival' as const, exclusion_reason: '' })) });
  }

  return (
    <div className="stack">
      <div className="grid3">
        <label>型號<input value={value.model} placeholder="例：MFYN4" autoCapitalize="characters"
          onChange={(e) => set({ model: e.target.value.toUpperCase() })} /></label>
        <label>國際條碼（選填）<input inputMode="numeric" placeholder="配件可輸入條碼帶品名" value={value.barcode} onChange={(e) => set({ barcode: e.target.value })} /></label>
        <label>
          數量（台）
          <input type="number" inputMode="numeric" min={1} max={999} value={value.devices.length}
            onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>
      <label>
        完整商品名稱（必填，請依單據完整輸入）
        <input value={value.full_product_name} placeholder="輸入國際條碼或型號會自動帶入；或依單據上的完整品名輸入"
          onChange={(e) => set({ full_product_name: e.target.value })} />
      </label>
      <CatalogNameHint lookup={lookup} name={value.full_product_name} onPick={pick} />
      <label>商品備註<input value={value.item_note} onChange={(e) => set({ item_note: e.target.value })} /></label>

    </div>
  );
}
