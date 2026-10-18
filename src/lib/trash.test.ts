import 'fake-indexeddb/auto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { db, newBoard, newFolder, touch, trashFolder } from './db';
import { emptyTrash, needsTrashUpgrade, permanentDelete, trashErrorMessage, trashSelection } from './trash';

afterEach(async () => {
  await Promise.all([db.boards.clear(), db.folders.clear(), db.assets.clear()]); vi.unstubAllGlobals();
});
it('deletes only the selected local Trash subtree, retaining shared images and unrelated records', async () => {
  const root = await newFolder('local', 'Root', null), child = await newFolder('local', 'Child', root.id);
  const removed = await newBoard('local', 'Removed', child.id), kept = await newBoard('local', 'Kept', null);
  await db.boards.update(removed.key, { assetIds: ['shared'] }); await db.boards.update(kept.key, { assetIds: ['shared'] });
  await db.assets.put({ key: 'local:shared', scope: 'local', id: 'shared', mimeType: 'image/png', created: 1, storage: null, remotePath: null, ocrStatus: 'done', ocrText: '', dirty: true, dataURL: 'data:image/png;base64,AA==' });
  await trashFolder('local', root.id);
  const selected = await trashSelection('local', { kind: 'folder', id: root.id });
  expect(selected.folders).toHaveLength(2); expect(selected.boards).toHaveLength(1);
  await permanentDelete('local', selected, null);
  expect(await db.folders.count()).toBe(0); expect((await db.boards.toArray()).map(item => item.id)).toEqual([kept.id]);
  expect(await db.assets.count()).toBe(1);
});
it('rejects local restored or newly added descendants after the user reviewed a selection', async () => {
  const root = await newFolder('local', 'Root', null), original = await newBoard('local', 'Original', root.id);
  await trashFolder('local', root.id);
  const selected = await trashSelection('local', { kind: 'folder', id: root.id });
  const added = await newBoard('local', 'Added while confirmation open', root.id);
  await expect(permanentDelete('local', selected, null)).rejects.toThrow('Trash changed');
  expect(await db.boards.get(original.key)).toBeDefined();
  await db.boards.delete(added.key); await db.boards.update(original.key, { deleted: false, ...touch() });
  await expect(permanentDelete('local', selected, null)).rejects.toThrow('Trash changed');
});
it('empty Trash keeps active boards, other accounts, and existing server tombstones', async () => {
  const active = await newBoard('local', 'Active', null), removed = await newBoard('local', 'Removed', null), other = await newBoard('other', 'Other', null), tombstone = await newBoard('local', 'Deleted board', null);
  await db.boards.update(removed.key, { deleted: true }); await db.boards.update(tombstone.key, { deleted: true, purged: true });
  await emptyTrash('local', null);
  expect((await db.boards.toArray()).map(item => item.id).sort()).toEqual([active.id, other.id, tombstone.id].sort());
});
it('replaces cloud-deleted content with private tombstones and clears local conflict snapshots', async () => {
  const board = await newBoard('owner', 'Confidential', null);
  await db.boards.update(board.key, { deleted: true, remoteRevision: 3, dirty: false, assetIds: ['image'], syncError: 'old', syncBase: { name: 'old' } as any, syncConflict: {} as any });
  const rpc = vi.fn(async () => ({ data: { folders: [], boards: [{ id: board.id, owner_id: 'owner', name: 'Deleted board', deleted: true, purged: true, revision: 4, updated_at: '2026-10-18T00:00:00Z' }] }, error: null }));
  await permanentDelete('owner', await trashSelection('owner'), { rpc } as unknown as SupabaseClient);
  expect(rpc).toHaveBeenCalledWith('purge_note_trash', { p_folders: [], p_boards: [{ id: board.id, revision: 3 }] });
  expect(await db.boards.get(board.key)).toMatchObject({ purged: true, deleted: true, dirty: false, name: 'Deleted board', remoteRevision: 4, elements: [], appState: {}, assetIds: [], preview: null, syncError: undefined, syncBase: undefined, syncConflict: undefined });
});
it('keeps Trash intact on missing SQL, offline devices, malformed responses, and account switches', async () => {
  const board = await newBoard('owner', 'Keep safely', null); await db.boards.update(board.key, { deleted: true });
  const selection = await trashSelection('owner');
  vi.stubGlobal('navigator', { onLine: false });
  await expect(permanentDelete('owner', selection, { rpc: vi.fn() } as any)).rejects.toThrow('Connect to the internet');
  vi.stubGlobal('navigator', { onLine: true });
  const error = { code: 'PGRST202', message: 'Could not find public.purge_note_trash in schema cache' };
  await expect(permanentDelete('owner', selection, { rpc: vi.fn(async () => ({ error })) } as any)).rejects.toEqual(error);
  expect(needsTrashUpgrade(error)).toBe(true); expect(trashErrorMessage(error)).toContain('SQL update');
  await expect(permanentDelete('owner', selection, { rpc: vi.fn(async () => ({ data: { folders: [], boards: [] }, error: null })) } as any)).rejects.toThrow('incomplete');
  await expect(permanentDelete('owner', selection, { rpc: vi.fn() } as any, { isCurrent: () => false })).rejects.toThrow('Account changed');
  expect(await db.boards.get(board.key)).toMatchObject({ name: board.name, deleted: true });
  expect((await db.boards.get(board.key))?.purged).toBeUndefined();
});
