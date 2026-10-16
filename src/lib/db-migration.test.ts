import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { expect, it } from 'vitest';
import { db, touch } from './db';

it('upgrades an existing library without losing notes or changing creation dates on edit', async () => {
  const legacy = new Dexie('note-canvas-v1');
  legacy.version(1).stores({ folders: '&key, scope, id, parentId', boards: '&key, scope, id, folderId', assets: '&key, scope, id' });
  const date = '2025-01-02T00:00:00Z';
  await legacy.table('folders').put({ key: 'local:folder', id: 'folder', scope: 'local', name: 'Existing folder', parentId: null, updatedAt: date });
  await legacy.table('boards').put({ key: 'local:board', id: 'board', scope: 'local', name: 'Existing note', folderId: 'folder', elements: [{ id: 'text', type: 'text', text: 'Keep my notes' }], updatedAt: date });
  legacy.close();
  try {
    const board = await db.boards.get('local:board');
    expect(board?.createdAt).toBe(date);
    expect(board?.elements[0]).toMatchObject({ text: 'Keep my notes' });
    expect((await db.folders.get('local:folder'))?.createdAt).toBe(date);
    await db.boards.update('local:board', { ...touch(), name: 'Edited note' });
    expect((await db.boards.get('local:board'))?.createdAt).toBe(date);
  } finally { await db.delete(); }
});
