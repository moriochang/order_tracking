// 掃描明細：拍照後由 Google Cloud Vision 辨識（或貼上文字），在瀏覽器解析後預覽，確認才帶入表單。
// 照片只在這次辨識時傳送，不儲存；畫面上保留照片供核對，離開頁面即消失。
import { useState } from 'react';
import { parseReceiptText, type ParsedReceipt } from '../lib/receiptParser';
import { linesFromWords } from '../lib/ocrLayout';
import { compressImage } from '../lib/image';
import { catalogByModels, ocrReceipt } from '../lib/api';
import { matchCatalogName } from '../lib/catalogMatch';
import { fmtDate } from '../lib/format';
import { Dialog, ErrorBanner } from './ui';

export type ScanResult = { raw_text: string; parsed: ParsedReceipt; provider: string; image_url?: string };

// 依產品資料校正品名；找不到型號時提示核對。產品資料尚未匯入或讀取失敗時略過。
async function withCatalog(parsed: ParsedReceipt): Promise<ParsedReceipt> {
  const models = [...new Set(parsed.items.map((i) => i.model).filter(Boolean))];
  const catalog = await catalogByModels(models).catch(() => null);
  if (!catalog?.length) return parsed;
  return {
    ...parsed,
    items: parsed.items.map((it) => {
      if (!it.model) return it;
      if (!catalog.some((c) => c.model === it.model)) {
        return { ...it, notes: [...it.notes, `產品資料中找不到型號 ${it.model}，請核對品名`] };
      }
      const fixed = matchCatalogName(it.full_product_name, it.model, catalog);
      return fixed
        ? { ...it, full_product_name: fixed, fixes: [...it.fixes, `品名已依產品資料校正（辨識為「${it.full_product_name}」）`] }
        : it;
    }),
  };
}

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
      setParsed(await withCatalog(parseReceiptText(lines)));
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
        <p className="small muted">單據放平、光線充足，從「iStore」拍到「應稅科技 NT$」。也可以從相簿選照片。</p>
        <ErrorBanner error={error} />
        {imageUrl && <a href={imageUrl} target="_blank" rel="noreferrer"><img src={imageUrl} alt="單據照片" className="scan-thumb" /></a>}

        <details open={!imageUrl}>
          <summary className="small">{imageUrl ? '辨識出的文字（可修改後重新解析）' : '或貼上單據文字'}</summary>
          <div className="stack tight">
            <textarea rows={8} value={text} placeholder="貼上單據文字"
              onChange={(e) => { setText(e.target.value); setParsed(null); }} />
            <div className="row gap end">
              <button type="button" className="secondary" onClick={async () => setParsed(await withCatalog(parseReceiptText(text)))} disabled={!text.trim()}>解析</button>
            </div>
          </div>
        </details>

        {parsed && <ScanPreview parsed={parsed} />}

        <div className="row gap end">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" disabled={busy || !parsed || (!parsed.items.length && !parsed.receipt_no)}
            onClick={() => parsed && onApply({ raw_text: text, parsed, provider, image_url: imageUrl })}>帶入表單</button>
        </div>
      </div>
    </Dialog>
  );
}

function ScanPreview({ parsed }: { parsed: ParsedReceipt }) {
  const field = (label: string, v: string) => (
    <><dt>{label}</dt><dd className={v ? '' : 'warn-text'}>{v || '未辨識'}</dd></>
  );
  return (
    <div className="card inset stack">
      <dl className="compact">
        {field('門市代碼', parsed.store_code)}
        {field('預結號碼', parsed.receipt_no)}
        {field('銷售日期', parsed.purchase_date && fmtDate(parsed.purchase_date))}
        {field('機號', parsed.register_no)}
        {field('序號', parsed.receipt_seq)}
      </dl>
      <ul className="plain">
        {parsed.items.map((it, i) => (
          <li key={i}>
            <span className="product-name">{it.full_product_name || '（品名未辨識）'}</span>
            {' '}× {it.qty ?? '?'} 台
            <span className="small muted">
              {it.barcode && `・條碼 ${it.barcode}`}
              {it.merged_lines > 1 && `・由 ${it.merged_lines} 行合併`}
            </span>
            {it.fixes.map((n) => <div key={n} className="small ok-text">✓ {n}</div>)}
            {it.notes.map((n) => <div key={n} className="small warn-text">需核對：{n}</div>)}
          </li>
        ))}
      </ul>
      <ScanChecks parsed={parsed} />
    </div>
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
