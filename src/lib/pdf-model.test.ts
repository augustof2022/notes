import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { Board } from '../types';
import { annotationElements, attachedPage, boundToPage, copyPageNotes, excerpt, isLibraryItem, mergeLineRects, pageBoardsOf, pageHighlights, pageNotes, pageSceneSize, pageSize } from './pdf-model';
import { searchBoards } from './search';
import { recordData, sameSyncedContent, withLocalView } from './sync-merge';
import { documentAnchor, documentContext, noteText, objectContent } from './ask-ai-scene';

const element = (fields: Record<string, unknown>) => ({ isDeleted: false, groupIds: [], boundElements: null, x: 0, y: 0, width: 10, height: 10, angle: 0, customData: undefined, ...fields }) as unknown as ExcalidrawElement;
const page = element({ id: 'page', type: 'image', fileId: 'picture', x: -400, y: -500, width: 800, height: 1000, locked: true,
  customData: { notePdfPage: { docId: 'doc', fileId: 'pdf-1', page: 3, name: 'Biology', text: 'Rubisco fixes carbon dioxide.', size: [612, 765] } } });
const highlight = (id: string, y: number, group = 'g1') => element({ id, type: 'rectangle', x: -300, y, width: 200, height: 14, groupIds: [group],
  customData: { notePdfHighlight: { pageId: 'page', docId: 'doc', page: 3, text: 'Rubisco fixes', color: 'green' } } });
const board = (fields: Partial<Board>): Board => ({ key: `s:${fields.id}`, scope: 's', name: 'Board', folderId: null, elements: [], appState: {}, assetIds: [], preview: null, updatedAt: '2026-01-01T00:00:00Z', deleted: false, dirty: false, remoteRevision: 0, id: 'x', ...fields });

describe('document pages and notes', () => {
  it('keeps page proportions at the standard width, with odd-sized pages', () => {
    const meta = { size: [612, 792] as [number, number], odd: { '2': [792, 612] as [number, number] } };
    expect(pageSize(meta, 1)).toEqual([612, 792]);
    expect(pageSize(meta, 2)).toEqual([792, 612]);
    expect(pageSceneSize([612, 792])).toEqual({ width: 800, height: 1035 });
  });
  it('counts a multi-line highlight once, and notes apart from their labels and lines', () => {
    const notes = pageNotes([page, highlight('h1', 0), highlight('h2', 16), element({ id: 'text', type: 'text', text: 'my idea', originalText: 'my idea' }), element({ id: 'arrow', type: 'arrow' }), element({ id: 'gone', type: 'text', text: 'x', isDeleted: true })]);
    expect(notes).toMatchObject({ notes: 1, highlights: 1 });
    expect(notes.text).toContain('my idea');
    expect(annotationElements([page, highlight('h1', 0)]).map(item => item.id)).toEqual(['h1']);
  });
  it('places highlights over the page as fractions of it', () => {
    const [mark] = pageHighlights([page, highlight('h1', -500 + 250, 'solo')]);
    expect(mark).toMatchObject({ left: 0.125, top: 0.25, width: 0.25, fill: '#86efac' });
  });
  it('merges selected word boxes into one box per line', () => {
    const lines = mergeLineRects([{ left: 10, top: 100, width: 40, height: 12 }, { left: 52, top: 101, width: 30, height: 11 }, { left: 10, top: 118, width: 50, height: 12 }, { left: 0, top: 0, width: 0, height: 0 }], 0);
    expect(lines).toEqual([{ x: 10, y: 100, width: 72, height: 12 }, { x: 10, y: 118, width: 50, height: 12 }]);
  });
  it('copies a page board’s notes next to a newly placed page, with every link kept', () => {
    let n = 0;
    const note = element({ id: 'note', type: 'rectangle', x: 450, y: -480, groupIds: ['grp'], boundElements: [{ id: 'label', type: 'text' }, { id: 'line', type: 'arrow' }], customData: { noteAi: { parentId: 'page', role: 'answer' } } });
    const label = element({ id: 'label', type: 'text', containerId: 'note', groupIds: ['grp'] });
    const line = element({ id: 'line', type: 'arrow', startBinding: { elementId: 'page', focus: 0, gap: 4 }, endBinding: { elementId: 'note', focus: 0, gap: 4 } });
    const copies = copyPageNotes([page, highlight('h1', 0), note, label, line], 'page', 'new-page', { x: 1000, y: 200 }, () => `id${++n}`);
    expect(copies).toHaveLength(4);
    const byOld = (old: string) => copies[[highlight('h1', 0), note, label, line].findIndex(item => item.id === old)];
    const [h, copiedNote, copiedLabel, copiedLine] = ['h1', 'note', 'label', 'line'].map(byOld) as any[];
    expect(new Set(copies.map(item => item.id)).size).toBe(4);
    expect(copiedNote.x).toBe(1450);
    expect(copiedNote.customData.noteAi.parentId).toBe('new-page');
    expect(copiedLabel.containerId).toBe(copiedNote.id);
    expect(copiedLabel.groupIds[0]).toBe(copiedNote.groupIds[0]);
    expect(copiedLabel.groupIds[0]).not.toBe('grp');
    expect(copiedLine.startBinding.elementId).toBe('new-page');
    expect(copiedLine.endBinding.elementId).toBe(copiedNote.id);
    expect(copiedNote.boundElements.map((item: { id: string }) => item.id)).toEqual([copiedLabel.id, copiedLine.id]);
    expect(h.customData.notePdfHighlight.pageId).toBe('new-page');
    expect(attachedPage(h)).toBe('new-page');
    expect(attachedPage(copiedNote)).toBe('new-page');
    expect(boundToPage(copies, 'new-page')).toEqual([{ id: copiedLine.id, type: 'arrow' }]);
  });
  it('finds the newest page board for each page, ignoring deleted ones', () => {
    const pages = pageBoardsOf([
      board({ id: 'a', appState: { notePdfPage: { docId: 'doc', page: 2 } }, updatedAt: '2026-01-01' }),
      board({ id: 'b', appState: { notePdfPage: { docId: 'doc', page: 2 } }, updatedAt: '2026-02-01' }),
      board({ id: 'c', appState: { notePdfPage: { docId: 'doc', page: 4 } }, deleted: true }),
      board({ id: 'd', appState: { notePdfPage: { docId: 'other', page: 1 } } }),
    ], 'doc');
    expect([...pages.keys()]).toEqual([2]);
    expect(pages.get(2)!.id).toBe('b');
  });
  it('keeps page boards and board-only references out of the library', () => {
    expect(isLibraryItem(board({ id: 'p', appState: { notePdfPage: { docId: 'doc', page: 1 } } }))).toBe(false);
    expect(isLibraryItem(board({ id: 'r', appState: { notePdf: { fileId: 'f', pages: 2, fileName: 'a.pdf', bytes: 1, source: 'pdf', size: [1, 1], boardId: 'host' } } }))).toBe(false);
    expect(isLibraryItem(board({ id: 'l', appState: { notePdf: { fileId: 'f', pages: 2, fileName: 'a.pdf', bytes: 1, source: 'pdf', size: [1, 1] } } }))).toBe(true);
  });
  it('trims excerpts around the first match', () => {
    expect(excerpt(`${'a '.repeat(200)}needle ${'b '.repeat(200)}`, ['needle'], 10)).toMatch(/^….*needle.*…$/);
  });
});

describe('documents in search, sync and Explain/Ask', () => {
  const doc = board({ id: 'doc', name: 'Biology', appState: { notePdf: { fileId: 'pdf-1', pages: 3, fileName: 'bio.pdf', bytes: 1, source: 'pdf', size: [612, 792] } } });
  const notes = board({ id: 'pb', name: 'Biology · page 3', appState: { notePdfPage: { docId: 'doc', page: 3 } }, elements: [page, element({ id: 't', type: 'text', text: 'chloroplast idea' })] });
  const host = board({ id: 'host', name: 'Study', elements: [element({ ...page, id: 'placed' })] });
  const privateRef = board({ id: 'ref', name: 'Private', appState: { notePdf: { fileId: 'pdf-2', pages: 1, fileName: 'p.pdf', bytes: 1, source: 'pdf', size: [1, 1], boardId: 'host' } } });
  const texts = new Map([['pdf-1', ['intro', 'middle', 'Rubisco fixes carbon']], ['pdf-2', ['Rubisco private']]]);
  it('finds document pages, notes on a page board, and pages placed on boards', () => {
    const found = searchBoards([doc, notes, host, privateRef], [], [], 'rubisco', null, texts);
    expect(found.map(item => [item.board.id, item.kind, item.page, item.elementId])).toEqual(expect.arrayContaining([['doc', 'pdf', 3, undefined], ['host', 'pdf', undefined, 'placed']]));
    expect(found.some(item => item.board.id === 'ref' || item.board.id === 'pb')).toBe(false);
    const idea = searchBoards([doc, notes], [], [], 'chloroplast', null, texts);
    expect(idea).toMatchObject([{ kind: 'pdf-notes', page: 3, title: 'Biology · page 3' }]);
    expect(searchBoards([{ ...doc, deleted: true }, notes], [], [], 'chloroplast', null, texts)).toEqual([]);
  });
  it('syncs document details and board references as shared content', () => {
    const local = board({ id: 'host', appState: { noteReferences: ['doc'], zoom: { value: 2 } as never } });
    expect(sameSyncedContent(local, board({ id: 'host', appState: { noteReferences: ['doc'], zoom: { value: 1 } as never } }))).toBe(true);
    expect(sameSyncedContent(local, board({ id: 'host', appState: {} }))).toBe(false);
    const remote = board({ id: 'host', appState: { noteReferences: ['doc', 'other'] } });
    expect(withLocalView(remote, local).appState).toMatchObject({ noteReferences: ['doc', 'other'], zoom: { value: 2 } });
    expect(recordData(doc).app_state).toMatchObject({ notePdf: { fileId: 'pdf-1' } });
  });
  it('gives Explain/Ask the words of highlights and pages, the page as context, and a place beside the page', () => {
    const mark = highlight('h1', -300, 'solo');
    expect(noteText(mark)).toBe('Rubisco fixes');
    expect(objectContent([page, mark], [mark], {}).text).toBe('Rubisco fixes');
    expect(objectContent([page], [page], {}).text).toBe('Rubisco fixes carbon dioxide.');
    expect(documentContext([page, mark], mark)).toContain('“Biology”, page 3');
    expect(documentAnchor([page, mark], mark)).toEqual({ x: -400, y: -300, width: 800 });
  });
});
