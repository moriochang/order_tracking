// 用相機讀條碼（單據上方的預結號碼條碼、商品盒上的國際條碼）。條碼程式庫用到時才載入。
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui';

export function BarcodeScanButton({ label, onResult }: { label: string; onResult: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary small-btn" onClick={() => setOpen(true)} aria-label={`掃描${label}條碼`}>掃條碼</button>
      {open && (
        <BarcodeScanDialog label={label} onClose={() => setOpen(false)}
          onResult={(text) => { setOpen(false); onResult(text); }} />
      )}
    </>
  );
}

function BarcodeScanDialog({ label, onResult, onClose }: { label: string; onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let stopped = false;
    let stop = () => {};
    (async () => {
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import('@zxing/browser'), import('@zxing/library'),
        ]);
        const hints = new Map<number, unknown>([
          [DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.CODE_39, BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
          ]],
          [DecodeHintType.TRY_HARDER, true],
        ]);
        const reader = new BrowserMultiFormatReader(hints);
        if (stopped || !video.current) return;
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' } }, video.current,
          (result, _err, c) => {
            if (!result) return;
            c.stop();
            onResultRef.current(result.getText().replace(/^\*|\*$/g, '').trim());
          },
        );
        if (stopped) controls.stop(); else stop = () => controls.stop();
      } catch (e) {
        const name = (e as Error)?.name;
        setError(name === 'NotAllowedError' ? '沒有相機權限，請在瀏覽器設定允許使用相機。'
          : name === 'NotFoundError' ? '找不到相機。'
          : `無法開啟相機：${(e as Error)?.message ?? e}`);
      }
    })();
    return () => { stopped = true; stop(); };
  }, []);

  return (
    <Dialog title={`掃描${label}`} onClose={onClose}>
      <div className="stack">
        {error
          ? <div className="alert error">{error}</div>
          : <video ref={video} className="scan-video" muted playsInline />}
        <p className="small muted">將條碼對準畫面中央，讀到後會自動填入。讀到的號碼仍請與單據核對。</p>
        <div className="row end"><button type="button" className="secondary" onClick={onClose}>取消</button></div>
      </div>
    </Dialog>
  );
}
