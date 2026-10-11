import type { Asset, Board, Folder, SearchMatch } from '../types';
import { descendantFolderIds } from './db';
import { indexedHandwriting } from './handwriting-index';

export function searchBoards(boards: Board[], folders: Folder[], assets: Asset[], query: string, folderId: string | null): SearchMatch[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const inScope = descendantFolderIds(folders, folderId);
  const match = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term));
  const result: SearchMatch[] = [];
  const images = new Map(assets.map(x => [x.id, x]));
  for (const board of boards) {
    if (board.deleted || (folderId && (!board.folderId || !inScope.has(board.folderId)))) continue;
    if (match(board.name)) result.push({ board, text: board.name, kind: 'title' });
    for (const element of board.elements) {
      if (element.isDeleted) continue;
      if (element.type === 'text' && match(element.text)) result.push({ board, elementId: element.id, text: element.text, kind: 'text' });
      if (element.type === 'freedraw') {
        const text = indexedHandwriting(element, board.elements);
        if (text && match(text)) result.push({ board, elementId: element.id, text, kind: 'handwriting' });
      }
      if (element.type === 'image' && element.fileId) {
        const text = images.get(element.fileId)?.ocrText || '';
        if (text && match(text)) result.push({ board, elementId: element.id, text, kind: 'image' });
      }
    }
  }
  return result.sort((a, b) => b.board.updatedAt.localeCompare(a.board.updatedAt));
}
