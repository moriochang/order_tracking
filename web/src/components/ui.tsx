import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeviceStatus } from '../lib/types';
import { STATUS_LABEL, errorMessage } from '../lib/labels';
import { ApiError } from '../lib/api';

export function StatusBadge({ status }: { status: DeviceStatus }) {
  return <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const detail = error instanceof ApiError && error.detail ? error.detail : '';
  return (
    <div className="alert error" role="alert">
      {errorMessage(error)}
      {detail && <div className="small muted">{detail}</div>}
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="link" onClick={onClose} aria-label="關閉">✕</button>
      </div>
      {children}
    </dialog>
  );
}

// 執行需要原因的操作（取消、更正等）
export function ReasonDialog(props: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const required = props.requireReason ?? true;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(reason.trim());
      props.onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <div className="stack">
        {props.description}
        <label>
          原因{required ? '（必填）' : '（選填）'}
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <ErrorBanner error={error} />
        <div className="row gap end">
          <button className="secondary" onClick={props.onClose}>返回</button>
          <button className={props.danger ? 'danger' : ''} disabled={busy || (required && !reason.trim())} onClick={confirm}>
            {busy ? '處理中…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => { if (alive) { setData(d); setError(null); } },
      (e) => { if (alive) setError(e); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
