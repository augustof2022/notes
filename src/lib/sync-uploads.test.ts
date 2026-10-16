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
  const query = { eq: () => query, order: () => query, range: async () => ({ data: [], error: null }) };
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
  expect(pendingImageMessage(2, ['Network failure', 'Reconnect Google Drive'], 1)).toBe('2 images pending · Reconnect Google Drive · 1 conflict copy also needs syncing');
  expect(syncErrorMessage({ message: 'Permission denied' })).toBe('Permission denied');
});
