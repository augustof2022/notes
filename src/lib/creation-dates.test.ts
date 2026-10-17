import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db, newBoard, newFolder, touch } from './db';
import { importLocalWorkspace, preserveConflict, syncWorkspace } from './sync';

vi.mock('./drive', () => ({ uploadDriveImage: vi.fn(), downloadDriveImage: vi.fn() }));
const createdAt = '2026-09-10T04:00:00.000Z';
const editedAt = '2026-10-15T01:00:00.000Z';
const settings = { supabaseUrl: '', supabaseKey: '', imageStore: 'supabase' as const, ocrEnabled: true, theme: 'light' as const };
beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([db.boards.clear(), db.folders.clear(), db.assets.clear()]);
  vi.unstubAllGlobals();
});
function cloud(rows: Record<string, object[]> = {}, saved?: object) {
  const rpc = vi.fn().mockResolvedValue({ data: saved || { revision: 1, updated_at: editedAt }, error: null });
  return {
    rpc,
    value: { rpc, from: (table: string) => {
      const query = { eq: () => query, order: () => query, range: async () => ({ data: rows[table] || [], error: null }) };
      return { select: () => query };
    } } as unknown as SupabaseClient
  };
}
it('gives new boards and folders a real, immutable creation timestamp', async () => {
  for (const record of [await newFolder('local', 'Folder', null), await newBoard('local', 'Board', null)]) {
    expect(record.createdAt).toBe(record.updatedAt);
    expect(record.createdAtEstimated).toBe(false);
    const table = 'elements' in record ? db.boards : db.folders;
    await table.update(record.key, { name: 'Renamed', ...touch() });
    expect((await table.get(record.key))?.createdAt).toBe(record.createdAt);
  }
});
it('freezes legacy IndexedDB edit dates as estimates during the v2 migration', async () => {
  db.close();
  await Dexie.delete(db.name);
  const legacy = new Dexie(db.name);
  legacy.version(1).stores({ folders: '&key, scope, id, parentId', boards: '&key, scope, id, folderId', assets: '&key, scope, id' });
  const record = { key: 'local:legacy', id: 'legacy', scope: 'local', name: 'Legacy', updatedAt: createdAt, deleted: false, dirty: false, remoteRevision: 0 };
  await legacy.table('folders').put({ ...record, parentId: null, color: '#aaa' });
  await legacy.table('boards').put({ ...record, folderId: null, elements: [], appState: {}, assetIds: [], preview: null });
  legacy.close();
  await db.open();
  for (const table of [db.folders, db.boards]) {
    const migrated = await table.get(record.key);
    expect(migrated?.createdAt).toBe(createdAt);
    expect(migrated?.createdAtEstimated).toBe(true);
    await table.update(record.key, { updatedAt: editedAt });
  }
  db.close(); await db.open();
  expect((await db.boards.get(record.key))?.createdAt).toBe(createdAt);
});
it('marks dates from the deployed v2 migration as estimates without changing them', async () => {
  db.close();
  await Dexie.delete(db.name);
  const legacy = new Dexie(db.name);
  legacy.version(2).stores({ folders: '&key, scope, id, parentId', boards: '&key, scope, id, folderId', assets: '&key, scope, id' });
  const record = { id: 'v2', scope: 'local', name: 'Existing v2', createdAt, updatedAt: editedAt, deleted: false, dirty: false, remoteRevision: 0 };
  await legacy.table('folders').put({ ...record, key: 'local:v2', parentId: null, color: '#aaa' });
  await legacy.table('boards').put({ ...record, key: 'local:v2', folderId: null, elements: [], appState: {}, assetIds: [], preview: null });
  await legacy.table('boards').put({ ...record, id: 'known', key: 'local:known', createdAtEstimated: false, folderId: null, elements: [], appState: {}, assetIds: [], preview: null });
  legacy.close();
  await db.open();
  for (const table of [db.folders, db.boards]) {
    expect(await table.get('local:v2')).toMatchObject({ createdAt, updatedAt: editedAt, createdAtEstimated: true });
  }
  expect(await db.boards.get('local:known')).toMatchObject({ createdAt, createdAtEstimated: false });
  db.close(); await db.open();
  expect(await db.boards.get('local:v2')).toMatchObject({ createdAt, createdAtEstimated: true });
});
it('keeps original creation dates on account import and uses a new date for conflict copies', async () => {
  const folder = await newFolder('local', 'Folder', null);
  const board = await newBoard('local', 'Board', folder.id);
  await db.folders.update(folder.key, { createdAt, updatedAt: editedAt });
  await db.boards.update(board.key, { createdAt, updatedAt: editedAt });
  await importLocalWorkspace('owner');
  expect((await db.folders.where('scope').equals('owner').first())?.createdAt).toBe(createdAt);
  expect((await db.boards.where('scope').equals('owner').first())?.createdAt).toBe(createdAt);
  const copy = preserveConflict({ ...board, createdAt });
  expect(copy.createdAt).toBe(copy.updatedAt);
  expect(copy.createdAt).not.toBe(createdAt);
  expect(copy.createdAtEstimated).toBe(false);
});
it('sends creation metadata and retains known dates through old-server saves and downloads', async () => {
  const folder = await newFolder('owner', 'Folder', null);
  const board = await newBoard('owner', 'Board', folder.id);
  await db.folders.update(folder.key, { createdAt });
  await db.boards.update(board.key, { createdAt });
  const row = { id: board.id, name: board.name, folder_id: folder.id, updated_at: editedAt, deleted: false, revision: 1 };
  const server = cloud({ note_boards: [row], note_folders: [{ ...row, id: folder.id, parent_id: null, color: folder.color }] });
  await syncWorkspace(server.value, 'owner', settings, vi.fn());
  expect(server.rpc).toHaveBeenCalledTimes(2);
  for (const [, arguments_] of server.rpc.mock.calls) expect(arguments_.p_record).toMatchObject({ created_at: createdAt, created_at_estimated: false });
  expect((await db.boards.get(board.key))?.createdAt).toBe(createdAt);
  expect((await db.folders.get(folder.key))?.createdAt).toBe(createdAt);
  const firstSeen = cloud({ note_boards: [{ ...row, id: 'first-seen' }] });
  await syncWorkspace(firstSeen.value, 'owner', settings, vi.fn());
  expect(await db.boards.get('owner:first-seen')).toMatchObject({ createdAt: editedAt, createdAtEstimated: true });
  const unflagged = cloud({ note_boards: [
    { ...row, created_at: editedAt },
    { ...row, id: 'v2-server', created_at: createdAt }
  ] });
  await syncWorkspace(unflagged.value, 'owner', settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ createdAt, createdAtEstimated: false });
  expect(await db.boards.get('owner:v2-server')).toMatchObject({ createdAt, createdAtEstimated: true });
});
it('downloads accurate remote creation dates and never replaces a known date with an estimate', async () => {
  const board = await newBoard('owner', 'Known board', null);
  await db.boards.update(board.key, { createdAt, dirty: false });
  const row = { name: 'Board', folder_id: null, updated_at: editedAt, deleted: false, revision: 1 };
  const server = cloud({ note_boards: [
    { ...row, id: board.id, created_at: editedAt, created_at_estimated: true },
    { ...row, id: 'from-another-device', created_at: createdAt, created_at_estimated: false }
  ] });
  await syncWorkspace(server.value, 'owner', settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ createdAt, createdAtEstimated: false });
  expect(await db.boards.get('owner:from-another-device')).toMatchObject({ createdAt, createdAtEstimated: false });
});
it('takes creation metadata returned by save_note when the local date was only estimated', async () => {
  const board = await newBoard('owner', 'Estimated board', null);
  await db.boards.update(board.key, { createdAt: editedAt, createdAtEstimated: true });
  const server = cloud({}, { revision: 1, updated_at: editedAt, created_at: createdAt, created_at_estimated: false });
  await syncWorkspace(server.value, 'owner', settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ createdAt, createdAtEstimated: false });
});
