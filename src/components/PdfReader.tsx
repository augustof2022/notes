import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, LayoutGrid, Loader2, NotebookPen, RefreshCw, Rows3, Search, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Board } from '../types';
import { drawPage, drawTextLayer, pageThumb } from '../lib/pdf-engine';
import { loadPdf, pdfTexts } from '../lib/pdf-store';
import { excerpt, matchesAll, pageBoardsOf, pageHighlights, pageNotes, pageSize, pdfDoc, searchTerms, type PageNotes } from '../lib/pdf-model';
import './pdf.css';

type Fit = { mode: 'width' | 'page' } | { mode: 'custom'; scale: number };
interface ViewPrefs { fit: Fit; view: 'pages' | 'tiles'; tile: number }
const PAD = 28, GAP = 44, MAX_FIT_WIDTH = 1500, ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const PT = 96 / 72;
function readPrefs(id: string): ViewPrefs {
  const fallback: ViewPrefs = { fit: { mode: 'width' }, view: 'pages', tile: 180 };
  try { const value = JSON.parse(localStorage.getItem(`note-pdf-view:${id}`) || 'null'); return value?.fit ? { ...fallback, ...value } : fallback; } catch { return fallback; }
}
function storePrefs(id: string, prefs: ViewPrefs) { try { localStorage.setItem(`note-pdf-view:${id}`, JSON.stringify(prefs)); } catch { /* Reading works without browser storage. */ } }

/**
 * Reads a document: pages fill the width by default, then zoom, fit a whole
 * page, or tile pages as a grid. Only pages near the view are drawn, sharp
 * for the screen, so long documents scroll smoothly. Each page shows whether
 * it has notes and opens its own annotation board.
 */
export function PdfReader({ board, boards, scope, client, initialPage, onAnnotate, onMessage }: { board: Board; boards: Board[]; scope: string; client: SupabaseClient | null; initialPage?: number; onAnnotate: (page: number) => void; onMessage: (text: string) => void }) {
  const meta = pdfDoc(board)!;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [prefs, setPrefs] = useState(() => readPrefs(board.id));
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [texts, setTexts] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const scroller = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<{ page: number; fraction: number; offset: number } | null>(null);
  const jumped = useRef(false);
  useEffect(() => storePrefs(board.id, prefs), [board.id, prefs]);
  useEffect(() => {
    let alive = true; setDoc(null); setFailure('');
    loadPdf(client, scope, meta.fileId).then(value => { if (!alive) return; setDoc(value); return pdfTexts(scope, meta.fileId, value).then(pages => { if (alive) setTexts(pages); }); })
      .catch(error => { if (alive) setFailure(error instanceof Error ? error.message : 'This document could not be opened.'); });
    return () => { alive = false; };
  }, [meta.fileId, scope, client, attempt]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);

  // CSS pixels per PDF point: the whole layout follows from this one number.
  const unit = useMemo(() => {
    if (!size.width) return 0;
    const [w, h] = meta.size;
    if (prefs.fit.mode === 'custom') return prefs.fit.scale * PT;
    const byWidth = Math.min(size.width - PAD * 2, MAX_FIT_WIDTH) / w;
    return prefs.fit.mode === 'width' ? byWidth : Math.min(byWidth, (size.height - PAD * 2) / h);
  }, [size, prefs.fit, meta.size]);
  // Pages are drawn sharp once zooming settles; until then the last drawing is scaled.
  const [renderUnit, setRenderUnit] = useState(unit);
  useEffect(() => { const timer = setTimeout(() => setRenderUnit(unit), unit && !renderUnit ? 0 : 180); return () => clearTimeout(timer); }, [unit]);
  const layout = useMemo(() => {
    const tops: number[] = [], heights: number[] = [], widths: number[] = [];
    let y = PAD;
    for (let page = 1; page <= meta.pages; page++) {
      const [w, h] = pageSize(meta, page);
      tops.push(y); widths.push(w * unit); heights.push(h * unit); y += h * unit + GAP;
    }
    return { tops, heights, widths, total: y + PAD - GAP };
  }, [meta, unit]);
  const pageAt = useCallback((y: number) => {
    let low = 0, high = layout.tops.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (layout.tops[mid] <= y) low = mid; else high = mid - 1; }
    return low + 1;
  }, [layout]);
  // Tiles scroll on their own; the reading position is kept for coming back.
  const lastPage = useRef(initialPage || 1);
  if (prefs.view === 'pages' && layout.tops.length && unit) lastPage.current = pageAt(scrollTop + size.height * 0.4);
  const current = lastPage.current;

  // Keep the same spot in view when the zoom changes.
  function rememberAnchor(focusY = size.height / 2) {
    if (!layout.tops.length) return;
    const y = scrollTop + focusY, page = pageAt(y), index = page - 1;
    anchor.current = { page, fraction: (y - layout.tops[index]) / Math.max(1, layout.heights[index] + GAP), offset: focusY };
  }
  useLayoutEffect(() => {
    const element = scroller.current, mark = anchor.current;
    if (!element || !unit) return;
    if (!jumped.current) {
      jumped.current = true;
      if (initialPage && initialPage > 1) { element.scrollTop = layout.tops[Math.min(meta.pages, initialPage) - 1] - PAD / 2; setScrollTop(element.scrollTop); }
      return;
    }
    if (!mark) return;
    anchor.current = null;
    const index = mark.page - 1;
    element.scrollTop = layout.tops[index] + mark.fraction * (layout.heights[index] + GAP) - mark.offset;
    setScrollTop(element.scrollTop);
  }, [layout]);
  useEffect(() => { if (initialPage && jumped.current && unit) goTo(initialPage); }, [initialPage]);

  function setFit(fit: Fit, focusY?: number) { rememberAnchor(focusY); setPrefs(previous => ({ ...previous, fit })); }
  const percent = Math.round(unit / PT * 100);
  function zoom(direction: 1 | -1, focusY?: number) {
    const now = unit / PT, next = direction > 0 ? ZOOMS.find(step => step > now + 0.001) : [...ZOOMS].reverse().find(step => step < now - 0.001);
    if (next) setFit({ mode: 'custom', scale: next }, focusY);
  }
  function goTo(page: number, smooth = false) {
    const element = scroller.current; if (!element) return;
    const clamped = Math.min(meta.pages, Math.max(1, page));
    if (prefs.view !== 'pages') { anchor.current = { page: clamped, fraction: 0, offset: PAD / 2 }; setPrefs(previous => ({ ...previous, view: 'pages' })); return; }
    element.scrollTo({ top: layout.tops[clamped - 1] - PAD / 2, behavior: smooth ? 'smooth' : 'auto' });
  }
  useLayoutEffect(() => {
    // Returning from tiles lands on the chosen page.
    const element = scroller.current, mark = anchor.current;
    if (prefs.view !== 'pages' || !element || !mark || !unit) return;
    anchor.current = null; element.scrollTop = layout.tops[mark.page - 1] - mark.offset; setScrollTop(element.scrollTop);
  }, [prefs.view]);

  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomBy(Math.exp(-event.deltaY * 0.0025), event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  function zoomBy(factor: number, focusY: number) {
    const scale = Math.min(4, Math.max(0.25, unit / PT * factor));
    setFit({ mode: 'custom', scale }, focusY);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.select()); }
      else if (mod && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoom(1); }
      else if (mod && event.key === '-') { event.preventDefault(); zoom(-1); }
      else if (mod && event.key === '0') { event.preventDefault(); setFit({ mode: 'width' }); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const pageBoards = useMemo(() => pageBoardsOf(boards, board.id), [boards, board.id]);
  const notes = useMemo(() => {
    const result = new Map<number, PageNotes>();
    for (const [page, item] of pageBoards) { const summary = pageNotes(item.elements); if (summary.notes || summary.highlights) result.set(page, { ...summary, marks: pageHighlights(item.elements) }); }
    return result;
  }, [pageBoards]);
  const terms = useMemo(() => searchTerms(deferredQuery), [deferredQuery]);
  const results = useMemo(() => {
    if (!terms.length) return [];
    const found: { page: number; kind: 'page' | 'notes'; text: string }[] = [];
    for (let page = 1; page <= meta.pages; page++) {
      const text = texts?.[page - 1] || '';
      if (text && matchesAll(text, terms)) found.push({ page, kind: 'page', text: excerpt(text, terms) });
      const note = notes.get(page)?.text || '';
      if (note && matchesAll(note, terms)) found.push({ page, kind: 'notes', text: excerpt(note, terms) });
    }
    return found;
  }, [terms, texts, notes, meta.pages]);
  const annotated = [...notes.keys()].sort((a, b) => a - b);

  const overscan = size.height;
  const first = layout.tops.length ? pageAt(Math.max(0, scrollTop - overscan)) : 1;
  const last = layout.tops.length ? pageAt(scrollTop + size.height + overscan) : 0;
  const visible: number[] = [];
  if (unit && doc && prefs.view === 'pages') for (let page = first; page <= last; page++) visible.push(page);
  const onScroll = () => { const element = scroller.current; if (element) setScrollTop(element.scrollTop); };

  return <section className="pdf-reader" aria-label={`${board.name}, ${meta.pages} pages`}>
    <div className="pdf-toolbar" role="toolbar" aria-label="Document view">
      <div className="pdf-segmented" role="group" aria-label="Layout">
        <button aria-pressed={prefs.view === 'pages'} title="Read pages" onClick={() => { anchor.current = { page: current, fraction: 0, offset: PAD / 2 }; setPrefs(previous => ({ ...previous, view: 'pages' })); }}><Rows3 size={15} /><span>Pages</span></button>
        <button aria-pressed={prefs.view === 'tiles'} title="See pages as tiles" onClick={() => setPrefs(previous => ({ ...previous, view: 'tiles' }))}><LayoutGrid size={15} /><span>Tiles</span></button>
      </div>
      {prefs.view === 'pages' ? <div className="pdf-zoom" role="group" aria-label="Zoom">
        <button className="icon-button" aria-label="Zoom out" title="Zoom out (Ctrl −)" disabled={!unit} onClick={() => zoom(-1)}><ZoomOut size={16} /></button>
        <select aria-label="Zoom level" value={prefs.fit.mode === 'custom' ? 'custom' : prefs.fit.mode} onChange={event => { const value = event.target.value; setFit(value === 'width' || value === 'page' ? { mode: value } : { mode: 'custom', scale: Number(value) }); }}>
          <option value="width">Fit width</option><option value="page">Fit page</option>
          {prefs.fit.mode === 'custom' && <option value="custom">{percent}%</option>}
          {ZOOMS.map(step => <option key={step} value={step}>{Math.round(step * 100)}%</option>)}
        </select>
        <button className="icon-button" aria-label="Zoom in" title="Zoom in (Ctrl +)" disabled={!unit} onClick={() => zoom(1)}><ZoomIn size={16} /></button>
      </div> : <label className="pdf-tile-size"><span>Tile size</span><input type="range" min={110} max={380} step={10} value={prefs.tile} onChange={event => setPrefs(previous => ({ ...previous, tile: Number(event.target.value) }))} /></label>}
      <div className="pdf-pager" role="group" aria-label="Page">
        <button className="icon-button" aria-label="Previous page" disabled={current <= 1} onClick={() => goTo(current - 1, true)}><ChevronLeft size={16} /></button>
        <PageInput page={current} pages={meta.pages} onGo={goTo} />
        <button className="icon-button" aria-label="Next page" disabled={current >= meta.pages} onClick={() => goTo(current + 1, true)}><ChevronRight size={16} /></button>
      </div>
      {annotated.length > 0 && <div className="pdf-annotated" role="group" aria-label="Pages with notes">
        <NotebookPen size={14} aria-hidden /><span>Notes on</span>
        {annotated.slice(0, 8).map(page => <button key={page} aria-current={page === current ? 'true' : undefined} onClick={() => goTo(page, true)} title={`Go to page ${page}`}>{page}</button>)}
        {annotated.length > 8 && <span className="pdf-annotated-more">+{annotated.length - 8}</span>}
      </div>}
      <div className={`pdf-search${searchOpen || query ? ' is-open' : ''}`}>
        <button className="icon-button pdf-search-toggle" aria-label="Search this document" title="Search this document (Ctrl F)" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Search size={16} /></button>
        <input ref={searchInput} type="search" aria-label="Search this document and its notes" placeholder="Search pages and notes" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); scroller.current?.focus(); } if (event.key === 'Enter' && results[0]) goTo((results.find(item => item.page > current) || results[0]).page, true); }} onBlur={() => { if (!query) setSearchOpen(false); }} />
      </div>
    </div>
    <div className="pdf-body">
      <div ref={scroller} className={`pdf-scroll${prefs.view === 'tiles' ? ' is-tiles' : ''}`} tabIndex={-1} onScroll={onScroll}>
        {failure ? <div className="pdf-state" role="alert"><p>{failure}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /> Try again</button></div>
          : !doc ? <div className="pdf-state" role="status"><Loader2 className="spinning" size={20} /><p>Opening {board.name}…</p></div>
          : prefs.view === 'tiles' ? <Tiles doc={doc} fileId={meta.fileId} pages={meta.pages} ratio={meta.size[0] / meta.size[1]} tile={prefs.tile} current={current} notes={notes} onOpen={page => goTo(page)} onAnnotate={onAnnotate} />
          : <div className="pdf-pages" style={{ height: layout.total }}>
            {visible.map(page => <PageView key={page} doc={doc} page={page} top={layout.tops[page - 1]} width={layout.widths[page - 1]} height={layout.heights[page - 1]}
              renderWidth={renderUnit * pageSize(meta, page)[0]} terms={terms} notes={notes.get(page)} onAnnotate={() => onAnnotate(page)} onMessage={onMessage} />)}
          </div>}
      </div>
      {terms.length > 0 && <aside className="pdf-results" aria-label="Search results">
        <header><strong>{results.length ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'No matches'}</strong>{!texts && <small>Reading pages…</small>}<button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={15} /></button></header>
        {results.length ? <ol>{results.slice(0, 300).map((result, index) => <li key={`${result.page}:${result.kind}:${index}`}>
          <button aria-current={result.page === current ? 'true' : undefined} onClick={() => result.kind === 'notes' ? onAnnotate(result.page) : goTo(result.page, true)}>
            <span className="pdf-result-head"><b>Page {result.page}</b>{result.kind === 'notes' && <em><NotebookPen size={11} /> Your notes</em>}</span>
            <span className="pdf-result-text"><Mark text={result.text} terms={terms} /></span>
          </button></li>)}</ol>
          : <p className="pdf-results-empty">Try fewer words. Notes you added on pages are searched too.</p>}
      </aside>}
    </div>
  </section>;
}

function PageInput({ page, pages, onGo }: { page: number; pages: number; onGo: (page: number) => void }) {
  const [value, setValue] = useState(String(page));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setValue(String(page)); }, [page]);
  return <span className="pdf-page-input"><input aria-label="Page number" inputMode="numeric" value={value} onFocus={event => { editing.current = true; event.target.select(); }}
    onBlur={() => { editing.current = false; setValue(String(page)); }} onChange={event => setValue(event.target.value.replace(/\D/g, ''))}
    onKeyDown={event => { if (event.key === 'Enter') { const next = Number(value); if (next) onGo(next); (event.target as HTMLInputElement).blur(); } if (event.key === 'Escape') (event.target as HTMLInputElement).blur(); }} /><span>of {pages}</span></span>;
}

function Mark({ text, terms }: { text: string; terms: readonly string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

function NotesBadge({ notes, onOpen, compact = false }: { notes?: PageNotes; onOpen: () => void; compact?: boolean }) {
  const label = notes ? [notes.notes && `${notes.notes} note${notes.notes === 1 ? '' : 's'}`, notes.highlights && `${notes.highlights} highlight${notes.highlights === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : '';
  return notes ? <button className="pdf-notes-badge" onClick={onOpen} title="Open this page's board"><NotebookPen size={13} aria-hidden /><span>{compact ? (notes.notes + notes.highlights) : label}</span></button>
    : <button className="pdf-annotate" onClick={onOpen} title="Annotate this page on its own board"><NotebookPen size={13} aria-hidden /><span>{compact ? 'Annotate' : 'Annotate page'}</span></button>;
}

function PageView({ doc, page, top, width, height, renderWidth, terms, notes, onAnnotate, onMessage }: { doc: PDFDocumentProxy; page: number; top: number; width: number; height: number; renderWidth: number; terms: readonly string[]; notes?: PageNotes; onAnnotate: () => void; onMessage: (text: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false), [textWidth, setTextWidth] = useState(0);
  useEffect(() => {
    if (!canvas.current || renderWidth < 1) return;
    const task = drawPage(doc, page, canvas.current, renderWidth);
    task.done.then(() => setDrawn(true)).catch(() => onMessage(`Page ${page} could not be drawn.`));
    return () => task.cancel();
  }, [doc, page, renderWidth]);
  useEffect(() => {
    if (!text.current || renderWidth < 1) return;
    let alive = true;
    // Selectable words come a moment after the picture, so scrolling stays smooth.
    const timer = setTimeout(() => { void drawTextLayer(doc, page, text.current!, renderWidth).then(() => { if (alive) { setTextWidth(renderWidth); markTerms(text.current!, terms); } }).catch(() => {}); }, 120);
    return () => { alive = false; clearTimeout(timer); };
  }, [doc, page, renderWidth]);
  useEffect(() => { if (text.current && textWidth) markTerms(text.current, terms); }, [terms, textWidth]);
  return <div className={`pdf-page${drawn ? ' is-drawn' : ''}`} style={{ top, width, height }} data-page={page}>
    <canvas ref={canvas} aria-hidden />
    {!!notes?.marks?.length && <div className="pdf-marks" aria-hidden>{notes.marks.map(mark => <i key={mark.id} style={{ left: `${mark.left * 100}%`, top: `${mark.top * 100}%`, width: `${mark.width * 100}%`, height: `${mark.height * 100}%`, background: mark.fill }} />)}</div>}
    <div ref={text} className="textLayer pdf-text-layer" style={{ transform: textWidth ? `scale(${width / textWidth})` : undefined }} />
    <div className="pdf-page-actions"><NotesBadge notes={notes} onOpen={onAnnotate} /></div>
    <span className="pdf-page-number" aria-hidden>{page}</span>
  </div>;
}
function markTerms(layer: HTMLElement, terms: readonly string[]) {
  for (const span of Array.from(layer.querySelectorAll('span'))) {
    const text = span.textContent?.toLocaleLowerCase() || '';
    span.classList.toggle('pdf-hit', terms.length > 0 && terms.some(term => text.includes(term)));
  }
}

function Tiles({ doc, fileId, pages, ratio, tile, current, notes, onOpen, onAnnotate }: { doc: PDFDocumentProxy; fileId: string; pages: number; ratio: number; tile: number; current: number; notes: Map<number, PageNotes>; onOpen: (page: number) => void; onAnnotate: (page: number) => void }) {
  const grid = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState<Set<number>>(new Set());
  useEffect(() => {
    const root = grid.current?.closest('.pdf-scroll'); if (!grid.current || !root) return;
    const observer = new IntersectionObserver(entries => {
      const add = entries.filter(entry => entry.isIntersecting).map(entry => Number((entry.target as HTMLElement).dataset.page));
      if (add.length) setShown(previous => { const next = new Set(previous); add.forEach(page => next.add(page)); return next; });
    }, { root, rootMargin: '400px 0px' });
    grid.current.querySelectorAll('[data-page]').forEach(item => observer.observe(item));
    return () => observer.disconnect();
  }, [pages]);
  useEffect(() => { grid.current?.querySelector(`[data-page="${current}"]`)?.scrollIntoView({ block: 'center' }); }, []);
  return <ol ref={grid} className="pdf-tiles" style={{ ['--tile' as string]: `${tile}px`, ['--ratio' as string]: String(ratio) }}>
    {Array.from({ length: pages }, (_, index) => index + 1).map(page => <li key={page} data-page={page} className={page === current ? 'is-current' : undefined}>
      <button className="pdf-tile" onClick={() => onOpen(page)} aria-label={`Read page ${page}`}><Thumb doc={doc} fileId={fileId} page={page} width={tile} show={shown.has(page)} /></button>
      <div className="pdf-tile-foot"><span>{page}</span><NotesBadge notes={notes.get(page)} compact onOpen={() => onAnnotate(page)} /></div>
    </li>)}
  </ol>;
}

export function Thumb({ doc, fileId, page, width, show }: { doc: PDFDocumentProxy; fileId: string; page: number; width: number; show: boolean }) {
  const [url, setUrl] = useState('');
  // Thumbnails are drawn in steps of 120 px so resizing tiles reuses them.
  const step = Math.ceil(width / 120) * 120;
  useEffect(() => { if (!show) return; let alive = true; void pageThumb(fileId, doc, page, step).then(value => { if (alive) setUrl(value); }).catch(() => {}); return () => { alive = false; }; }, [show, step, doc, page, fileId]);
  return url ? <img src={url} alt="" draggable={false} /> : <span className="pdf-thumb-wait" aria-hidden />;
}
