import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, exportToBlob, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ImagePlus, Loader2, LockKeyhole, UnlockKeyhole, ScanText } from 'lucide-react';
import type { Board, Settings, ViewLock } from '../types';
import { constantInkUpdates, DEFAULT_PEN_WIDTH, penWidth, stickyTextTool, viewLockCorrection } from '../lib/canvas-behavior';
import { ReadTextDialog } from './ReadTextDialog';
import { PenWidthPanel } from './PenWidthPanel';
import { SnapControls } from './SnapControls';
import { restoreSnapping, snapMode, snapState, type SnapMode } from '../lib/snapping';
import { DiagramTools } from './DiagramTools';
import { repairDiagramElements } from '../lib/diagram-scene';
import { installLockedPan } from '../lib/locked-pan';
import { db, touch } from '../lib/db';
import { blobToDataURL, localSceneFiles, storeSceneFiles } from '../lib/assets';
import { queueOcr } from '../lib/ocr';
import { downloadAsset } from '../lib/sync';
import { recordKey } from '../types';

export interface CanvasHandle {
  flush: () => Promise<void>;
  exportPng: () => Promise<Blob | null>;
  jumpTo: (elementId: string) => void;
  reloadImages: () => Promise<void>;
}
function cleanAppState(state: AppState): Board['appState'] {
  return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom, viewBackgroundColor: state.viewBackgroundColor,
    currentItemFontFamily: state.currentItemFontFamily, currentItemRoughness: state.currentItemRoughness,
    currentItemStrokeWidth: state.currentItemStrokeWidth, currentItemStrokeColor: state.currentItemStrokeColor, currentItemFontSize: state.currentItemFontSize,
    gridStep: state.gridStep, ...restoreSnapping(state) };
}
function sceneSignature(elements: readonly ExcalidrawElement[], state: Partial<AppState>) {
  return `${elements.map(x => `${x.id}:${x.version}:${x.isDeleted}`).join('|')}:${JSON.stringify(state)}`;
}
export const BoardCanvas = forwardRef<CanvasHandle, { board: Board; settings: Settings; client: SupabaseClient | null; onSaved: () => void; onMessage: (text: string) => void; jumpId?: string }>(function BoardCanvas({ board, settings, client, onSaved, onMessage, jumpId }, ref) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [canvasRoot, setCanvasRoot] = useState<HTMLDivElement | null>(null);
  const [empty, setEmpty] = useState(!board.elements.some(x => !x.isDeleted));
  const [viewLocked, setViewLocked] = useState(!!board.appState.noteViewLock);
  const [snapping, setSnapping] = useState(() => restoreSnapping(board.appState));
  const viewLock = useRef<ViewLock | null>(board.appState.noteViewLock || null);
  const previousTool = useRef<string>('selection');
  const correcting = useRef(false);
  const [reading, setReading] = useState(false);
  const [showPenWidth, setShowPenWidth] = useState(false);
  const [widthValue, setWidthValue] = useState(board.appState.currentItemStrokeWidth || DEFAULT_PEN_WIDTH);
  const initialSignature = useRef(sceneSignature(board.elements, board.appState));
  const lastSignature = useRef(initialSignature.current);
  const pending = useRef<{ elements: readonly ExcalidrawElement[]; state: Board['appState']; files: BinaryFiles } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef(Promise.resolve());
  const booted = useRef(false);
  useEffect(() => {
    if (canvasRoot && api) return installLockedPan(canvasRoot, api, () => !!viewLock.current);
  }, [canvasRoot, api]);
  const latest = useRef({ settings, onSaved, onMessage }); latest.current = { settings, onSaved, onMessage };
  async function loadFiles() {
    if (client) {
      for (const id of board.assetIds) {
        const asset = await db.assets.get(recordKey(board.scope, id));
        if (asset && !asset.dataURL) {
          try { await downloadAsset(client, asset); }
          catch (error) { onMessage(error instanceof Error ? error.message : 'Could not load an image. Reconnect storage and try again.'); }
        }
      }
    }
    return localSceneFiles(board.scope, board.assetIds);
  }
  const initialData = useMemo<Promise<ExcalidrawInitialDataState>>(() => loadFiles().then(files => ({ elements: board.elements, appState: { currentItemStrokeWidth: DEFAULT_PEN_WIDTH, ...board.appState, ...restoreSnapping(board.appState), theme: settings.theme }, files, scrollToContent: board.elements.length > 0 && !board.appState.zoom })), [board.key]);
  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    const snapshot = pending.current; pending.current = null;
    if (snapshot) {
      saving.current = saving.current.catch(() => {}).then(async () => {
        const assets = await storeSceneFiles(board.scope, snapshot.files, latest.current.settings.ocrEnabled);
        await db.boards.update(board.key, { elements: snapshot.elements, appState: snapshot.state,
          assetIds: [...new Set(snapshot.elements.filter(x => x.type === 'image' && !x.isDeleted).map(x => x.type === 'image' ? x.fileId : null).filter((x): x is NonNullable<typeof x> => !!x))], ...touch() });
        for (const asset of assets) if (latest.current.settings.ocrEnabled) queueOcr(asset);
        latest.current.onSaved();
      }).catch(error => { pending.current ||= snapshot; latest.current.onMessage(`Could not save: ${error instanceof Error ? error.message : 'device storage is unavailable'}. Export your board before closing.`); throw error; });
    }
    await saving.current;
  }
  function changed(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) {
    if (correcting.current) return;
    const nextSnapping = restoreSnapping(state);
    setSnapping(previous => previous.gridSize === nextSnapping.gridSize && previous.gridModeEnabled === nextSnapping.gridModeEnabled && previous.objectsSnapModeEnabled === nextSnapping.objectsSnapModeEnabled ? previous : nextSnapping);
    const selectedPen = elements.find(x => x.type === 'freedraw' && !x.isDeleted && state.selectedElementIds[x.id]);
    setShowPenWidth(state.activeTool.type === 'freedraw' || !!selectedPen);
    setWidthValue(selectedPen?.strokeWidth || state.currentItemStrokeWidth);
    let repaired = repairDiagramElements(elements);
    for (const element of elements) {
      const updates = constantInkUpdates(element);
      if (updates) { mutateElement(element, updates, false); repaired = true; }
    }
    const correction = viewLockCorrection(state, viewLock.current);
    const tool = stickyTextTool(state.activeTool, previousTool.current);
    previousTool.current = state.activeTool.type;
    correcting.current = true;
    try {
      if (api && (repaired || correction)) api.updateScene({ elements, ...(correction ? { appState: correction } : {}), captureUpdate: CaptureUpdateAction.NEVER });
      if (api && tool) api.setActiveTool(tool);
    } finally { correcting.current = false; }
    const clean = { ...cleanAppState(state), ...(correction || {}), noteViewLock: viewLock.current }; const signature = sceneSignature(elements, clean);
    setEmpty(!elements.some(x => !x.isDeleted));
    if (!booted.current) { booted.current = true; if (!repaired) { lastSignature.current = signature; return; } }
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    // Copy now: canvas file maps and app state can mutate during a delayed save.
    pending.current = { elements: structuredClone(elements), state: structuredClone(clean), files: { ...files } };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, 300);
  }
  function jumpTo(elementId: string) {
    if (!api) return;
    const element = api.getSceneElements().find(x => x.id === elementId);
    if (!element) return;
    api.updateScene({ appState: { selectedElementIds: { [elementId]: true } } });
    api.scrollToContent(element, { fitToContent: !viewLock.current, animate: !viewLock.current, maxZoom: 1.4 });
  }
  function changePenWidth(value: number) {
    if (!api) return;
    const width = penWidth(value), state = api.getAppState();
    const elements = api.getSceneElementsIncludingDeleted();
    for (const element of elements) if (element.type === 'freedraw' && !element.isDeleted && state.selectedElementIds[element.id]) {
      mutateElement(element, { strokeWidth: width, width: element.width }, false);
    }
    setWidthValue(width);
    api.updateScene({ elements, appState: { currentItemStrokeWidth: width }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function changeSnapping(mode: SnapMode, size = api?.getAppState().gridSize) {
    api?.updateScene({ appState: snapState(mode, size), captureUpdate: CaptureUpdateAction.NEVER });
  }
  useImperativeHandle(ref, () => ({ flush, jumpTo,
    reloadImages: async () => { const files = await loadFiles(); api?.addFiles(Object.values(files)); },
    exportPng: async () => {
      await flush(); if (!api || !api.getSceneElements().length) return null;
      return exportToBlob({ elements: api.getSceneElements(), appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: settings.theme === 'dark' }, files: api.getFiles(), mimeType: 'image/png' });
    }
  }), [api, settings.theme]);
  useEffect(() => {
    const flushOnHide = () => { if (document.visibilityState === 'hidden') void flush().catch(() => {}); };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (pending.current) { event.preventDefault(); void flush().catch(() => {}); } };
    document.addEventListener('visibilitychange', flushOnHide); window.addEventListener('beforeunload', beforeUnload);
    return () => { document.removeEventListener('visibilitychange', flushOnHide); window.removeEventListener('beforeunload', beforeUnload); void flush().catch(() => {}); };
  }, []);
  useEffect(() => { if (api && jumpId) jumpTo(jumpId); }, [api, jumpId]);
  useEffect(() => {
    if (!api) return;
    const paste = (event: ClipboardEvent) => {
      const target = document.activeElement;
      if (document.querySelector('.modal-backdrop') || target?.closest('input, textarea, [contenteditable="true"]')) return;
      const images = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
      const text = event.clipboardData?.getData('text/plain') || '';
      // Let the editor handle its own structured object clipboard.
      if (!images.length && (!text || text.includes('excalidraw/clipboard'))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void (async () => {
        const state = api.getAppState();
        const x = state.width / 2 / state.zoom.value - state.scrollX;
        const y = state.height / 2 / state.zoom.value - state.scrollY;
        const added: ExcalidrawElement[] = [];
        if (images.length) {
          for (const [index, image] of images.entries()) {
            const bitmap = await createImageBitmap(image);
            const width = Math.min(650, bitmap.width), height = bitmap.height * width / bitmap.width;
            bitmap.close();
            const hash = await crypto.subtle.digest('SHA-256', await image.arrayBuffer());
            const id = Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('') as BinaryFileData['id'];
            const dataURL = await blobToDataURL(image);
            api.addFiles([{ id, dataURL, mimeType: image.type, created: Date.now() } as BinaryFileData]);
            added.push(...convertToExcalidrawElements([{ type: 'image', x: x - width / 2 + index * 25, y: y - height / 2 + index * 25, width, height, fileId: id, status: 'saved', scale: [1, 1] }]));
          }
        } else added.push(...convertToExcalidrawElements([{ type: 'text', text, x: x - 140, y: y - 30, fontSize: 20, fontFamily: 2, width: 300 }]));
        api.updateScene({ elements: [...api.getSceneElements(), ...added], appState: { selectedElementIds: Object.fromEntries(added.map(element => [element.id, true])) }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      })().catch(error => onMessage(`Could not paste: ${error instanceof Error ? error.message : 'unsupported clipboard image'}`));
    };
    document.addEventListener('paste', paste, true);
    return () => document.removeEventListener('paste', paste, true);
  }, [api]);
  useEffect(() => {
    if (!api || !booted.current || pending.current) return;
    const signature = sceneSignature(board.elements, board.appState);
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    viewLock.current = board.appState.noteViewLock || null; setViewLocked(!!viewLock.current);
    api.updateScene({ elements: board.elements, appState: { ...api.getAppState(), ...board.appState, ...restoreSnapping(board.appState) } });
    void loadFiles().then(files => api.addFiles(Object.values(files))).catch(error => onMessage(String(error)));
  }, [board.remoteRevision]);
  return <div className="board-canvas" ref={setCanvasRoot}>
    {!api && <div className="canvas-loading"><Loader2 className="spinning" size={24} /> Opening your board…</div>}
    <Excalidraw excalidrawAPI={setApi} initialData={initialData} onChange={changed} theme={settings.theme}
      name={board.name} autoFocus={true} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: true, export: false, toggleTheme: false } }} />
    {empty && api && <div className="canvas-welcome" aria-hidden="true"><div className="welcome-icon"><ImagePlus size={25} /></div><h2>Start anywhere.</h2><p>Paste a screenshot. Type a thought. Draw a connection.</p><span><kbd>Ctrl</kbd> + <kbd>V</kbd> to paste · <kbd>T</kbd> to type · <kbd>Space</kbd> + drag to pan</span></div>}
    {api && <div className="canvas-tools" role="group" aria-label="Board controls"><button aria-pressed={viewLocked} onClick={() => {
      const state = api.getAppState(); viewLock.current = viewLock.current ? null : { zoom: state.zoom };
      setViewLocked(!!viewLock.current); changed(api.getSceneElementsIncludingDeleted(), state, api.getFiles());
    }} title="Keep the zoom percentage fixed while still moving around the board">{viewLocked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}{viewLocked ? 'Unlock zoom' : 'Lock zoom'}</button>
      <button onClick={() => { void flush().then(() => setReading(true)).catch(() => {}); }}><ScanText size={15} />Read text</button>
      <SnapControls mode={snapMode(snapping)} size={snapping.gridSize} onModeChange={mode => changeSnapping(mode)} onSizeChange={size => changeSnapping(snapMode(api.getAppState()), size)} />
      </div>}
    <PenWidthPanel root={canvasRoot} enabled={showPenWidth} value={widthValue} onChange={changePenWidth} />
    {api && <DiagramTools api={api} root={canvasRoot} onMessage={onMessage} />}
    {reading && api && <ReadTextDialog api={api} board={board} client={client} onClose={() => setReading(false)} onMessage={onMessage} />}
  </div>;
});
