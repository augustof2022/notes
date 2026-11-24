import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight, Copy, Highlighter, Loader2, MessageCircleQuestion, Sparkles, TextSelect, X } from 'lucide-react';
import { contentFingerprint } from '../lib/canvas-signature';
import { drawTextLayer } from '../lib/pdf-engine';
import { loadPdf } from '../lib/pdf-store';
import { attachedPage, PDF_TEXT_EVENT, HIGHLIGHT_COLORS, highlightData, mergeLineRects, pageObject, type HighlightColor, type HighlightData } from '../lib/pdf-model';
import { cleanSelection, LEARN_EVENT, type LearnSelection } from '../lib/explain-scene';
import './pdf.css';

export interface PageBoardNav { docName: string; page: number; pages: number; onBack: () => void; onGo: (page: number) => void }
const HIGHLIGHT_OPACITY = 42;
const readColor = (): HighlightColor => { try { const value = localStorage.getItem('note-highlight-color'); return HIGHLIGHT_COLORS.some(item => item.id === value) ? value as HighlightColor : 'yellow'; } catch { return 'yellow'; } };

/**
 * Document pages on a board. On a page's own board, a bar returns to the
 * document, steps between pages, and asks about the page. On any board, the
 * words of a page can be selected to copy, highlight, Explain or Ask; a
 * highlight is a board object of its own. Highlights and notes brought from
 * an annotated page follow their page when it is moved or resized.
 */
export function PdfPageTools({ api, root, scope, client, nav, firstView, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; scope: string; client: SupabaseClient | null; nav?: PageBoardNav; firstView?: boolean; onMessage: (text: string) => void }) {
  const [textFor, setTextFor] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  useFollowPages(api);
  // The first visit to a page's board shows the whole page; later visits keep where you were.
  useEffect(() => {
    if (!nav || !firstView) return;
    const page = api.getSceneElements().find(element => pageObject(element));
    if (page) requestAnimationFrame(() => api.scrollToContent(page, { fitToViewport: true, viewportZoomFactor: 0.86, animate: false }));
  }, []);
  useEffect(() => {
    if (!nav) return;
    const find = () => { const page = api.getSceneElements().find(element => pageObject(element)); setPageId(previous => previous === (page?.id || null) ? previous : page?.id || null); };
    find(); return api.onChange(find);
  }, [api, !!nav]);
  useEffect(() => {
    const start = (event: Event) => { const id = (event as CustomEvent<{ elementId: string }>).detail?.elementId; if (id) begin(id); };
    root?.addEventListener(PDF_TEXT_EVENT, start);
    return () => root?.removeEventListener(PDF_TEXT_EVENT, start);
  }, [root, api]);
  function begin(id: string) {
    const element = api.getSceneElements().find(item => item.id === id);
    if (!pageObject(element)) return;
    if (element!.angle) { onMessage('Straighten the page to select its words.'); return; }
    api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    setTextFor(id);
  }
  const [askPage, setAskPage] = useState(false), [pagePrompt, setPagePrompt] = useState('');
  const learnPage = (kind: 'explain' | 'ask', question?: string) => {
    if (!pageId) return false;
    const detail: LearnSelection = { kind, sourceId: pageId, selection: '', object: true, question, accepted: false };
    root?.dispatchEvent(new CustomEvent(LEARN_EVENT, { detail }));
    return detail.accepted;
  };
  const sendPageAsk = () => { const text = pagePrompt.trim(); if (text && learnPage('ask', text)) { setAskPage(false); setPagePrompt(''); } };
  return <>
    {nav && <div className="pdf-page-bar" role="toolbar" aria-label={`Page ${nav.page} of ${nav.docName}`}>
      <button className="pdf-bar-back" onClick={nav.onBack} title={`Back to ${nav.docName}`}><ArrowLeft size={15} /><span>All pages</span></button>
      <span className="pdf-bar-divider" aria-hidden />
      <button className="icon-button" aria-label="Previous page" disabled={nav.page <= 1} onClick={() => nav.onGo(nav.page - 1)}><ChevronLeft size={16} /></button>
      <span className="pdf-bar-page" aria-live="polite">Page {nav.page}<span> of {nav.pages}</span></span>
      <button className="icon-button" aria-label="Next page" disabled={nav.page >= nav.pages} onClick={() => nav.onGo(nav.page + 1)}><ChevronRight size={16} /></button>
      <span className="pdf-bar-divider" aria-hidden />
      <button aria-pressed={!!textFor} disabled={!pageId} onClick={() => { if (textFor) setTextFor(null); else if (pageId) begin(pageId); }} title="Select words on the page to copy, highlight, Explain or Ask"><TextSelect size={15} /><span>Select text</span></button>
      <button className="is-ai" disabled={!pageId} onClick={() => learnPage('explain')} title="Explain this whole page in a connected note"><Sparkles size={14} /><span>Explain page</span></button>
      <button className="is-ai" disabled={!pageId} aria-expanded={askPage} onClick={() => setAskPage(value => !value)} title="Ask your own question about this page"><MessageCircleQuestion size={14} /><span>Ask</span></button>
      {askPage && <form className="pdf-page-ask" onSubmit={event => { event.preventDefault(); sendPageAsk(); }}>
        <textarea autoFocus rows={1} maxLength={2000} aria-label={`Your prompt about page ${nav.page}`} placeholder={`Ask about page ${nav.page}`} value={pagePrompt} onChange={event => setPagePrompt(event.target.value)}
          onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPageAsk(); } if (event.key === 'Escape') { event.preventDefault(); setAskPage(false); } }} />
        <button type="submit" className="pdf-select-send" aria-label="Send prompt" disabled={!pagePrompt.trim()}><ArrowUp size={15} /></button>
      </form>}
    </div>}
    {textFor && <TextMode key={textFor} api={api} root={root} scope={scope} client={client} elementId={textFor} onDone={() => setTextFor(null)} onMessage={onMessage} />}
  </>;
}

/** Moves a page's highlights and brought-along notes with it, live, as it is dragged or resized. */
function useFollowPages(api: ExcalidrawImperativeAPI) {
  useEffect(() => {
    const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
    let content = '', frame = 0, pendingState: AppState | null = null;
    const apply = () => {
      frame = 0;
      const state = pendingState || api.getAppState(); pendingState = null;
      const elements = api.getSceneElementsIncludingDeleted();
      const moves = new Map<string, { dx: number; dy: number; sx: number; sy: number; from: { x: number; y: number }; to: { x: number; y: number } }>();
      const seen = new Set<string>();
      for (const element of elements) {
        if (!pageObject(element)) continue;
        seen.add(element.id);
        const box = { x: element.x, y: element.y, width: element.width, height: element.height }, last = boxes.get(element.id);
        boxes.set(element.id, box);
        if (!last || (last.x === box.x && last.y === box.y && last.width === box.width && last.height === box.height)) continue;
        moves.set(element.id, { dx: box.x - last.x, dy: box.y - last.y, sx: box.width / last.width, sy: box.height / last.height, from: last, to: box });
      }
      for (const id of boxes.keys()) if (!seen.has(id)) boxes.delete(id);
      if (!moves.size) return;
      let changed = false;
      const next = elements.map(element => {
        const page = !element.isDeleted && attachedPage(element), move = page && moves.get(page);
        if (!move || state.selectedElementIds[element.id]) return element;
        changed = true;
        const resized = Math.abs(move.sx - 1) > 1e-6 || Math.abs(move.sy - 1) > 1e-6;
        if (!resized) return newElementWith(element, { x: element.x + move.dx, y: element.y + move.dy });
        // Highlights stretch with the page; other notes keep their size and their place on it.
        const x = move.to.x + (element.x - move.from.x) * move.sx, y = move.to.y + (element.y - move.from.y) * move.sy;
        return highlightData(element) ? newElementWith(element, { x, y, width: element.width * move.sx, height: element.height * move.sy }) : newElementWith(element, { x, y });
      });
      if (changed) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
    };
    const changed = (elements: readonly ExcalidrawElement[], state: AppState) => {
      const next = contentFingerprint(elements);
      if (next === content) return; // Panning and zooming move nothing.
      content = next; pendingState = state;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    changed(api.getSceneElementsIncludingDeleted(), api.getAppState());
    const stop = api.onChange(changed);
    return () => { stop(); cancelAnimationFrame(frame); };
  }, [api]);
}

interface Picked { text: string; rects: { x: number; y: number; width: number; height: number }[]; bar: { left: number; top: number; below: boolean } }

/** The selectable words of one page, laid exactly over its picture and kept there as the board pans and zooms. */
function TextMode({ api, root, scope, client, elementId, onDone, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; scope: string; client: SupabaseClient | null; elementId: string; onDone: () => void; onMessage: (text: string) => void }) {
  const outer = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false), [picked, setPicked] = useState<Picked | null>(null);
  const [asking, setAsking] = useState(false), [prompt, setPrompt] = useState(''), [color, setColor] = useState(readColor), [copied, setCopied] = useState(false);
  const page = pageObject(api.getSceneElements().find(element => element.id === elementId));
  const done = useRef(onDone); done.current = onDone;
  // Place the words over the page: screen position from the board's scroll and zoom.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const element = api.getSceneElements().find(item => item.id === elementId);
      if (!element || !pageObject(element) || !outer.current || !root) { done.current(); return; }
      const state = api.getAppState(), bounds = root.getBoundingClientRect(), zoom = state.zoom.value;
      const x = (element.x + state.scrollX) * zoom + state.offsetLeft - bounds.left, y = (element.y + state.scrollY) * zoom + state.offsetTop - bounds.top;
      outer.current.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      outer.current.style.width = `${element.width}px`; outer.current.style.height = `${element.height}px`;
      if (layer.current?.dataset.width) layer.current.style.transform = `scale(${element.width / Number(layer.current.dataset.width)})`;
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    const stops = [api.onScrollChange(queue), api.onChange(queue)];
    window.addEventListener('resize', queue);
    return () => { stops.forEach(stop => stop()); window.removeEventListener('resize', queue); cancelAnimationFrame(frame); };
  }, [api, elementId, root]);
  useEffect(() => {
    if (!page || !layer.current) return;
    let alive = true;
    loadPdf(client, scope, page.fileId).then(doc => drawTextLayer(doc, page.page, layer.current!, page.size[0] * 2))
      .then(() => { if (!alive || !layer.current) return; layer.current.dataset.width = String(page.size[0] * 2); const element = api.getSceneElements().find(item => item.id === elementId); if (element) layer.current.style.transform = `scale(${element.width / (page.size[0] * 2)})`; setReady(true); outer.current?.focus({ preventScroll: true }); })
      .catch(error => { if (alive) { onMessage(error instanceof Error ? error.message : 'The words on this page could not be read.'); done.current(); } });
    return () => { alive = false; };
  }, [elementId]);
  useEffect(() => {
    const read = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !layer.current || !selection.rangeCount || !layer.current.contains(selection.anchorNode)) { if (!asking) setPicked(null); return; }
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text) { setPicked(null); return; }
      const range = selection.getRangeAt(0), state = api.getAppState(), zoom = state.zoom.value;
      const rects = Array.from(range.getClientRects()).filter(rect => !(rect.width > 0 && rect.height > layer.current!.getBoundingClientRect().height * 0.5));
      const scene = mergeLineRects(rects.map(rect => ({ left: (rect.left - state.offsetLeft) / zoom - state.scrollX, top: (rect.top - state.offsetTop) / zoom - state.scrollY, width: rect.width / zoom, height: rect.height / zoom })), 1.2);
      const box = range.getBoundingClientRect(), bounds = root!.getBoundingClientRect();
      const below = box.top - bounds.top < 120;
      setPicked({ text, rects: scene, bar: { left: Math.max(12, Math.min(bounds.width - 12, box.left + box.width / 2 - bounds.left)), top: below ? box.bottom - bounds.top + 10 : box.top - bounds.top - 10, below } });
    };
    const settle = () => requestAnimationFrame(read);
    document.addEventListener('selectionchange', settle);
    return () => document.removeEventListener('selectionchange', settle);
  }, [asking]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !asking) { event.preventDefault(); event.stopPropagation(); done.current(); } };
    // Leaving the page (a tap on the board) ends word selection.
    const pointer = (event: PointerEvent) => { const target = event.target as HTMLElement; if (!target.closest('.pdf-text-mode, .pdf-select-bar, .pdf-text-done')) done.current(); };
    window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, [asking]);
  /** The canvas pans and zooms under the words: forward the wheel to it. */
  function wheel(event: React.WheelEvent) {
    const canvas = root?.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive') || root?.querySelector<HTMLCanvasElement>('.excalidraw canvas:last-of-type');
    if (!canvas) return;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true }));
  }

  function highlight(): string | null {
    if (!picked || !page) return null;
    const fill = HIGHLIGHT_COLORS.find(item => item.id === color)!.fill;
    const data: HighlightData = { pageId: elementId, docId: page.docId, page: page.page, text: cleanSelection(picked.text), color };
    const created = convertToExcalidrawElements(picked.rects.map(rect => ({ type: 'rectangle' as const, ...rect, backgroundColor: fill, strokeColor: 'transparent', fillStyle: 'solid' as const, strokeWidth: 1, roughness: 0, opacity: HIGHLIGHT_OPACITY, roundness: null, customData: { notePdfHighlight: data } })));
    const group = created.length > 1 ? crypto.randomUUID() : null;
    const highlights = group ? created.map(element => newElementWith(element, { groupIds: [group] })) : created;
    const elements = [...api.getSceneElementsIncludingDeleted()];
    // Just above the page, so later notes stay on top of the highlight.
    const at = elements.findIndex(element => element.id === elementId);
    let end = at + 1; while (end < elements.length && highlightData(elements[end])) end++;
    elements.splice(at < 0 ? elements.length : end, 0, ...highlights);
    api.updateScene({ elements, appState: { selectedElementIds: Object.fromEntries(highlights.map(element => [element.id, true])), selectedGroupIds: group ? { [group]: true } : {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    document.getSelection()?.removeAllRanges();
    return highlights[0].id;
  }
  function learn(kind: 'explain' | 'ask', question?: string) {
    if (!picked) return;
    const text = picked.text, id = highlight();
    if (!id) return;
    const detail: LearnSelection = { kind, sourceId: id, selection: text, question, accepted: false };
    root?.dispatchEvent(new CustomEvent(LEARN_EVENT, { detail }));
    if (!detail.accepted) { onMessage('Gemini is still answering. Your highlight is saved; ask again when it is done.'); }
    done.current();
  }
  async function copy() {
    if (!picked) return;
    try { await navigator.clipboard.writeText(picked.text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { onMessage('Copy is blocked in this browser. Press Ctrl+C instead.'); }
  }
  const chooseColor = (value: HighlightColor) => { setColor(value); try { localStorage.setItem('note-highlight-color', value); } catch { /* The choice lasts this session. */ } };
  const host = root;
  if (!host || !page) return null;
  return createPortal(<>
    <div ref={outer} className={`pdf-text-mode${ready ? ' is-ready' : ''}`} tabIndex={-1} onWheel={wheel} onContextMenu={event => event.stopPropagation()}
      onCopy={event => event.stopPropagation()} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); const range = document.createRange(); range.selectNodeContents(layer.current!); document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range); } }}>
      <div ref={layer} className="textLayer pdf-text-layer" />
    </div>
    <div className="pdf-text-done" role="status">
      {ready ? <><TextSelect size={14} aria-hidden /><span>Drag across the words on page {page.page}</span></> : <><Loader2 size={14} className="spinning" aria-hidden /><span>Reading the words…</span></>}
      <button onClick={() => done.current()}><Check size={14} /> Done</button>
    </div>
    {picked && <div className={`pdf-select-bar${picked.bar.below ? ' is-below' : ''}`} style={{ left: picked.bar.left, top: picked.bar.top }} role="toolbar" aria-label="Selected words" onPointerDown={event => { if (!(event.target as HTMLElement).closest('textarea')) event.preventDefault(); }}>
      {asking ? <form className="pdf-select-ask" onSubmit={event => { event.preventDefault(); if (prompt.trim()) learn('ask', prompt.trim()); }}>
        <span className="pdf-select-quote" title={picked.text}>“{picked.text.length > 70 ? `${picked.text.slice(0, 69)}…` : picked.text}”</span>
        <div><textarea autoFocus rows={1} maxLength={2000} aria-label="Your prompt" placeholder="Ask about these words" value={prompt} onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (prompt.trim()) learn('ask', prompt.trim()); } if (event.key === 'Escape') { event.preventDefault(); setAsking(false); } }} />
          <button type="submit" className="pdf-select-send" aria-label="Send prompt" disabled={!prompt.trim()}><ArrowUp size={15} /></button>
          <button type="button" aria-label="Cancel" onClick={() => setAsking(false)}><X size={15} /></button></div>
      </form> : <>
        <span className="pdf-swatches" role="radiogroup" aria-label="Highlight colour">{HIGHLIGHT_COLORS.map(item => <button key={item.id} role="radio" aria-checked={color === item.id} aria-label={item.label} title={item.label} style={{ ['--swatch' as string]: item.fill }} onClick={() => chooseColor(item.id)} />)}</span>
        <button onClick={() => { highlight(); done.current(); }} title="Highlight these words as a board object"><Highlighter size={14} />Highlight</button>
        <span className="pdf-bar-divider" aria-hidden />
        <button className="is-ai" onClick={() => learn('explain')} title="Highlight and explain in a connected note"><Sparkles size={14} />Explain</button>
        <button className="is-ai" onClick={() => { setPrompt(''); setAsking(true); }} title="Highlight and ask your own question"><MessageCircleQuestion size={14} />Ask</button>
        <span className="pdf-bar-divider" aria-hidden />
        <button aria-label="Copy" title="Copy the words" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      </>}
    </div>}
  </>, host);
}
