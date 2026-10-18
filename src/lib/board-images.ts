import type { SupabaseClient } from '@supabase/supabase-js';
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { db } from './db';
import { downloadAsset } from './sync';
import { recordKey } from '../types';

export interface ImageLoadIssue { id: string; reason: string; reconnect: boolean }
export interface BoardImageState { boardKey: string; total: number; loaded: number; loading: boolean; issues: ImageLoadIssue[] }
export function boardImageIds(elements: readonly ExcalidrawElement[]) {
  return [...new Set(elements.flatMap(element => element.type === 'image' && !element.isDeleted && element.fileId ? [element.fileId] : []))].sort();
}
export function imageLoadLabel(state: BoardImageState) {
  if (state.loading) return `Loading images · ${state.loaded} of ${state.total}`;
  if (state.issues.length) return `${state.issues.length} image${state.issues.length === 1 ? '' : 's'} could not load · ${state.loaded} of ${state.total} ready`;
  return `${state.loaded} image${state.loaded === 1 ? '' : 's'} ready on this device`;
}
export async function loadBoardImages({ boardKey, scope, ids, client, files, isCurrent, onFile, onProgress }: {
  boardKey: string; scope: string; ids: string[]; client: SupabaseClient | null; files: BinaryFiles;
  isCurrent: () => boolean; onFile: (file: BinaryFileData) => void; onProgress: (state: BoardImageState) => void;
}) {
  const unique = [...new Set(ids)], waiting = unique.filter(id => !files[id]?.dataURL);
  const state: BoardImageState = { boardKey, total: unique.length, loaded: unique.length - waiting.length, loading: waiting.length > 0, issues: [] };
  const publish = () => { if (isCurrent()) onProgress({ ...state, issues: [...state.issues] }); };
  const fail = (id: string, error: unknown) => {
    const reason = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Could not load this image. Check your connection and retry.';
    state.issues.push({ id, reason, reconnect: /reconnect.*(?:google|drive)|(?:google|drive).*reconnect/i.test(reason) });
  };
  publish();
  if (!waiting.length || !isCurrent()) return;
  const assets = await db.assets.bulkGet(waiting.map(id => recordKey(scope, id)));
  const queue: number[] = [];
  // Supply every cached image first, even if an earlier remote image is slow.
  for (let index = 0; index < waiting.length && isCurrent(); index++) {
    const asset = assets[index];
    if (!asset?.dataURL) { queue.push(index); continue; }
    onFile({ id: asset.id, dataURL: asset.dataURL, mimeType: asset.mimeType, created: asset.created } as BinaryFileData);
    state.loaded++;
  }
  publish();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (next < queue.length && isCurrent()) {
      const index = queue[next++], id = waiting[index];
      try {
        let asset = assets[index];
        if (!asset) throw new Error('Image details have not arrived on this device. Sync again; if they remain missing, sync the device where you added the image.');
        if (!client) throw new Error('Sign in to the Note account that owns this board to load its cloud images.');
        if (!navigator.onLine) throw new Error('Offline. This image is not cached on this device yet; it will retry when you reconnect.');
        asset = await downloadAsset(client, asset);
        if (!isCurrent()) return;
        if (!asset.dataURL) throw new Error('The image download did not finish. Retry images.');
        onFile({ id, dataURL: asset.dataURL, mimeType: asset.mimeType, created: asset.created } as BinaryFileData);
        state.loaded++;
      } catch (error) { if (isCurrent()) fail(id, error); }
      publish();
    }
  }));
  state.loading = false; publish();
}
