import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PAGE_PIXEL_WIDTH } from './pdf-model';

type PdfJs = typeof import('pdfjs-dist');
let library: Promise<PdfJs> | null = null;
/** pdf.js loads only when a document is first opened; it parses and draws in a worker. */
export function pdfjs() {
  library ||= import('pdfjs-dist').then(module => { module.GlobalWorkerOptions.workerSrc = workerUrl; return module; }).catch(error => { library = null; throw error; });
  return library;
}
const assets = () => new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href;
async function load(data: Uint8Array) {
  const lib = await pdfjs(), base = assets();
  return lib.getDocument({ data, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` }).promise;
}

/** Open documents, most recently used last; older ones are closed to free their memory. */
const open = new Map<string, Promise<PDFDocumentProxy>>();
const MAX_OPEN = 4;
export function openPdf(fileId: string, read: () => Promise<Blob>): Promise<PDFDocumentProxy> {
  const existing = open.get(fileId);
  if (existing) { open.delete(fileId); open.set(fileId, existing); return existing; }
  const promise = read().then(blob => blob.arrayBuffer()).then(buffer => load(new Uint8Array(buffer)));
  open.set(fileId, promise);
  promise.catch(() => { if (open.get(fileId) === promise) open.delete(fileId); });
  while (open.size > MAX_OPEN) {
    const [oldest, doc] = open.entries().next().value!;
    open.delete(oldest); void doc.then(item => item.loadingTask.destroy()).catch(() => {});
  }
  return promise;
}
export function closePdf(fileId: string) { const doc = open.get(fileId); open.delete(fileId); void doc?.then(item => item.loadingTask.destroy()).catch(() => {}); }

export interface PdfInfo { pages: number; size: [number, number]; odd?: Record<string, [number, number]>; texts: string[] }
/** Page count, sizes, and the words of every page (read in order, reporting progress). */
export async function readPdf(data: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<PdfInfo> {
  const doc = await load(new Uint8Array(data.slice(0)));
  try {
    const texts: string[] = [], sizes: [number, number][] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push([Math.round(viewport.width * 100) / 100, Math.round(viewport.height * 100) / 100]);
      texts.push(textOf(await page.getTextContent()));
      page.cleanup();
      if (index % 4 === 0 || index === doc.numPages) { onProgress?.(index, doc.numPages); await new Promise(resolve => setTimeout(resolve)); }
    }
    const size = mostCommon(sizes);
    const odd: Record<string, [number, number]> = {};
    sizes.forEach((item, index) => { if (item[0] !== size[0] || item[1] !== size[1]) odd[String(index + 1)] = item; });
    return { pages: doc.numPages, size, ...(Object.keys(odd).length ? { odd } : {}), texts };
  } finally { void doc.loadingTask.destroy(); }
}
function mostCommon(sizes: [number, number][]): [number, number] {
  const counts = new Map<string, number>();
  for (const size of sizes) counts.set(size.join('x'), (counts.get(size.join('x')) || 0) + 1);
  const [best] = [...counts].sort((a, b) => b[1] - a[1])[0] || ['612x792'];
  return best.split('x').map(Number) as [number, number];
}
/** Words of a page in reading order, one line per text line. */
export function textOf(content: TextContent) {
  let text = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    text += item.str + (item.hasEOL ? '\n' : '');
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const texts = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextContent>>>();
export function pageTextContent(doc: PDFDocumentProxy, page: number) {
  let cache = texts.get(doc);
  if (!cache) { cache = new Map(); texts.set(doc, cache); }
  if (!cache.has(page)) cache.set(page, doc.getPage(page).then(item => item.getTextContent()));
  return cache.get(page)!;
}

/**
 * Draws a page into `canvas` at `cssWidth` (CSS pixels) for this screen's
 * pixel density. Returns a cancel function; a cancelled render resolves quietly.
 */
export function drawPage(doc: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, maxPixels = 16_000_000) {
  let task: RenderTask | null = null, cancelled = false, page: PDFPageProxy | null = null;
  const done = (async () => {
    page = await doc.getPage(pageNumber);
    if (cancelled) return;
    const base = page.getViewport({ scale: 1 });
    let scale = cssWidth / base.width * Math.min(window.devicePixelRatio || 1, 2.5);
    // Very large zooms stay within the browser's canvas limits.
    if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
    const viewport = page.getViewport({ scale });
    // Draw offscreen, then swap in one step so a re-render never flashes blank.
    const buffer = document.createElement('canvas');
    buffer.width = Math.floor(viewport.width); buffer.height = Math.floor(viewport.height);
    task = page.render({ canvas: buffer, viewport, background: '#ffffff' });
    try { await task.promise; } catch (error) { if (cancelled || (error as Error)?.name === 'RenderingCancelledException') return; throw error; }
    if (cancelled) return;
    canvas.width = buffer.width; canvas.height = buffer.height;
    canvas.getContext('2d')!.drawImage(buffer, 0, 0);
    buffer.width = buffer.height = 0;
  })();
  return { done, cancel: () => { cancelled = true; task?.cancel(); } };
}

/** A page as a crisp WebP picture for a board (1600 px wide, white background). */
export async function pagePicture(doc: PDFDocumentProxy, pageNumber: number, width = PAGE_PIXEL_WIDTH) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not draw this page.');
  return blob;
}

/** Small page pictures for lists and grids, kept for a while (at most 160). */
const thumbs = new Map<string, Promise<string>>();
export function pageThumb(fileId: string, doc: PDFDocumentProxy, page: number, width = 220) {
  const key = `${fileId}:${page}:${width}`;
  const existing = thumbs.get(key);
  if (existing) { thumbs.delete(key); thumbs.set(key, existing); return existing; }
  const promise = pagePicture(doc, page, Math.round(width * Math.min(window.devicePixelRatio || 1, 2))).then(blob => URL.createObjectURL(blob));
  thumbs.set(key, promise);
  promise.catch(() => thumbs.delete(key));
  while (thumbs.size > 160) { const [oldest, url] = thumbs.entries().next().value!; thumbs.delete(oldest); void url.then(URL.revokeObjectURL).catch(() => {}); }
  return promise;
}

/** Renders the selectable text of a page into `container`, laid out for `width` CSS pixels. */
export async function drawTextLayer(doc: PDFDocumentProxy, pageNumber: number, container: HTMLElement, width: number) {
  const lib = await pdfjs(), page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 }), scale = width / base.width;
  const viewport = page.getViewport({ scale });
  container.replaceChildren();
  container.style.setProperty('--total-scale-factor', String(scale));
  container.style.setProperty('--scale-round-x', '1px'); container.style.setProperty('--scale-round-y', '1px');
  const layer = new lib.TextLayer({ textContentSource: await pageTextContent(doc, pageNumber), container, viewport });
  await layer.render();
  const end = document.createElement('div'); end.className = 'endOfContent'; container.append(end);
  return layer;
}

/**
 * Keeps a drag over a page's words from jumping to select whole blocks.
 * Between words the pointer is over the layer itself, which browsers treat
 * as "the start or end of everything"; while selecting, a cover
 * (.endOfContent) sits under the words so gaps hit it instead, and on older
 * Chromium it follows the selection's moving end. Ported from pdf.js's
 * TextLayerBuilder (Apache-2.0). Returns a function that unbinds the layer.
 */
const selectionLayers = new Map<HTMLElement, HTMLElement>();
let selectionListeners: AbortController | null = null;
export function bindTextSelection(layer: HTMLElement): () => void {
  const end = layer.querySelector<HTMLElement>(':scope > .endOfContent');
  if (!end) return () => {};
  const start = () => layer.classList.add('selecting');
  layer.addEventListener('pointerdown', start);
  selectionLayers.set(layer, end);
  enableSelectionListeners();
  return () => {
    layer.removeEventListener('pointerdown', start);
    resetSelectionLayer(end, layer);
    selectionLayers.delete(layer);
    if (!selectionLayers.size) { selectionListeners?.abort(); selectionListeners = null; }
  };
}
function resetSelectionLayer(end: HTMLElement, layer: HTMLElement) {
  layer.append(end); end.style.width = ''; end.style.height = ''; end.style.userSelect = '';
  layer.classList.remove('selecting');
}
function enableSelectionListeners() {
  if (selectionListeners) return;
  selectionListeners = new AbortController();
  const { signal } = selectionListeners;
  const resetAll = () => selectionLayers.forEach(resetSelectionLayer);
  let pointerDown = false, modern: boolean | undefined, previous: Range | null = null;
  document.addEventListener('pointerdown', () => { pointerDown = true; }, { signal, capture: true });
  document.addEventListener('pointerup', () => { pointerDown = false; resetAll(); }, { signal });
  window.addEventListener('blur', () => { pointerDown = false; resetAll(); }, { signal });
  document.addEventListener('keyup', () => { if (!pointerDown) resetAll(); }, { signal });
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount) { resetAll(); return; }
    const active = new Set<HTMLElement>();
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (range.collapsed && !pointerDown) continue;
      for (const layer of selectionLayers.keys()) if (range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of selectionLayers) { if (active.has(layer)) layer.classList.add('selecting'); else resetSelectionLayer(end, layer); }
    // Firefox and Chromium 148+ stop at the cover on their own.
    if (modern === undefined) {
      const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
      modern = 'MozAppearance' in document.documentElement.style || (!!chromium && Number(chromium) >= 148);
    }
    if (modern || !active.size) return;
    const range = selection.getRangeAt(0);
    const moveStart = !!previous && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
    let anchor: Node | null = moveStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!moveStart && range.endOffset === 0 && anchor) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling || null;
      } while (anchor && !anchor.childNodes.length);
    }
    const layer = (anchor as Element | null)?.parentElement?.closest<HTMLElement>('.pdf-text-layer');
    const end = layer && selectionLayers.get(layer);
    if (anchor && layer && end && anchor.parentElement) {
      end.style.width = `${layer.offsetWidth}px`; end.style.height = `${layer.offsetHeight}px`; end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, moveStart ? anchor : anchor.nextSibling);
    }
    previous = range.cloneRange();
  }, { signal });
}
