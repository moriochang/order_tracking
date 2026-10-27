import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DeviceStatus } from '../lib/types';
import { STATUS_LABEL, errorMessage } from '../lib/labels';
import { ApiError, listProfiles } from '../lib/api';

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

// 操作人姓名：每個人一個顏色，在異動紀錄中容易分辨。
// 依帳號建立順序分配色票（看得到的帳號各不相同）；清單裡沒有的名字（例如資料庫帳號）依名字計算。
// 色票都是深色，白字對比足夠；人數超過色票數時才會重複。
const OPERATOR_COLORS = [
  '#248a3d', '#0071e3', '#8944ab', '#c93400', '#b0247a', '#0e7c86',
  '#5e5ce6', '#8a5a00', '#d70015', '#00704a', '#3a5a8c', '#6e6e00',
];
const OperatorColors = createContext<Map<string, string>>(new Map());

export function OperatorColorsProvider({ children }: { children: ReactNode }) {
  const profiles = useAsync(listProfiles, []);
  const colors = useMemo(() => new Map([...(profiles.data ?? [])]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.email.localeCompare(b.email))
    .map((p, i) => [p.display_name, OPERATOR_COLORS[i % OPERATOR_COLORS.length]])), [profiles.data]);
  return <OperatorColors.Provider value={colors}>{children}</OperatorColors.Provider>;
}

function hashColor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return OPERATOR_COLORS[h % OPERATOR_COLORS.length];
}

export function Operator({ name }: { name: string | null | undefined }) {
  const colors = useContext(OperatorColors);
  if (!name) return null;
  return <span className="operator" style={{ background: colors.get(name) ?? hashColor(name) }}>{name}</span>;
}
