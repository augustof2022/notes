import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Session } from '@supabase/supabase-js';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, CircleHelp, ChevronDown, ChevronRight, Cloud, CloudOff, Folder as FolderIcon, FolderPlus, Grid2X2, Image, Keyboard, LayoutGrid, Loader2, Menu, MoreHorizontal, Move, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Plus, RefreshCw, Search, Settings as SettingsIcon, Sparkles, StickyNote, Trash2, TriangleAlert, X } from 'lucide-react';
import type { Asset, Board, Folder, SearchMatch, Settings } from './types';
import { recordKey } from './types';
import { canMoveFolder, db, descendantFolderIds, folderPath, getSettings, loadWorkspace, newBoard, newFolder, seedLocal, storeSettings, touch, trashFolder, watchSettings } from './lib/db';
import { getSupabase } from './lib/supabase';
import { appConfig } from './config';
import { downloadAsset, importLocalWorkspace, syncWorkspace } from './lib/sync';
import { createSyncRunner, SYNC_IDLE_MS, SYNC_POLL_MS } from './lib/sync-runner';
import { pendingSyncItems, pendingSyncLabel } from './lib/sync-status';
import { SyncDetails } from './components/SyncDetails';
import { disconnectDrive, driveConnected, googleSignInUrl, useGoogleDriveSession } from './lib/drive';
import { needsImageOcr, onOcrStatus, queueOcr } from './lib/ocr';
import { searchBoards } from './lib/search';
import { BoardCanvas, type CanvasHandle } from './components/BoardCanvas';
import { Modal } from './components/Modal';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { readOAuthReturn } from './lib/oauth-return';
import { LibrarySort } from './components/LibrarySort';
import { readLibrarySorts, sortLibraryRecords, storeLibrarySorts } from './lib/library-sort';
import { APP_VERSION } from './lib/version';

type Dialog = { kind: 'folder' | 'board' | 'rename' | 'move'; record?: Board | Folder } | { kind: 'settings' | 'auth' | 'help' | 'search' } | null;
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
function download(name: string, blob: Blob) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function relativeDate(date: string) {
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  return days < 1 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Something went wrong. Please try again.'; }
function importedCreation(record: { createdAt?: unknown; createdAtEstimated?: unknown; updatedAt?: unknown }) {
  const valid = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
  return valid(record.createdAt)
    ? { createdAt: record.createdAt, createdAtEstimated: record.createdAtEstimated !== false }
    : { createdAt: valid(record.updatedAt) ? record.updatedAt : new Date().toISOString(), createdAtEstimated: true };
}
function readSidebarCollapsed() { try { return localStorage.getItem('note-sidebar-collapsed') === 'true'; } catch { return false; } }

export default function App() {
  const [oauthReturn] = useState(() => readOAuthReturn(location.href));
  const [authError, setAuthError] = useState(oauthReturn?.message || '');
  const [settings, setSettings] = useState<Settings>(getSettings);
  const [session, setSession] = useState<Session | null>(null);
  const scope = session?.user.id || 'local';
  const [workspace, setWorkspace] = useState<{ folders: Folder[]; boards: Board[] }>({ folders: [], boards: [] });
  const [librarySorts, setLibrarySorts] = useState(readLibrarySorts);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [trash, setTrash] = useState<(Board | Folder)[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [jumpId, setJumpId] = useState<string>();
  const [view, setView] = useState<'library' | 'trash'>('library');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(oauthReturn ? { kind: 'auth' } : null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [syncStatus, setSyncStatus] = useState('Saved on this device');
  const [syncing, setSyncing] = useState(false);
  const [syncDetails, setSyncDetails] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [searchFolderId, setSearchFolderId] = useState<string | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [driveRevision, setDriveRevision] = useState(0);
  const canvasRef = useRef<CanvasHandle>(null);
  const activeScope = useRef(scope); activeScope.current = scope;
  const syncPromise = useRef<Promise<void> | null>(null);
  const syncRunner = useRef(createSyncRunner());
  const idleSyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirtyVersions = useRef(new Map<string, string>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  const client = getSupabase();
  const currentBoard = workspace.boards.find(x => x.id === boardId);
  const currentFolder = workspace.folders.find(x => x.id === folderId);
  const path = folderPath(workspace.folders, currentBoard?.folderId ?? folderId);
  const message = useCallback((text: string) => {
    setToast(text); if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 7000);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; storeSettings(settings); }, [settings]);
  useEffect(() => watchSettings(setSettings), []);
  useEffect(() => storeLibrarySorts(librarySorts), [librarySorts]);
  useEffect(() => { try { localStorage.setItem('note-sidebar-collapsed', String(sidebarCollapsed)); } catch { /* Collapsing still works without browser storage. */ } }, [sidebarCollapsed]);
  useEffect(() => {
    if (oauthReturn) history.replaceState(history.state, '', oauthReturn.url);
  }, [oauthReturn]);
  useEffect(() => {
    void seedLocal().catch(error => message(messageOf(error)));
    const event = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    window.addEventListener('beforeinstallprompt', event);
    return () => window.removeEventListener('beforeinstallprompt', event);
  }, []);
  useEffect(() => {
    if (!client) { setSession(null); return; }
    let alive = true;
    void client.auth.getSession().then(({ data, error }) => { if (alive) { if (error) message(messageOf(error)); setSession(data.session); } });
    const { data } = client.auth.onAuthStateChange((_event, session) => { if (alive) setSession(session); });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, [client]);
  useEffect(() => {
    let alive = true;
    void useGoogleDriveSession(session).then(connected => {
      if (!alive || !connected) return;
      setDriveRevision(previous => previous + 1);
      void canvasRef.current?.reloadImages().catch(error => message(messageOf(error)));
    }).catch(error => { if (alive) message(messageOf(error)); });
    return () => { alive = false; };
  }, [session?.user.id, session?.provider_token]);
  useEffect(() => {
    setFolderId(null); setBoardId(null); setWorkspace({ folders: [], boards: [] }); setAssets([]); setView('library');
    setSyncStatus(scope === 'local' ? 'Saved on this device' : 'Ready to sync');
    setLastChecked(null); setLastSynced(null); setSyncDetails(false); setSyncing(false); dirtyVersions.current.clear();
    clearTimeout(idleSyncTimer.current);
    const subscription = liveQuery(async () => ({
      workspace: await loadWorkspace(scope), assets: await db.assets.where('scope').equals(scope).toArray(),
      trash: [...await db.folders.where('scope').equals(scope).filter(x => x.deleted).toArray(), ...await db.boards.where('scope').equals(scope).filter(x => x.deleted).toArray()]
    })).subscribe({ next: data => { setWorkspace(data.workspace); setAssets(data.assets); setTrash(data.trash); }, error: error => message(`Device storage could not open: ${messageOf(error)}`) });
    return () => subscription.unsubscribe();
  }, [scope]);
  const sync = useCallback(async (manual = true) => {
    if (!client || scope === 'local' || activeScope.current !== scope) return;
    const promise = syncRunner.current.request(async () => {
      if (activeScope.current !== scope) return;
      setSyncing(true);
      try {
        // Every queued pass flushes again, including edits made during an upload.
        await canvasRef.current?.flush();
        let result = await syncWorkspace(client, scope, settings, text => { if (activeScope.current === scope) setSyncStatus(text); }, { isCurrent: () => activeScope.current === scope, isBoardBusy: key => canvasRef.current?.hasPendingChanges(key) || false });
        if (result.conflicts) message('Your changes are saved in a conflict copy because another device edited the same item.');
        // Drain successful in-flight edits and conflict copies without waiting
        // for the polling timer. Failed items retain their explanation and retry
        // on the next poll or manual attempt rather than looping aggressively.
        for (let attempt = 0; attempt < 2 && result.downloaded && !result.deferred && result.pending > 0 && activeScope.current === scope; attempt++) {
          await canvasRef.current?.flush();
          const [boards, folders, images] = await Promise.all([db.boards.where('scope').equals(scope).toArray(), db.folders.where('scope').equals(scope).toArray(), db.assets.where('scope').equals(scope).toArray()]);
          const waiting = pendingSyncItems(boards, folders, images);
          if (!waiting.length || waiting.some(item => item.failed)) break;
          result = await syncWorkspace(client, scope, settings, text => { if (activeScope.current === scope) setSyncStatus(text); }, { isCurrent: () => activeScope.current === scope, isBoardBusy: key => canvasRef.current?.hasPendingChanges(key) || false });
          if (result.conflicts) message('Your changes are saved in a conflict copy because another device edited the same item.');
        }
        if (activeScope.current === scope) {
          if (result.downloaded) setLastChecked(Date.now());
          if (result.complete) setLastSynced(Date.now());
        }
      } catch (error) {
        if (activeScope.current === scope) setSyncStatus(`Could not finish syncing · ${messageOf(error)}`);
      } finally { if (activeScope.current === scope) setSyncing(false); }
    }, manual);
    syncPromise.current = promise;
    await promise;
    if (syncPromise.current === promise) syncPromise.current = null;
  }, [client, scope, settings, message]);
  useEffect(() => {
    void sync();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void sync(false); }, SYNC_POLL_MS);
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastWake < 1000) return;
      lastWake = Date.now(); void sync(false);
    };
    const online = () => { void sync(); };
    const offline = () => setSyncStatus('Offline · changes are saved on this device');
    const visibility = () => {
      if (document.visibilityState === 'hidden') { void canvasRef.current?.flush().then(() => sync(false)).catch(error => message(messageOf(error))); }
      else wake();
    };
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    window.addEventListener('focus', wake); window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('focus', wake); window.removeEventListener('pageshow', wake); document.removeEventListener('visibilitychange', visibility); clearTimeout(idleSyncTimer.current); };
  }, [sync, driveRevision]);
  useEffect(() => {
    if (scope === 'local') return;
    const versions = new Map<string, string>();
    for (const record of [...workspace.boards, ...workspace.folders, ...trash]) if (record.dirty) versions.set(record.key, record.updatedAt);
    for (const asset of assets) if (asset.dirty) versions.set(`image:${asset.key}`, `${asset.ocrStatus}:${asset.ocrText}`);
    const changed = [...versions].some(([key, value]) => dirtyVersions.current.get(key) !== value);
    dirtyVersions.current = versions;
    if (!changed) return;
    clearTimeout(idleSyncTimer.current);
    idleSyncTimer.current = setTimeout(() => { void sync(false); }, SYNC_IDLE_MS);
  }, [workspace, assets, trash, scope, sync]);
  useEffect(() => {
    return onOcrStatus(text => { message(text); if (text === 'Image text is searchable') void sync(); });
  }, [scope, sync]);
  useEffect(() => {
    if (settings.ocrEnabled) for (const asset of assets) if (needsImageOcr(asset)) void queueOcr(asset);
  }, [assets, settings.ocrEnabled]);
  async function flushCanvas() { await canvasRef.current?.flush(); }
  async function signInWithGoogle() {
    if (!client) throw new Error('Cloud sync is not available in this version.');
    await flushCanvas(); await syncPromise.current;
    const providerResponse = await fetch(`${appConfig.supabaseUrl.replace(/\/$/, '')}/auth/v1/settings`, { headers: { apikey: appConfig.supabaseKey } });
    if (!providerResponse.ok) throw new Error('Could not check Google sign-in. Check your connection and try again.');
    if (!(await providerResponse.json()).external?.google) throw new Error('Google sign-in is not set up yet. The app owner needs to enable Google in Supabase.');
    const url = await googleSignInUrl(client, new URL(import.meta.env.BASE_URL, location.href).href, session?.user.email);
    const next = { ...settings, imageStore: 'drive' as const };
    setSettings(next); storeSettings(next); disconnectDrive();
    location.assign(url);
  }
  async function navigateFolder(id: string | null) {
    try { await flushCanvas(); setBoardId(null); setFolderId(id); setView('library'); setJumpId(undefined); setMenuFor(null); setSidebarOpen(false); }
    catch (error) { message(messageOf(error)); }
  }
  async function openBoard(board: Board, elementId?: string) {
    try { await flushCanvas(); setBoardId(board.id); setFolderId(board.folderId); setView('library'); setJumpId(elementId); setDialog(null); setSidebarOpen(false); setMenuFor(null); if (board.id === boardId && elementId) canvasRef.current?.jumpTo(elementId); }
    catch (error) { message(messageOf(error)); }
  }
  function openSearch() { setQuery(''); setSearchFolderId(folderId); setDialog({ kind: 'search' }); }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (dialog) return;
      if (sidebarOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSidebarOpen(false); return; }
      const editing = event.target instanceof HTMLElement && (!!event.target.closest('input,textarea,[contenteditable="true"]'));
      const appShortcut = ((event.ctrlKey || event.metaKey) && ['k', 's'].includes(event.key.toLowerCase()))
        || ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'n')
        || (!editing && (event.key === '?' || (event.key === 'F2' && currentBoard)));
      if (appShortcut) event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); setDialog({ kind: event.shiftKey ? 'folder' : 'board' }); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flushCanvas().then(() => { if (scope !== 'local') void sync(); else message('Board saved on this device'); }).catch(error => message(messageOf(error))); }
      if (!editing && event.key === 'F2' && currentBoard) { event.preventDefault(); setDialog({ kind: 'rename', record: currentBoard }); }
      if (!editing && event.key === '?') { event.preventDefault(); setDialog({ kind: 'help' }); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [dialog, folderId, currentBoard, scope, sync, sidebarOpen]);
  async function moveRecord(record: Board | Folder, destination: string | null) {
    await flushCanvas();
    if ('parentId' in record) {
      if (!canMoveFolder(workspace.folders, record.id, destination)) throw new Error('Choose a folder outside this folder’s descendants.');
      await db.folders.update(record.key, { parentId: destination, ...touch() });
    } else await db.boards.update(record.key, { folderId: destination, ...touch() });
    setDialog(null); setMenuFor(null); void sync();
  }
  async function moveToTrash(record: Board | Folder) {
    await flushCanvas();
    if ('parentId' in record) await trashFolder(scope, record.id);
    else await db.boards.update(record.key, { deleted: true, ...touch() });
    if (record.id === boardId) setBoardId(null);
    if ('parentId' in record && descendantFolderIds(workspace.folders, record.id).has(folderId || '')) { setFolderId(null); setBoardId(null); }
    setMenuFor(null); message('Moved to Trash. You can restore it anytime.'); void sync();
  }
  async function restore(record: Board | Folder) {
    const allFolders = await db.folders.where('scope').equals(scope).toArray();
    const restoreFolder = async (id: string | null, visited = new Set<string>()) => {
      if (!id || visited.has(id)) return; visited.add(id);
      const folder = allFolders.find(x => x.id === id);
      if (folder?.deleted) { await restoreFolder(folder.parentId, visited); await db.folders.update(folder.key, { deleted: false, ...touch() }); }
    };
    await db.transaction('rw', db.folders, db.boards, async () => {
      if ('parentId' in record) {
        await restoreFolder(record.id);
        const descendants = descendantFolderIds(allFolders, record.id);
        for (const folder of allFolders.filter(x => descendants.has(x.id))) await db.folders.update(folder.key, { deleted: false, ...touch() });
        const boards = await db.boards.where('scope').equals(scope).toArray();
        for (const board of boards.filter(x => x.folderId && descendants.has(x.folderId))) await db.boards.update(board.key, { deleted: false, ...touch() });
      } else { await restoreFolder(record.folderId); await db.boards.update(record.key, { deleted: false, ...touch() }); }
    });
    message('Restored to your library'); void sync();
  }
  async function duplicate(board: Board) {
    await flushCanvas(); const current = await db.boards.get(board.key); if (!current) return;
    const id = crypto.randomUUID(), createdAt = new Date().toISOString(); await db.boards.add({ ...current, id, key: recordKey(scope, id), name: `${current.name} (copy)`, remoteRevision: 0, createdAt, createdAtEstimated: false, updatedAt: createdAt, dirty: true });
    setMenuFor(null); message('Board duplicated'); void sync();
  }
  async function exportBackup() {
    await flushCanvas();
    if (client) {
      const { downloadAsset } = await import('./lib/sync');
      for (const asset of assets.filter(x => !x.dataURL)) await downloadAsset(client, asset);
    }
    const backup = { format: 'note-backup', version: 1, exportedAt: new Date().toISOString(), folders: await db.folders.where('scope').equals(scope).toArray(), boards: await db.boards.where('scope').equals(scope).toArray(), assets: await db.assets.where('scope').equals(scope).toArray() };
    download(`note-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    message('Backup exported, including your images');
  }
  async function importBackup(file: File) {
    const data = JSON.parse(await file.text());
    if (data.format !== 'note-backup' || data.version !== 1 || !Array.isArray(data.boards) || !Array.isArray(data.folders) || !Array.isArray(data.assets)) throw new Error('Choose a Note backup JSON file.');
    const folderIds = new Map<string, string>(data.folders.map((x: Folder) => [x.id, crypto.randomUUID()]));
    await db.transaction('rw', db.folders, db.boards, db.assets, async () => {
      for (const folder of data.folders) {
        if (typeof folder.name !== 'string' || folder.name.length > 200) throw new Error('Invalid folder in backup.');
        const id = folderIds.get(folder.id)!;
        await db.folders.put({ ...folder, id, scope, key: recordKey(scope, id), parentId: folder.parentId ? folderIds.get(folder.parentId) || null : null, remoteRevision: 0, ...importedCreation(folder), ...touch() });
      }
      for (const board of data.boards) {
        if (typeof board.name !== 'string' || !Array.isArray(board.elements) || !Array.isArray(board.assetIds)) throw new Error('Invalid board in backup.');
        const id = crypto.randomUUID();
        await db.boards.put({ ...board, id, scope, key: recordKey(scope, id), folderId: board.folderId ? folderIds.get(board.folderId) || null : null, remoteRevision: 0, ...importedCreation(board), ...touch() });
      }
      for (const asset of data.assets) {
        if (typeof asset.id !== 'string' || typeof asset.dataURL !== 'string' || !asset.dataURL.startsWith('data:image/')) throw new Error('The backup has a missing or invalid image.');
        const key = recordKey(scope, asset.id);
        if (!await db.assets.get(key)) await db.assets.put({ ...asset, scope, key, remotePath: null, storage: null, dirty: true });
      }
    });
    message('Backup imported as new boards'); void sync();
  }
  function recordMenu(record: Board | Folder) {
    return <div className="item-menu" role="menu">
      <button role="menuitem" onClick={() => { setDialog({ kind: 'rename', record }); setMenuFor(null); }}>Rename <kbd>F2</kbd></button>
      <button role="menuitem" onClick={() => { setDialog({ kind: 'move', record }); setMenuFor(null); }}><Move size={14} /> Move to folder</button>
      {'elements' in record && <button role="menuitem" onClick={() => void duplicate(record).catch(error => message(messageOf(error)))}>Duplicate board</button>}
      <button role="menuitem" className="danger" onClick={() => void moveToTrash(record).catch(error => message(messageOf(error)))}><Trash2 size={14} /> Move to Trash</button>
    </div>;
  }
  function folderTree(parentId: string | null, depth = 0, seen = new Set<string>()) {
    return sortLibraryRecords(workspace.folders.filter(x => x.parentId === parentId && !seen.has(x.id)), librarySorts.folders).map(folder => {
      const children = workspace.folders.some(x => x.parentId === folder.id) || workspace.boards.some(x => x.folderId === folder.id);
      const open = expanded.has(folder.id);
      return <div key={folder.id}>
        <div className={`tree-row ${folderId === folder.id && !boardId ? 'active' : ''}`} style={{ paddingLeft: 10 + depth * 15 }} draggable onDragStart={event => event.dataTransfer.setData('application/x-note', JSON.stringify({ kind: 'folder', id: folder.id }))}
          onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); try { const data = JSON.parse(event.dataTransfer.getData('application/x-note')); const record = data.kind === 'folder' ? workspace.folders.find(x => x.id === data.id) : workspace.boards.find(x => x.id === data.id); if (record) void moveRecord(record, folder.id).catch(error => message(messageOf(error))); } catch {} }}>
          <button className="tree-chevron" aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (open) next.delete(folder.id); else next.add(folder.id); return next; })}>{children ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span />}</button>
          <button className="tree-label" onClick={() => void navigateFolder(folder.id)}><FolderIcon size={17} fill={folder.color} color={folder.color} /><span>{folder.name}</span></button>
          <button className="tree-more icon-button" aria-label={`Options for ${folder.name}`} onClick={() => setMenuFor(menuFor === folder.id ? null : folder.id)}><MoreHorizontal size={15} /></button>
          {menuFor === folder.id && recordMenu(folder)}
        </div>
        {open && <>{folderTree(folder.id, depth + 1, new Set([...seen, folder.id]))}{sortLibraryRecords(workspace.boards.filter(x => x.folderId === folder.id), librarySorts.boards).map(board => <button key={board.id} className={`tree-board ${boardId === board.id ? 'active' : ''}`} style={{ paddingLeft: 36 + depth * 15 }} onClick={() => void openBoard(board)} draggable onDragStart={event => event.dataTransfer.setData('application/x-note', JSON.stringify({ kind: 'board', id: board.id }))}><StickyNote size={15} /><span>{board.name}</span></button>)}</>}
      </div>;
    });
  }
  const directFolders = sortLibraryRecords(workspace.folders.filter(x => x.parentId === folderId), librarySorts.folders);
  const visibleBoards = sortLibraryRecords(workspace.boards.filter(x => folderId === null || x.folderId === folderId), librarySorts.boards);
  const matches = dialog?.kind === 'search' ? searchBoards(workspace.boards, workspace.folders, assets, query, searchFolderId) : [];
  const pendingSync = pendingSyncItems([...workspace.boards, ...trash.filter((record): record is Board => 'elements' in record)], [...workspace.folders, ...trash.filter((record): record is Folder => 'parentId' in record)], assets);
  const dirtyCount = pendingSync.length;
  const pendingLabel = pendingSyncLabel(pendingSync);
  const syncFailed = pendingSync.some(item => item.failed) || syncStatus.startsWith('Could not');
  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} onClick={event => { if (!(event.target as HTMLElement).closest('.item-menu,.tree-more,.card-menu-button,.board-options')) setMenuFor(null); }}>
    {sidebarOpen && <button className="sidebar-overlay" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
    <aside id="note-sidebar" className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <button className="icon-button mobile-sidebar-close" aria-label="Hide sidebar" onClick={() => setSidebarOpen(false)}><X size={19} /></button>
      <button className="brand" onClick={() => void navigateFolder(null)}><span className="brand-mark">N<span /></span><span>Note<span className="brand-caption">a little room for big ideas</span></span></button>
      <button className="search-trigger" onClick={openSearch}><Search size={16} /><span>Find anything</span><kbd>Ctrl K</kbd></button>
      <button className="new-board-button" onClick={() => setDialog({ kind: 'board' })}><Plus size={18} /><span>New board</span><span className="new-shortcut">↵</span></button>
      <nav className="sidebar-nav" aria-label="Library navigation"><button className={`nav-row ${folderId === null && !boardId && view === 'library' ? 'active' : ''}`} onClick={() => void navigateFolder(null)}><LayoutGrid size={17} /><span>All boards</span><span className="count">{workspace.boards.length}</span></button></nav>
      <div className="tree-heading"><span>YOUR FOLDERS</span><button className="icon-button" aria-label="New folder" title="New folder (Ctrl Alt Shift N)" onClick={() => setDialog({ kind: 'folder' })}><FolderPlus size={16} /></button></div>
      <div className="folder-tree" onDragOver={event => event.preventDefault()} onDrop={event => { if (event.target !== event.currentTarget) return; try { const data = JSON.parse(event.dataTransfer.getData('application/x-note')); const record = data.kind === 'folder' ? workspace.folders.find(x => x.id === data.id) : workspace.boards.find(x => x.id === data.id); if (record) void moveRecord(record, null).catch(error => message(messageOf(error))); } catch {} }}>
        {folderTree(null)}
        {sortLibraryRecords(workspace.boards.filter(x => x.folderId === null), librarySorts.boards).map(board => <button className={`tree-board ${boardId === board.id ? 'active' : ''}`} key={board.id} onClick={() => void openBoard(board)}><StickyNote size={15} /><span>{board.name}</span></button>)}
        {!workspace.folders.length && <p className="tree-empty">Make a folder for a project,<br />or a corner of your mind.</p>}
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-row ${view === 'trash' ? 'active' : ''}`} onClick={() => void flushCanvas().then(() => { setBoardId(null); setView('trash'); }).catch(error => message(messageOf(error)))}><Trash2 size={16} /><span>Trash</span>{trash.length > 0 && <span className="count">{trash.length}</span>}</button>
        <button className="nav-row" onClick={() => setDialog({ kind: 'help' })}><Keyboard size={16} /><span>Keyboard shortcuts</span><kbd>?</kbd></button>
        <button className="nav-row" onClick={() => setDialog({ kind: 'settings' })}><SettingsIcon size={16} /><span>Settings & storage</span></button>
        <nav className="legal-links" aria-label="About and policies"><a href="./about.html" target="_blank" rel="noreferrer">About</a><a href="./privacy.html" target="_blank" rel="noreferrer">Privacy</a><a href="./terms.html" target="_blank" rel="noreferrer">Terms</a></nav>
        <div className="account-box"><span className="avatar">{session?.user.email?.[0]?.toUpperCase() || 'Y'}</span><div><strong>{session?.user.email || 'Your workspace'}</strong><span>{scope === 'local' ? 'On this device' : settings.imageStore === 'drive' ? 'Supabase + Google Drive' : 'Supabase cloud'}</span></div><button className="icon-button" aria-label={session ? 'Account settings' : 'Sign in to sync'} onClick={() => setDialog({ kind: session ? 'settings' : 'auth' })}><ArrowUpRight size={17} /></button></div>
      </div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="topbar-left"><button className="icon-button desktop-sidebar-toggle" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="note-sidebar" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button><button className="icon-button mobile-menu" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="breadcrumbs"><button onClick={() => void navigateFolder(null)}><Grid2X2 size={14} /> Workspace</button>{path.map(folder => <span key={folder.id}><ChevronRight size={13} /><button onClick={() => void navigateFolder(folder.id)}>{folder.name}</button></span>)}{currentBoard && <span><ChevronRight size={13} /><button className="breadcrumb-current" onClick={() => setDialog({ kind: 'rename', record: currentBoard })}>{currentBoard.name}</button></span>}</div></div>
        <div className="topbar-actions"><a className="app-version" href="./updates.html" target="_blank" rel="noreferrer" aria-label={`Note version ${APP_VERSION}. View version updates`}>v{APP_VERSION}</a><button className={`save-status ${syncing ? 'is-syncing' : ''} ${syncFailed ? 'sync-attention' : ''}`} aria-label={scope === 'local' ? 'Saved locally. Sign in to sync' : `Sync now. ${syncing ? 'Syncing; click to queue another pass' : syncStatus}`} aria-busy={syncing} title={scope === 'local' ? syncStatus : `${syncStatus}${dirtyCount ? ` · ${pendingLabel} waiting` : ''}`} onClick={() => scope === 'local' ? setDialog({ kind: 'auth' }) : void sync()}>{syncing ? <Loader2 size={14} className="spinning" /> : scope === 'local' ? <CloudOff size={14} /> : syncFailed ? <TriangleAlert size={14} /> : dirtyCount ? <RefreshCw size={14} /> : <Check size={14} />}<span>{scope === 'local' ? 'Saved locally' : syncing ? 'Syncing' : syncFailed ? 'Sync needs attention' : dirtyCount ? `${pendingSync.some(item => item.kind !== pendingSync[0].kind) ? `${dirtyCount} items` : pendingLabel} pending` : syncStatus.startsWith('Everything') ? 'Synced' : 'Check sync'}</span></button>{scope !== 'local' && <button className="icon-button sync-details-trigger" aria-label="Sync details" title="See what is waiting and why" onClick={() => setSyncDetails(true)}><CircleHelp size={16} /></button>}{currentBoard && <><span className="board-chrome-quick-slot" /><button className="icon-button board-chrome-trigger" aria-label="Board toolbar visibility" title="Show or hide board toolbars" onClick={() => canvasRef.current?.toggleControls()}><PanelsTopLeft size={18} /><span>Toolbars</span></button></>}{installEvent && <button className="icon-button" title="Install Note" aria-label="Install Note" onClick={() => void installEvent.prompt().then(() => setInstallEvent(null))}><ArrowDownToLine size={17} /></button>}
        {currentBoard ? <div className="board-options"><button className="icon-button" aria-label="Board options" onClick={() => setMenuFor(menuFor === currentBoard.id ? null : currentBoard.id)}><MoreHorizontal size={21} /></button>{menuFor === currentBoard.id && <div className="item-menu board-menu"><button onClick={() => setDialog({ kind: 'rename', record: currentBoard })}>Rename</button><button onClick={() => setDialog({ kind: 'move', record: currentBoard })}>Move to folder</button><button onClick={() => void canvasRef.current?.exportPng().then(blob => { if (blob) download(`${currentBoard.name}.png`, blob); else message('Add something to the board first.'); }).catch(error => message(messageOf(error)))}>Export PNG</button><button className="danger" onClick={() => void moveToTrash(currentBoard)}>Move to Trash</button></div>}</div> : <button className="icon-button" aria-label="Search workspace" onClick={openSearch}><Search size={18} /></button>}</div>
      </header>
      {needRefresh && <div className="update-banner"><span>A new version of Note is ready.</span><button onClick={() => void flushCanvas().then(() => updateServiceWorker(true)).catch(error => message(messageOf(error)))}>Save and update <RefreshCw size={13} /></button></div>}
      {currentBoard ? <div className="editor-container"><BoardCanvas key={currentBoard.key} ref={canvasRef} board={currentBoard} settings={settings} client={client} onSaved={() => { if (scope === 'local') setSyncStatus('Saved on this device'); }} onMessage={message} jumpId={jumpId} /></div>
        : view === 'trash' ? <section className="library"><div className="library-intro"><p className="eyebrow">A SECOND CHANCE</p><h1>Trash</h1><p>Restore a board or folder whenever you need it.</p></div>{trash.length ? <div className="trash-list">{trash.map(record => <div key={record.key}>{'parentId' in record ? <FolderIcon size={19} /> : <StickyNote size={19} />}<span>{record.name}</span><button className="secondary-button" onClick={() => void restore(record).catch(error => message(messageOf(error)))}>Restore</button></div>)}</div> : <div className="empty-library"><Trash2 size={32} /><h2>Nothing in Trash</h2><p>Your ideas are right where you left them.</p></div>}</section>
        : <section className="library"><div className="library-intro"><p className="eyebrow">YOUR SPACE TO THINK</p><div className="library-title"><h1>{currentFolder?.name || 'A little room for big ideas.'}</h1>{currentFolder && <button className="icon-button" aria-label="Rename current folder" onClick={() => setDialog({ kind: 'rename', record: currentFolder })}><MoreHorizontal size={22} /></button>}</div><p>{currentFolder ? 'Keep everything together. Give every thought a little space.' : 'Collect the things that spark something. Make sense of them here.'}</p></div>
          {scope === 'local' && <div className="sync-banner"><span className="banner-icon"><Cloud size={21} /></span><div><strong>Your ideas, wherever you are.</strong><p>{client ? 'Sign in to open your cloud boards on your other devices.' : 'Cloud sync is not available in this version. Your boards stay saved on this device.'}</p></div>{client && <button onClick={() => setDialog({ kind: 'auth' })}>Sign in to sync <ArrowUpRight size={15} /></button>}</div>}
          <div className="section-heading library-section-heading"><h2>Folders <span>{directFolders.length}</span></h2><div className="library-actions"><LibrarySort label="Sort folders" value={librarySorts.folders} onChange={value => setLibrarySorts(previous => ({ ...previous, folders: value }))} /><button onClick={() => setDialog({ kind: 'folder' })}><FolderPlus size={15} /> New folder</button></div></div>
          {librarySorts.folders.startsWith('created') && directFolders.some(item => !item.createdAt || item.createdAtEstimated) && <p className="library-sort-note">Older items use their earliest recorded date.</p>}
          <div className="folder-grid">{directFolders.map(folder => <div className="folder-card" key={folder.id}><button className="folder-card-main" onClick={() => void navigateFolder(folder.id)}><FolderIcon size={31} fill={folder.color} color={folder.color} /><span><strong>{folder.name}</strong><small>{workspace.boards.filter(x => x.folderId && descendantFolderIds(workspace.folders, folder.id).has(x.folderId)).length} boards</small></span></button><button className="card-menu-button icon-button" aria-label={`Options for ${folder.name}`} onClick={() => setMenuFor(menuFor === folder.id ? null : folder.id)}><MoreHorizontal size={17} /></button>{menuFor === folder.id && recordMenu(folder)}</div>)}</div>
          <div className="section-heading board-section-heading library-section-heading"><h2>{folderId ? 'Boards in this folder' : 'Your boards'} <span>{visibleBoards.length}</span></h2><div className="library-actions"><LibrarySort label="Sort boards" value={librarySorts.boards} onChange={value => setLibrarySorts(previous => ({ ...previous, boards: value }))} /><button onClick={() => setDialog({ kind: 'board' })}><Plus size={15} /> New board</button></div></div>
          {librarySorts.boards.startsWith('created') && visibleBoards.some(item => !item.createdAt || item.createdAtEstimated) && <p className="library-sort-note">Older items use their earliest recorded date.</p>}
          <div className="board-grid">{visibleBoards.map((board, index) => <div className="board-card" key={board.id} draggable onDragStart={event => event.dataTransfer.setData('application/x-note', JSON.stringify({ kind: 'board', id: board.id }))}><button className={`board-card-main card-color-${index % 4}`} onClick={() => void openBoard(board)}><div className="board-thumbnail"><BoardThumbnail board={board} /><span className="thumbnail-open"><ArrowUpRight size={18} /></span></div><div className="board-card-info"><strong>{board.name}</strong><span>{folderPath(workspace.folders, board.folderId).map(x => x.name).join(' / ') || 'Workspace'}<i />{relativeDate(board.updatedAt)}</span></div></button><button className="card-menu-button icon-button" aria-label={`Options for ${board.name}`} onClick={() => setMenuFor(menuFor === board.id ? null : board.id)}><MoreHorizontal size={18} /></button>{menuFor === board.id && recordMenu(board)}</div>)}<button className="create-board-card" onClick={() => setDialog({ kind: 'board' })}><span><Plus size={24} /></span><strong>A fresh canvas</strong><small>Make room for the next idea</small></button></div>
          <div className="library-tip"><span><Sparkles size={15} /></span><p>A screenshot is a great place to start. <kbd>Win Shift S</kbd> to capture, then <kbd>Ctrl V</kbd> to paste into a board.</p></div>
        </section>}
    </main>
    {toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {dialog && ['folder', 'board', 'rename'].includes(dialog.kind) && <NameDialog dialog={dialog as Extract<NonNullable<Dialog>, { kind: 'folder' | 'board' | 'rename' | 'move' }>} folders={workspace.folders} folderId={folderId} onClose={() => setDialog(null)} onSubmit={async name => {
      if (dialog.kind === 'rename' && dialog.record) { await flushCanvas(); if ('parentId' in dialog.record) await db.folders.update(dialog.record.key, { name, ...touch() }); else await db.boards.update(dialog.record.key, { name, ...touch() }); }
      else if (dialog.kind === 'folder') { await flushCanvas(); const folder = await newFolder(scope, name, folderId); if (folderId) setExpanded(previous => new Set([...previous, folderId])); setFolderId(folder.id); setBoardId(null); }
      else { await flushCanvas(); const board = await newBoard(scope, name, folderId); setBoardId(board.id); if (folderId) setExpanded(previous => new Set([...previous, folderId])); }
      setDialog(null); setSidebarOpen(false); void sync();
    }} />}
    {dialog?.kind === 'move' && dialog.record && <MoveDialog record={dialog.record} folders={workspace.folders} onClose={() => setDialog(null)} onMove={destination => moveRecord(dialog.record!, destination)} />}
    {dialog?.kind === 'search' && <Modal title="Find anything" wide onClose={() => setDialog(null)}><div className="search-modal-input"><Search size={20} /><input autoFocus aria-label="Search notes and boards" placeholder="A word, an idea, a screenshot…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>Esc</kbd></div><div className="search-scope"><span>Search in</span><select aria-label="Search folder" value={searchFolderId || ''} onChange={event => setSearchFolderId(event.target.value || null)}><option value="">Entire workspace</option>{workspace.folders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(workspace.folders, folder.id).map(x => x.name).join(' / ')}</option>)}</select><small>Includes all subfolders</small></div><div className="search-results">{!query.trim() ? <div className="search-empty"><Search size={26} /><p>Search board names, typed notes, image text, and saved handwriting text.</p></div> : matches.length ? matches.map((match, index) => <SearchResult key={`${match.board.id}:${match.elementId || 'title'}:${index}`} match={match} folders={workspace.folders} onOpen={() => void openBoard(match.board, match.elementId)} />) : <div className="search-empty"><p>No matches in this folder.</p><small>Try fewer words or choose Entire workspace.</small></div>}</div></Modal>}
    {dialog?.kind === 'help' && <Modal title="Less clicking. More thinking." wide onClose={() => setDialog(null)}><p className="dialog-description">Your keyboard belongs on the canvas.</p><div className="shortcut-grid">{[['Find across boards', 'Ctrl K'], ['New board', 'Ctrl Alt N'], ['New folder', 'Ctrl Alt Shift N'], ['Save / sync', 'Ctrl S'], ['Rename open board', 'F2'], ['Paste image or text', 'Ctrl V'], ['Copy / cut selection', 'Ctrl C / X'], ['Undo / redo', 'Ctrl Z / Y'], ['Duplicate selection', 'Ctrl D'], ['Select all', 'Ctrl A'], ['Delete selection', 'Delete'], ['Type text', 'T'], ['Draw / arrow / rectangle', 'P / A / R'], ['Diagram: add child', 'Tab'], ['Diagram: add sibling', 'Shift Tab'], ['Stamp last icon', 'I'], ['Stop stamping', 'Esc'], ['Pan canvas', 'Space + drag'], ['Zoom canvas', 'Ctrl + scroll'], ['Show shortcuts', '?']].map(([name, shortcut]) => <div key={name}><span>{name}</span><kbd>{shortcut}</kbd></div>)}</div><p className="small-note">Use Cmd instead of Ctrl on Mac. Diagram shortcuts work on a selected diagram shape or while typing its label. Other canvas shortcuts work when you aren’t editing text.</p></Modal>}
    {syncDetails && session && <SyncDetails account={session.user.email || session.user.id} status={syncStatus} pending={pendingSync} syncing={syncing} lastChecked={lastChecked} lastSynced={lastSynced} onSync={sync} onClose={() => setSyncDetails(false)} />}
    {dialog?.kind === 'settings' && <SettingsDialog cloudConfigured={!!client} settings={settings} session={session} syncStatus={syncStatus} onSyncDetails={() => { setDialog(null); setSyncDetails(true); }} assets={assets} syncing={syncing} onSyncNow={sync} onClose={() => setDialog(null)} onSave={async next => { await flushCanvas(); setSettings(next); storeSettings(next); message('Settings saved'); }} onSignIn={() => setDialog({ kind: 'auth' })} onSignOut={async () => { await flushCanvas(); await syncPromise.current; await client?.auth.signOut(); disconnectDrive(); message('Signed out. Your cloud boards stay in your account.'); }} onConnectDrive={signInWithGoogle} onExport={exportBackup} onImport={importBackup} onImportLocal={async () => { await importLocalWorkspace(scope); message('Device boards copied into your account'); void sync(); }} onRetryOcr={async () => { for (let asset of assets.filter(x => x.ocrStatus !== 'done' || !x.ocrText.trim())) { if (!asset.dataURL && client) { await downloadAsset(client, asset); asset = (await db.assets.get(asset.key)) || asset; } if (asset.dataURL) void queueOcr(asset, { force: true }); } message('Image text recognition queued'); }} />}
    {dialog?.kind === 'auth' && <AuthDialog configured={!!client} client={client} initialError={authError} onGoogle={signInWithGoogle} onClose={() => { setDialog(null); setAuthError(''); }} onComplete={() => { setDialog(null); setAuthError(''); message('Signed in. Your device boards are separate; copy them from Settings if you want.'); }} />}
  </div>;
}

function BoardThumbnail({ board }: { board: Board }) {
  const elements = board.elements.filter(x => !x.isDeleted);
  if (!elements.length) return <div className="thumbnail-empty"><span className="paper-note"><span /><span /><span /></span><span className="paper-dot" /><span className="paper-dash" /></div>;
  const minX = Math.min(...elements.map(x => x.x)), minY = Math.min(...elements.map(x => x.y));
  const width = Math.max(300, ...elements.map(x => x.x + Math.abs(x.width) - minX));
  const height = Math.max(180, ...elements.map(x => x.y + Math.abs(x.height) - minY));
  return <svg className="scene-thumbnail" viewBox={`${minX - 20} ${minY - 20} ${width + 40} ${height + 40}`} aria-hidden="true">{elements.slice(0, 150).map(element => element.type === 'text' ? <text key={element.id} x={element.x} y={element.y + element.fontSize} fontSize={element.fontSize} fill={element.strokeColor}>{element.text.split('\n').slice(0, 6).map((line, index) => <tspan key={index} x={element.x} dy={index ? element.fontSize * 1.3 : 0}>{line}</tspan>)}</text> : element.type === 'image' ? <g key={element.id}><rect x={element.x} y={element.y} width={element.width} height={element.height} rx="8" fill="#e7e1f5" /><text x={element.x + 10} y={element.y + 24} fontSize="14" fill="#8b77bf">Screenshot</text></g> : element.type === 'ellipse' ? <ellipse key={element.id} cx={element.x + element.width / 2} cy={element.y + element.height / 2} rx={Math.abs(element.width / 2)} ry={Math.abs(element.height / 2)} stroke={element.strokeColor} fill={element.backgroundColor || 'none'} strokeWidth={2} /> : element.type === 'rectangle' || element.type === 'frame' ? <rect key={element.id} x={element.x} y={element.y} width={Math.abs(element.width)} height={Math.abs(element.height)} rx={8} stroke={element.strokeColor} fill={element.backgroundColor || 'none'} strokeWidth={2} /> : 'points' in element ? <polyline key={element.id} points={element.points.map(point => `${element.x + point[0]},${element.y + point[1]}`).join(' ')} stroke={element.strokeColor} fill="none" strokeWidth={element.strokeWidth} /> : null)}</svg>;
}
function NameDialog({ dialog, folderId, folders, onClose, onSubmit }: { dialog: { kind: string; record?: Board | Folder }; folderId: string | null; folders: Folder[]; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(dialog.record?.name || ''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title={dialog.kind === 'rename' ? 'Give it a name' : dialog.kind === 'folder' ? 'Make a little space' : 'Start a new board'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!name.trim()) { setError('Add a name first.'); return; } setBusy(true); void onSubmit(name.trim()).catch(error => { setError(messageOf(error)); setBusy(false); }); }}><p className="dialog-description">{dialog.kind === 'rename' ? 'A name that makes sense to you.' : `Inside ${folderPath(folders, folderId).map(x => x.name).join(' / ') || 'your workspace'}.`}</p><label>{dialog.kind === 'folder' ? 'Folder name' : 'Name'}<input value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder={dialog.kind === 'folder' ? 'e.g. Projects, Learning, Life' : 'e.g. Ideas worth keeping'} autoFocus /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : dialog.kind === 'rename' ? 'Save name' : dialog.kind === 'folder' ? 'Create folder' : 'Create board'}<ArrowUpRight size={16} /></button></div></form></Modal>;
}
function MoveDialog({ record, folders, onClose, onMove }: { record: Board | Folder; folders: Folder[]; onClose: () => void; onMove: (destination: string | null) => Promise<void> }) {
  const [destination, setDestination] = useState('parentId' in record ? record.parentId || '' : record.folderId || ''); const [error, setError] = useState('');
  return <Modal title={`Move ${record.name}`} onClose={onClose}><form onSubmit={event => { event.preventDefault(); void onMove(destination || null).catch(error => setError(messageOf(error))); }}><label>Destination folder<select value={destination} onChange={event => setDestination(event.target.value)}><option value="">Workspace</option>{folders.filter(folder => !('parentId' in record) || canMoveFolder(folders, record.id, folder.id)).map(folder => <option key={folder.id} value={folder.id}>{folderPath(folders, folder.id).map(x => x.name).join(' / ')}</option>)}</select></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button">Move here</button></div></form></Modal>;
}
function SearchResult({ match, folders, onOpen }: { match: SearchMatch; folders: Folder[]; onOpen: () => void }) {
  return <button className="search-result" onClick={onOpen}><span className={`result-icon ${match.kind}`}>{match.kind === 'image' ? <Image size={18} /> : <StickyNote size={18} />}</span><span><strong>{match.board.name}</strong><small>{folderPath(folders, match.board.folderId).map(x => x.name).join(' / ') || 'Workspace'} · {match.kind === 'image' ? 'Image text' : match.kind === 'title' ? 'Board name' : match.kind === 'handwriting' ? 'Handwriting' : 'Typed note'}</small><p>{match.text.slice(0, 240)}</p></span><ArrowUpRight size={17} /></button>;
}
function AuthDialog({ configured, client, initialError, onGoogle, onClose, onComplete }: { configured: boolean; client: ReturnType<typeof getSupabase>; initialError: string; onGoogle: () => Promise<void>; onClose: () => void; onComplete: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [signup, setSignup] = useState(false); const [useEmail, setUseEmail] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(initialError); const [notice, setNotice] = useState('');
  function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    void work().catch(error => setError(messageOf(error))).finally(() => setBusy(false));
  }
  return <Modal title={configured ? 'Your workspace, anywhere' : 'Cloud sync unavailable'} onClose={onClose}>
    {!configured ? <><p className="dialog-description">Cloud sync is not available in this version. You can keep using Note and saving boards on this device.</p><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Stay on this device</button></div></> : <>
      <p className="dialog-description">Sign in with Google to keep your boards in your private workspace and save new images to your own Google Drive.</p>
      <p className="small-note">Cloud notes are accessible to the service operator. Read the <a href="./privacy.html" target="_blank" rel="noreferrer">privacy policy</a> and <a href="./terms.html" target="_blank" rel="noreferrer">terms of service</a> before signing in.</p>
      <button type="button" className="google-sign-in" disabled={busy} onClick={() => action(onGoogle)}>{busy ? 'Please wait…' : 'Continue with Google'}</button>
      <p className="small-note">Google will ask permission to save images in a private “Note images” folder. Your other Drive files stay outside the app’s access.</p>
      <button type="button" className="text-button email-choice" disabled={busy} onClick={() => { setUseEmail(!useEmail); setError(''); setNotice(''); }}>{useEmail ? 'Hide email sign-in' : 'Use email instead'}</button>
      {useEmail && <form onSubmit={event => { event.preventDefault(); action(async () => {
        const response = signup ? await client!.auth.signUp({ email, password, options: { emailRedirectTo: new URL(import.meta.env.BASE_URL, location.href).href } }) : await client!.auth.signInWithPassword({ email, password });
        if (response.error) throw response.error;
        if (response.data.session) onComplete(); else setNotice('Check your email to confirm your account, then sign in.');
      }); }}>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setSignup(!signup)}>{signup ? 'Already have an account?' : 'Create an account'}</button><button className="primary-button" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button></div>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    </>}
  </Modal>;
}
function SettingsDialog({ cloudConfigured, settings, session, syncStatus, assets, syncing, onSyncNow, onSyncDetails, onClose, onSave, onSignIn, onSignOut, onConnectDrive, onExport, onImport, onImportLocal, onRetryOcr }: { cloudConfigured: boolean; settings: Settings; session: Session | null; syncStatus: string; assets: Asset[]; syncing: boolean; onSyncNow: () => Promise<void>; onSyncDetails: () => void; onClose: () => void; onSave: (settings: Settings) => Promise<void>; onSignIn: () => void; onSignOut: () => Promise<void>; onConnectDrive: () => Promise<void>; onExport: () => Promise<void>; onImport: (file: File) => Promise<void>; onImportLocal: () => Promise<void>; onRetryOcr: () => Promise<void> }) {
  const [draft, setDraft] = useState(settings); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [tab, setTab] = useState<'cloud' | 'storage' | 'preferences'>('cloud');
  const fileRef = useRef<HTMLInputElement>(null);
  function action(work: () => Promise<void>) { setError(''); setBusy(true); void work().catch(error => setError(messageOf(error))).finally(() => setBusy(false)); }
  return <Modal title="Make Note yours" wide onClose={onClose}><p className="settings-version">Note v{APP_VERSION} · <a href="./updates.html" target="_blank" rel="noreferrer">Version updates</a></p><div className="settings-tabs">{(['cloud', 'storage', 'preferences'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'cloud' ? 'Cloud sync' : value === 'storage' ? 'Images & search' : 'Preferences & backup'}</button>)}</div><form onSubmit={event => { event.preventDefault(); action(async () => { await onSave(draft); setNotice('Settings saved.'); }); }}>
    {tab === 'cloud' && <><p className="dialog-description">{cloudConfigured ? 'Sign in to sync your folders, boards, and images across devices.' : 'Cloud sync is not available in this version. Your boards stay saved on this device.'}</p><div className="settings-account"><span><Cloud size={18} /><strong>{session?.user.email || 'Not signed in'}</strong></span><button type="button" className="secondary-button" disabled={busy || !cloudConfigured} onClick={() => session ? action(onSignOut) : onSignIn()}>{session ? 'Sign out' : 'Sign in'}</button></div><p className="small-note sync-detail">{syncStatus}</p>{session && <div className="board-chrome-presets"><button type="button" className="secondary-button" disabled={syncing || busy} onClick={() => action(onSyncNow)}>{syncing ? 'Syncing…' : 'Sync now'}</button><button type="button" className="secondary-button" onClick={onSyncDetails}>View sync details</button></div>}{session && <button className="secondary-button" type="button" disabled={busy} onClick={() => action(onImportLocal)}>Copy this device’s boards into my account</button>}</>}
    {tab === 'storage' && <><p className="dialog-description">Paste an image onto a board. Note saves it in the background.</p><label>Store new images in<select value={draft.imageStore} onChange={event => setDraft({ ...draft, imageStore: event.target.value as Settings['imageStore'] })}><option value="supabase">Supabase Storage</option><option value="drive">My Google Drive — private “Note images” folder</option></select></label><p className="small-note">Google sign-in automatically selects Drive for new images. Existing images stay in their original storage.</p><button type="button" className="secondary-button" disabled={busy} onClick={() => action(onConnectDrive)}>{session ? 'Reconnect Google Drive' : 'Connect Google Drive'} <ArrowUpRight size={15} /></button><p className="small-note">{driveConnected(session?.user.id) ? `Drive connected for ${session?.user.email || 'your Google account'}.` : 'Drive is not connected for uploads in this session. Reconnect with the same Google account to upload waiting images; they remain saved on this device.'}</p><div className="upload-status"><strong>{assets.filter(x => x.dirty).length} image{assets.filter(x => x.dirty).length === 1 ? '' : 's'} waiting to sync</strong><p role="status">{syncStatus}</p>{assets.filter(x => x.dirty && x.syncError).slice(0, 3).map(asset => <p key={asset.key} className="upload-error">{asset.syncError}</p>)}<button type="button" className="secondary-button" disabled={busy || syncing || !session} onClick={() => action(async () => { await onSyncNow(); setNotice('Sync attempt finished. Check the upload status above.'); })}>{syncing ? 'Uploading…' : 'Retry uploads now'}</button><p className="small-note">Keep Note open on the device where you added the images until syncing finishes. If Drive needs access, use Reconnect Google Drive above.</p></div><label className="toggle-row"><span><strong>Search words in images</strong><small>Free English OCR runs on your device.</small></span><input type="checkbox" checked={draft.ocrEnabled} onChange={event => setDraft({ ...draft, ocrEnabled: event.target.checked })} /></label><button type="button" className="text-button" disabled={busy} onClick={() => action(onRetryOcr)}>Retry unread images</button></>}
    {tab === 'preferences' && <><label>Appearance<select value={draft.theme} onChange={event => setDraft({ ...draft, theme: event.target.value as Settings['theme'] })}><option value="light">Light — a quiet place to think</option><option value="dark">Dark — for late-night ideas</option></select></label><div className="backup-block"><h3>Keep a copy of your ideas</h3><p>Export your workspace, including images and screenshot text, as a portable backup. Importing creates new boards.</p><div><button type="button" className="secondary-button" disabled={busy} onClick={() => action(onExport)}><ArrowDownToLine size={16} /> Export backup</button><button type="button" className="secondary-button" disabled={busy} onClick={() => fileRef.current?.click()}>Import backup</button></div><input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) action(() => onImport(file)); event.target.value = ''; }} /></div><p className="small-note">Local boards belong to this browser. Export a backup before clearing browser data.</p></>}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Done</button><button className="primary-button" disabled={busy}>{busy ? 'Please wait…' : 'Save settings'}</button></div></form></Modal>;
}
