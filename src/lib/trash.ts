import type { SupabaseClient } from '@supabase/supabase-js';
import type { Board, Folder } from '../types';
import { db, descendantFolderIds } from './db';

export interface TrashSelection { folders: Folder[]; boards: Board[] }
export interface TrashDeleteOptions { isCurrent?: () => boolean }
const changedMessage = 'Trash changed on this or another device. Sync, review the remaining items, and try again.';

export function needsTrashUpgrade(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === 'PGRST202' && /purge_note_trash/.test(value.message || '')
    || value?.code === '42883' && /purge_note_trash/.test(value.message || '')
    || ['42703', 'PGRST204'].includes(value?.code || '') && /purged/.test(value?.message || '');
}
export function trashErrorMessage(error: unknown) {
  if (needsTrashUpgrade(error)) return 'Run the permanent-trash SQL update in Supabase, then try again.';
  const message = (error as { message?: string } | null)?.message;
  if (message?.includes('NOTE_TRASH_CHANGED')) return changedMessage;
  return message || 'Could not permanently delete these items. They remain in Trash; try again.';
}
function assertSelection(scope: string, selection: TrashSelection) {
  if (new Set(selection.folders.map(item => item.id)).size !== selection.folders.length
    || new Set(selection.boards.map(item => item.id)).size !== selection.boards.length) throw new Error(changedMessage);
  if ([...selection.folders, ...selection.boards].some(item => item.scope !== scope || !item.deleted || item.purged)) {
    throw new Error(changedMessage);
  }
}
function sameSnapshot(current: Folder | Board | undefined, item: Folder | Board) {
  return current?.deleted && !current.purged && current.remoteRevision === item.remoteRevision
    && current.updatedAt === item.updatedAt && current.dirty === item.dirty;
}
async function assertLocalSnapshot(scope: string, selection: TrashSelection) {
  for (const item of selection.folders) if (!sameSnapshot(await db.folders.get(item.key), item)) throw new Error(changedMessage);
  for (const item of selection.boards) if (!sameSnapshot(await db.boards.get(item.key), item)) throw new Error(changedMessage);
  if (!selection.folders.length) return;
  const folderIds = new Set(selection.folders.map(item => item.id)), boardIds = new Set(selection.boards.map(item => item.id));
  const folders = await db.folders.where('scope').equals(scope).toArray(), boards = await db.boards.where('scope').equals(scope).toArray();
  if (folders.some(item => !item.purged && item.parentId && folderIds.has(item.parentId) && !folderIds.has(item.id))
    || boards.some(item => !item.purged && item.folderId && folderIds.has(item.folderId) && !boardIds.has(item.id))) throw new Error(changedMessage);
}
/** Capture exactly the currently displayed Trash, including descendants of a folder. */
export async function trashSelection(scope: string, target?: { kind: 'folder' | 'board'; id: string }): Promise<TrashSelection> {
  const [folders, boards] = await Promise.all([
    db.folders.where('scope').equals(scope).toArray(), db.boards.where('scope').equals(scope).toArray()
  ]);
  const visibleFolders = folders.filter(item => !item.purged), visibleBoards = boards.filter(item => !item.purged);
  let selection: TrashSelection;
  if (!target) selection = { folders: visibleFolders.filter(item => item.deleted), boards: visibleBoards.filter(item => item.deleted) };
  else if (target.kind === 'board') selection = { folders: [], boards: visibleBoards.filter(item => item.id === target.id) };
  else {
    const ids = descendantFolderIds(visibleFolders, target.id);
    selection = { folders: visibleFolders.filter(item => ids.has(item.id)), boards: visibleBoards.filter(item => item.folderId && ids.has(item.folderId)) };
  }
  assertSelection(scope, selection);
  if (target && ![...selection.folders, ...selection.boards].some(item => item.id === target.id)) throw new Error(changedMessage);
  return selection;
}
function tombstone<T extends Folder | Board>(item: T, remote: Record<string, any>): T {
  const base = {
    ...item, name: remote.name, purged: true, deleted: true, dirty: false,
    remoteRevision: remote.revision, updatedAt: remote.updated_at,
    syncError: undefined, syncBase: undefined, syncConflict: undefined
  };
  return ('elements' in item
    ? { ...base, folderId: null, elements: [], appState: {}, assetIds: [], preview: null }
    : { ...base, parentId: null, color: '#b6a5e5' }) as T;
}
/** Permanently delete an explicit, reviewed snapshot. Shared image files are retained. */
export async function permanentDelete(scope: string, selection: TrashSelection, client: SupabaseClient | null, options: TrashDeleteOptions = {}) {
  assertSelection(scope, selection);
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error('Account changed. Open Trash in the current account and try again.'); };
  assertCurrent();
  if (!selection.folders.length && !selection.boards.length) return;
  // Validate again immediately before the external operation, after any UI confirmation.
  await db.transaction('r', db.folders, db.boards, async () => {
    await assertLocalSnapshot(scope, selection);
  });
  assertCurrent();
  if (scope === 'local') {
    await db.transaction('rw', db.folders, db.boards, async () => {
      await assertLocalSnapshot(scope, selection);
      await db.boards.bulkDelete(selection.boards.map(item => item.key));
      await db.folders.bulkDelete(selection.folders.map(item => item.key));
    });
    return;
  }
  if (!client || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw new Error('Connect to the internet to permanently delete synced Trash.');
  const result = await client.rpc('purge_note_trash', {
    p_folders: selection.folders.map(item => ({ id: item.id, revision: item.remoteRevision })),
    p_boards: selection.boards.map(item => ({ id: item.id, revision: item.remoteRevision }))
  });
  if (result.error) throw result.error;
  assertCurrent();
  const remote = result.data as { folders?: Record<string, any>[]; boards?: Record<string, any>[] } | null;
  for (const kind of ['folders', 'boards'] as const) {
    const rows = remote?.[kind];
    if (!Array.isArray(rows) || rows.length !== selection[kind].length || selection[kind].some(item => !rows.some(row => row.id === item.id && row.owner_id === scope && row.purged && row.deleted && Number.isInteger(row.revision)))) {
      throw new Error('Deletion response was incomplete. Sync to check Trash before trying again.');
    }
  }
  await db.transaction('rw', db.folders, db.boards, async () => {
    // A completed permanent deletion wins over a late local edit or restore.
    // The server marker prevents any old device from publishing that edit again.
    for (const item of selection.folders) await db.folders.put(tombstone(item, remote!.folders!.find(row => row.id === item.id)!));
    for (const item of selection.boards) await db.boards.put(tombstone(item, remote!.boards!.find(row => row.id === item.id)!));
  });
}
export async function emptyTrash(scope: string, client: SupabaseClient | null, options: TrashDeleteOptions = {}) {
  return permanentDelete(scope, await trashSelection(scope), client, options);
}
