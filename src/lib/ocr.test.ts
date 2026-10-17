import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from './db';
import type { Asset } from '../types';
const mock = vi.hoisted(() => ({ recognize: vi.fn(), setParameters: vi.fn().mockResolvedValue(undefined), createWorker: vi.fn() }));
vi.mock('tesseract.js', () => ({ createWorker: mock.createWorker, PSM: { SPARSE_TEXT: '11', AUTO: '3' } }));
beforeEach(() => { vi.resetModules(); mock.recognize.mockReset(); mock.createWorker.mockReset(); mock.createWorker.mockResolvedValue(mock); vi.stubGlobal('location', { href: 'http://localhost/' }); });
afterEach(async () => { await db.assets.clear(); vi.unstubAllGlobals(); });
function asset(updates: Partial<Asset> = {}): Asset { return { key: 'local:image', id: 'image', scope: 'local', dataURL: 'data:image/png;base64,test', mimeType: 'image/png', created: 1, storage: null, remotePath: null, ocrText: '', ocrStatus: 'pending', dirty: false, ...updates }; }
it('reads newly downloaded images and deduplicates repeated indexing requests', async () => {
  const { queueOcr, needsImageOcr } = await import('./ocr');
  expect(needsImageOcr(asset({ dataURL: undefined }))).toBe(false);
  const image = asset(); await db.assets.put(image); mock.recognize.mockResolvedValue({ data: { text: 'HARBOR 2749' } });
  await Promise.all([queueOcr(image), queueOcr(image), queueOcr(image)]);
  expect(mock.recognize).toHaveBeenCalledTimes(1);
  expect((await db.assets.get(image.key))?.ocrText).toBe('HARBOR 2749');
});
it('retries old empty results once, falls back to page layout, and allows an explicit retry', async () => {
  const { queueOcr, needsImageOcr } = await import('./ocr');
  const image = asset({ ocrStatus: 'done' }); await db.assets.put(image); mock.recognize.mockResolvedValue({ data: { text: '' } });
  expect(needsImageOcr(image)).toBe(true); await queueOcr(image);
  expect(mock.recognize).toHaveBeenCalledTimes(2);
  expect(needsImageOcr((await db.assets.get(image.key))!)).toBe(false);
  mock.recognize.mockResolvedValue({ data: { text: 'Recovered words' } }); await queueOcr(image, { force: true });
  expect((await db.assets.get(image.key))?.ocrText).toBe('Recovered words');
});
it('keeps failed images saved and recovers after an explicit retry', async () => {
  const { queueOcr, needsImageOcr } = await import('./ocr');
  const image = asset(); await db.assets.put(image); mock.recognize.mockRejectedValueOnce(new Error('offline'));
  await queueOcr(image); expect(needsImageOcr((await db.assets.get(image.key))!)).toBe(false);
  expect((await db.assets.get(image.key))?.dataURL).toBe(image.dataURL);
  mock.recognize.mockResolvedValue({ data: { text: 'Recovered' } }); await queueOcr(image, { force: true });
  expect((await db.assets.get(image.key))?.ocrStatus).toBe('done');
});
it('does not run text recognition or show OCR messages for generated icon stamps', async () => {
  const { queueOcr, needsImageOcr, onOcrStatus } = await import('./ocr');
  const icon = asset({ id: 'note-icon-v1-clarify-7c3aed', key: 'local:note-icon-v1-clarify-7c3aed' });
  await db.assets.put(icon);
  const notify = vi.fn(), off = onOcrStatus(notify);
  expect(needsImageOcr(icon)).toBe(false);
  await queueOcr(icon, { force: true }); off();
  expect(mock.createWorker).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
});
