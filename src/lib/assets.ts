import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import { db } from './db';
import type { Asset } from '../types';
import { recordKey } from '../types';
import { isIconStampFile } from './icon-stamps';
import { isRichTextFile } from './rich-text';

export async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(new Error('Could not read image.')); reader.readAsDataURL(blob); });
}
export async function dataURLToBlob(url: string) { return (await fetch(url)).blob(); }
async function compactImage(dataURL: string) {
  const original = await dataURLToBlob(dataURL);
  const image = await createImageBitmap(original);
  // Keep original dimensions so small screenshot text stays legible.
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  canvas.getContext('2d')!.drawImage(image, 0, 0); image.close();
  const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.94));
  return compressed && compressed.size < original.size ? compressed : original;
}
export async function storeSceneFiles(scope: string, files: BinaryFiles, ocrEnabled: boolean): Promise<Asset[]> {
  const added: Asset[] = [];
  for (const file of Object.values(files)) {
    if (isRichTextFile(file.id)) continue;
    const key = recordKey(scope, file.id);
    if (await db.assets.get(key)) continue;
    let blob: Blob;
    try { blob = await compactImage(file.dataURL); } catch { blob = await dataURLToBlob(file.dataURL); }
    const asset: Asset = { key, id: file.id, scope, dataURL: await blobToDataURL(blob), mimeType: blob.type || file.mimeType,
      created: file.created, storage: null, remotePath: null, ocrText: '', ocrStatus: isIconStampFile(file.id) ? 'done' : ocrEnabled ? 'pending' : 'failed', dirty: true };
    await db.assets.put(asset); added.push(asset);
  }
  return added;
}
export async function localSceneFiles(scope: string, ids: string[]): Promise<BinaryFiles> {
  const files: BinaryFiles = {};
  for (const id of ids) {
    const asset = await db.assets.get(recordKey(scope, id));
    if (asset?.dataURL) files[id] = { id, dataURL: asset.dataURL, mimeType: asset.mimeType, created: asset.created } as BinaryFileData;
  }
  return files;
}
