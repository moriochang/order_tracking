import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMe } from '../auth/AuthProvider';
import { ApiError, rpc } from '../lib/api';
import { fmtDate, todayTaipei } from '../lib/format';
import type { DraftItem } from '../lib/types';
import { Dialog, ErrorBanner } from '../components/ui';
import { ItemEditor, draftItemPayload, draftItemProblems, emptyDraftItem, sameProduct } from '../components/ItemEditor';
import { ReceiptScanDialog, ScanChecks, type ScanResult } from '../components/ReceiptScan';

type Header = {
  store_code: string;
  customer_name: string;
  customer_phone: string;
  purchase_date: string;
  register_no: string;
  receipt_seq: string;
  receipt_no: string;
  order_note: string;
};

type Duplicate = { order_id: string; order_no: string; customer_name: string; purchase_date: string; receipt_no: string | null; match_type: string };

function headerProblems(h: Header): string[] {
  const p: string[] = [];
  if (!h.store_code) p.push('請選擇門市');
  if (!h.customer_name.trim()) p.push('請填寫顧客姓名');
  if (!/^\+?[0-9#]{6,20}$/.test(h.customer_phone.replace(/[\s()-]/g, ''))) p.push('請填寫正確的聯絡電話');
  if (!h.purchase_date) p.push('請填寫結帳日期');
  if (h.purchase_date > todayTaipei()) p.push('結帳日期不能是未來日期');
  if (!/^[0-9A-Za-z]{1,10}$/.test(h.register_no.trim())) p.push('請填寫收銀機號（英數字）');
  if (!/^[0-9A-Za-z]{1,20}$/.test(h.receipt_seq.trim())) p.push('請填寫序號（英數字）');
  return p;
}

export function NewOrderPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [requestId] = useState(() => crypto.randomUUID());  // 同一份表單重送不會重複建立
  const [h, setH] = useState<Header>({
    // 目前只有門市 75；有多家門市權限時仍預設 75
    store_code: me.stores.length === 1 ? me.stores[0].code : me.stores.some((s) => s.code === '75') ? '75' : '',
    customer_name: '', customer_phone: '',
    purchase_date: todayTaipei(), register_no: '', receipt_seq: '', receipt_no: '', order_note: '',
  });
  const [items, setItems] = useState<DraftItem[]>([]);
  const [editing, setEditing] = useState<DraftItem | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [dups, setDups] = useState<Duplicate[] | null>(null);
  const [ackReason, setAckReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [mergeNotice, setMergeNotice] = useState('');

  const set = (patch: Partial<Header>) => setH((prev) => ({ ...prev, ...patch }));
  const unchecked = items.filter((i) => i.scan_notes?.length).length;
  const problems = [
    ...headerProblems(h),
    ...(items.length ? [] : ['請至少加入一項商品']),
    ...(editing ? ['請先完成或取消正在編輯的商品'] : []),
    ...(unchecked ? [`有 ${unchecked} 項掃描商品需核對，請點「編輯」確認內容後儲存`] : []),
  ];

  const deviceTotal = items.reduce((s, i) => s + i.devices.length, 0);

  function saveEditing() {
    if (!editing || draftItemProblems(editing).length) return;
    const saved = { ...editing, scan_notes: undefined };   // 同仁已核對
    setMergeNotice('');
    const isNew = !items.some((i) => i.key === saved.key);
    const twinIdx = isNew ? items.findIndex((i) => sameProduct(i, saved)) : -1;
    if (twinIdx >= 0) {
      // 與已加入的商品相同：合併數量，不另開一項
      const twin = items[twinIdx];
      setItems((prev) => prev.map((i) => (i.key === twin.key ? { ...i, devices: [...i.devices, ...saved.devices] } : i)));
      setMergeNotice(`與第 ${twinIdx + 1} 項相同，已合併為 ${twin.devices.length + saved.devices.length} 台。`);
    } else {
      setItems((prev) => (isNew ? [...prev, saved] : prev.map((i) => (i.key === saved.key ? saved : i))));
    }
    setEditing(null);
  }

  // 掃描結果帶入表單：只填有辨識到的欄位；取代先前掃描帶入的商品，手動新增的保留
  function applyScan(r: ScanResult) {
    const p = r.parsed;
    setH((prev) => ({
      ...prev,
      purchase_date: p.purchase_date && p.purchase_date <= todayTaipei() ? p.purchase_date : prev.purchase_date,
      register_no: p.register_no || prev.register_no,
      receipt_seq: p.receipt_seq || prev.receipt_seq,
      receipt_no: p.receipt_no || prev.receipt_no,
    }));
    setItems((prev) => [
      ...prev.filter((i) => i.source !== 'ocr'),
      ...p.items.map((it) => ({
        key: crypto.randomUUID(),
        full_product_name: it.full_product_name,
        barcode: it.barcode,
        model: it.model,
        item_note: '',
        devices: Array.from({ length: Math.min(999, Math.max(1, it.qty ?? 1)) },
          () => ({ initial_status: 'pending_arrival' as const, exclusion_reason: '' })),
        source: 'ocr' as const,
        product_code: it.product_code,
        scan_notes: [...it.notes, ...(it.qty ? [] : ['數量未辨識，暫設 1 台'])],
        scan_fixes: it.fixes,
      })),
    ]);
    setScan(r);
    setScanOpen(false);
  }

  async function review() {
    setShowErrors(true);
    setError(null);
    if (problems.length) return;
    setBusy(true);
    try {
      const found = await rpc<Duplicate[]>('check_duplicate_order', {
        p_store_code: h.store_code,
        p_receipt_no: h.receipt_no.trim() || null,
        p_register_no: h.register_no.trim(),
        p_receipt_seq: h.receipt_seq.trim(),
        p_purchase_date: h.purchase_date,
      });
      if (found.length) setDups(found);
      else setConfirming(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc<{ order_id: string }>('create_order', {
        p_order: {
          client_request_id: requestId,
          store_code: h.store_code,
          customer_name: h.customer_name.trim(),
          customer_phone: h.customer_phone,
          purchase_date: h.purchase_date,
          register_no: h.register_no.trim(),
          receipt_seq: h.receipt_seq.trim(),
          receipt_no: h.receipt_no.trim() || null,
          order_note: h.order_note.trim() || null,
          duplicate_ack_reason: ackReason.trim() || null,
          items: items.map(draftItemPayload),
          ...(scan && items.some((i) => i.source === 'ocr')
            ? { scan: { raw_text: scan.raw_text, parsed: { ...scan.parsed, provider: scan.provider } } } : {}),
        },
      });
      navigate(`/orders/${result.order_id}`, { replace: true });
    } catch (e) {
      setConfirming(false);
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
        await review();  // 期間有人建立了相同單據，重新顯示比對結果
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  }

  const hardDuplicate = dups?.some((d) => d.match_type === 'receipt_no');

  return (
    <div className="stack">
      <h1>新增訂單</h1>
      <div className="two-col">
        <div className="stack">
          {/* 區塊 A：顧客／單據資料 */}
          <section className="card stack">
            <h2>A. 顧客與單據資料</h2>
            {scan && (
              <div className="alert info stack tight">
                <div>已從掃描帶入單據資料，請逐欄與單據核對。顧客姓名與電話單據上沒有，請手動填寫。</div>
                {scan.image_url && <a href={scan.image_url} target="_blank" rel="noreferrer"><img src={scan.image_url} alt="單據照片" className="scan-thumb" /></a>}
                <ScanChecks parsed={scan.parsed} />
              </div>
            )}
            <div className="grid2">
              <label>顧客姓名（必填）<input value={h.customer_name} onChange={(e) => set({ customer_name: e.target.value })} /></label>
              <label>聯絡電話（必填）<input type="tel" inputMode="tel" value={h.customer_phone} onChange={(e) => set({ customer_phone: e.target.value })} /></label>
              <label>結帳／預購日期（必填）<input type="date" max={todayTaipei()} value={h.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} /></label>
              <label>
                門市（必填）
                <select value={h.store_code} onChange={(e) => set({ store_code: e.target.value })} disabled={me.stores.length === 1}>
                  <option value="">請選擇</option>
                  {me.stores.map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
                </select>
              </label>
              <label>收銀機號（必填）<input inputMode="numeric" placeholder="例：011" value={h.register_no} onChange={(e) => set({ register_no: e.target.value })} /></label>
              <label>序號（必填）<input inputMode="numeric" placeholder="例：196" value={h.receipt_seq} onChange={(e) => set({ receipt_seq: e.target.value })} /></label>
              <label>預結號碼<input value={h.receipt_no} onChange={(e) => set({ receipt_no: e.target.value })} /></label>
            </div>
            <label>訂單備註<textarea rows={2} value={h.order_note} onChange={(e) => set({ order_note: e.target.value })} /></label>
            <p className="muted small">序號是收據上的流水號，不是機器 SN；機器 SN 於到貨時登記。</p>
          </section>

          {/* 區塊 B ＋ C：商品與單機初始狀態 */}
          <section className="card stack">
            <div className="row between wrap">
              <h2>B. 商品明細</h2>
              <div className="row gap">
                <button type="button" className="secondary" onClick={() => setScanOpen(true)} disabled={!!editing}>掃描明細</button>
                <button type="button" onClick={() => setEditing(emptyDraftItem())} disabled={!!editing}>＋ 手動新增</button>
              </div>
            </div>

            {items.length === 0 && !editing && <p className="muted">尚未加入商品。</p>}
            {mergeNotice && <div className="alert info small">{mergeNotice}</div>}
            {items.map((it, idx) => (
              <div key={it.key} className={`draft-item ${editing?.key === it.key ? 'hidden' : ''}`}>
                <div className="grow">
                  <div className="product-name">{idx + 1}. {it.full_product_name || '（品名未辨識）'}{it.source === 'ocr' && <span className="small muted">・掃描</span>}</div>
                  <div className="small muted">
                    {[it.barcode && `條碼 ${it.barcode}`, it.model].filter(Boolean).join('・')}
                    {' '}× {it.devices.length} 台
                    {it.devices.some((d) => d.initial_status === 'excluded') &&
                      `（其中 ${it.devices.filter((d) => d.initial_status === 'excluded').length} 台已取走／不追蹤）`}
                  </div>
                  {it.item_note && <div className="small">備註：{it.item_note}</div>}
                  {it.scan_fixes?.map((n) => <div key={n} className="small ok-text">✓ {n}</div>)}
                  {it.scan_notes?.map((n) => <div key={n} className="small warn-text">需核對：{n}</div>)}
                  {draftItemProblems(it).map((n) => <div key={n} className="small danger-text">・{n}</div>)}
                </div>
                <div className="row gap">
                  <button type="button" className="link" disabled={!!editing} onClick={() => setEditing({ ...it, devices: it.devices.map((d) => ({ ...d })) })}>編輯</button>
                  <button type="button" className="link danger-text" disabled={!!editing} onClick={() => setItems((p) => p.filter((x) => x.key !== it.key))}>移除</button>
                </div>
              </div>
            ))}

            {editing && (
              <div className="card inset stack">
                <h3>{items.some((i) => i.key === editing.key) ? '編輯商品' : '手動新增商品'}</h3>
                <ItemEditor value={editing} onChange={setEditing} />
                {draftItemProblems(editing).map((p) => <div key={p} className="small danger-text">・{p}</div>)}
                <div className="row gap end">
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>取消</button>
                  <button type="button" disabled={draftItemProblems(editing).length > 0} onClick={saveEditing}>加入／更新商品</button>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* 區塊 D：摘要 */}
        <aside className="card stack summary">
          <h2>摘要</h2>
          <dl>
            <dt>顧客</dt><dd>{h.customer_name || '—'}</dd>
            <dt>單據日期</dt><dd>{fmtDate(h.purchase_date)}</dd>
            <dt>預結號碼</dt><dd>{h.receipt_no || '—'}</dd>
            <dt>機號</dt><dd>{h.register_no || '—'}</dd>
            <dt>序號</dt><dd>{h.receipt_seq || '—'}</dd>
          </dl>
          <div className="stack tight">
            <div className="muted">商品明細（{items.length} 項）</div>
            {items.length === 0 ? <div className="small muted">尚未加入商品。</div> : (
              <ul className="plain stack tight">
                {items.map((it, idx) => (
                  <li key={it.key}>
                    <div className="product-name">{idx + 1}. {it.full_product_name || '（品名未辨識）'}</div>
                    <div className="small muted">
                      {[it.barcode && `條碼 ${it.barcode}`, it.model].filter(Boolean).join('・')} × {it.devices.length} 台
                    </div>
                    {it.item_note.trim() && <div className="device-note block">⚠ {it.item_note.trim()}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <dl>
            <dt>訂單備註</dt><dd className="clip">{h.order_note || '—'}</dd>
          </dl>
          {showErrors && problems.length > 0 && (
            <div className="alert error">{problems.map((p) => <div key={p}>・{p}</div>)}</div>
          )}
          <ErrorBanner error={error} />
          <div className="row gap end">
            <button type="button" className="secondary" onClick={() => navigate('/')}>取消</button>
            <button type="button" disabled={busy} onClick={review}>{busy ? '檢查中…' : '建立訂單'}</button>
          </div>
        </aside>
      </div>

      {scanOpen && <ReceiptScanDialog onApply={applyScan} onClose={() => setScanOpen(false)} />}

      {dups && (
        <Dialog title={hardDuplicate ? '已有相同單據的訂單' : '疑似重複單據'} onClose={() => setDups(null)}>
          <div className="stack">
            <p>{hardDuplicate
              ? '此門市已有相同「預結號碼」的訂單，不能重複建立。請查看既有訂單，或修正預結號碼。'
              : '已有相同收銀機號、序號與日期的訂單。若確認不是重複，請填寫原因後繼續。'}</p>
            <ul className="plain">
              {dups.map((d) => (
                <li key={d.order_id}>
                  <a href={`#/orders/${d.order_id}`} target="_blank" rel="noreferrer">{d.order_no}</a>
                  {' '}{d.customer_name}・{fmtDate(d.purchase_date)}{d.receipt_no ? `・${d.receipt_no}` : ''}
                </li>
              ))}
            </ul>
            {!hardDuplicate && (
              <label>確認不是重複的原因（必填）<textarea rows={2} value={ackReason} onChange={(e) => setAckReason(e.target.value)} /></label>
            )}
            <div className="row gap end">
              <button className="secondary" onClick={() => setDups(null)}>返回修改</button>
              {!hardDuplicate && (
                <button disabled={!ackReason.trim()} onClick={() => { setDups(null); setConfirming(true); }}>確認不是重複，繼續</button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {confirming && (
        <Dialog title="確認建立訂單" onClose={() => setConfirming(false)}>
          <div className="stack">
            <p>{h.customer_name}・{h.customer_phone}・{fmtDate(h.purchase_date)}・{h.receipt_no || `機 ${h.register_no}／序 ${h.receipt_seq}`}</p>
            <ul className="plain">
              {items.map((it) => (
                <li key={it.key}>
                  <span className="product-name">{it.full_product_name}</span> × {it.devices.length} 台
                  {it.item_note.trim() && <span className="device-note">⚠ {it.item_note.trim()}</span>}
                </li>
              ))}
            </ul>
            {h.order_note.trim() && <p className="small">訂單備註：{h.order_note.trim()}</p>}
            <p className="small muted">將建立 1 張訂單、{items.length} 項商品、{deviceTotal} 筆單機紀錄，並寫入異動紀錄。</p>
            <ErrorBanner error={error} />
            <div className="row gap end">
              <button className="secondary" onClick={() => setConfirming(false)}>返回</button>
              <button disabled={busy} onClick={create}>{busy ? '建立中…' : '確認建立'}</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
