import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Board, Folder, RecordBase, Settings } from '../types';
import { recordKey } from '../types';
import { db, folderPath, touch } from './db';
import { blobToDataURL, dataURLToBlob } from './assets';
import { downloadDriveImage, uploadDriveImage } from './drive';
import { pendingImageMessage, syncErrorMessage } from './sync-status';

type CloudRow = Record<string, any>;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function creationFromCloud(row: CloudRow, existing?: Pick<RecordBase, 'createdAt' | 'createdAtEstimated'>) {
  const hasExisting = validDate(existing?.createdAt);
  const existingEstimated = existing?.createdAtEstimated !== false;
  // Older servers supplied created_at without recording whether it had been
  // backfilled. Only an explicit false flag confirms an original timestamp.
  const remoteEstimated = row.created_at_estimated !== false;
  // Keep the original local time when talking to older servers, or when their
  // migration only knows an estimate and this device knows the real date.
  if (hasExisting && (!validDate(row.created_at) || (remoteEstimated && !existingEstimated))) {
    return { createdAt: existing!.createdAt, createdAtEstimated: existingEstimated };
  }
  if (validDate(row.created_at)) return { createdAt: row.created_at, createdAtEstimated: remoteEstimated };
  return { createdAt: validDate(row.updated_at) ? row.updated_at : undefined, createdAtEstimated: true };
}
function folderFromCloud(row: CloudRow, scope: string, existing?: Folder): Folder {
  return { key: recordKey(scope, row.id), id: row.id, scope, name: row.name, parentId: row.parent_id, color: row.color, ...creationFromCloud(row, existing), updatedAt: row.updated_at, deleted: row.deleted, dirty: false, remoteRevision: row.revision };
}
function boardFromCloud(row: CloudRow, scope: string, existing?: Board): Board {
  return { key: recordKey(scope, row.id), id: row.id, scope, name: row.name, folderId: row.folder_id, elements: row.elements || [], appState: row.app_state || {}, assetIds: row.asset_ids || [], preview: null, ...creationFromCloud(row, existing), updatedAt: row.updated_at, deleted: row.deleted, dirty: false, remoteRevision: row.revision };
}
export function preserveConflict<T extends Board | Folder>(record: T): T {
  const id = crypto.randomUUID();
  const timestamps = touch();
  return { ...record, id, key: recordKey(record.scope, id), name: `${record.name} (conflict copy)`, remoteRevision: 0, ...timestamps, createdAt: timestamps.updatedAt, createdAtEstimated: false };
}
async function allRows(client: SupabaseClient, table: string, scope: string) {
  const result: CloudRow[] = [];
  for (let from = 0;; from += 500) {
    const { data, error } = await client.from(table).select('*').eq('owner_id', scope).order('id').range(from, from + 499);
    if (error) throw error;
    result.push(...data); if (data.length < 500) break;
  }
  return result;
}
export async function downloadAsset(client: SupabaseClient, asset: Asset): Promise<Asset> {
  if (asset.dataURL || !asset.remotePath) return asset;
  let blob: Blob;
  if (asset.storage === 'drive') blob = await downloadDriveImage(asset.remotePath, asset.scope);
  else {
    const { data, error } = await client.storage.from('note-images').download(asset.remotePath);
    if (error) throw error; blob = data;
  }
  const dataURL = await blobToDataURL(blob);
  await db.assets.update(asset.key, { dataURL }); return { ...asset, dataURL };
}
export async function syncWorkspace(client: SupabaseClient, scope: string, settings: Settings, report: (message: string) => void) {
  if (!navigator.onLine) { report('Offline · saved on this device'); return; }
  const dirtyAssets = await db.assets.where('scope').equals(scope).filter(x => x.dirty).toArray();
  let pendingImages = false;
  const failedImages = new Set<string>();
  const imageErrors: string[] = [];
  for (const asset of dirtyAssets) {
    try {
      let storage = asset.storage; let remotePath = asset.remotePath;
      if (!remotePath) {
        if (!asset.dataURL) throw new Error('Image file is missing here. Open Note on the device where you added it, then retry uploads.');
        const blob = await dataURLToBlob(asset.dataURL);
        storage = settings.imageStore;
        if (storage === 'drive') remotePath = await uploadDriveImage(asset.id, scope, blob);
        else {
          remotePath = `${scope}/${asset.id}`;
          const { error } = await client.storage.from('note-images').upload(remotePath, blob, { contentType: asset.mimeType, upsert: true });
          if (error) throw error;
        }
        // Persist the location before metadata so retries don't upload twice.
        await db.assets.update(asset.key, { storage, remotePath });
      }
      const { error } = await client.from('note_assets').upsert({ id: asset.id, owner_id: scope, mime_type: asset.mimeType, created_ms: asset.created, storage, remote_path: remotePath, ocr_text: asset.ocrText, ocr_status: asset.ocrStatus }, { onConflict: 'owner_id,id' });
      if (error) throw error;
      await db.transaction('rw', db.assets, async () => {
        const current = await db.assets.get(asset.key);
        if (current?.ocrText === asset.ocrText && current.ocrStatus === asset.ocrStatus) await db.assets.update(asset.key, { dirty: false, syncError: undefined });
      });
    } catch (error) {
      pendingImages = true;
      failedImages.add(asset.id);
      const reason = syncErrorMessage(error); imageErrors.push(reason);
      await db.assets.update(asset.key, { syncError: reason });
      report(reason);
    }
  }
  const folders = await db.folders.where('scope').equals(scope).toArray();
  const dirtyFolders = folders.filter(x => x.dirty).sort((a, b) => folderPath(folders, a.parentId).length - folderPath(folders, b.parentId).length);
  const dirtyBoards = await db.boards.where('scope').equals(scope).filter(x => x.dirty).toArray();
  let conflicts = 0;
  for (const record of [...dirtyFolders, ...dirtyBoards]) {
    const isBoard = 'elements' in record;
    // Other devices need both the uploaded file and its saved metadata.
    if (isBoard) {
      const images = await db.assets.bulkGet(record.assetIds.map(id => recordKey(scope, id)));
      const waiting = record.assetIds.filter((_, index) => !images[index]?.remotePath || images[index]?.dirty);
      if (waiting.length) {
        pendingImages = true;
        for (const id of waiting) failedImages.add(id);
        if (images.some(x => !x)) imageErrors.push('Image file is missing here. Open Note on the device where you added it, then retry uploads.');
        continue;
      }
    }
    const creation = creationFromCloud({}, record);
    const creationPayload = { created_at: creation.createdAt || record.updatedAt, created_at_estimated: creation.createdAt ? creation.createdAtEstimated : true };
    const payload = isBoard
      ? { id: record.id, name: record.name, folder_id: record.folderId, elements: record.elements, app_state: record.appState, asset_ids: record.assetIds, deleted: record.deleted, ...creationPayload }
      : { id: record.id, name: record.name, parent_id: record.parentId, color: record.color, deleted: record.deleted, ...creationPayload };
    const { data, error } = await client.rpc('save_note', { p_kind: isBoard ? 'board' : 'folder', p_record: payload, p_expected_revision: record.remoteRevision });
    const table = isBoard ? db.boards : db.folders;
    if (error) {
      if (!error.message.includes('NOTE_CONFLICT')) throw error;
      const { data: remote, error: readError } = await client.from(isBoard ? 'note_boards' : 'note_folders').select('*').eq('id', record.id).single();
      if (readError) throw readError;
      await db.transaction('rw', table, async () => {
        // Preserve the latest local edit, including changes made during the request.
        const latest = await table.get(record.key);
        if (latest) await table.put(preserveConflict(latest) as Board & Folder);
        await table.put((isBoard ? boardFromCloud(remote, scope, latest as Board | undefined) : folderFromCloud(remote, scope, latest as Folder | undefined)) as Board & Folder);
      });
      conflicts++; continue;
    }
    await db.transaction('rw', table, async () => {
      const current = await table.get(record.key);
      if (current) await table.update(record.key, { remoteRevision: data.revision, dirty: current.updatedAt !== record.updatedAt, ...creationFromCloud(data, current), ...(current.updatedAt === record.updatedAt ? { updatedAt: data.updated_at } : {}) });
    });
  }
  const [cloudFolders, cloudBoards, cloudAssets] = await Promise.all([allRows(client, 'note_folders', scope), allRows(client, 'note_boards', scope), allRows(client, 'note_assets', scope)]);
  await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
    for (const row of cloudFolders) {
      const existing = await db.folders.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.folders.put(folderFromCloud(row, scope, existing));
    }
    for (const row of cloudBoards) {
      const existing = await db.boards.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.boards.put({ ...boardFromCloud(row, scope, existing), preview: existing?.preview || null });
    }
    for (const row of cloudAssets) {
      const existing = await db.assets.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.assets.put({ key: recordKey(scope, row.id), id: row.id, scope, dataURL: existing?.dataURL, mimeType: row.mime_type, created: row.created_ms, storage: row.storage, remotePath: row.remote_path, ocrText: row.ocr_text || '', ocrStatus: row.ocr_status || 'done', ocrVersion: existing?.ocrVersion, dirty: false });
    }
  });
  report(pendingImages ? pendingImageMessage(failedImages.size, imageErrors, conflicts) : conflicts ? `Saved a conflict copy of ${conflicts} item${conflicts === 1 ? '' : 's'} · sync again to upload it` : 'Everything is synced');
}
export async function importLocalWorkspace(scope: string) {
  const folders = await db.folders.where('scope').equals('local').toArray();
  const boards = await db.boards.where('scope').equals('local').toArray();
  const assets = await db.assets.where('scope').equals('local').toArray();
  const folderIds = new Map(folders.map(x => [x.id, crypto.randomUUID()]));
  await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
    for (const folder of folders.filter(x => !x.deleted)) {
      const id = folderIds.get(folder.id)!;
      await db.folders.put({ ...folder, ...creationFromCloud({ updated_at: folder.updatedAt }, folder), id, key: recordKey(scope, id), scope, parentId: folder.parentId ? folderIds.get(folder.parentId) || null : null, remoteRevision: 0, ...touch() });
    }
    for (const board of boards.filter(x => !x.deleted)) {
      const id = crypto.randomUUID();
      await db.boards.put({ ...board, ...creationFromCloud({ updated_at: board.updatedAt }, board), id, key: recordKey(scope, id), scope, folderId: board.folderId ? folderIds.get(board.folderId) || null : null, remoteRevision: 0, ...touch() });
    }
    for (const asset of assets) {
      const key = recordKey(scope, asset.id);
      if (!await db.assets.get(key)) await db.assets.put({ ...asset, key, scope, storage: null, remotePath: null, dirty: true });
    }
  });
}
