import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Board } from '../types';
import { db, newBoard, newFolder } from './db';
import { resolveSyncConflict, syncWorkspace } from './sync';
import { pendingSyncItems } from './sync-status';
vi.mock('./drive', () => ({ uploadDriveImage: vi.fn(), downloadDriveImage: vi.fn() }));
const scope = 'owner';
const settings = { imageStore: 'supabase' as const, ocrEnabled: true, theme: 'light' as const };
beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
afterEach(async () => { await Promise.all([db.boards.clear(), db.folders.clear(), db.assets.clear()]); vi.unstubAllGlobals(); });
function cloud() {
  const rows: Record<string, Map<string, any>> = { note_boards: new Map(), note_folders: new Map(), note_assets: new Map() };
  const failures = new Map<string, string>();
  const selects: { table: string; columns: string }[] = [];
  const metadata = vi.fn(async (row: any) => { rows.note_assets.set(row.id, structuredClone(row)); return { error: null as null | { message: string } }; });
  const rpc = vi.fn(async (_name: string, args: any) => {
    const table = rows[args.p_kind === 'board' ? 'note_boards' : 'note_folders'];
    if (failures.has(args.p_record.id)) return { data: null, error: { message: failures.get(args.p_record.id)! } };
    const old = table.get(args.p_record.id);
    if ((old?.revision || 0) !== args.p_expected_revision) return { data: null, error: { message: 'NOTE_CONFLICT' } };
    const saved = { ...structuredClone(args.p_record), owner_id: scope, revision: (old?.revision || 0) + 1, updated_at: new Date().toISOString() };
    table.set(saved.id, saved); return { data: saved, error: null };
  });
  const from = (name: string) => {
    const filters = new Map<string, unknown>(); let ids: string[] | undefined;
    const result = () => [...rows[name].values()].filter(row => (!ids || ids.includes(row.id)) && [...filters].every(([key, value]) => row[key] === value));
    const query = { in: (_key: string, values: string[]) => { ids = values; return query; }, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, order: () => query,
      range: async (start: number, end: number) => ({ data: structuredClone(result().slice(start, end + 1)), error: null }),
      single: async () => ({ data: structuredClone(result()[0]), error: result().length ? null : { message: 'Not found' } }) };
    return { select: (columns = '*') => { selects.push({ table: name, columns }); return query; }, upsert: metadata };
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rows, failures, rpc, metadata, selects };
}
const asset = (changes: Partial<Asset> = {}): Asset => ({ key: 'owner:image', id: 'image', scope, mimeType: 'image/png', created: 1, storage: 'supabase', remotePath: 'owner/image', ocrText: '', ocrStatus: 'pending', dirty: true, ...changes });
function remoteBoard(board: Board, name = board.name) { return { id: board.id, owner_id: scope, name, folder_id: board.folderId, elements: board.elements, app_state: board.appState, asset_ids: board.assetIds, deleted: board.deleted, revision: 1, updated_at: board.updatedAt, created_at: board.createdAt, created_at_estimated: false }; }
it('isolates a failed board, downloads other-device changes, and retries with the named error intact', async () => {
  const blocked = await newBoard(scope, 'Blocked board', null), good = await newBoard(scope, 'Working board', null), server = cloud(), report = vi.fn();
  server.rows.note_boards.set('other-device', { ...remoteBoard(good, 'From phone'), id: 'other-device' });
  server.failures.set(blocked.id, 'Permission denied saving this board');
  const first = await syncWorkspace(server.client, scope, settings, report);
  expect(first).toMatchObject({ complete: false, downloaded: true, pending: 1 });
  expect(await db.boards.get(good.key)).toMatchObject({ dirty: false });
  expect(await db.boards.get(blocked.key)).toMatchObject({ dirty: true, syncError: 'Permission denied saving this board' });
  expect(await db.boards.get('owner:other-device')).toMatchObject({ name: 'From phone', dirty: false });
  expect(report.mock.lastCall?.[0]).toMatch(/Blocked board.*Permission denied/);
  server.failures.clear();
  expect(await syncWorkspace(server.client, scope, settings, report)).toMatchObject({ complete: true, pending: 0 });
  expect((await db.boards.get(blocked.key))?.syncError).toBeUndefined();
});
it('publishes a board while OCR changes during image metadata upload, without reporting false completion', async () => {
  const board = await newBoard(scope, 'Screenshots', null), server = cloud(), report = vi.fn();
  await db.boards.update(board.key, { assetIds: ['image'] }); await db.assets.put(asset());
  server.metadata.mockImplementationOnce(async row => {
    server.rows.note_assets.set(row.id, row);
    await db.assets.update('owner:image', { ocrText: 'New searchable text', ocrStatus: 'done', dirty: true });
    return { error: null };
  });
  expect(await syncWorkspace(server.client, scope, settings, report)).toMatchObject({ complete: false, pending: 1 });
  expect(await db.boards.get(board.key)).toMatchObject({ dirty: false });
  expect(await db.assets.get('owner:image')).toMatchObject({ dirty: true, metadataSaved: true, ocrText: 'New searchable text' });
  expect(server.rows.note_boards.has(board.id)).toBe(true);
  expect(report.mock.lastCall?.[0]).not.toBe('Everything is synced');
  expect(await syncWorkspace(server.client, scope, settings, report)).toMatchObject({ complete: true });
});
it('does not block a published image on failed text metadata and recovers its cloud location', async () => {
  const board = await newBoard(scope, 'Already uploaded', null), server = cloud();
  await db.boards.update(board.key, { assetIds: ['image'] });
  await db.assets.put(asset({ remotePath: null, storage: null }));
  server.rows.note_assets.set('image', { owner_id: scope, id: 'image', storage: 'supabase', remote_path: 'owner/image', mime_type: 'image/png', ocr_text: '', ocr_status: 'pending', created_ms: 1 });
  server.metadata.mockResolvedValue({ error: { message: 'Text metadata is temporarily unavailable' } });
  const result = await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ dirty: false });
  expect(await db.assets.get('owner:image')).toMatchObject({ remotePath: 'owner/image', metadataSaved: true, dirty: true });
  expect(result).toMatchObject({ complete: false, pending: 1 });
});
it('preserves edits made during a save even when both edits have the same timestamp', async () => {
  const board = await newBoard(scope, 'Before request', null), server = cloud(), report = vi.fn();
  const original = server.rpc.getMockImplementation()!;
  server.rpc.mockImplementationOnce(async (name, args) => { await db.boards.update(board.key, { name: 'Edited during request', updatedAt: board.updatedAt }); return original(name, args); });
  expect(await syncWorkspace(server.client, scope, settings, report)).toMatchObject({ complete: false, pending: 1 });
  expect(await db.boards.get(board.key)).toMatchObject({ dirty: true, name: 'Edited during request', remoteRevision: 1 });
  expect(report.mock.lastCall?.[0]).toMatch(/1 board pending/);
  expect(await syncWorkspace(server.client, scope, settings, report)).toMatchObject({ complete: true });
  expect(server.rows.note_boards.get(board.id).name).toBe('Edited during request');
});
it('recognizes an already committed retry instead of making duplicate conflict copies', async () => {
  const board = await newBoard(scope, 'Committed before connection dropped', null), server = cloud();
  server.rows.note_boards.set(board.id, remoteBoard(board));
  const result = await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(result).toMatchObject({ complete: true, conflicts: 0 });
  expect(await db.boards.count()).toBe(1);
  expect(await db.boards.get(board.key)).toMatchObject({ dirty: false, remoteRevision: 1 });
});
it('keeps genuine concurrent edits on the same ID until an explicit version choice', async () => {
  const board = await newBoard(scope, 'Local change', null), server = cloud();
  server.rows.note_boards.set(board.id, remoteBoard(board, 'Changed on phone'));
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: false, conflicts: 1, pending: 1 });
  expect(await db.boards.count()).toBe(1);
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Local change', dirty: true, syncConflict: { revision: 1, data: { name: 'Changed on phone' } } });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: false, pending: 1 });
  expect(server.rows.note_boards.size).toBe(1);
  await resolveSyncConflict(scope, board.key, 'local');
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
  expect(server.rows.note_boards.size).toBe(1);
  expect(server.rows.note_boards.get(board.id).name).toBe('Local change');
});
it('syncs Trash changes even when their old image file is missing, and counts them as pending', async () => {
  const board = await newBoard(scope, 'Trashed board', null), server = cloud();
  await db.boards.update(board.key, { deleted: true, assetIds: ['missing'] });
  expect(pendingSyncItems([await db.boards.get(board.key) as Board], [], [])).toMatchObject([{ kind: 'board', reason: 'Waiting to sync its move to Trash.' }]);
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
  expect(server.rows.note_boards.get(board.id).deleted).toBe(true);
});
it('keeps a bad folder from stopping unrelated root boards and explains blocked dependencies', async () => {
  const folder = await newFolder(scope, 'Blocked folder', null), nested = await newBoard(scope, 'Nested board', folder.id), independent = await newBoard(scope, 'Independent', null), server = cloud();
  server.failures.set(folder.id, 'Folder save failed');
  await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(await db.boards.get(independent.key)).toMatchObject({ dirty: false });
  expect((await db.boards.get(nested.key))?.syncError).toContain('Waiting for folder “Blocked folder”');
  server.failures.clear();
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
});
it('stops further requests when the active account changes', async () => {
  await newBoard(scope, 'First', null); await newBoard(scope, 'Second', null);
  const server = cloud(); let current = true;
  const original = server.rpc.getMockImplementation()!;
  server.rpc.mockImplementationOnce(async (name, args) => { const result = await original(name, args); current = false; return result; });
  await expect(syncWorkspace(server.client, scope, settings, vi.fn(), { isCurrent: () => current })).rejects.toThrow('active account changed');
  expect(server.rpc).toHaveBeenCalledTimes(1);
  expect((await db.boards.toArray()).every(board => board.dirty)).toBe(true);
});

it('does not overwrite a newer locally acknowledged revision with an older cloud snapshot', async () => {
  const board = await newBoard(scope, 'Newer saved board', null), server = cloud();
  await db.boards.update(board.key, { dirty: false, remoteRevision: 3 });
  server.rows.note_boards.set(board.id, { ...remoteBoard(board, 'Older snapshot'), revision: 2 });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Newer saved board', remoteRevision: 3, dirty: false });
});

it('polls revisions without redownloading unchanged boards and fetches changed scenes', async () => {
  const board = await newBoard(scope, 'Saved board', null), server = cloud();
  await syncWorkspace(server.client, scope, settings, vi.fn());
  server.selects.length = 0;
  await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(server.selects.filter(query => query.table === 'note_boards')).toEqual([{ table: 'note_boards', columns: 'id,revision' }]);
  const remote = server.rows.note_boards.get(board.id);
  server.rows.note_boards.set(board.id, { ...remote, name: 'Edited on phone', revision: 2 });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Edited on phone', remoteRevision: 2 });
  expect(server.selects).toContainEqual({ table: 'note_boards', columns: '*' });
});

it('defers incoming changes while the open editor has unsaved work, then receives them safely', async () => {
  const board = await newBoard(scope, 'Open board', null), server = cloud();
  await db.boards.update(board.key, { dirty: false, remoteRevision: 1 });
  server.rows.note_boards.set(board.id, { ...remoteBoard(board, 'Phone update'), revision: 2 });
  const report = vi.fn();
  const waiting = await syncWorkspace(server.client, scope, settings, report, { isBoardBusy: key => key === board.key });
  expect(waiting).toMatchObject({ complete: false, deferred: true });
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Open board', remoteRevision: 1 });
  expect(report.mock.lastCall?.[0]).toContain('Finish editing');
  expect(await syncWorkspace(server.client, scope, settings, report, { isBoardBusy: () => false })).toMatchObject({ complete: true, deferred: false });
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Phone update', remoteRevision: 2 });
});
it('does not upload an old snapshot while its editor is still saving', async () => {
  const board = await newBoard(scope, 'Saving board', null), server = cloud();
  const result = await syncWorkspace(server.client, scope, settings, vi.fn(), { isBoardBusy: key => key === board.key });
  expect(result).toMatchObject({ complete: false, pending: 1, deferred: true });
  expect(server.rpc).not.toHaveBeenCalled();
  expect((await db.boards.get(board.key))?.dirty).toBe(true);
});

it('defers conflict replacement when more local edits arrive during the request', async () => {
  const board = await newBoard(scope, 'Local start', null), server = cloud(); let busy = false;
  server.rows.note_boards.set(board.id, remoteBoard(board, 'Phone version'));
  const original = server.rpc.getMockImplementation()!;
  server.rpc.mockImplementationOnce(async (name, args) => { busy = true; return original(name, args); });
  const result = await syncWorkspace(server.client, scope, settings, vi.fn(), { isBoardBusy: () => busy });
  expect(result).toMatchObject({ complete: false, deferred: true, conflicts: 0 });
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Local start', dirty: true, remoteRevision: 0 });
  await db.boards.update(board.key, { name: 'Latest local edit' }); busy = false;
  expect(await syncWorkspace(server.client, scope, settings, vi.fn(), { isBoardBusy: () => busy })).toMatchObject({ conflicts: 1 });
  expect(await db.boards.count()).toBe(1);
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Latest local edit', syncConflict: { data: { name: 'Phone version' } } });
});

const element = (id: string, text = id, version = 1) => ({ id, type: 'text', text, x: 0, y: 0, version, versionNonce: version, updated: version, isDeleted: false });
it('receives a real other-device edit over a legacy view-only dirty snapshot without making a board', async () => {
  const board = await newBoard(scope, 'Shared board', null), server = cloud();
  await db.boards.update(board.key, { elements: [element('a')] as unknown as Board['elements'] });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  const before = await db.boards.get(board.key) as Board;
  await db.boards.update(board.key, { appState: { ...before.appState, scrollX: 500, zoom: { value: 0.7 as any } }, dirty: true });
  const remote = server.rows.note_boards.get(board.id);
  server.rows.note_boards.set(board.id, { ...remote, elements: [element('a', 'Written on phone', 2)], revision: 2 });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true, conflicts: 0 });
  expect(await db.boards.count()).toBe(1);
  expect(await db.boards.get(board.key)).toMatchObject({ elements: [{ text: 'Written on phone' }], appState: { scrollX: 500, zoom: { value: 0.7 } }, remoteRevision: 2, dirty: false });
});
it('ignores file-loading status and element bookkeeping in an otherwise identical retry', async () => {
  const board = await newBoard(scope, 'Image board', null), server = cloud();
  const local = { ...board, elements: [{ ...element('image'), type: 'image', fileId: 'file', status: 'saved' }] as unknown as Board['elements'], appState: { ...board.appState, scrollX: 100 } };
  await db.boards.put(local);
  server.rows.note_boards.set(board.id, { ...remoteBoard(local), elements: [{ ...element('image', 'image', 8), type: 'image', fileId: 'file', status: 'pending' }], app_state: { ...board.appState, scrollX: 0 } });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true, conflicts: 0 });
  expect(await db.boards.count()).toBe(1);
});
it('merges independent additions from two devices onto the same board ID', async () => {
  const board = await newBoard(scope, 'Shared additions', null), server = cloud();
  await db.boards.update(board.key, { elements: [element('base')] as unknown as Board['elements'] });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  await db.boards.update(board.key, { elements: [element('base'), element('laptop')] as unknown as Board['elements'], dirty: true });
  const remote = server.rows.note_boards.get(board.id);
  server.rows.note_boards.set(board.id, { ...remote, elements: [element('base'), element('phone')], revision: 2 });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ conflicts: 0, pending: 1 });
  expect(await db.boards.count()).toBe(1);
  expect((await db.boards.get(board.key))?.elements.map(item => item.id)).toEqual(['base', 'laptop', 'phone']);
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
  expect(server.rows.note_boards.size).toBe(1);
  expect(server.rows.note_boards.get(board.id).elements.map((item: any) => item.id)).toEqual(['base', 'laptop', 'phone']);
});
it('retains both overlapping element edits until choosing cloud, with local viewing preferences retained', async () => {
  const board = await newBoard(scope, 'Review edits', null), server = cloud();
  await db.boards.update(board.key, { elements: [element('same')] as unknown as Board['elements'] });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  await db.boards.update(board.key, { elements: [element('same', 'Laptop edit', 2)] as unknown as Board['elements'], appState: { ...board.appState, scrollY: 250 }, dirty: true });
  const remote = server.rows.note_boards.get(board.id);
  server.rows.note_boards.set(board.id, { ...remote, elements: [element('same', 'Phone edit', 2)], revision: 2, updated_at: '2026-10-18T00:00:00Z' });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: false, conflicts: 1, pending: 1 });
  expect(await db.boards.get(board.key)).toMatchObject({ elements: [{ text: 'Laptop edit' }], syncConflict: { revision: 2, data: { elements: [{ text: 'Phone edit' }] } } });
  await resolveSyncConflict(scope, board.key, 'cloud');
  expect(await db.boards.get(board.key)).toMatchObject({ elements: [{ text: 'Phone edit' }], appState: { scrollY: 250 }, remoteRevision: 2, updatedAt: '2026-10-18T00:00:00Z', dirty: false });
  expect(await db.boards.count()).toBe(1);
});
it('does not overwrite a newer cloud change after an explicit keep-local choice', async () => {
  const board = await newBoard(scope, 'Laptop name', null), server = cloud();
  server.rows.note_boards.set(board.id, remoteBoard(board, 'Phone name'));
  await syncWorkspace(server.client, scope, settings, vi.fn());
  await resolveSyncConflict(scope, board.key, 'local');
  server.rows.note_boards.set(board.id, { ...remoteBoard(board, 'Newer phone name'), revision: 2 });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ conflicts: 1, complete: false });
  expect(server.rows.note_boards.get(board.id).name).toBe('Newer phone name');
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Laptop name', syncConflict: { revision: 2 } });
  expect(await db.boards.count()).toBe(1);
});
it('receives purge tombstones over dirty busy editors without resurrecting content or conflicts', async () => {
  const board = await newBoard(scope, 'Unsent local edit', null), server = cloud();
  await db.boards.update(board.key, { dirty: true, remoteRevision: 1, syncConflict: { revision: 2, data: { name: 'Old conflict' } } });
  server.rows.note_boards.set(board.id, { ...remoteBoard(board, ''), revision: 3, deleted: true, purged: true, elements: [], app_state: {}, asset_ids: [], folder_id: null });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn(), { isBoardBusy: () => true })).toMatchObject({ complete: true, pending: 0, conflicts: 0 });
  const purged = await db.boards.get(board.key);
  expect(purged).toMatchObject({ purged: true, deleted: true, name: '', elements: [], appState: {}, assetIds: [], dirty: false, remoteRevision: 3 });
  expect(purged?.syncBase).toBeUndefined(); expect(purged?.syncConflict).toBeUndefined();
  expect(server.rpc).not.toHaveBeenCalled();
});
it('merges a folder rename and another-device color change without creating folders', async () => {
  const folder = await newFolder(scope, 'Original folder', null), server = cloud();
  await syncWorkspace(server.client, scope, settings, vi.fn());
  await db.folders.update(folder.key, { name: 'Laptop folder name', dirty: true });
  const remote = server.rows.note_folders.get(folder.id);
  server.rows.note_folders.set(folder.id, { ...remote, color: '#123456', revision: 2 });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ conflicts: 0, pending: 1 });
  expect(await db.folders.count()).toBe(1);
  expect(await db.folders.get(folder.key)).toMatchObject({ name: 'Laptop folder name', color: '#123456' });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
  expect(server.rows.note_folders.size).toBe(1);
});
it('handles a purge committed after polling and before a save without creating a pending resurrection', async () => {
  const board = await newBoard(scope, 'Old open snapshot', null), server = cloud();
  server.rpc.mockImplementationOnce(async () => {
    server.rows.note_boards.set(board.id, { ...remoteBoard(board, ''), revision: 2, purged: true, deleted: true, elements: [], app_state: {}, asset_ids: [] });
    return { data: null, error: { message: 'NOTE_PURGED' } };
  });
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true, pending: 0, conflicts: 0 });
  expect(await db.boards.get(board.key)).toMatchObject({ purged: true, name: '', elements: [], dirty: false, remoteRevision: 2 });
  expect(await db.boards.count()).toBe(1);
});
it('does not let a delayed save acknowledgement rewind a newer revision stored by another tab', async () => {
  const board = await newBoard(scope, 'Initial tab', null), server = cloud();
  const original = server.rpc.getMockImplementation()!;
  server.rpc.mockImplementationOnce(async (name, args) => {
    const saved = await original(name, args);
    await db.boards.update(board.key, { name: 'Newer acknowledged tab edit', dirty: false, remoteRevision: 3 });
    return saved;
  });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Newer acknowledged tab edit', dirty: false, remoteRevision: 3 });
});
it('requires a new version review if the conflict changed while the user choice was waiting', async () => {
  const board = await newBoard(scope, 'Local version', null), server = cloud();
  server.rows.note_boards.set(board.id, remoteBoard(board, 'First cloud version'));
  await syncWorkspace(server.client, scope, settings, vi.fn());
  server.rows.note_boards.set(board.id, { ...remoteBoard(board, 'New cloud version'), revision: 2 });
  await syncWorkspace(server.client, scope, settings, vi.fn());
  await expect(resolveSyncConflict(scope, board.key, 'local', 1)).rejects.toThrow('cloud version changed');
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Local version', dirty: true, remoteRevision: 0, syncConflict: { revision: 2 } });
  expect(server.rows.note_boards.get(board.id).name).toBe('New cloud version');
  await resolveSyncConflict(scope, board.key, 'local', 2);
  expect(await syncWorkspace(server.client, scope, settings, vi.fn())).toMatchObject({ complete: true });
});
