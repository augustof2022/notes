import type { Asset, Board, Folder } from '../types';

export interface PendingSyncItem { key: string; kind: 'board' | 'folder' | 'image'; name: string; reason: string; failed: boolean; conflict?: boolean }
export function syncErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The cloud request failed. Check your connection and retry.';
}
export function pendingImageMessage(count: number, errors: string[], conflicts = 0) {
  const reason = errors.find(x => /reconnect.*drive|drive.*reconnect/i.test(x)) || errors[0] || 'Retry uploads now. Open Note on the device where these images were added if their files are missing here.';
  return `${count} image${count === 1 ? '' : 's'} pending · ${reason}${conflicts ? ` · ${conflicts} sync conflict${conflicts === 1 ? '' : 's'} need${conflicts === 1 ? 's' : ''} review` : ''}`;
}
export function imageReady(asset: Asset | undefined) {
  // File upload and searchable-text metadata are separate. A board can use the
  // last published metadata while OCR finishes or another metadata update waits.
  return !!asset?.remotePath && (asset.metadataSaved === true || !asset.dirty);
}
export function pendingSyncItems(boards: Board[], folders: Folder[], assets: Asset[]): PendingSyncItem[] {
  const images = new Map(assets.map(asset => [asset.id, asset]));
  const pending: PendingSyncItem[] = [];
  for (const record of [...folders, ...boards]) {
    if (!record.dirty || record.purged) continue;
    const board = 'elements' in record;
    const waiting = board && !record.deleted ? record.assetIds.filter(id => !imageReady(images.get(id))).length : 0;
    pending.push({ key: record.key, kind: board ? 'board' : 'folder', name: record.name,
      failed: !!record.syncError || !!record.syncConflict, conflict: !!record.syncConflict,
      reason: record.syncError || (waiting ? `Waiting for ${waiting} image${waiting === 1 ? '' : 's'} to upload and register in the cloud.` : record.deleted ? 'Waiting to sync its move to Trash.' : 'Saved on this device; waiting to upload changes.') });
  }
  for (const asset of assets.filter(asset => asset.dirty)) {
    const names = boards.filter(board => !board.deleted && board.assetIds.includes(asset.id)).map(board => board.name);
    pending.push({ key: asset.key, kind: 'image', name: names.length ? `Image in ${names.join(', ')}` : 'Image', failed: !!asset.syncError,
      reason: asset.syncError || (!asset.remotePath ? 'Waiting to upload the image file.' : !imageReady(asset) ? 'File uploaded; waiting to register its location in the cloud.' : 'File uploaded; waiting to sync searchable text or image metadata.') });
  }
  return pending;
}
export function pendingSyncLabel(items: PendingSyncItem[]) {
  const counts = { board: 0, folder: 0, image: 0 };
  for (const item of items) counts[item.kind]++;
  return (Object.entries(counts) as [PendingSyncItem['kind'], number][]).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`).join(', ');
}
