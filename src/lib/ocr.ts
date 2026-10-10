import { createWorker, type Worker } from 'tesseract.js';
import { db } from './db';
import type { Asset } from '../types';
let workerPromise: Promise<Worker> | null = null;
let chain = Promise.resolve();
let notify: (text: string) => void = () => {};
export function onOcrStatus(callback: (text: string) => void) { notify = callback; }
function getWorker() {
  if (!workerPromise) {
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    workerPromise = createWorker('eng', 1, { workerPath: `${base}ocr/worker.min.js`, langPath: `${base}ocr`, corePath: `${base}ocr/core`, workerBlobURL: false }).catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}
export function queueOcr(asset: Asset) {
  chain = chain.then(async () => {
    const current = await db.assets.get(asset.key);
    if (!current?.dataURL || current.ocrStatus === 'done') return;
    notify('Reading screenshot text…');
    try {
      const worker = await getWorker(); const result = await worker.recognize(current.dataURL);
      await db.assets.update(asset.key, { ocrText: result.data.text.trim(), ocrStatus: 'done', dirty: true });
      notify('Screenshot text is searchable');
    } catch {
      await db.assets.update(asset.key, { ocrStatus: 'failed' });
      notify('Couldn’t read image text. The image is saved; retry OCR in Settings.');
    }
  }).catch(() => notify('Screenshot text recognition is unavailable.'));
}
