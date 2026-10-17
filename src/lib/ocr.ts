import { createWorker, PSM, type Worker } from 'tesseract.js';
import { db } from './db';
import type { Asset } from '../types';
import { isIconStampFile } from './icon-stamps';
let workerPromise: Promise<Worker> | null = null;
let chain = Promise.resolve();
export const OCR_VERSION = 2;
const jobs = new Map<string, Promise<void>>();
const listeners = new Set<(text: string) => void>();
function notify(text: string) { for (const listener of listeners) listener(text); }
export function onOcrStatus(callback: (text: string) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
export function needsImageOcr(asset: Asset) {
  return !isIconStampFile(asset.id) && !!asset.dataURL && (asset.ocrStatus === 'pending' || (asset.ocrStatus === 'done' && !asset.ocrText.trim() && (asset.ocrVersion || 0) < OCR_VERSION));
}
function getWorker() {
  if (!workerPromise) {
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    workerPromise = createWorker('eng', 1, { workerPath: `${base}ocr/worker.min.js`, langPath: `${base}ocr`, corePath: `${base}ocr/core`, workerBlobURL: false }).catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}
async function readableImage(dataURL: string) {
  if (typeof document === 'undefined') return dataURL;
  const image = new Image(); image.src = dataURL; await image.decode();
  const scale = Math.min(2, 4096 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}
export function queueOcr(asset: Asset, options: { force?: boolean } = {}): Promise<void> {
  if (isIconStampFile(asset.id)) return Promise.resolve();
  const existing = jobs.get(asset.key); if (existing) return existing;
  const job = chain.then(async () => {
    const current = await db.assets.get(asset.key);
    if (!current?.dataURL || (!options.force && !needsImageOcr(current))) return;
    notify('Reading image text…');
    try {
      const worker = await getWorker(), image = await readableImage(current.dataURL);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      let result = await worker.recognize(image);
      if (!result.data.text.trim()) { await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO }); result = await worker.recognize(image); }
      const text = result.data.text.trim();
      await db.assets.update(asset.key, { ocrText: text, ocrStatus: 'done', ocrVersion: OCR_VERSION, dirty: true });
      notify(text ? 'Image text is searchable' : 'No readable printed text found. You can retry from Read text.');
    } catch {
      await db.assets.update(asset.key, { ocrStatus: 'failed' });
      notify('Couldn’t read image text. Your image is saved; retry from Read text.');
    }
  }).catch(() => notify('Image text recognition is unavailable.')).finally(() => { jobs.delete(asset.key); });
  jobs.set(asset.key, job); chain = job; return job;
}
