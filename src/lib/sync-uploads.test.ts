import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db, newBoard } from './db';
import { syncWorkspace } from './sync';
import { pendingImageMessage, syncErrorMessage } from './sync-status';
import type { Asset } from '../types';
const upload = vi.hoisted(() => vi.fn());
vi.mock('./drive', () => ({ uploadDriveImage: upload, downloadDriveImage: vi.fn() }));
beforeEach(() => { upload.mockReset(); vi.stubGlobal('navigator', { onLine: true }); });
afterEach(async () => { await Promise.all([db.boards.clear(), db.folders.clear(), db.assets.clear()]); vi.unstubAllGlobals(); });
const settings = { imageStore: 'drive' as const, ocrEnabled: true, theme: 'light' as const };
function client(metadata = vi.fn().mockResolvedValue({ error: null })) {
  const rpc = vi.fn().mockResolvedValue({ data: { revision: 1, updated_at: '2026-10-11T01:00:00Z' }, error: null });
  const query = { eq: () => query, in: () => query, order: () => query, range: async () => ({ data: [], error: null }) };
  return { value: { from: () => ({ upsert: metadata, select: () => query }), rpc } as unknown as SupabaseClient, rpc, metadata };
}
async function fixture(dataURL: string | undefined = 'data:image/png;base64,aGk=') {
  const asset: Asset = { key: 'owner:image', id: 'image', scope: 'owner', dataURL, mimeType: 'image/png', created: 1, storage: null, remotePath: null, ocrText: '', ocrStatus: 'done', dirty: true };
  await db.assets.put(asset); const board = await newBoard('owner', 'A board', null);
  await db.boards.update(board.key, { assetIds: ['image'] }); return { asset, board };
}
it('keeps the Drive reconnection reason visible and uploads the waiting board on retry', async () => {
  const { asset, board } = await fixture(), cloud = client(), report = vi.fn();
  upload.mockRejectedValueOnce(new Error('Reconnect Google Drive to sync your images.'));
  await syncWorkspace(cloud.value, 'owner', settings, report);
  expect(report.mock.lastCall?.[0]).toMatch(/1 image pending.*Reconnect Google Drive/);
  expect((await db.assets.get(asset.key))?.syncError).toContain('Reconnect');
  expect((await db.assets.get(asset.key))?.dataURL).toBe(asset.dataURL); expect(cloud.rpc).not.toHaveBeenCalled();
  expect((await db.boards.get(board.key))?.dirty).toBe(true);
  upload.mockResolvedValueOnce('private-drive-file'); await syncWorkspace(cloud.value, 'owner', settings, report);
  expect(report.mock.lastCall?.[0]).toBe('Everything is synced');
  expect((await db.boards.get(board.key))?.dirty).toBe(false); expect((await db.assets.get(asset.key))?.syncError).toBeUndefined();
});
it('preserves Supabase metadata errors and reuses an uploaded file on retry', async () => {
  const { asset } = await fixture(), metadata = vi.fn().mockResolvedValueOnce({ error: { message: 'Storage metadata access denied' } }).mockResolvedValue({ error: null }), cloud = client(metadata), report = vi.fn();
  upload.mockResolvedValue('private-drive-file'); await syncWorkspace(cloud.value, 'owner', settings, report);
  expect(report.mock.lastCall?.[0]).toContain('Storage metadata access denied'); expect((await db.assets.get(asset.key))?.remotePath).toBe('private-drive-file');
  await syncWorkspace(cloud.value, 'owner', settings, report); expect(upload).toHaveBeenCalledTimes(1);
  expect(report.mock.lastCall?.[0]).toBe('Everything is synced');
});
it('explains missing image bytes instead of silently reporting success', async () => {
  const { asset } = await fixture(); await db.assets.update(asset.key, { dataURL: undefined }); const cloud = client(), report = vi.fn();
  await syncWorkspace(cloud.value, 'owner', settings, report); expect(report.mock.lastCall?.[0]).toContain('Image file is missing here');
  expect(upload).not.toHaveBeenCalled(); expect(cloud.rpc).not.toHaveBeenCalled();
});
it('prioritizes reconnection instructions while retaining pending counts and conflict information', () => {
  expect(pendingImageMessage(2, ['Network failure', 'Reconnect Google Drive'], 1)).toBe('2 images pending · Reconnect Google Drive · 1 sync conflict needs review');
  expect(syncErrorMessage({ message: 'Permission denied' })).toBe('Permission denied');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
async function waitingImage(id: string, boardName = id) {
  const asset: Asset = { key: `owner:${id}`, id, scope: 'owner', dataURL: 'data:image/png;base64,aGk=', mimeType: 'image/png', created: 1, storage: null, remotePath: null, ocrText: '', ocrStatus: 'done', dirty: true };
  await db.assets.put(asset);
  const board = await newBoard('owner', boardName, null);
  await db.boards.update(board.key, { assetIds: [id] });
  return { asset, board };
}
it('uploads at most two images together and publishes ready boards before an unrelated slow image finishes', async () => {
  const slow = await waitingImage('a-slow'), fast = await waitingImage('b-fast'), next = await waitingImage('c-next'), cloud = client(), report = vi.fn();
  const gate = deferred<string>(); let active = 0, maxActive = 0;
  upload.mockImplementation(async (id: string) => {
    active++; maxActive = Math.max(maxActive, active);
    try { return id === slow.asset.id ? await gate.promise : `remote-${id}`; }
    finally { active--; }
  });
  const work = syncWorkspace(cloud.value, 'owner', settings, report);
  await vi.waitFor(() => expect(cloud.rpc.mock.calls.map(call => call[1].p_record.id)).toEqual(expect.arrayContaining([fast.board.id, next.board.id])));
  expect((await db.boards.get(slow.board.key))?.dirty).toBe(true);
  expect((await db.boards.get(fast.board.key))?.dirty).toBe(false);
  expect(maxActive).toBe(2);
  expect(upload).toHaveBeenCalledTimes(3);
  expect(report.mock.calls.some(([text]) => text === 'Syncing images · 2 of 3 synced…')).toBe(true);
  gate.resolve('remote-slow');
  expect(await work).toMatchObject({ complete: true, pending: 0 });
  expect(cloud.rpc).toHaveBeenCalledTimes(3);
});
it('saves a shared board only once when its image metadata finishes concurrently', async () => {
  const first = await waitingImage('first'), second = await waitingImage('second'), cloud = client();
  await db.boards.delete(second.board.key);
  await db.boards.update(first.board.key, { assetIds: [first.asset.id, second.asset.id] });
  const one = deferred<string>(), two = deferred<string>();
  upload.mockImplementation((id: string) => id === first.asset.id ? one.promise : two.promise);
  const work = syncWorkspace(cloud.value, 'owner', settings, vi.fn());
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  one.resolve('remote-first'); two.resolve('remote-second');
  expect(await work).toMatchObject({ complete: true });
  expect(cloud.rpc).toHaveBeenCalledTimes(1);
  expect((await db.boards.get(first.board.key))?.dirty).toBe(false);
});
it('stops scheduling a pasted batch and sending metadata when the account changes', async () => {
  for (const id of ['a', 'b', 'c', 'd']) await waitingImage(id);
  const cloud = client(), gate = deferred<string>(); let current = true;
  upload.mockImplementation(() => gate.promise);
  const work = syncWorkspace(cloud.value, 'owner', settings, vi.fn(), { isCurrent: () => current });
  const cancelled = expect(work).rejects.toThrow('active account changed');
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  current = false; gate.resolve('completed-previous-account-upload');
  await cancelled;
  expect(upload).toHaveBeenCalledTimes(2);
  expect(cloud.metadata).not.toHaveBeenCalled();
  expect(cloud.rpc).not.toHaveBeenCalled();
});
