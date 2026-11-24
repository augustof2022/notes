import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { Asset, Board, PdfDocMeta, PdfPageRef } from '../types';

export const PDF_MIME = 'application/pdf';
/** Dispatched on the board root with `{ elementId }` to select words on a page picture. */
export const PDF_TEXT_EVENT = 'note-pdf-text';
export const isPdfAsset = (asset: Pick<Asset, 'mimeType'> | undefined) => asset?.mimeType === PDF_MIME;

/** Width of a document page on a board, in scene units; its picture is rendered at twice this. */
export const PAGE_SCENE_WIDTH = 800;
export const PAGE_PIXEL_WIDTH = 1600;
/** Page words kept on a page object, for search and Explain/Ask without opening the PDF. */
export const MAX_PAGE_TEXT = 12000;
export const HIGHLIGHT_COLORS = [
  { id: 'yellow', fill: '#fde047', label: 'Yellow' },
  { id: 'green', fill: '#86efac', label: 'Green' },
  { id: 'blue', fill: '#93c5fd', label: 'Blue' },
  { id: 'pink', fill: '#f9a8d4', label: 'Pink' },
] as const;
export type HighlightColor = typeof HIGHLIGHT_COLORS[number]['id'];

/** Kept on the picture of a page placed on a board. */
export interface PageObjectData { docId: string; fileId: string; page: number; name: string; text: string; size: [number, number] }
/** Kept on each highlight rectangle; a multi-line highlight is one group. */
export interface HighlightData { pageId: string; docId: string; page: number; text: string; color: HighlightColor }

export const pdfDoc = (board: Pick<Board, 'appState'> | undefined): PdfDocMeta | null => {
  const meta = board?.appState?.notePdf;
  return meta && typeof meta.fileId === 'string' && Number.isInteger(meta.pages) && meta.pages > 0 ? meta : null;
};
export const pdfPageRef = (board: Pick<Board, 'appState'> | undefined): PdfPageRef | null => {
  const ref = board?.appState?.notePdfPage;
  return ref && typeof ref.docId === 'string' && Number.isInteger(ref.page) && ref.page > 0 ? ref : null;
};
/** Library documents: documents that are not private to one board. */
export const isLibraryDoc = (board: Board) => !!pdfDoc(board) && !pdfDoc(board)!.boardId;
/** What the library shows as a board or document: not page annotation boards, not board-only references. */
export const isLibraryItem = (board: Board) => !pdfPageRef(board) && !pdfDoc(board)?.boardId;
export const isPlainBoard = (board: Board) => !pdfPageRef(board) && !pdfDoc(board);

export function pageSize(meta: Pick<PdfDocMeta, 'size' | 'odd'>, page: number): [number, number] {
  const odd = meta.odd?.[String(page)];
  return odd && odd[0] > 0 && odd[1] > 0 ? odd : meta.size;
}
/** A page's size on a board, keeping its proportions at the standard width. */
export function pageSceneSize(size: [number, number], width = PAGE_SCENE_WIDTH) {
  return { width, height: Math.round(width * size[1] / size[0]) };
}

export const pageObject = (element: ExcalidrawElement | undefined): PageObjectData | null => {
  const data = element?.customData?.notePdfPage;
  return element && !element.isDeleted && element.type === 'image' && data && typeof data.docId === 'string' && Number.isInteger(data.page) ? data as PageObjectData : null;
};
export const highlightData = (element: ExcalidrawElement | undefined): HighlightData | null => {
  const data = element?.customData?.notePdfHighlight;
  return element && !element.isDeleted && data && typeof data.pageId === 'string' && typeof data.text === 'string' ? data as HighlightData : null;
};
/** The page an annotation follows when its page is moved (highlights and notes brought from an annotated page). */
export const attachedPage = (element: ExcalidrawElement): string | null =>
  highlightData(element)?.pageId || (typeof element.customData?.notePdfAttach === 'string' ? element.customData.notePdfAttach : null);

/** The page annotation boards of a document, by page number (the most recently edited wins a duplicate). */
export function pageBoardsOf(boards: readonly Board[], docId: string) {
  const pages = new Map<number, Board>();
  for (const board of boards) {
    const ref = pdfPageRef(board);
    if (!ref || ref.docId !== docId || board.deleted) continue;
    const existing = pages.get(ref.page);
    if (!existing || existing.updatedAt < board.updatedAt) pages.set(ref.page, board);
  }
  return pages;
}

/** Elements a person added on a page board: everything but the page itself and derived formatted-text previews. */
export function annotationElements(elements: readonly ExcalidrawElement[]) {
  return elements.filter(element => !element.isDeleted && !pageObject(element) && !element.customData?.noteRichTextRender);
}
export interface PageNotes { notes: number; highlights: number; text: string; marks?: ReturnType<typeof pageHighlights> }
/** What a page board holds, for its badge and for search: highlights, other notes, and their words. */
export function pageNotes(elements: readonly ExcalidrawElement[]): PageNotes {
  let notes = 0, highlights = 0; const words: string[] = []; const groups = new Set<string>();
  for (const element of annotationElements(elements)) {
    const highlight = highlightData(element);
    if (highlight) {
      const group = element.groupIds?.at(-1);
      if (group && groups.has(group)) continue;
      if (group) groups.add(group);
      highlights++; words.push(highlight.text); continue;
    }
    if (element.type === 'text') { words.push(element.originalText || element.text); if (!element.containerId) notes++; continue; }
    if (['arrow', 'line'].includes(element.type)) continue;
    notes++;
  }
  return { notes, highlights, text: words.join('\n') };
}

/** Lines of selected text as client rectangles, merged into one box per line (with a little air). */
export function mergeLineRects(rects: readonly { left: number; top: number; width: number; height: number }[], pad = 1.5) {
  const usable = rects.filter(rect => rect.width > 0.5 && rect.height > 0.5).map(rect => ({ left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const rect of usable) {
    const height = rect.bottom - rect.top;
    const line = lines.find(item => {
      const overlap = Math.min(item.bottom, rect.bottom) - Math.max(item.top, rect.top);
      return overlap > Math.min(height, item.bottom - item.top) * 0.5 && rect.left <= item.right + height * 1.5 && rect.right >= item.left - height * 1.5;
    });
    if (line) { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); line.top = Math.min(line.top, rect.top); line.bottom = Math.max(line.bottom, rect.bottom); }
    else lines.push({ ...rect });
  }
  return lines.map(line => ({ x: line.left - pad, y: line.top - pad, width: line.right - line.left + pad * 2, height: line.bottom - line.top + pad * 2 }));
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
/**
 * Copies a page board's notes onto another board, next to a newly placed
 * copy of that page: every id is new, links between the copied notes are
 * kept (groups, labels, bound lines, AI threads), links to the old page point
 * at the new one, and each note follows the new page when it is moved.
 */
export function copyPageNotes(elements: readonly ExcalidrawElement[], fromPageId: string, toPageId: string, offset: { x: number; y: number }, newId: () => string = () => crypto.randomUUID()) {
  const source = annotationElements(elements).concat(elements.filter(element => !element.isDeleted && element.customData?.noteRichTextRender && !pageObject(element)));
  const ids = new Map<string, string>([[fromPageId, toPageId]]);
  for (const element of source) ids.set(element.id, newId());
  const groups = new Map<string, string>();
  const group = (id: string) => { if (!groups.has(id)) groups.set(id, newId()); return groups.get(id)!; };
  // Any string in customData that names a copied element (or the old page) is a link: point it at the copy.
  const remap = (value: unknown): unknown => typeof value === 'string' ? ids.get(value) ?? value
    : Array.isArray(value) ? value.map(remap)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)])) : value;
  const copies: ExcalidrawElement[] = [];
  for (const element of source) {
    const copy = structuredClone(element) as Writable<ExcalidrawElement> & Record<string, any>;
    copy.id = ids.get(element.id)!;
    copy.x += offset.x; copy.y += offset.y;
    copy.groupIds = element.groupIds.map(group);
    copy.frameId = null;
    copy.seed = Math.floor(Math.random() * 2 ** 31);
    copy.versionNonce = Math.floor(Math.random() * 2 ** 31);
    copy.boundElements = element.boundElements?.filter(bound => ids.has(bound.id)).map(bound => ({ ...bound, id: ids.get(bound.id)! })) || null;
    if ('containerId' in element && element.containerId) copy.containerId = ids.get(element.containerId) ?? null;
    for (const end of ['startBinding', 'endBinding'] as const) {
      const binding = (element as any)[end];
      if (binding?.elementId) copy[end] = ids.has(binding.elementId) ? { ...binding, elementId: ids.get(binding.elementId) } : null;
    }
    copy.customData = { ...(remap(element.customData || {}) as Record<string, unknown>), ...(highlightData(element) ? {} : { notePdfAttach: toPageId }) };
    copies.push(copy);
  }
  return copies;
}

/** Lines bound to the old page that were copied: the new page lists them as bound, like the old one did. */
export function boundToPage(copies: readonly ExcalidrawElement[], pageId: string) {
  return copies.filter(element => ['arrow', 'line'].includes(element.type) && [(element as any).startBinding?.elementId, (element as any).endBinding?.elementId].includes(pageId))
    .map(element => ({ id: element.id, type: element.type as 'arrow' }));
}

/** Search terms in reading order, lower-cased. */
export const searchTerms = (query: string) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
/** A short excerpt of `text` around the first term, for a result line. */
export function excerpt(text: string, terms: readonly string[], radius = 90) {
  const flat = text.replace(/\s+/g, ' ').trim(), lower = flat.toLocaleLowerCase();
  const at = Math.max(0, ...terms.map(term => lower.indexOf(term)).filter(index => index >= 0).slice(0, 1));
  const start = Math.max(0, at - radius), end = Math.min(flat.length, at + radius * 2);
  return `${start ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
export const matchesAll = (text: string, terms: readonly string[]) => { const lower = text.toLocaleLowerCase(); return terms.every(term => lower.includes(term)); };

/** Highlights on a page board as fractions of the page, to show them over the page while reading. */
export function pageHighlights(elements: readonly ExcalidrawElement[]) {
  const page = elements.find(element => pageObject(element));
  if (!page || !page.width || !page.height) return [];
  return elements.flatMap(element => {
    const data = highlightData(element);
    if (!data || data.pageId !== page.id) return [];
    const fill = HIGHLIGHT_COLORS.find(item => item.id === data.color)?.fill || HIGHLIGHT_COLORS[0].fill;
    return [{ id: element.id, left: (element.x - page.x) / page.width, top: (element.y - page.y) / page.height, width: element.width / page.width, height: element.height / page.height, fill }];
  });
}
