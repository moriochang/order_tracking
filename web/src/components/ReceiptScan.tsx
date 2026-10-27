// 掃描明細：拍照後由 Google Cloud Vision 辨識（或貼上文字），在瀏覽器解析後預覽，確認才帶入表單。
// 照片只在這次辨識時傳送，不儲存；畫面上保留照片供核對，離開頁面即消失。
import { useEffect, useState } from 'react';
import { fieldOk, parseReceiptText, type ParsedItem, type ParsedReceipt } from '../lib/receiptParser';
import { CatalogNameHint, useCatalogLookup } from './ItemEditor';
import { linesFromWords } from '../lib/ocrLayout';
import { compressImage } from '../lib/image';
import { catalogByModels, ocrReceipt } from '../lib/api';
import { matchCatalogName } from '../lib/catalogMatch';
import { Dialog, ErrorBanner } from './ui';

export type ScanResult = { raw_text: string; parsed: ParsedReceipt; provider: string; image_url?: string };

// 依型號帶入產品資料的正式品名：只有一筆就直接用；多筆時取跟單據最接近的；找不到型號時提示核對。
// 產品資料尚未匯入或讀取失敗時略過。
async function withCatalog(parsed: ParsedReceipt): Promise<ParsedReceipt> {
  const models = [...new Set(parsed.items.map((i) => i.model).filter(Boolean))];
  const catalog = await catalogByModels(models).catch(() => null);
  if (!catalog?.length) return parsed;
  return {
    ...parsed,
    items: parsed.items.map((it) => {
      if (!it.model) return it;
      const names = [...new Set(catalog.filter((c) => c.model === it.model).map((c) => c.product_name))];
      if (!names.length) return { ...it, notes: [...it.notes, `產品資料中找不到型號 ${it.model}，請核對品名`] };
      const fixed = names.length === 1 ? names[0] : matchCatalogName(it.full_product_name, it.model, catalog);
      return fixed && fixed !== it.full_product_name
        ? { ...it, full_product_name: fixed, fixes: [...it.fixes, `品名已依型號帶入產品資料（單據為「${it.full_product_name}」）`] }
        : it;
    }),
  };
}

const enrich = withCatalog;

export function ReceiptScanDialog({ onApply, onClose }: { onApply: (r: ScanResult) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [provider, setProvider] = useState('manual_text');
  const [imageUrl, setImageUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setParsed(null);
    try {
      const { base64, url } = await compressImage(file);
      setImageUrl(url);
      const result = await ocrReceipt(base64);
      const lines = linesFromWords(result.words) || result.text;
      setText(lines);
      setProvider(result.provider);
      setParsed(await enrich(parseReceiptText(lines)));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="掃描明細" onClose={onClose}>
      <div className="stack">
        <label className={`button ${busy ? 'disabled' : ''}`}>
          {busy ? '辨識中…' : imageUrl ? '重新拍照' : '拍照辨識'}
          <input type="file" accept="image/*" className="hidden" disabled={busy}
            onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <p className="small muted">單據放平擺正、光線充足。系統只讀「預購明細 Pre-Sale」到「消費金額」這一段，抓型號（數量預設 1 台）。橘色欄位可直接修改，正確後會變綠色。可以從照片選取。</p>
        <ErrorBanner error={error} />
        {imageUrl && <a href={imageUrl} target="_blank" rel="noreferrer"><img src={imageUrl} alt="單據照片" className="scan-thumb" /></a>}

        <details open={!imageUrl}>
          <summary className="small">{imageUrl ? '辨識出的文字（可修改後重新解析）' : '或貼上單據文字'}</summary>
          <div className="stack tight">
            <textarea rows={8} value={text} placeholder="貼上單據文字"
              onChange={(e) => { setText(e.target.value); setParsed(null); }} />
            <div className="row gap end">
              <button type="button" className="secondary" onClick={async () => setParsed(await enrich(parseReceiptText(text)))} disabled={!text.trim()}>解析</button>
            </div>
          </div>
        </details>

        {parsed && <ScanPreview parsed={parsed} onChange={setParsed} />}

        <div className="row gap end">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" disabled={busy || !parsed || (!parsed.items.length && !parsed.receipt_no)}
            onClick={() => parsed && onApply({ raw_text: text, parsed, provider, image_url: imageUrl })}>帶入表單</button>
        </div>
      </div>
    </Dialog>
  );
}

// 預覽：機號、序號、預結號碼與每項型號都可以直接修改；符合格式（或對到產品資料）顯示綠色
function ScanPreview({ parsed, onChange }: { parsed: ParsedReceipt; onChange: (p: ParsedReceipt) => void }) {
  const field = (key: keyof typeof fieldOk, label: string, hint: string) => {
    const v = parsed[key];
    const ok = fieldOk[key](v);
    return (
      <label className={`scan-field ${ok ? 'ok' : 'warn'}`}>
        <span>{label}</span>
        <input inputMode="numeric" pattern="[0-9]*" value={v}
          onChange={(e) => onChange({ ...parsed, [key]: e.target.value.replace(/\D/g, '') })} />
        {!ok && <span className="small">{v ? `需核對：${hint}` : '未辨識，請輸入'}</span>}
      </label>
    );
  };
  const setItem = (i: number, it: ParsedItem) => onChange({ ...parsed, items: parsed.items.map((x, j) => (j === i ? it : x)) });
  return (
    <div className="card inset stack">
      <div className="stack tight">
        {field('register_no', '機號', '通常是 010、011、012、013')}
        {field('receipt_seq', '序號', '1–5 位數字')}
        {field('receipt_no', '預結號碼', '8 位數字')}
      </div>
      <ul className="plain">
        {parsed.items.map((it, i) => <ScanItemRow key={i} item={it} onChange={(x) => setItem(i, x)} />)}
      </ul>
      <ScanChecks parsed={parsed} />
    </div>
  );
}

// 單一商品：改型號後依產品資料帶入品名；對到產品資料才算完成（綠色），否則保留「需核對」
function ScanItemRow({ item, onChange }: { item: ParsedItem; onChange: (it: ParsedItem) => void }) {
  const lookup = useCatalogLookup(item.model, '');
  const names = lookup?.names;
  useEffect(() => {
    if (!names || !item.model) return;
    if (names.length === 1 && item.full_product_name !== names[0]) {
      onChange({ ...item, full_product_name: names[0], notes: [], fixes: ['品名已依型號帶入產品資料'] });
    } else if (names.length === 0 && !item.notes.length) {
      onChange({ ...item, notes: [`產品資料中找不到型號 ${item.model}，請核對`], fixes: [] });
    } else if (names.length > 1 && !names.includes(item.full_product_name) && !item.notes.length) {
      onChange({ ...item, notes: ['這個型號有多筆品名，請選擇'], fixes: [] });
    }
  }, [names]);  // 只在查詢結果變動時執行

  const ok = !item.notes.length && !!names?.includes(item.full_product_name);
  return (
    <li className={`scan-item ${ok ? 'ok' : 'warn'}`}>
      <div className="row gap wrap">
        <input className="scan-model" value={item.model} placeholder="型號" autoCapitalize="characters" aria-label="型號"
          onChange={(e) => {
            const model = e.target.value.toUpperCase().trim();
            onChange({ ...item, model, notes: model ? [] : ['型號未辨識'], fixes: [] });
          }} />
        <span>× {item.qty ?? 1} 台{item.merged_lines > 1 && <span className="small muted">（由 {item.merged_lines} 行合併）</span>}</span>
      </div>
      <div className="product-name">{item.full_product_name || '（品名未辨識）'}</div>
      {names && names.length > 1 && (
        <CatalogNameHint lookup={lookup} name={item.full_product_name}
          onPick={(n) => onChange({ ...item, full_product_name: n, notes: [], fixes: ['品名已依型號帶入產品資料'] })} />
      )}
      {ok && <div className="small ok-text">✓ 型號已對到產品資料</div>}
      {item.notes.map((n) => <div key={n} className="small warn-text">需核對：{n}</div>)}
    </li>
  );
}

export function ScanChecks({ parsed }: { parsed: ParsedReceipt }) {
  return (
    <div className="small">
      {parsed.checks.map((c) => (
        <div key={c.label} className={c.ok ? 'ok-text' : 'warn-text'}>{c.ok ? '✓' : '✗'} {c.label}{c.ok ? '' : '（不符，請核對）'}</div>
      ))}
      {parsed.warnings.map((w) => <div key={w} className="warn-text">⚠ {w}</div>)}
    </div>
  );
}
