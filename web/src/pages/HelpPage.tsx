// 操作教學：直接讀取 PDF 教學的原始檔（docs/manual/manual.html），網頁與 PDF 內容一致。
// 搜尋時把教學切成小段（每個卡片、清單、表格的每一列），列出符合的段落並標示關鍵字。
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import manualHtml from '../../../docs/manual/manual.html?raw';

type Chunk = { section: string; sub: string; html: string; text: string };
type Section = { id: string; title: string; html: string };

// 教學的 class 名稱（card、badge、step…）與網站樣式重複，一律加上 m- 前綴，樣式也限定在 .manual 裡
const prefixClasses = (sel: string) => sel.replace(/\.([a-zA-Z][\w-]*)/g, '.m-$1');

function scopeCss(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((rule) => {
    const i = rule.indexOf('{');
    if (i < 0) return '';
    const selectors = rule.slice(0, i).trim();
    const body = rule.slice(i + 1);
    if (!selectors || selectors.startsWith('@')) return '';
    const scoped = selectors.split(',').map((s) => {
      const t = s.trim();
      if (t === ':root' || t === 'body') return '.manual';
      if (t === '*') return '.manual *';
      return `.manual ${prefixClasses(t)}`;
    }).join(', ');
    return `${scoped} {${body}}`;
  }).join('\n');
}

function parseManual() {
  const doc = new DOMParser().parseFromString(manualHtml, 'text/html');
  const css = scopeCss(doc.querySelector('style')?.textContent ?? '');
  doc.querySelectorAll('[class]').forEach((el) => {
    el.setAttribute('class', el.getAttribute('class')!.split(/\s+/).filter(Boolean).map((c) => `m-${c}`).join(' '));
  });
  const sections: Section[] = [];
  const chunks: Chunk[] = [];
  doc.querySelectorAll('section:not(.m-cover)').forEach((sec, n) => {
    const title = sec.querySelector('h2')?.textContent?.trim() ?? '';
    sections.push({ id: `s${n + 1}`, title, html: sec.innerHTML });
    let sub = '';
    for (const el of Array.from(sec.children)) {
      if (el.tagName === 'H2') continue;
      if (el.tagName === 'H3') { sub = el.textContent?.trim() ?? ''; continue; }
      if (el.tagName === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tr'));
        const head = rows.find((r) => r.querySelector('th'));
        for (const r of rows) {
          if (r === head) continue;
          chunks.push({ section: title, sub, html: `<table>${head?.outerHTML ?? ''}${r.outerHTML}</table>`, text: r.textContent ?? '' });
        }
        continue;
      }
      chunks.push({ section: title, sub, html: el.outerHTML, text: el.textContent ?? '' });
    }
  });
  return { css, sections, chunks };
}

// 在 HTML 的文字裡標示關鍵字（不動到標籤）
function highlight(html: string, terms: string[]) {
  if (!terms.length) return html;
  const box = document.createElement('div');
  box.innerHTML = html;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = node.data.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i % 2) { const m = document.createElement('mark'); m.textContent = p; frag.appendChild(m); }
      else if (p) frag.appendChild(document.createTextNode(p));
    });
    node.replaceWith(frag);
  }
  return box.innerHTML;
}

const SUGGESTIONS = ['登記到貨', 'SN', '完成交付', '通知', '國際條碼', '保貼', '寄送', '更正', '取消', 'AC+'];

export function HelpPage() {
  const manual = useMemo(parseManual, []);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const setQ = (v: string) => setParams((p) => { if (v) p.set('q', v); else p.delete('q'); return p; }, { replace: true });
  const [input, setInput] = useState(q);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

  const results = terms.length
    ? manual.chunks.filter((c) => {
      const hay = `${c.section} ${c.sub} ${c.text}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    : [];
  const groups = results.reduce<{ section: string; items: Chunk[] }[]>((g, c) => {
    const last = g[g.length - 1];
    if (last?.section === c.section) last.items.push(c); else g.push({ section: c.section, items: [c] });
    return g;
  }, []);

  function search(v: string) {
    setInput(v);
    setQ(v.trim());
  }

  return (
    <div className="stack">
      <style>{manual.css}</style>
      <h1>操作教學</h1>
      <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); search(input); }}>
        <div className="input-group">
          <input className="grow" type="search" value={input} placeholder="搜尋，例如：交付、SN、保貼"
            onChange={(e) => search(e.target.value)} />
        </div>
      </form>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className={`chip ${q === s ? 'on' : ''}`} onClick={() => search(q === s ? '' : s)}>{s}</button>
        ))}
      </div>

      {terms.length > 0 ? (
        results.length === 0 ? (
          <div className="muted">找不到「{q}」相關的說明，試試其他關鍵字。</div>
        ) : (
          <>
            <div className="muted small">找到 {results.length} 段相關說明</div>
            {groups.map((g) => (
              <div key={g.section} className="card manual">
                <h2>{g.section}</h2>
                {g.items.map((c, i) => (
                  <div key={i}>
                    {c.sub && <div className="help-sub">{c.sub}</div>}
                    <div dangerouslySetInnerHTML={{ __html: highlight(c.html, terms) }} />
                  </div>
                ))}
              </div>
            ))}
          </>
        )
      ) : (
        <>
          <div className="card help-toc">
            {manual.sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{s.title}</a>
            ))}
          </div>
          {manual.sections.map((s) => (
            <section key={s.id} id={s.id} className="card manual" dangerouslySetInnerHTML={{ __html: s.html }} />
          ))}
        </>
      )}
    </div>
  );
}
