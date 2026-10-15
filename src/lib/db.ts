import Dexie, { type Table } from 'dexie';
import type { Asset, Board, Folder, Settings } from '../types';
import { recordKey } from '../types';
import { appConfig } from '../config';
import { DEFAULT_PEN_WIDTH } from './canvas-behavior';
import { snapState } from './snapping';

class NoteDB extends Dexie {
  folders!: Table<Folder, string>; boards!: Table<Board, string>; assets!: Table<Asset, string>;
  constructor() {
    super('note-canvas-v1');
    this.version(1).stores({ folders: '&key, scope, id, parentId', boards: '&key, scope, id, folderId', assets: '&key, scope, id' });
  }
}
export const db = new NoteDB();
export const settingsDefaults: Settings = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || appConfig.supabaseUrl,
  supabaseKey: import.meta.env.VITE_SUPABASE_ANON_KEY || appConfig.supabaseKey,
  imageStore: 'supabase', ocrEnabled: true, theme: 'light'
};
export function getSettings(): Settings {
  try { const saved = JSON.parse(localStorage.getItem('note-settings') || '{}'); return { ...settingsDefaults, ...saved, supabaseUrl: saved.supabaseUrl || settingsDefaults.supabaseUrl, supabaseKey: saved.supabaseKey || settingsDefaults.supabaseKey }; }
  catch { return settingsDefaults; }
}
export function storeSettings(settings: Settings) { localStorage.setItem('note-settings', JSON.stringify(settings)); }
export function watchSettings(onChange: (settings: Settings) => void) {
  const changed = (event: StorageEvent) => {
    if (event.storageArea !== localStorage || (event.key !== null && event.key !== 'note-settings')) return;
    onChange(getSettings());
  };
  window.addEventListener('storage', changed);
  return () => window.removeEventListener('storage', changed);
}
export const touch = () => ({ updatedAt: new Date().toISOString(), dirty: true });
export async function newFolder(scope: string, name: string, parentId: string | null): Promise<Folder> {
  const id = crypto.randomUUID();
  const folder: Folder = { key: recordKey(scope, id), id, scope, name, parentId, color: '#b6a5e5', ...touch(), deleted: false, remoteRevision: 0 };
  await db.folders.add(folder); return folder;
}
export async function newBoard(scope: string, name: string, folderId: string | null): Promise<Board> {
  const id = crypto.randomUUID();
  const board: Board = { key: recordKey(scope, id), id, scope, name, folderId, elements: [], appState: { viewBackgroundColor: '#faf9f6', currentItemFontFamily: 2, currentItemRoughness: 0, currentItemStrokeWidth: DEFAULT_PEN_WIDTH, ...snapState('off') }, assetIds: [], preview: null, ...touch(), deleted: false, remoteRevision: 0 };
  await db.boards.add(board); return board;
}
export async function loadWorkspace(scope: string) {
  const [folders, boards] = await Promise.all([db.folders.where('scope').equals(scope).toArray(), db.boards.where('scope').equals(scope).toArray()]);
  return { folders: folders.filter(x => !x.deleted), boards: boards.filter(x => !x.deleted) };
}
export async function trashFolder(scope: string, id: string) {
  const { folders, boards } = await loadWorkspace(scope);
  const ids = descendantFolderIds(folders, id);
  await db.transaction('rw', db.folders, db.boards, async () => {
    for (const folder of folders.filter(x => ids.has(x.id))) await db.folders.update(folder.key, { deleted: true, ...touch() });
    for (const board of boards.filter(x => x.folderId && ids.has(x.folderId))) await db.boards.update(board.key, { deleted: true, ...touch() });
  });
}
export function descendantFolderIds(folders: Folder[], id: string | null): Set<string> {
  if (id === null) return new Set(folders.map(x => x.id));
  const ids = new Set([id]); let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) { ids.add(folder.id); changed = true; }
  }
  return ids;
}
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const result: Folder[] = []; const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); const folder = folders.find(x => x.id === id); if (!folder) break;
    result.unshift(folder); id = folder.parentId;
  }
  return result;
}
export function canMoveFolder(folders: Folder[], id: string, destination: string | null) {
  return destination === null || !descendantFolderIds(folders, id).has(destination);
}
export async function seedLocal() {
  if (localStorage.getItem('note-welcomed')) return;
  await db.transaction('rw', db.folders, db.boards, async () => {
    if (await db.boards.where('scope').equals('local').count()) return;
    const folder = await newFolder('local', 'My ideas', null);
    await newBoard('local', 'My first board', folder.id);
    localStorage.setItem('note-welcomed', 'true');
  });
}
