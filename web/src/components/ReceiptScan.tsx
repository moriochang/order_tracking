// 掃描明細：用 iPhone「掃描文字」（或 Mac 原況文字複製後貼上）取得單據文字，解析後預覽，確認才帶入表單。
import { useState } from 'react';
import { parseReceiptText, type ParsedReceipt } from '../lib/receiptParser';
import { fmtDate } from '../lib/format';
import { Dialog } from './ui';

export type ScanResult = { raw_text: string; parsed: ParsedReceipt };

export function ReceiptScanDialog({ onApply, onClose }: { onApply: (r: ScanResult) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);

  return (
    <Dialog title="掃描明細" onClose={onClose}>
      <div className="stack">
        <ol className="small muted steps">
          <li>iPhone／iPad：點一下下方文字框，再點鍵盤上方的「掃描文字」圖示（或長按文字框選「掃描文字」）。</li>
          <li>鏡頭對準單據，從「iStore」到「應稅科技 NT$」都要在畫面內，點「插入」。單據太長可以分段掃描，文字會接在後面。</li>
          <li>Mac：在照片上選取單據文字複製，貼到下方。</li>
        </ol>
        <textarea rows={10} value={text} placeholder="在這裡掃描或貼上單據文字"
          onChange={(e) => { setText(e.target.value); setParsed(null); }} />
        <div className="row gap end">
          <button type="button" className="secondary" onClick={() => { setText(''); setParsed(null); }} disabled={!text}>清除</button>
          <button type="button" onClick={() => setParsed(parseReceiptText(text))} disabled={!text.trim()}>解析</button>
        </div>

        {parsed && <ScanPreview parsed={parsed} />}

        <div className="row gap end">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" disabled={!parsed || (!parsed.items.length && !parsed.receipt_no)}
            onClick={() => parsed && onApply({ raw_text: text, parsed })}>帶入表單</button>
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
