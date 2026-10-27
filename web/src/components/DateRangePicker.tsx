// 日期區間選擇：在日曆上先點開始日、再點結束日，中間反白；左側有常用捷徑。按「套用」才生效。
// 日期一律用 YYYY-MM-DD 字串（台北日期），以 UTC 計算避免時區位移。
import { useState } from 'react';
import { fmtDate, todayTaipei } from '../lib/format';
import { Dialog } from './ui';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const toStr = (d: Date) => d.toISOString().slice(0, 10);
function addDays(s: string, n: number) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toStr(d);
}
// 月份以該月 1 號表示
function addMonths(month: string, n: number) {
  const d = toDate(month);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toStr(d);
}
const monthOf = (s: string) => `${s.slice(0, 8)}01`;
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000) + 1;

function shortcuts(today: string): { label: string; from: string; to: string }[] {
  const month = monthOf(today);
  const lastMonth = addMonths(month, -1);
  return [
    { label: '今天', from: today, to: today },
    { label: '昨天', from: addDays(today, -1), to: addDays(today, -1) },
    { label: '近 7 天', from: addDays(today, -6), to: today },
    { label: '近 30 天', from: addDays(today, -29), to: today },
    { label: '本月', from: month, to: today },
    { label: '上個月', from: lastMonth, to: addDays(month, -1) },
  ];
}

export function DateRangePicker({ from, to, onApply, onClose }: {
  from: string; to: string; onApply: (from: string, to: string) => void; onClose: () => void;
}) {
  const today = todayTaipei();
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [hover, setHover] = useState('');
  // 右邊的月份預設為結束日（或今天）所在月份，左邊顯示前一個月
  const [right, setRight] = useState(monthOf(to || from || today));
  const left = addMonths(right, -1);

  // 第一次點選開始日；再點一次是結束日（比開始早就對調）；已選好區間再點則重新開始
  function pick(day: string) {
    if (!start || end) { setStart(day); setEnd(''); return; }
    if (day < start) { setEnd(start); setStart(day); } else setEnd(day);
  }
  const previewEnd = end || (start && hover ? hover : '');
  const [lo, hi] = start && previewEnd && previewEnd < start ? [previewEnd, start] : [start, previewEnd];

  function month(m: string) {
    const first = toDate(m);
    const lead = first.getUTCDay();
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(m, i))];
    return (
      <div className="cal-month">
        <div className="cal-title">{first.getUTCFullYear()} 年 {first.getUTCMonth() + 1} 月</div>
        <div className="cal-grid">
          {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{w}</div>)}
          {cells.map((d, i) => {
            if (!d) return <div key={`e${i}`} />;
            const future = d > today;
            const edge = d === lo || d === hi;
            const inRange = lo && hi && d > lo && d < hi;
            return (
              <button key={d} type="button" disabled={future}
                className={`cal-day${edge ? ' edge' : ''}${inRange ? ' in' : ''}${d === today ? ' today' : ''}`}
                onClick={() => pick(d)} onMouseEnter={() => setHover(d)}>
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const ready = start && end;
  return (
    <Dialog title="選擇日期區間" onClose={onClose}>
      <div className="stack">
        <div className="cal-summary">
          <div><span className="muted small">自</span><b>{start ? fmtDate(start) : '請點選開始日'}</b></div>
          <div><span className="muted small">至</span><b>{end ? fmtDate(end) : start ? '請點選結束日' : '—'}</b></div>
          {ready && <div className="muted small">共 {daysBetween(start, end)} 天</div>}
        </div>
        <div className="chips">
          {shortcuts(today).map((s) => (
            <button key={s.label} type="button" className={`chip ${start === s.from && end === s.to ? 'on' : ''}`}
              onClick={() => { setStart(s.from); setEnd(s.to); setRight(monthOf(s.to)); }}>{s.label}</button>
          ))}
        </div>
        <div className="cal-nav">
          <button type="button" className="link" aria-label="上個月" onClick={() => setRight(addMonths(right, -1))}>←</button>
          <div className="cal-months" onMouseLeave={() => setHover('')}>
            <div className="cal-left">{month(left)}</div>
            {month(right)}
          </div>
          <button type="button" className="link" aria-label="下個月" disabled={right >= monthOf(today)}
            onClick={() => setRight(addMonths(right, 1))}>→</button>
        </div>
        <div className="row gap end">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" disabled={!ready} onClick={() => { onApply(start, end); onClose(); }}>套用</button>
        </div>
      </div>
    </Dialog>
  );
}
