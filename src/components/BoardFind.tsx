import { useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, ChevronUp, Image, PenLine, Search, Type, X } from 'lucide-react';
import { db } from '../lib/db';
import { recordKey } from '../types';
import { findOnBoard, findSnippet, type BoardFindKind, type BoardFindMatch } from '../lib/board-find';
import './board-find.css';

const kinds: Record<BoardFindKind, { label: string; icon: React.ReactNode }> = {
  text: { label: 'Text', icon: <Type size={14} /> }, cutout: { label: 'Erased text', icon: <Type size={14} /> },
  image: { label: 'Image text', icon: <Image size={14} /> }, handwriting: { label: 'Handwriting', icon: <PenLine size={14} /> },
};
const modalOpen = () => !!document.querySelector('.modal-backdrop,[aria-modal="true"]');

/** Ctrl+F on a board: finds typed text, text read from images, and reviewed handwriting. */
export function BoardFind({ api, root, scope, zoomLocked }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; scope: string; zoomLocked: () => boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [imageText, setImageText] = useState<Map<string, string>>(new Map()), [pending, setPending] = useState(0);
  const [revision, setRevision] = useState(0), [, setViewport] = useState('');
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const openFind = () => { setOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f' || modalOpen() || !root?.isConnected) return;
      event.preventDefault(); event.stopImmediatePropagation(); openFind();
    };
    const request = () => openFind();
    document.addEventListener('keydown', key, true); root?.addEventListener('note-board-find', request);
    return () => { document.removeEventListener('keydown', key, true); root?.removeEventListener('note-board-find', request); };
  }, [root]);
  useEffect(() => api.onChange((_elements, state) => {
    // The editor's own Find (main menu or command palette) only knows typed text.
    if (state.openSidebar?.tab === 'search') { api.updateScene({ appState: { openSidebar: null }, captureUpdate: CaptureUpdateAction.NEVER }); openFind(); }
  }), [api]);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const unsubscribe = api.onChange((_elements, state) => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setViewport(`${state.scrollX}:${state.scrollY}:${state.zoom.value}:${state.width}:${state.height}`); setRevision(value => value + 1); });
    });
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [api, open]);
  const fileIds = open ? [...new Set(api.getSceneElements().flatMap(element => element.type === 'image' && element.fileId && !element.customData?.noteRichTextRender ? [element.fileId] : []))].sort().join('|') : '';
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const ids = fileIds ? fileIds.split('|') : [];
    const load = () => db.assets.bulkGet(ids.map(id => recordKey(scope, id))).then(assets => {
      if (!alive) return;
      setImageText(new Map(assets.flatMap(asset => asset?.ocrText ? [[asset.id, asset.ocrText] as [string, string]] : [])));
      setPending(assets.filter(asset => asset && asset.ocrStatus === 'pending').length);
    }).catch(() => {});
    void load();
    // Image text can finish reading while Find is open.
    const timer = setInterval(load, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, fileIds, scope]);
  const matches = useMemo(() => open ? findOnBoard(api.getSceneElements(), imageText, query) : [], [open, query, imageText, revision]);
  const index = matches.length ? Math.min(active, matches.length - 1) : -1;
  const current = index >= 0 ? matches[index] : null;
  const shown = useRef(false);
  useEffect(() => { setActive(0); shown.current = false; }, [query]);
  function show(match: BoardFindMatch) {
    const elements = api.getSceneElements().filter(element => match.targetIds.includes(element.id));
    if (!elements.length) return;
    const selectable = elements.filter(element => !element.locked);
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(selectable.map(element => [element.id, true])), selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    api.scrollToContent(elements, { fitToContent: !zoomLocked(), animate: true, maxZoom: 1.4 });
  }
  function go(next: number) {
    if (!matches.length) return;
    // The first Enter (or arrow) goes to the highlighted first match itself.
    if (!shown.current) next = Math.max(0, index);
    shown.current = true;
    const wrapped = (next + matches.length) % matches.length;
    setActive(wrapped); show(matches[wrapped]);
    requestAnimationFrame(() => list.current?.querySelector(`[data-find-index="${wrapped}"]`)?.scrollIntoView({ block: 'nearest' }));
  }
  function close() { setOpen(false); root?.querySelector<HTMLElement>('.excalidraw')?.focus(); }
  if (!open) return null;
  const state = api.getAppState(), origin = root?.getBoundingClientRect();
  const rect = (match: BoardFindMatch) => {
    const elements = api.getSceneElements().filter(element => match.targetIds.includes(element.id));
    if (!elements.length || !origin) return null;
    const [x1, y1, x2, y2] = getCommonBounds(elements), z = state.zoom.value, pad = 6;
    return { left: (x1 + state.scrollX) * z + state.offsetLeft - origin.left - pad, top: (y1 + state.scrollY) * z + state.offsetTop - origin.top - pad, width: (x2 - x1) * z + pad * 2, height: (y2 - y1) * z + pad * 2 };
  };
  return <>
    <div className="board-find-highlights" aria-hidden="true">
      {matches.map((match, position) => { const box = rect(match); return box && <span key={match.key} className={position === index ? 'board-find-highlight current' : 'board-find-highlight'} style={box} />; })}
    </div>
    <div className="board-find" role="search" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="board-find-bar">
        <Search size={15} aria-hidden="true" />
        <input ref={input} className="board-find-input" value={query} placeholder="Find text, image text, handwriting" aria-label="Find on this board" onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); go(index < 0 ? 0 : index + (event.shiftKey ? -1 : 1)); } }} />
        <span className="board-find-count" role="status">{query.trim() ? matches.length ? `${index + 1} of ${matches.length}` : 'No matches' : ''}</span>
        <button type="button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!matches.length} onClick={() => go(index - 1)}><ChevronUp size={16} /></button>
        <button type="button" aria-label="Next match" title="Next (Enter)" disabled={!matches.length} onClick={() => go(index + 1)}><ChevronDown size={16} /></button>
        <button type="button" aria-label="Close find" title="Close (Esc)" onClick={close}><X size={16} /></button>
      </div>
      {query.trim() && (matches.length > 0 || pending > 0) && <div ref={list} className="board-find-results">
        {matches.map((match, position) => <button type="button" key={match.key} data-find-index={position} aria-current={position === index} onClick={() => { shown.current = true; setActive(position); show(match); }}>
          <span className="board-find-kind">{kinds[match.kind].icon}{kinds[match.kind].label}</span>
          <span className="board-find-snippet">{findSnippet(match.text, query).map((part, key) => part.match ? <mark key={key}>{part.text}</mark> : <span key={key}>{part.text}</span>)}</span>
        </button>)}
        {pending > 0 && <p className="board-find-note">{pending} image{pending === 1 ? ' is' : 's are'} still being read. Matches appear when reading finishes.</p>}
      </div>}
    </div>
  </>;
}
