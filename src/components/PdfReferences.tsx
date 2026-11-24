import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ArrowLeft, BookOpen, FileText, FileUp, LibraryBig, Loader2, Maximize2, Minimize2, NotebookPen, Plus, Search, Trash2, X } from 'lucide-react';
import type { Board } from '../types';
import { db, touch } from '../lib/db';
import { localSceneFiles } from '../lib/assets';
import { boardImageIds } from '../lib/board-images';
import { createPageObject, DOCUMENT_ACCEPT, importDocument, isDocumentFile, loadPdf, pdfTexts } from '../lib/pdf-store';
import { boundToPage, copyPageNotes, excerpt, isLibraryDoc, matchesAll, pageBoardsOf, pageNotes, pageObject, pageSceneSize, pageSize, pdfDoc, searchTerms, type PageNotes } from '../lib/pdf-model';
import { Thumb } from './PdfReader';
import './pdf.css';

const PAGE_DRAG = 'application/x-note-pdf-page';
type View = { kind: 'list' } | { kind: 'library' } | { kind: 'doc'; id: string; page?: number };
const readWide = () => { try { return localStorage.getItem('note-references-wide') === 'true'; } catch { return false; } };

/**
 * A board's reference bar: documents kept with this board (added here, never
 * shown in the library) and library documents pinned to it. Pick a document
 * to read its pages, then place any page on the board to annotate. A library
 * page that already has notes from its own page board brings them along.
 */
export function PdfReferences({ api, root, board, boards, scope, client, references, onReferences, onMessage }: {
  api: ExcalidrawImperativeAPI; root: HTMLElement | null; board: Board; boards: Board[]; scope: string; client: SupabaseClient | null;
  references: string[]; onReferences: (ids: string[]) => void; onMessage: (text: string) => void;
}) {
  const [host, setHost] = useState<Element | null>(null);
  const [open, setOpen] = useState(false), [wide, setWide] = useState(readWide);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { setHost(root?.closest('.main-content')?.querySelector('.board-header-tools') || null); }, [root]);
  useEffect(() => { try { localStorage.setItem('note-references-wide', String(wide)); } catch { /* Width lasts this session. */ } }, [wide]);
  const docs = useMemo(() => {
    const own = boards.filter(item => !item.deleted && pdfDoc(item)?.boardId === board.id);
    const pinned = references.map(id => boards.find(item => item.id === id)).filter((item): item is Board => !!item && !item.deleted && isLibraryDoc(item));
    return [...own, ...pinned].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [boards, board.id, references]);
  const library = useMemo(() => boards.filter(item => !item.deleted && isLibraryDoc(item) && !references.includes(item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [boards, references]);
  const notesFor = (doc: Board) => { const result = new Map<number, PageNotes>(); for (const [page, item] of pageBoardsOf(boards, doc.id)) { const notes = pageNotes(item.elements); if (notes.notes || notes.highlights) result.set(page, notes); } return result; };

  async function upload(files: File[]) {
    const accepted = files.filter(isDocumentFile);
    if (!accepted.length) { onMessage('Choose a PDF or a Word (.docx) file.'); return; }
    setOpen(true);
    let last: Board | null = null;
    for (const item of accepted) {
      try {
        setImporting(`Adding ${item.name}…`);
        last = await importDocument({ file: item, scope, folderId: board.folderId, boardId: board.id, onProgress: progress => setImporting(progress.stage === 'converting' ? `Converting ${item.name} to PDF…` : progress.stage === 'reading' && progress.total ? `Reading page ${progress.done} of ${progress.total}…` : `Adding ${item.name}…`) });
      } catch (error) { onMessage(error instanceof Error ? error.message : 'This document could not be added.'); }
    }
    setImporting('');
    if (last) { setView({ kind: 'doc', id: last.id }); onMessage(accepted.length > 1 ? 'Documents added to this board' : `${last.name} is ready. Place any page on the board.`); }
  }
  async function remove(doc: Board) {
    if (pdfDoc(doc)?.boardId) await db.boards.update(doc.key, { deleted: true, ...touch() });
    else onReferences(references.filter(id => id !== doc.id));
    setConfirm(null); if (view.kind === 'doc' && view.id === doc.id) setView({ kind: 'list' });
  }

  /** Places a page on the board at `at` (scene point, its centre), or in the middle of the view. */
  async function place(doc: Board, page: number, withNotes: boolean, at?: { x: number; y: number }) {
    const meta = pdfDoc(doc); if (!meta) return;
    const pdf = await loadPdf(client, scope, meta.fileId);
    const state = api.getAppState(), zoom = state.zoom.value, size = pageSceneSize(pageSize(meta, page));
    const center = at || { x: state.width / 2 / zoom - state.scrollX, y: state.height / 2 / zoom - state.scrollY };
    const spot = freeSpot(api.getSceneElements(), { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size });
    const { element, file } = await createPageObject({ scope, docBoard: doc, doc: pdf, page, x: spot.x, y: spot.y });
    api.addFiles([file]);
    let placed = element as ExcalidrawElement; const added: ExcalidrawElement[] = [];
    const source = withNotes ? pageBoardsOf(boards, doc.id).get(page) : undefined;
    const original = source?.elements.find(item => pageObject(item));
    if (source && original) {
      const copies = copyPageNotes(source.elements, original.id, element.id, { x: element.x - original.x, y: element.y - original.y });
      const bound = boundToPage(copies, element.id);
      if (bound.length) placed = newElementWith(element, { boundElements: bound });
      added.push(...copies);
      const files = await localSceneFiles(scope, boardImageIds(copies));
      if (Object.keys(files).length) api.addFiles(Object.values(files));
    }
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), placed, ...added], appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    requestAnimationFrame(() => api.scrollToContent(placed, { fitToContent: false, animate: true }));
  }

  // Drag a page from the bar onto the board, or drop a PDF/Word file on the board to keep it here.
  useEffect(() => {
    if (!root) return;
    const over = (event: DragEvent) => {
      const types = Array.from(event.dataTransfer?.types || []);
      if (types.includes(PAGE_DRAG) || (types.includes('Files') && Array.from(event.dataTransfer?.items || []).some(item => item.type === 'application/pdf' || item.type.includes('wordprocessingml')))) { event.preventDefault(); event.stopPropagation(); event.dataTransfer!.dropEffect = 'copy'; }
    };
    const drop = (event: DragEvent) => {
      const data = event.dataTransfer?.getData(PAGE_DRAG);
      const files = Array.from(event.dataTransfer?.files || []).filter(isDocumentFile);
      if (!data && !files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (files.length) { void upload(files); return; }
      try {
        const { docId, page, notes } = JSON.parse(data!);
        const doc = boards.find(item => item.id === docId);
        const state = api.getAppState(), zoom = state.zoom.value;
        if (doc) void place(doc, page, notes, { x: (event.clientX - state.offsetLeft) / zoom - state.scrollX, y: (event.clientY - state.offsetTop) / zoom - state.scrollY }).catch(error => onMessage(error instanceof Error ? error.message : 'This page could not be placed.'));
      } catch { /* Not a page from the bar. */ }
    };
    root.addEventListener('dragover', over, true); root.addEventListener('drop', drop, true);
    return () => { root.removeEventListener('dragover', over, true); root.removeEventListener('drop', drop, true); };
  });

  const terms = searchTerms(query);
  const current = view.kind === 'doc' ? docs.find(item => item.id === view.id) : undefined;
  useEffect(() => { if (view.kind === 'doc' && !current) setView({ kind: 'list' }); }, [current, view.kind]);
  const count = docs.length;
  return <>
    {host && createPortal(<button className="board-header-button pdf-references-trigger" aria-pressed={open} aria-controls="pdf-references" onClick={() => setOpen(value => !value)} title="PDFs and Word documents for this board">
      <BookOpen size={16} /><span>References</span>{count > 0 && <span className="pdf-count">{count}</span>}</button>, host)}
    <input ref={file} type="file" accept={DOCUMENT_ACCEPT} multiple hidden onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void upload(files); }} />
    {open && <aside id="pdf-references" className={`pdf-references${wide ? ' is-wide' : ''}`} aria-label="References">
      <header className="pdf-ref-head">
        {view.kind !== 'list' ? <button className="icon-button" aria-label="Back to references" onClick={() => setView({ kind: 'list' })}><ArrowLeft size={17} /></button> : <BookOpen size={17} className="pdf-ref-icon" aria-hidden />}
        <h2 title={current?.name}>{view.kind === 'library' ? 'From your library' : current ? current.name : 'References'}</h2>
        <button className="icon-button" aria-label={wide ? 'Narrow the panel' : 'Widen the panel to read'} title={wide ? 'Narrow' : 'Widen to read'} onClick={() => setWide(value => !value)}>{wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        <button className="icon-button" aria-label="Close references" onClick={() => setOpen(false)}><X size={17} /></button>
      </header>
      {view.kind === 'doc' && current ? <DocPages key={current.id} doc={current} scope={scope} client={client} notes={notesFor(current)} startPage={view.page} wide={wide} onPlace={(page, notes) => place(current, page, notes)} onMessage={onMessage} />
        : <>
          <div className="pdf-ref-tools">
            <label className="pdf-ref-search"><Search size={14} aria-hidden /><input type="search" placeholder={view.kind === 'library' ? 'Search your library' : 'Search names and pages'} aria-label="Search references" value={query} onChange={event => setQuery(event.target.value)} /></label>
            {view.kind === 'list' && <div className="pdf-ref-actions">
              <button className="primary-button" onClick={() => file.current?.click()} disabled={!!importing}><FileUp size={15} />Add PDF or Word</button>
              <button className="secondary-button" onClick={() => { setQuery(''); setView({ kind: 'library' }); }}><LibraryBig size={15} />From library</button>
            </div>}
            {importing && <p className="pdf-ref-progress" role="status"><Loader2 size={14} className="spinning" aria-hidden />{importing}</p>}
          </div>
          {view.kind === 'library' ? <DocList docs={library.filter(item => matchesAll(item.name, terms))} notesFor={notesFor} empty={library.length ? 'No documents match.' : 'Documents you add to folders appear here. Pages you annotated there bring their notes along.'}
            onPick={doc => { onReferences([...references, doc.id]); setQuery(''); setView({ kind: 'doc', id: doc.id }); }} pickLabel="Add" />
            : terms.length ? <SearchHits docs={docs} scope={scope} terms={terms} onOpen={(id, page) => setView({ kind: 'doc', id, page })} />
            : <DocList docs={docs} notesFor={notesFor} onPick={doc => setView({ kind: 'doc', id: doc.id })} confirm={confirm} onConfirm={setConfirm} onRemove={doc => void remove(doc)}
              empty={<><FileText size={26} aria-hidden /><strong>Read alongside your board</strong><span>Add a PDF or Word file, then place its pages here to highlight, connect and ask about them.</span><small>Google Docs: File → Download → Microsoft Word (.docx) or PDF.</small></>} />}
        </>}
    </aside>}
  </>;
}

/** The first spot, from the preferred one rightwards, where a new page does not cover another page. */
function freeSpot(elements: readonly ExcalidrawElement[], want: { x: number; y: number; width: number; height: number }) {
  const pages = elements.filter(element => pageObject(element));
  const hits = (x: number) => pages.some(page => x < page.x + page.width + 40 && x + want.width + 40 > page.x && want.y < page.y + page.height && want.y + want.height > page.y);
  let x = want.x;
  for (let guard = 0; guard < 200 && hits(x); guard++) x = Math.max(...pages.filter(page => want.y < page.y + page.height && want.y + want.height > page.y && x < page.x + page.width + 40 && x + want.width + 40 > page.x).map(page => page.x + page.width + 60));
  return { x, y: want.y };
}

function DocList({ docs, notesFor, onPick, pickLabel, confirm, onConfirm, onRemove, empty }: { docs: Board[]; notesFor: (doc: Board) => Map<number, PageNotes>; onPick: (doc: Board) => void; pickLabel?: string; confirm?: string | null; onConfirm?: (id: string | null) => void; onRemove?: (doc: Board) => void; empty: React.ReactNode }) {
  if (!docs.length) return <div className="pdf-ref-empty">{empty}</div>;
  return <ul className="pdf-ref-list">{docs.map(doc => {
    const meta = pdfDoc(doc)!, annotated = notesFor(doc).size, own = !!meta.boardId;
    return <li key={doc.id}>
      <button className="pdf-ref-doc" onClick={() => onPick(doc)}>
        <span className="pdf-ref-doc-icon" aria-hidden><FileText size={18} /></span>
        <span className="pdf-ref-doc-text"><strong>{doc.name}</strong><small>{meta.pages} page{meta.pages === 1 ? '' : 's'}{meta.source === 'docx' ? ' · from Word' : ''}{own ? ' · this board only' : ' · library'}{annotated ? ` · notes on ${annotated} page${annotated === 1 ? '' : 's'}` : ''}</small></span>
        {pickLabel && <span className="pdf-ref-pick"><Plus size={14} />{pickLabel}</span>}
      </button>
      {onRemove && (confirm === doc.id ? <span className="pdf-ref-confirm"><button className="danger" onClick={() => onRemove(doc)}>{own ? 'Delete' : 'Remove'}</button><button onClick={() => onConfirm?.(null)}>Keep</button></span>
        : <button className="icon-button pdf-ref-remove" aria-label={own ? `Delete ${doc.name}` : `Remove ${doc.name} from this board`} title={own ? 'Delete from this board' : 'Remove from this board (stays in your library)'} onClick={() => onConfirm?.(doc.id)}><Trash2 size={14} /></button>)}
    </li>;
  })}</ul>;
}

function SearchHits({ docs, scope, terms, onOpen }: { docs: Board[]; scope: string; terms: string[]; onOpen: (id: string, page?: number) => void }) {
  const [texts, setTexts] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    let alive = true;
    void Promise.all(docs.map(async doc => [doc.id, await pdfTexts(scope, pdfDoc(doc)!.fileId) || []] as const)).then(entries => { if (alive) setTexts(new Map(entries)); });
    return () => { alive = false; };
  }, [docs, scope]);
  const hits: { doc: Board; page?: number; text: string }[] = [];
  for (const doc of docs) {
    if (matchesAll(doc.name, terms)) hits.push({ doc, text: `${pdfDoc(doc)!.pages} pages` });
    (texts.get(doc.id) || []).forEach((text, index) => { if (hits.length < 200 && matchesAll(text, terms)) hits.push({ doc, page: index + 1, text: excerpt(text, terms, 60) }); });
  }
  if (!hits.length) return <div className="pdf-ref-empty"><strong>No matches</strong><span>Names and the words on every page are searched.</span></div>;
  return <ul className="pdf-ref-list pdf-ref-hits">{hits.map((hit, index) => <li key={`${hit.doc.id}:${hit.page || 0}:${index}`}>
    <button className="pdf-ref-doc" onClick={() => onOpen(hit.doc.id, hit.page)}><span className="pdf-ref-doc-text"><strong>{hit.doc.name}{hit.page ? <em> · page {hit.page}</em> : null}</strong><small>{hit.text}</small></span></button>
  </li>)}</ul>;
}

function DocPages({ doc, scope, client, notes, startPage, wide, onPlace, onMessage }: { doc: Board; scope: string; client: SupabaseClient | null; notes: Map<number, PageNotes>; startPage?: number; wide: boolean; onPlace: (page: number, notes: boolean) => Promise<void>; onMessage: (text: string) => void }) {
  const meta = pdfDoc(doc)!;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [failure, setFailure] = useState('');
  const [shown, setShown] = useState<Set<number>>(new Set()), [busy, setBusy] = useState<Set<number>>(new Set());
  const [withNotes, setWithNotes] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => { let alive = true; loadPdf(client, scope, meta.fileId).then(value => { if (alive) setPdf(value); }).catch(error => { if (alive) setFailure(error instanceof Error ? error.message : 'This document could not be opened.'); }); return () => { alive = false; }; }, [meta.fileId]);
  useEffect(() => {
    const root = list.current; if (!root || !pdf) return;
    const observer = new IntersectionObserver(entries => {
      const add = entries.filter(entry => entry.isIntersecting).map(entry => Number((entry.target as HTMLElement).dataset.page));
      if (add.length) setShown(previous => { const next = new Set(previous); add.forEach(page => next.add(page)); return next; });
    }, { root: root.parentElement, rootMargin: '600px 0px' });
    root.querySelectorAll('[data-page]').forEach(item => observer.observe(item));
    if (startPage) root.querySelector(`[data-page="${startPage}"]`)?.scrollIntoView({ block: 'start' });
    return () => observer.disconnect();
  }, [pdf]);
  async function add(page: number) {
    setBusy(previous => new Set(previous).add(page));
    try { await onPlace(page, withNotes); } catch (error) { onMessage(error instanceof Error ? error.message : 'This page could not be placed.'); }
    finally { setBusy(previous => { const next = new Set(previous); next.delete(page); return next; }); }
  }
  const width = wide ? 640 : 320, [w, h] = meta.size;
  if (failure) return <div className="pdf-ref-empty" role="alert"><strong>Could not open</strong><span>{failure}</span></div>;
  return <div className="pdf-ref-pages">
    {notes.size > 0 && <label className="toggle-row pdf-ref-notes-toggle"><span><strong>Bring my notes along</strong><small>Pages annotated in the document place their highlights and notes with them.</small></span><input type="checkbox" checked={withNotes} onChange={event => setWithNotes(event.target.checked)} /></label>}
    <ol ref={list}>{Array.from({ length: meta.pages }, (_, index) => index + 1).map(page => {
      const note = notes.get(page), [pw, ph] = pageSize(meta, page);
      return <li key={page} data-page={page} className={startPage === page ? 'is-target' : undefined}>
        <div className="pdf-ref-page" draggable={!!pdf} style={{ aspectRatio: `${pw || w} / ${ph || h}` }} title="Drag onto the board, or use Add to board"
          onDragStart={event => { event.dataTransfer.setData(PAGE_DRAG, JSON.stringify({ docId: doc.id, page, notes: withNotes })); event.dataTransfer.effectAllowed = 'copy'; }}>
          {pdf ? <Thumb doc={pdf} fileId={meta.fileId} page={page} width={width} show={shown.has(page)} /> : <span className="pdf-thumb-wait" aria-hidden />}
        </div>
        <div className="pdf-ref-page-foot">
          <span>Page {page}</span>
          {note && <span className="pdf-ref-page-notes" title={withNotes ? 'Its notes come along' : 'Notes stay behind'}><NotebookPen size={12} aria-hidden />{note.notes + note.highlights}</span>}
          <button className="pdf-ref-add" disabled={busy.has(page) || !pdf} onClick={() => void add(page)}>{busy.has(page) ? <Loader2 size={13} className="spinning" /> : <Plus size={13} />}Add to board</button>
        </div>
      </li>;
    })}</ol>
  </div>;
}
