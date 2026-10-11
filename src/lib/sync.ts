import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Board, Folder, Settings } from '../types';
import { recordKey } from '../types';
import { db, folderPath, touch } from './db';
import { blobToDataURL, dataURLToBlob } from './assets';
import { downloadDriveImage, uploadDriveImage } from './drive';

type CloudRow = Record<string, any>;
function folderFromCloud(row: CloudRow, scope: string): Folder {
  return { key: recordKey(scope, row.id), id: row.id, scope, name: row.name, parentId: row.parent_id, color: row.color, updatedAt: row.updated_at, deleted: row.deleted, dirty: false, remoteRevision: row.revision };
}
function boardFromCloud(row: CloudRow, scope: string): Board {
  return { key: recordKey(scope, row.id), id: row.id, scope, name: row.name, folderId: row.folder_id, elements: row.elements || [], appState: row.app_state || {}, assetIds: row.asset_ids || [], preview: null, updatedAt: row.updated_at, deleted: row.deleted, dirty: false, remoteRevision: row.revision };
}
export function preserveConflict<T extends Board | Folder>(record: T): T {
  const id = crypto.randomUUID();
  return { ...record, id, key: recordKey(record.scope, id), name: `${record.name} (conflict copy)`, remoteRevision: 0, ...touch() };
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
  for (const asset of dirtyAssets) {
    try {
      let storage = asset.storage; let remotePath = asset.remotePath;
      if (!remotePath) {
        if (!asset.dataURL) continue;
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
        if (current?.ocrText === asset.ocrText && current.ocrStatus === asset.ocrStatus) await db.assets.update(asset.key, { dirty: false });
      });
    } catch (error) {
      pendingImages = true;
      report(error instanceof Error ? error.message : 'Image sync is pending. Your local copy is saved.');
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
      if (images.some(x => !x?.remotePath || x.dirty)) { pendingImages = true; continue; }
    }
    const payload = isBoard
      ? { id: record.id, name: record.name, folder_id: record.folderId, elements: record.elements, app_state: record.appState, asset_ids: record.assetIds, deleted: record.deleted }
      : { id: record.id, name: record.name, parent_id: record.parentId, color: record.color, deleted: record.deleted };
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
        await table.put((isBoard ? boardFromCloud(remote, scope) : folderFromCloud(remote, scope)) as Board & Folder);
      });
      conflicts++; continue;
    }
    await db.transaction('rw', table, async () => {
      const current = await table.get(record.key);
      if (current) await table.update(record.key, { remoteRevision: data.revision, dirty: current.updatedAt !== record.updatedAt, ...(current.updatedAt === record.updatedAt ? { updatedAt: data.updated_at } : {}) });
    });
  }
  const [cloudFolders, cloudBoards, cloudAssets] = await Promise.all([allRows(client, 'note_folders', scope), allRows(client, 'note_boards', scope), allRows(client, 'note_assets', scope)]);
  await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
    for (const row of cloudFolders) {
      const existing = await db.folders.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.folders.put(folderFromCloud(row, scope));
    }
    for (const row of cloudBoards) {
      const existing = await db.boards.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.boards.put({ ...boardFromCloud(row, scope), preview: existing?.preview || null });
    }
    for (const row of cloudAssets) {
      const existing = await db.assets.get(recordKey(scope, row.id));
      if (!existing?.dirty) await db.assets.put({ key: recordKey(scope, row.id), id: row.id, scope, dataURL: existing?.dataURL, mimeType: row.mime_type, created: row.created_ms, storage: row.storage, remotePath: row.remote_path, ocrText: row.ocr_text || '', ocrStatus: row.ocr_status || 'done', ocrVersion: existing?.ocrVersion, dirty: false });
    }
  });
  report(conflicts ? `Saved a conflict copy of ${conflicts} item${conflicts === 1 ? '' : 's'} · sync again to upload it` : pendingImages ? 'Boards saved locally · some images are waiting to sync' : 'Everything is synced');
}
export async function importLocalWorkspace(scope: string) {
  const folders = await db.folders.where('scope').equals('local').toArray();
  const boards = await db.boards.where('scope').equals('local').toArray();
  const assets = await db.assets.where('scope').equals('local').toArray();
  const folderIds = new Map(folders.map(x => [x.id, crypto.randomUUID()]));
  await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
    for (const folder of folders.filter(x => !x.deleted)) {
      const id = folderIds.get(folder.id)!;
      await db.folders.put({ ...folder, id, key: recordKey(scope, id), scope, parentId: folder.parentId ? folderIds.get(folder.parentId) || null : null, remoteRevision: 0, ...touch() });
    }
    for (const board of boards.filter(x => !x.deleted)) {
      const id = crypto.randomUUID();
      await db.boards.put({ ...board, id, key: recordKey(scope, id), scope, folderId: board.folderId ? folderIds.get(board.folderId) || null : null, remoteRevision: 0, ...touch() });
    }
    for (const asset of assets) {
      const key = recordKey(scope, asset.id);
      if (!await db.assets.get(key)) await db.assets.put({ ...asset, key, scope, storage: null, remotePath: null, dirty: true });
    }
  });
}
