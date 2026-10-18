import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset } from '../types';
import { db } from './db';
import { downloadAsset } from './sync';
import { loadBoardImages, type BoardImageState } from './board-images';
const driveDownload = vi.hoisted(() => vi.fn());
vi.mock('./drive', () => ({ downloadDriveImage: driveDownload, uploadDriveImage: vi.fn() }));
vi.mock('./assets', async importOriginal => ({ ...await importOriginal<typeof import('./assets')>(), blobToDataURL: async (blob: Blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}` }));
const image = new Blob(['image bytes'], { type: 'image/png' });
const cached = 'data:image/png;base64,Y2FjaGVk';
const asset = (id: string, patch: Partial<Asset> = {}): Asset => ({ key: `owner:${id}`, scope: 'owner', id, created: 1, mimeType: 'image/png', storage: 'supabase', remotePath: `owner/${id}`, dirty: false, metadataSaved: true, ocrText: '', ocrStatus: 'done', ...patch });
const cloud = (download = vi.fn().mockResolvedValue({ data: image, error: null })) => ({ client: { storage: { from: () => ({ download }) } } as unknown as SupabaseClient, download });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { driveDownload.mockReset(); vi.stubGlobal('navigator', { onLine: true }); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await db.assets.clear(); });
function loader(ids: string[], client: SupabaseClient, isCurrent = () => true) {
  const progress = vi.fn<(state: BoardImageState) => void>(), file = vi.fn();
  return { progress, file, run: () => loadBoardImages({ boardKey: 'owner:board', scope: 'owner', ids, client, files: {}, isCurrent, onFile: file, onProgress: progress }) };
}
it('shows cached images first and downloads progressively with at most three requests', async () => {
  await db.assets.bulkPut(['a','b','c','d','e'].map(id => asset(id)).concat(asset('cached', { dataURL: cached })));
  const pending = new Map<string, ReturnType<typeof deferred<any>>>(); let active = 0, max = 0;
  const download = vi.fn(async (path: string) => { active++; max = Math.max(max, active); const request = deferred<any>(); pending.set(path, request); try { return await request.promise; } finally { active--; } });
  const job = loader(['a','b','c','d','e','cached'], cloud(download).client), running = job.run();
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(3));
  expect(job.file.mock.calls.map(([file]) => file.id)).toEqual(['cached']);
  pending.get('owner/b')!.resolve({ data: image, error: null });
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(4));
  expect(job.file.mock.calls.map(([file]) => file.id)).toEqual(['cached', 'b']);
  pending.get('owner/c')!.resolve({ data: null, error: { message: 'Temporary connection failure' } });
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(5));
  for (const path of ['owner/a','owner/d','owner/e']) pending.get(path)!.resolve({ data: image, error: null });
  await running;
  expect(max).toBe(3);
  expect(job.progress.mock.lastCall?.[0]).toMatchObject({ total: 6, loaded: 5, loading: false, issues: [{ id: 'c', reason: 'Temporary connection failure' }] });
  expect((await db.assets.toArray()).every(row => !row.dirty)).toBe(true);
});
it('keeps Drive retrieval errors visible and recovers on retry without downloading cached images again', async () => {
  await db.assets.bulkPut([asset('cached', { dataURL: cached }), asset('drive', { storage: 'drive', remotePath: 'private-file' })]);
  driveDownload.mockRejectedValueOnce(new Error('Reconnect Google Drive to load or upload images.')).mockResolvedValue(image);
  const server = cloud(), first = loader(['cached','drive'], server.client);
  await first.run();
  expect(first.progress.mock.lastCall?.[0]).toMatchObject({ total: 2, loaded: 1, loading: false, issues: [{ id: 'drive', reconnect: true }] });
  const retry = loader(['cached','drive'], server.client); await retry.run();
  expect(retry.progress.mock.lastCall?.[0]).toMatchObject({ loaded: 2, loading: false, issues: [] });
  await retry.run();
  expect(driveDownload).toHaveBeenCalledTimes(2); expect(server.download).not.toHaveBeenCalled();
  expect(await db.assets.get('owner:drive')).toMatchObject({ dirty: false, remotePath: 'private-file', dataURL: expect.stringContaining('data:image/png') });
});
it('retrieves late image metadata without needing a new board revision', async () => {
  const server = cloud(), job = loader(['late'], server.client); await job.run();
  expect(job.progress.mock.lastCall?.[0].issues[0].reason).toContain('Image details');
  await db.assets.put(asset('late')); await job.run();
  expect(job.progress.mock.lastCall?.[0]).toMatchObject({ loaded: 1, issues: [] });
});
it('stops filling the old canvas and scheduling files when the board or account changes', async () => {
  await db.assets.bulkPut(['a','b','c','d'].map(id => asset(id)));
  const gate = deferred<any>(), server = cloud(vi.fn().mockReturnValue(gate.promise)); let current = true;
  const job = loader(['a','b','c','d'], server.client, () => current), running = job.run();
  await vi.waitFor(() => expect(server.download).toHaveBeenCalledTimes(3));
  current = false; gate.resolve({ data: image, error: null }); await running;
  expect(server.download).toHaveBeenCalledTimes(3); expect(job.file).not.toHaveBeenCalled();
});
it('uses cached files offline and leaves uncached files with a clear retry reason', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  await db.assets.bulkPut([asset('cached', { dataURL: cached }), asset('remote')]);
  const server = cloud(), job = loader(['cached','remote'], server.client); await job.run();
  expect(job.file.mock.calls[0][0]).toMatchObject({ id: 'cached', dataURL: cached });
  expect(job.progress.mock.lastCall?.[0]).toMatchObject({ loaded: 1, loading: false, issues: [{ id: 'remote', reason: expect.stringContaining('Offline') }] });
  expect(server.download).not.toHaveBeenCalled();
});
it('shares concurrent image requests and reuses the downloaded device cache', async () => {
  const row = asset('same'); await db.assets.put(row);
  const gate = deferred<any>(), server = cloud(vi.fn().mockReturnValue(gate.promise));
  const first = downloadAsset(server.client, row), second = downloadAsset(server.client, row);
  await vi.waitFor(() => expect(server.download).toHaveBeenCalledTimes(1));
  gate.resolve({ data: image, error: null });
  expect((await Promise.all([first, second]))[0].dataURL).toBe((await db.assets.get(row.key))?.dataURL);
  await downloadAsset(server.client, row); expect(server.download).toHaveBeenCalledTimes(1);
});
it('times out a stalled body, cancels its request, and allows a new download', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const row = asset('stalled'); await db.assets.put(row);
  const server = cloud(vi.fn().mockReturnValue(new Promise(() => {})));
  const result = expect(downloadAsset(server.client, row)).rejects.toThrow('image download timed out');
  await vi.waitFor(() => expect(server.download).toHaveBeenCalledTimes(1));
  const signal = server.download.mock.calls[0][2].signal as AbortSignal;
  await vi.advanceTimersByTimeAsync(90000); await result;
  expect(signal.aborted).toBe(true); expect((await db.assets.get(row.key))?.dataURL).toBeUndefined();
  server.download.mockResolvedValue({ data: image, error: null });
  expect((await downloadAsset(server.client, row)).dataURL).toContain('data:image/png');
  expect(vi.getTimerCount()).toBe(0);
});
it('does not cache empty files or a non-image response as a successful download', async () => {
  const row = asset('invalid'); await db.assets.put(row);
  const server = cloud(vi.fn().mockResolvedValue({ data: new Blob(['Error page'], { type: 'text/html' }), error: null }));
  await expect(downloadAsset(server.client, row)).rejects.toThrow('not a usable image');
  expect((await db.assets.get(row.key))?.dataURL).toBeUndefined();
  server.download.mockResolvedValue({ data: new Blob(), error: null });
  await expect(downloadAsset(server.client, row)).rejects.toThrow('not a usable image');
});
it('does not overwrite a newer image location with a download from its old location', async () => {
  const row = asset('moving'); await db.assets.put(row);
  const gate = deferred<any>(), server = cloud(vi.fn().mockReturnValue(gate.promise));
  const request = downloadAsset(server.client, row);
  await vi.waitFor(() => expect(server.download).toHaveBeenCalledTimes(1));
  await db.assets.update(row.key, { remotePath: 'new/location' });
  gate.resolve({ data: image, error: null }); await request;
  expect(await db.assets.get(row.key)).toMatchObject({ remotePath: 'new/location' });
  expect((await db.assets.get(row.key))?.dataURL).toBeUndefined();
});
