import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { indexedHandwriting, type HandwritingIndex } from './handwriting-index';

export type BoardFindKind = 'text' | 'image' | 'handwriting' | 'cutout';
export interface BoardFindMatch {
  key: string; kind: BoardFindKind; text: string;
  /** Elements to select and frame when this match is shown. */
  targetIds: string[];
  x: number; y: number;
}

export const findTerms = (query: string) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

/**
 * Search typed text (including diagram and shape labels), recognized image
 * text, reviewed handwriting, and erased-text cutouts on one board. Matches
 * are ordered top-to-bottom, then left-to-right, so stepping through them
 * walks the board in reading order.
 */
export function findOnBoard(elements: readonly ExcalidrawElement[], imageText: ReadonlyMap<string, string>, query: string): BoardFindMatch[] {
  const terms = findTerms(query);
  if (!terms.length) return [];
  const visible = elements.filter(element => !element.isDeleted), byId = new Map(visible.map(element => [element.id, element]));
  const matches = (text: string) => { const lower = text.toLocaleLowerCase(); return terms.every(term => lower.includes(term)); };
  const result: BoardFindMatch[] = [];
  for (const element of visible) {
    if (element.customData?.noteRichTextRender) continue;
    if (element.type === 'text') {
      const text = element.originalText || element.text;
      if (!matches(text)) continue;
      // Labels are found through their shape or connection, which is what
      // the user selects and moves.
      const owner = element.containerId && byId.get(element.containerId);
      const target = owner || element;
      result.push({ key: element.id, kind: 'text', text, targetIds: [target.id], x: target.x, y: target.y });
    } else if (element.type === 'image') {
      const text = element.fileId ? imageText.get(element.fileId) || '' : '';
      if (text && matches(text)) result.push({ key: element.id, kind: 'image', text, targetIds: [element.id], x: element.x, y: element.y });
      const erased = element.customData?.noteErasedFrom;
      if (erased?.kind === 'Text' && typeof erased.label === 'string' && erased.label !== 'Text' && matches(erased.label) && !(text && matches(text)))
        result.push({ key: `${element.id}:cutout`, kind: 'cutout', text: erased.label, targetIds: [element.id], x: element.x, y: element.y });
    } else if (element.type === 'freedraw') {
      const text = indexedHandwriting(element, visible);
      if (!text || !matches(text)) continue;
      const strokes = (element.customData?.noteHandwriting as HandwritingIndex).strokeIds.flatMap(id => byId.get(id) || []);
      result.push({ key: element.id, kind: 'handwriting', text, targetIds: strokes.map(stroke => stroke.id),
        x: Math.min(...strokes.map(stroke => stroke.x)), y: Math.min(...strokes.map(stroke => stroke.y)) });
    }
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x || a.key.localeCompare(b.key));
}

/** A short excerpt around the first matching term, split for highlighting. */
export function findSnippet(text: string, query: string, radius = 32): { text: string; match: boolean }[] {
  const terms = findTerms(query), flat = text.replace(/\s+/g, ' ').trim(), lower = flat.toLocaleLowerCase();
  const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0), flat.length);
  const start = Math.max(0, first - radius), end = Math.min(flat.length, first + radius * 2);
  const excerpt = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  if (!terms.length) return [{ text: excerpt, match: false }];
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return excerpt.split(pattern).filter(Boolean).map(part => ({ text: part, match: terms.includes(part.toLocaleLowerCase()) }));
}
