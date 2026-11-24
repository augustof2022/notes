import type { Asset, Board, Folder, SearchMatch } from '../types';
import { descendantFolderIds } from './db';
import { indexedHandwriting } from './handwriting-index';
import { excerpt, pageObject, pdfDoc, pdfPageRef } from './pdf-model';

/**
 * Board names, typed notes, image and handwriting text, and documents: the
 * words of every page (`pdfText`, by file id), notes made on a page's own
 * board, and pages placed on boards. Board-only references stay private to
 * their board and are searched from its reference bar instead.
 */
export function searchBoards(boards: Board[], folders: Folder[], assets: Asset[], query: string, folderId: string | null, pdfText: ReadonlyMap<string, readonly string[]> = new Map()): SearchMatch[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const inScope = descendantFolderIds(folders, folderId);
  const match = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term));
  const result: SearchMatch[] = [];
  const images = new Map(assets.map(x => [x.id, x]));
  const docs = new Map(boards.filter(board => pdfDoc(board)).map(board => [board.id, board]));
  for (const board of boards) {
    if (board.deleted || (folderId && (!board.folderId || !inScope.has(board.folderId)))) continue;
    const doc = pdfDoc(board), ref = pdfPageRef(board);
    if (doc?.boardId) continue;
    if (doc) {
      if (match(board.name)) result.push({ board, text: board.name, kind: 'title' });
      let hits = 0;
      for (const [index, text] of (pdfText.get(doc.fileId) || []).entries()) {
        if (hits >= 25) break;
        if (text && match(text)) { result.push({ board, page: index + 1, text: excerpt(text, terms), kind: 'pdf' }); hits++; }
      }
      continue;
    }
    const parent = ref && docs.get(ref.docId);
    if (ref && (!parent || parent.deleted)) continue;
    if (!ref && match(board.name)) result.push({ board, text: board.name, kind: 'title' });
    const notes = ref ? { kind: 'pdf-notes' as const, page: ref.page, title: `${parent!.name} · page ${ref.page}` } : null;
    for (const element of board.elements) {
      if (element.isDeleted) continue;
      const page = pageObject(element);
      if (page) {
        // A page's own board: the document's search already covers its words.
        if (!ref && page.text && match(page.text)) result.push({ board, elementId: element.id, text: excerpt(page.text, terms), kind: 'pdf', title: `${board.name} · ${page.name}, page ${page.page}` });
        continue;
      }
      const highlight = element.customData?.notePdfHighlight?.text;
      if (typeof highlight === 'string' && highlight && match(highlight)) { result.push({ board, elementId: element.id, text: highlight, ...(notes || { kind: 'text' as const }) }); continue; }
      if (element.type === 'text' && match(element.text)) result.push({ board, elementId: element.id, text: element.text, ...(notes || { kind: 'text' as const }) });
      if (element.type === 'freedraw') {
        const text = indexedHandwriting(element, board.elements);
        if (text && match(text)) result.push({ board, elementId: element.id, text, ...(notes || { kind: 'handwriting' as const }) });
      }
      if (element.type === 'image' && element.fileId) {
        const text = images.get(element.fileId)?.ocrText || '';
        if (text && match(text)) result.push({ board, elementId: element.id, text, ...(notes || { kind: 'image' as const }) });
      }
    }
  }
  return result.sort((a, b) => b.board.updatedAt.localeCompare(a.board.updatedAt));
}
