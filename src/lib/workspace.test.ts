import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db, newBoard, newFolder, descendantFolderIds, canMoveFolder, folderPath, loadWorkspace, trashFolder } from './db';
import { searchBoards } from './search';
import { preserveConflict } from './sync';
import type { Asset, Board, Folder } from '../types';
import { recordKey } from '../types';
afterEach(async () => { await Promise.all([db.folders.clear(), db.boards.clear(), db.assets.clear()]); });
describe('workspace hierarchy and scoped search', () => {
  it('finds nested folders at any depth and rejects moving a folder into its descendants', async () => {
    const parent = await newFolder('local', 'Parent', null);
    const child = await newFolder('local', 'Child', parent.id);
    const grandchild = await newFolder('local', 'Grandchild', child.id);
    const unrelated = await newFolder('local', 'Other', null);
    const folders = [parent, child, grandchild, unrelated];
    expect([...descendantFolderIds(folders, parent.id)]).toEqual([parent.id, child.id, grandchild.id]);
    expect(canMoveFolder(folders, parent.id, grandchild.id)).toBe(false);
    expect(canMoveFolder(folders, parent.id, parent.id)).toBe(false);
    expect(canMoveFolder(folders, child.id, unrelated.id)).toBe(true);
    expect(folderPath(folders, grandchild.id).map(x => x.name)).toEqual(['Parent', 'Child', 'Grandchild']);
  });
  it('searches board titles, typed content, and OCR in descendants while excluding other folders', async () => {
    const parent = await newFolder('local', 'Projects', null);
    const child = await newFolder('local', 'Deep research', parent.id);
    const other = await newFolder('local', 'Other', null);
    const title = await newBoard('local', 'Canvas research', parent.id);
    const typed = await newBoard('local', 'Notes', child.id);
    const screenshot = await newBoard('local', 'Screenshots', child.id);
    const outside = await newBoard('local', 'Canvas outside', other.id);
    const trashed = { ...title, deleted: true };
    typed.elements = [{ id: 'text', type: 'text', text: 'Canvas research findings', isDeleted: false }, { id: 'deleted', type: 'text', text: 'secretword', isDeleted: true }] as unknown as Board['elements'];
    screenshot.elements = [{ id: 'image', type: 'image', fileId: 'file', isDeleted: false }] as unknown as Board['elements'];
    const asset = { id: 'file', ocrText: 'CANVAS RESEARCH from a screenshot' } as Asset;
    const matches = searchBoards([title, typed, screenshot, outside, trashed], [parent, child, other], [asset], 'canvas research', parent.id);
    expect(matches).toHaveLength(3);
    expect(matches.map(x => x.kind).sort()).toEqual(['image', 'text', 'title']);
    expect(matches.find(x => x.kind === 'image')?.elementId).toBe('image');
    expect(searchBoards([typed], [parent, child], [], 'secretword', null)).toHaveLength(0);
    expect(searchBoards([outside], [parent, child, other], [], 'canvas', parent.id)).toHaveLength(0);
    expect(searchBoards([outside], [parent, child, other], [], 'canvas', null)).toHaveLength(1);
  });
  it('keeps local boards separate from signed-in accounts', async () => {
    await newBoard('local', 'Private device board', null);
    await newBoard('user-a', 'Account A', null);
    await newBoard('user-b', 'Account B', null);
    expect((await loadWorkspace('user-a')).boards.map(x => x.name)).toEqual(['Account A']);
    expect((await loadWorkspace('local')).boards.map(x => x.name)).toEqual(['Private device board']);
  });
  it('soft-deletes the subtree without deleting an unrelated board', async () => {
    const root = await newFolder('local', 'Root', null);
    const child = await newFolder('local', 'Child', root.id);
    const board = await newBoard('local', 'Inside', child.id);
    const outside = await newBoard('local', 'Outside', null);
    await trashFolder('local', root.id);
    expect((await loadWorkspace('local')).boards.map(x => x.id)).toEqual([outside.id]);
    expect((await db.boards.get(board.key))?.deleted).toBe(true);
    expect(await db.boards.count()).toBe(2);
  });
  it('preserves local board contents and image references in a conflict copy', async () => {
    const original = await newBoard('user-a', 'My board', null);
    original.assetIds = ['image']; original.remoteRevision = 3;
    original.elements = [{ id: 'text', type: 'text', text: 'Unsynced local work' }] as unknown as Board['elements'];
    const copy = preserveConflict(original);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('My board (conflict copy)');
    expect(copy.elements).toEqual(original.elements);
    expect(copy.assetIds).toEqual(['image']);
    expect(copy.remoteRevision).toBe(0);
    expect(copy.dirty).toBe(true);
    expect(copy.key).toBe(recordKey('user-a', copy.id));
  });
  it('handles malformed cycles without hanging when computing folder paths', () => {
    const folders = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }] as Folder[];
    expect(folderPath(folders, 'a')).toHaveLength(2);
    expect(descendantFolderIds(folders, 'a').size).toBe(2);
  });
});
