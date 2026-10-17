import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Board, Folder, RecordBase, Settings } from '../types';
import { recordKey } from '../types';
import { db, folderPath, touch } from './db';
import { blobToDataURL, dataURLToBlob } from './assets';
import { downloadDriveImage, uploadDriveImage } from './drive';
import { imageReady, pendingSyncItems, pendingSyncLabel, syncErrorMessage } from './sync-status';

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
  return { ...record, id, key: recordKey(record.scope, id), name: `${record.name} (conflict copy)`, syncError: undefined, remoteRevision: 0, ...timestamps, createdAt: timestamps.updatedAt, createdAtEstimated: false };
}
async function allRows(client: SupabaseClient, table: string, scope: string, columns = '*', ids?: string[]) {
  const result: CloudRow[] = [];
  for (let from = 0;; from += 500) {
    let query = client.from(table).select(columns).eq('owner_id', scope);
    if (ids) query = query.in('id', ids);
    const { data, error } = await query.order('id').range(from, from + 499);
    if (error) throw error;
    result.push(...data); if (data.length < 500) break;
  }
  return result;
}
async function changedBoards(client: SupabaseClient, scope: string) {
  const local = await db.boards.where('scope').equals(scope).toArray();
  if (!local.length) return allRows(client, 'note_boards', scope);
  const known = new Map(local.map(board => [board.id, board]));
  // Poll a small revision list instead of downloading every saved drawing on
  // every check. No server migrations or client-clock watermark are needed.
  const manifest = await allRows(client, 'note_boards', scope, 'id,revision');
  const changed = manifest.filter(row => {
    const existing = known.get(row.id);
    return !existing || (!existing.dirty && existing.remoteRevision < row.revision);
  }).map(row => row.id);
  const rows: CloudRow[] = [];
  for (let index = 0; index < changed.length; index += 100) rows.push(...await allRows(client, 'note_boards', scope, '*', changed.slice(index, index + 100)));
  return rows;
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
class SyncCancelled extends Error {}
export interface SyncResult { complete: boolean; downloaded: boolean; pending: number; conflicts: number; deferred: boolean }
function recordData(record: Board | Folder) {
  return 'elements' in record
    ? { name: record.name, folder_id: record.folderId, elements: record.elements, app_state: record.appState, asset_ids: record.assetIds, deleted: record.deleted }
    : { name: record.name, parent_id: record.parentId, color: record.color, deleted: record.deleted };
}
function sameContent(a: Board | Folder, b: Board | Folder) {
  const canonical = (record: Board | Folder) => JSON.stringify(recordData(record), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return canonical(a) === canonical(b);
}
export async function syncWorkspace(client: SupabaseClient, scope: string, settings: Settings, report: (message: string) => void, options: { isCurrent?: () => boolean; isBoardBusy?: (key: string) => boolean } = {}): Promise<SyncResult> {
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new SyncCancelled('The active account changed; syncing stopped.'); };
  assertCurrent();
  if (!navigator.onLine) { report('Offline · changes are saved on this device'); return { complete: false, downloaded: false, pending: 0, conflicts: 0, deferred: false }; }
  let conflicts = 0, downloaded = false, deferred = false;
  const errors: string[] = [];
  // Refresh first, even when an upload is blocked. A failed local record must
  // never stop this device from receiving the rest of its cloud workspace.
  report('Checking the cloud for changes…');
  try {
    const [cloudFolders, cloudBoards, cloudAssets] = await Promise.all([allRows(client, 'note_folders', scope), changedBoards(client, scope), allRows(client, 'note_assets', scope)]);
    assertCurrent();
    await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
      for (const row of cloudFolders) {
        const existing = await db.folders.get(recordKey(scope, row.id));
        if (!existing?.dirty && (!existing || existing.remoteRevision <= row.revision)) await db.folders.put(folderFromCloud(row, scope, existing));
      }
      for (const row of cloudBoards) {
        const existing = await db.boards.get(recordKey(scope, row.id));
        if (options.isBoardBusy?.(recordKey(scope, row.id))) { deferred = true; continue; }
        if (!existing?.dirty && (!existing || existing.remoteRevision <= row.revision)) await db.boards.put({ ...boardFromCloud(row, scope, existing), preview: existing?.preview || null });
      }
      for (const row of cloudAssets) {
        const key = recordKey(scope, row.id), existing = await db.assets.get(key);
        if (!existing?.dirty) await db.assets.put({ key, id: row.id, scope, dataURL: existing?.dataURL, mimeType: row.mime_type, created: row.created_ms, storage: row.storage, remotePath: row.remote_path, ocrText: row.ocr_text || '', ocrStatus: row.ocr_status || 'done', ocrVersion: existing?.ocrVersion, dirty: false, metadataSaved: true });
        else if (!existing.remotePath || (existing.remotePath === row.remote_path && existing.storage === row.storage)) await db.assets.update(key, { storage: row.storage, remotePath: row.remote_path, metadataSaved: true });
      }
    });
    downloaded = true;
  } catch (error) { if (error instanceof SyncCancelled) throw error; errors.push(`Could not download cloud changes: ${syncErrorMessage(error)}`); }

  async function saveRecord(record: Board | Folder): Promise<void> {
    assertCurrent();
    const isBoard = 'elements' in record, kind = isBoard ? 'board' : 'folder';
    if (isBoard && options.isBoardBusy?.(record.key)) { deferred = true; return; }
    const table = isBoard ? db.boards : db.folders;
    try {
      const parentId = isBoard ? record.folderId : record.parentId;
      const parent = parentId ? await db.folders.get(recordKey(scope, parentId)) : undefined;
      if (parent && parent.remoteRevision === 0) throw new Error(`Waiting for folder “${parent.name}” to sync${parent.syncError ? `: ${parent.syncError}` : '.'}`);
      report(`Uploading ${kind} “${record.name}”…`);
      const creation = creationFromCloud({}, record);
      const payload = { id: record.id, ...recordData(record), created_at: creation.createdAt || record.updatedAt, created_at_estimated: creation.createdAt ? creation.createdAtEstimated : true };
      const { data, error } = await client.rpc('save_note', { p_kind: kind, p_record: payload, p_expected_revision: record.remoteRevision });
      assertCurrent();
      let saved = data;
      if (error) {
        if (!error.message.includes('NOTE_CONFLICT')) throw error;
        const { data: remote, error: readError } = await client.from(isBoard ? 'note_boards' : 'note_folders').select('*').eq('owner_id', scope).eq('id', record.id).single();
        if (readError) throw readError;
        assertCurrent();
        if (isBoard && options.isBoardBusy?.(record.key)) { deferred = true; return; }
        const remoteRecord = isBoard ? boardFromCloud(remote, scope, record as Board) : folderFromCloud(remote, scope, record as Folder);
        // A response can be lost after the server committed the save. Recognize
        // an identical retry instead of creating another conflict copy forever.
        if (sameContent(record, remoteRecord)) saved = remote;
        else {
          await db.transaction('rw', table, async () => {
            const latest = await table.get(record.key);
            if (latest) await table.put(preserveConflict(latest) as Board & Folder);
            await table.put((isBoard ? boardFromCloud(remote, scope, latest as Board | undefined) : folderFromCloud(remote, scope, latest as Folder | undefined)) as Board & Folder);
          });
          conflicts++; return;
        }
      }
      if (!saved || !Number.isFinite(saved.revision)) throw new Error('The cloud did not confirm this save. Please retry.');
      await db.transaction('rw', table, async () => {
        const current = await table.get(record.key);
        if (!current) return;
        const busy = isBoard && !!options.isBoardBusy?.(record.key);
        if (busy) deferred = true;
        const unchanged = !busy && sameContent(current, record);
        await table.update(record.key, { remoteRevision: saved.revision, dirty: !unchanged, syncError: undefined, ...creationFromCloud(saved, current), ...(unchanged ? { updatedAt: saved.updated_at } : {}) });
      });
    } catch (error) {
      if (error instanceof SyncCancelled) throw error;
      assertCurrent();
      const reason = syncErrorMessage(error);
      await table.update(record.key, { syncError: reason });
      errors.push(`${isBoard ? 'Board' : 'Folder'} “${record.name}”: ${reason}`);
    }
  }
  const folders = await db.folders.where('scope').equals(scope).toArray();
  for (const folder of folders.filter(x => x.dirty).sort((a, b) => folderPath(folders, a.parentId).length - folderPath(folders, b.parentId).length)) await saveRecord(folder);

  const boards = await db.boards.where('scope').equals(scope).filter(x => x.dirty).toArray();
  const waitingBoards: Board[] = [];
  for (const board of boards) {
    const images = board.deleted ? [] : await db.assets.bulkGet(board.assetIds.map(id => recordKey(scope, id)));
    if (images.some(asset => !imageReady(asset))) waitingBoards.push(board);
    else await saveRecord(board);
  }
  const dirtyAssets = await db.assets.where('scope').equals(scope).filter(x => x.dirty).toArray();
  for (let index = 0; index < dirtyAssets.length; index++) {
    assertCurrent();
    const asset = dirtyAssets[index];
    report(`Syncing image ${index + 1} of ${dirtyAssets.length}…`);
    try {
      let storage = asset.storage, remotePath = asset.remotePath;
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
        await db.assets.update(asset.key, { storage, remotePath });
      }
      assertCurrent();
      const { error } = await client.from('note_assets').upsert({ id: asset.id, owner_id: scope, mime_type: asset.mimeType, created_ms: asset.created, storage, remote_path: remotePath, ocr_text: asset.ocrText, ocr_status: asset.ocrStatus }, { onConflict: 'owner_id,id' });
      if (error) throw error;
      assertCurrent();
      await db.transaction('rw', db.assets, async () => {
        const current = await db.assets.get(asset.key);
        if (current) await db.assets.update(asset.key, { metadataSaved: true, syncError: undefined, dirty: current.ocrText !== asset.ocrText || current.ocrStatus !== asset.ocrStatus });
      });
    } catch (error) {
      if (error instanceof SyncCancelled) throw error;
      assertCurrent();
      const reason = syncErrorMessage(error);
      await db.assets.update(asset.key, { syncError: reason });
      errors.push(`Image: ${reason}`);
    }
  }
  for (const board of waitingBoards) {
    // Use the latest scene if the person kept editing during image uploads.
    const current = await db.boards.get(board.key);
    if (!current?.dirty) continue;
    const images = current.deleted ? [] : await db.assets.bulkGet(current.assetIds.map(id => recordKey(scope, id)));
    if (images.some(asset => !imageReady(asset))) {
      const reason = images.some(asset => !asset) ? 'Image file is missing here. Open Note on the device where you added it, then retry uploads.'
        : images.find(asset => asset?.syncError)?.syncError || 'Waiting for image files and their cloud metadata. Text recognition does not need to finish first.';
      await db.boards.update(current.key, { syncError: reason });
    } else await saveRecord(current);
  }
  assertCurrent();
  const [latestBoards, latestFolders, latestAssets] = await Promise.all([db.boards.where('scope').equals(scope).toArray(), db.folders.where('scope').equals(scope).toArray(), db.assets.where('scope').equals(scope).toArray()]);
  const pending = pendingSyncItems(latestBoards, latestFolders, latestAssets);
  const complete = downloaded && pending.length === 0 && errors.length === 0 && !deferred;
  report(complete ? 'Everything is synced' : pending.length ? `${pendingSyncLabel(pending)} pending · ${errors[0] || pending.find(item => item.failed)?.reason || (deferred ? 'Finish editing to sync the open board.' : conflicts ? 'A conflict copy is ready to upload.' : 'New changes arrived while syncing; another sync is queued.')}` : errors[0] || (deferred ? 'Finish editing to sync the open board.' : 'Cloud refresh is waiting to retry.'));
  return { complete, downloaded, pending: pending.length, conflicts, deferred };
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
