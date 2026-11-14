import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { AppWindow, Camera, Loader2, Maximize2, RefreshCw, Scissors, ScreenShareOff, SwitchCamera, X } from 'lucide-react';
import { blobToDataURL } from '../lib/assets';
import { stampGridTranslation, stampScenePoint } from '../lib/stamp-placement';
import { boardImageSize, CAPTURE_TOOL, canSnip, captureShortcut, clampPoint, cropFromSelection, dragRect, fitFrame, fitWithin, imageFileId, isCaptureCancel, isCaptureTool, isNewSnip, markExternalLaunch, SHARE_IDLE_MS, shareLabel, SNIP_WAIT_MS, systemSnip, usesNativeCamera, type CaptureMode, type Point, type Rect, type Size } from '../lib/capture';
import './capture-tools.css';

/** Chrome and Edge keep focus on Note after the picker instead of jumping to the shared window. */
type FocusController = { setFocusBehavior?: (behavior: 'focus-captured-surface' | 'no-focus-change') => void };
type CaptureControllerClass = new () => FocusController;
interface Share { stream: MediaStream; video: HTMLVideoElement; label: string }
/** Waiting for the system screenshot tool to put a snip on the clipboard. */
interface SnipWait { at: Point; baseline: string | null | undefined; opened: boolean; reading: boolean; blocked: boolean }

async function readClipboardImage() {
  if (typeof navigator.clipboard?.read !== 'function') throw Object.assign(new Error('Clipboard reading is unavailable.'), { name: 'NotSupportedError' });
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(entry => entry.startsWith('image/'));
    if (type) { const blob = await item.getType(type); return { blob, hash: await imageFileId(blob) }; }
  }
  return null;
}
/** Denied, unsupported, or not permitted: the snip then arrives with Ctrl+V instead. */
async function clipboardBlocked(error: unknown) {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotSupportedError' || name === 'TypeError') return true;
  try { return (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })).state === 'denied'; } catch { return name === 'NotAllowedError'; }
}
/** Open Windows' own snip overlay (the one Win+Shift+S opens). It copies the snip to the clipboard. */
function openWindowsSnip() {
  markExternalLaunch();
  const link = document.createElement('a'); link.href = 'ms-screenclip:'; link.rel = 'noopener'; link.click();
}
async function pictureSize(blob: Blob): Promise<Size> {
  const bitmap = await createImageBitmap(blob);
  try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
}
function typingOrDialog(target: EventTarget | null, root: HTMLElement) {
  if (!(target instanceof HTMLElement) || (target !== document.body && !root.contains(target))) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return true;
  return [...document.querySelectorAll<HTMLElement>('.modal-backdrop,[role="dialog"][aria-modal="true"],dialog[open]')]
    .some(element => !element.closest('.excalidraw') && element.getClientRects().length > 0);
}

const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The picture could not be encoded.')), type, quality));

function nextVideoFrame(video: HTMLVideoElement, timeout: number) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeout);
    // A still window sends no new frames; the timeout keeps the last one.
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
  });
}

async function grabFrame(video: HTMLVideoElement) {
  if (video.paused) await video.play();
  if (!video.videoWidth) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The shared screen did not send a picture. Try again.')), 5000);
    video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  await nextVideoFrame(video, 400);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  return canvas;
}

/** Decode a camera photo (with its orientation) and shrink it to a board-friendly size. */
async function photoBlob(file: Blob) {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.width, size.height);
    return { blob: await canvasBlob(canvas, 'image/jpeg', 0.9), size };
  } finally { bitmap.close(); }
}

export function CaptureTools({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLDivElement | null; onMessage: (text: string) => void }) {
  const [host, setHost] = useState<Element | null>(null);
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [snip, setSnip] = useState<{ frame: HTMLCanvasElement; at: Point } | null>(null);
  const [viewfinder, setViewfinder] = useState<Point | null>(null);
  const [shared, setShared] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<{ token: number; blocked: boolean } | null>(null);
  const wait = useRef<SnipWait | null>(null);
  const modeRef = useRef<CaptureMode | null>(null);
  const share = useRef<Share | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const photoAt = useRef<Point | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const starting = useRef(false);
  const live = useRef({ onMessage }); live.current = { onMessage };
  const snipSupported = canSnip(), screenshotTool = systemSnip();

  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-capture"]') || null); }, [root]);
  useEffect(() => api.onChange((_elements, state) => {
    const armed = isCaptureTool(state.activeTool);
    // Native pointer cleanup otherwise drops custom tools back to selection.
    if (armed && !state.activeTool.locked) api.updateScene({ appState: { activeTool: { ...state.activeTool, locked: true } }, captureUpdate: CaptureUpdateAction.NEVER });
    if (!armed && modeRef.current) { modeRef.current = null; setMode(null); }
  }), [api]);
  useEffect(() => () => { stopShare(); wait.current = null; }, []);

  function focusBoard() { root?.querySelector<HTMLElement>('.excalidraw')?.focus(); }
  function arm(next: CaptureMode) {
    if (!root || api.getAppState().viewModeEnabled) return;
    if (modeRef.current === next) { disarm(); return; }
    flushSync(() => {
      root.dispatchEvent(new Event('note-board-tool-activate'));
      api.updateScene({ appState: { openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
      api.setActiveTool({ type: 'custom', customType: CAPTURE_TOOL, locked: true });
      modeRef.current = next; setMode(next);
    });
    focusBoard(); api.setCursor('crosshair');
  }
  function disarm(focus = true) {
    modeRef.current = null; setMode(null);
    if (isCaptureTool(api.getAppState().activeTool)) api.setActiveTool({ type: 'selection', locked: false });
    api.resetCursor();
    if (focus) focusBoard();
  }

  function stopShare() {
    clearTimeout(idle.current);
    const current = share.current; share.current = null;
    if (current) { current.stream.getTracks().forEach(track => track.stop()); current.video.srcObject = null; current.video.remove(); }
    setShared(null);
  }
  function keepShareAlive() {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { stopShare(); live.current.onMessage('Stopped screen sharing after 10 idle minutes.'); }, SHARE_IDLE_MS);
  }
  /** Call without awaiting first: the browser needs the click that started it. */
  function ensureShare(): Promise<Share> {
    const current = share.current;
    if (current && current.stream.getVideoTracks().some(track => track.readyState === 'live')) return Promise.resolve(current);
    stopShare();
    const Controller = (globalThis as { CaptureController?: CaptureControllerClass }).CaptureController;
    const controller = typeof Controller === 'function' ? new Controller() : undefined;
    const options = { video: { displaySurface: 'window', frameRate: { ideal: 5, max: 15 } }, audio: false, controller,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'include' };
    return navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions).then(stream => {
      try { controller?.setFocusBehavior?.('no-focus-change'); } catch { /* picker already finished; focus stays as the browser chose */ }
      const [track] = stream.getVideoTracks();
      const video = document.createElement('video');
      video.className = 'capture-share-video'; video.muted = true; video.playsInline = true; video.srcObject = stream;
      document.body.append(video);
      const next: Share = { stream, video, label: shareLabel(track?.getSettings().displaySurface) };
      track?.addEventListener('ended', () => { if (share.current === next) stopShare(); });
      share.current = next; setShared(next.label);
      return next;
    });
  }
  function startSnip(at: Point) {
    if (starting.current) return;
    starting.current = true; setBusy(true);
    ensureShare().then(current => grabFrame(current.video)).then(frame => { keepShareAlive(); setSnip({ frame, at }); })
      .catch(error => live.current.onMessage(isCaptureCancel(error) ? 'Snip cancelled.' : `Could not snip: ${errorText(error, 'screen sharing is unavailable')}`))
      .finally(() => { starting.current = false; setBusy(false); });
  }
  async function finishSnip(crop: Rect | null) {
    const current = snip; if (!current) return;
    setSnip(null); focusBoard();
    const { frame, at } = current, rect = crop || { x: 0, y: 0, width: frame.width, height: frame.height };
    try {
      const canvas = document.createElement('canvas'); canvas.width = rect.width; canvas.height = rect.height;
      canvas.getContext('2d')!.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      await insertPicture(await canvasBlob(canvas, 'image/png'), rect, at);
    } catch (error) { live.current.onMessage(`Could not add the snip: ${errorText(error, 'please try again')}`); }
  }

  function endWait() { wait.current = null; setWaiting(null); }
  /** Snip with the computer's own screenshot tool, then pick the snip up from the clipboard. */
  function beginSystemSnip(at: Point) {
    const current: SnipWait = { at, baseline: undefined, opened: false, reading: false, blocked: false };
    wait.current = current; setWaiting({ token: Date.now(), blocked: false });
    // Remember what is already on the clipboard so it is never mistaken for the new snip.
    current.reading = true;
    readClipboardImage().then(image => { if (wait.current === current && !current.opened) current.baseline = image?.hash ?? null; })
      .catch(error => clipboardBlocked(error).then(blocked => { if (blocked && wait.current === current) { current.blocked = true; setWaiting({ token: Date.now(), blocked: true }); } }))
      .finally(() => { current.reading = false; });
    if (screenshotTool === 'windows') openWindowsSnip();
  }
  function placeWaitingSnip(blob: Blob) {
    const current = wait.current; if (!current) return;
    endWait(); focusBoard();
    void pictureSize(blob).then(size => insertPicture(blob, size, current.at))
      .catch(error => live.current.onMessage(`Could not add the snip: ${errorText(error, 'please try again')}`));
  }
  useEffect(() => {
    const current = wait.current; if (!waiting || !current) return;
    const opened = () => { current.opened = true; };
    const poll = () => {
      if (wait.current !== current || current.reading || current.blocked || !document.hasFocus()) return;
      if (current.baseline === undefined && !current.opened) return;
      current.reading = true;
      readClipboardImage().then(image => { if (wait.current === current && image && isNewSnip(image.hash, current.baseline, current.opened)) placeWaitingSnip(image.blob); })
        .catch(error => clipboardBlocked(error).then(blocked => { if (blocked && wait.current === current) { current.blocked = true; setWaiting({ token: Date.now(), blocked: true }); } }))
        .finally(() => { current.reading = false; });
    };
    // Window capture runs before the board's own paste handler, which would center the picture.
    const paste = (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.files || []).find(file => file.type.startsWith('image/'));
      if (!image || wait.current !== current) return;
      event.preventDefault(); event.stopImmediatePropagation(); placeWaitingSnip(image);
    };
    const interval = setInterval(poll, 250);
    const timeout = setTimeout(() => { if (wait.current === current) { endWait(); live.current.onMessage('Stopped waiting for a snip. Press X to snip again.'); } }, SNIP_WAIT_MS);
    window.addEventListener('blur', opened); window.addEventListener('focus', poll); window.addEventListener('paste', paste, true);
    return () => { clearInterval(interval); clearTimeout(timeout); window.removeEventListener('blur', opened); window.removeEventListener('focus', poll); window.removeEventListener('paste', paste, true); };
  }, [waiting?.token]);

  async function insertPicture(blob: Blob, size: Size, at: Point) {
    const id = await imageFileId(blob) as BinaryFileData['id'];
    api.addFiles([{ id, dataURL: await blobToDataURL(blob) as BinaryFileData['dataURL'], mimeType: blob.type as BinaryFileData['mimeType'], created: Date.now() }]);
    const shown = boardImageSize(size), state = api.getAppState();
    let { x, y } = at;
    if (state.gridModeEnabled && state.gridSize) { const offset = stampGridTranslation([{ x, y }], state.gridSize); x += offset.x; y += offset.y; }
    const [element] = convertToExcalidrawElements([{ type: 'image', x, y, width: shown.width, height: shown.height, fileId: id, status: 'saved', scale: [1, 1] }]);
    if (isCaptureTool(api.getAppState().activeTool)) api.setActiveTool({ type: 'selection', locked: false });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  async function addPhoto(file: Blob, at: Point) {
    try { const photo = await photoBlob(file); await insertPicture(photo.blob, photo.size, at); }
    catch (error) { live.current.onMessage(`Could not add the photo: ${errorText(error, 'this picture format is not supported here')}`); }
  }

  /** The board point was chosen: open the screen picker or the camera from this same click. */
  function place(client: Point) {
    const current = modeRef.current; if (!current) return;
    const at = stampScenePoint(client, api.getAppState());
    if (current === 'snip') beginSystemSnip(at);
    else if (usesNativeCamera()) { photoAt.current = at; photoInput.current?.click(); }
    else setViewfinder(at);
    // Let the editor finish its own pointer-up before switching tools.
    queueMicrotask(() => disarm(false));
  }

  useEffect(() => {
    if (!root) return;
    let candidate: { id: number; x: number; y: number; moved: boolean } | null = null;
    const pointers = new Set<number>();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modeRef.current && isCaptureTool(api.getAppState().activeTool)) { event.preventDefault(); event.stopImmediatePropagation(); disarm(); return; }
      if (event.key === 'Escape' && wait.current) { event.preventDefault(); event.stopImmediatePropagation(); endWait(); return; }
      const shortcut = captureShortcut(event), state = api.getAppState();
      if (!shortcut || (shortcut === 'snip' && !canSnip()) || typingOrDialog(event.target, root) || state.editingTextElement || state.openDialog || state.viewModeEnabled || state.contextMenu) return;
      event.preventDefault(); event.stopImmediatePropagation(); arm(shortcut);
    };
    const down = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLCanvasElement) || !root.contains(event.target)) return;
      pointers.add(event.pointerId); if (pointers.size > 1) candidate = null;
    };
    const move = (event: PointerEvent) => {
      if (candidate?.id === event.pointerId && Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > (event.pointerType === 'touch' ? 10 : 6)) candidate.moved = true;
    };
    const up = (event: PointerEvent) => { pointers.delete(event.pointerId); if (event.type === 'pointercancel') candidate = null; };
    const clear = () => { candidate = null; pointers.clear(); };
    const offDown = api.onPointerDown((tool, state, event) => {
      candidate = isCaptureTool(tool) && event.button === 0 && event.isPrimary && pointers.size <= 1 && !state.resize.handleType
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
    });
    const offUp = api.onPointerUp((tool, _state, event) => {
      const finished = candidate; candidate = null;
      if (!finished || finished.moved || finished.id !== event.pointerId || !isCaptureTool(tool) || event.type !== 'pointerup') return;
      const bounds = root.querySelector('canvas.interactive')?.getBoundingClientRect();
      if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      place({ x: event.clientX, y: event.clientY });
    });
    document.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear);
    return () => {
      offDown(); offUp();
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear);
    };
  }, [api, root]);

  const hint = mode === 'snip'
    ? <>Click where the snip goes, then drag over anything on your screen</>
    : <>Click or tap the board where the photo goes</>;
  const waitingText = waiting?.blocked
    ? <>Snip with {screenshotTool === 'mac' ? <kbd>⌘ Ctrl Shift 4</kbd> : <kbd>Win Shift S</kbd>}, then press <kbd>Ctrl V</kbd> here. It lands where you clicked.</>
    : screenshotTool === 'windows' ? <>Drag over what you want. It lands where you clicked. <small>No snip overlay? Press <kbd>Win Shift S</kbd>.</small></>
    : screenshotTool === 'mac' ? <>Press <kbd>⌘ Ctrl Shift 4</kbd> and drag. It lands where you clicked.</>
    : <>Copy a screenshot to the clipboard, or press <kbd>Ctrl V</kbd>. It lands where you clicked.</>;
  return <>
    {host && createPortal(<>
      {snipSupported && <button type="button" className="capture-snip-trigger note-wide-only" aria-pressed={mode === 'snip'} aria-label="Snip from screen"
        aria-keyshortcuts="X" title="Snip (X): click the board where it goes, then drag over anything on your screen" onClick={() => arm('snip')}><Scissors size={18} /></button>}
      <button type="button" className="capture-camera-trigger" aria-pressed={mode === 'camera'} aria-label="Take a photo"
        aria-keyshortcuts="C" title="Camera (C): click the board where the photo goes, then take a picture" onClick={() => arm('camera')}><Camera size={18} /></button>
    </>, host)}
    <input ref={photoInput} className="capture-photo-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true"
      onChange={event => { const file = event.target.files?.[0], at = photoAt.current; event.target.value = ''; photoAt.current = null; if (file && at) void addPhoto(file, at); }} />
    {mode && <div className="capture-hint" role="status">{mode === 'snip' ? <Scissors size={16} /> : <Camera size={16} />}<span>{hint}.<span className="capture-esc"> Esc cancels.</span></span>
      <button type="button" aria-label="Cancel" title="Cancel (Esc)" onClick={() => disarm()}><X size={17} /></button></div>}
    {!mode && waiting && <div className="capture-hint capture-waiting-hint" role="status"><Scissors size={16} /><span>{waitingText}</span>
      {snipSupported && <button type="button" className="capture-hint-text" title="Share a window and snip it inside Note instead" onClick={() => { const at = wait.current?.at; endWait(); if (at) startSnip(at); }}><AppWindow size={16} /><span>Snip a window</span></button>}
      <button type="button" aria-label="Cancel snip" title="Cancel (Esc)" onClick={() => { endWait(); focusBoard(); }}><X size={17} /></button></div>}
    {!mode && busy && <div className="capture-hint" role="status"><Loader2 className="spinning" size={16} /><span>Choose a window or screen to snip in the browser's picker.</span></div>}
    {!mode && !busy && !snip && shared && <div className="capture-share-pill" role="status"><Scissors size={14} /><span>Snip is ready · sharing {shared}</span>
      <button type="button" onClick={stopShare} title="Stop sharing your screen with Note"><ScreenShareOff size={15} /><span>Stop</span></button></div>}
    {snip && createPortal(<SnipOverlay frame={snip.frame} label={shared || 'your screen'} onSnip={crop => void finishSnip(crop)}
      onChangeSource={() => { const at = snip.at; setSnip(null); stopShare(); startSnip(at); }}
      onCancel={() => { setSnip(null); focusBoard(); }} />, document.body)}
    {viewfinder && createPortal(<CameraOverlay onClose={() => { setViewfinder(null); focusBoard(); }}
      onError={error => { setViewfinder(null); focusBoard(); live.current.onMessage(isCaptureCancel(error) ? 'Camera access was not allowed. Allow the camera for Note in your browser\'s site settings.' : `Could not open the camera: ${errorText(error, 'no camera found')}`); }}
      onCapture={(blob, size) => { const at = viewfinder; setViewfinder(null); focusBoard(); void insertPicture(blob, size, at).catch(error => live.current.onMessage(`Could not add the photo: ${errorText(error, 'please try again')}`)); }} />, document.body)}
  </>;
}

/** A frozen picture of the shared window or screen. Drag over it to snip. */
function SnipOverlay({ frame, label, onSnip, onChangeSource, onCancel }: { frame: HTMLCanvasElement; label: string; onSnip: (crop: Rect | null) => void; onChangeSource: () => void; onCancel: () => void }) {
  const overlay = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), clip = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const [drag, setDrag] = useState<{ id: number; start: Point; end: Point } | null>(null);
  const actions = useRef({ onSnip, onCancel }); actions.current = { onSnip, onCancel };
  const size = { width: frame.width, height: frame.height };
  const shown = fitFrame(size, area, window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    const element = stage.current; if (!element) return;
    const measure = () => { const bounds = element.getBoundingClientRect(); setArea({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { frame.className = 'capture-snip-frame'; clip.current?.prepend(frame); return () => frame.remove(); }, [frame]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    overlay.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); actions.current.onCancel(); }
      else if (event.key === 'Enter' && !(event.target as Element)?.closest?.('button')) { event.preventDefault(); event.stopImmediatePropagation(); actions.current.onSnip(null); }
      else if (event.key === 'Tab') {
        const items = [...overlay.current?.querySelectorAll<HTMLElement>('button') || []];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected && !previous.closest('.excalidraw')) previous.focus(); };
  }, []);
  const point = (event: ReactPointerEvent) => clampPoint({ x: event.clientX, y: event.clientY }, shown);
  const selection = drag && dragRect(drag.start, drag.end);
  const crop = selection && cropFromSelection(selection, shown, size);
  return <div ref={overlay} className="capture-overlay capture-snip" role="dialog" aria-modal="true" aria-label="Snip from screen" tabIndex={-1}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('.capture-bar')) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const start = point(event); setDrag({ id: event.pointerId, start, end: start });
    }}
    onPointerMove={event => { if (drag?.id === event.pointerId) setDrag({ ...drag, end: point(event) }); }}
    onPointerUp={event => {
      if (drag?.id !== event.pointerId) return;
      const final = cropFromSelection(dragRect(drag.start, point(event)), shown, size);
      setDrag(null); if (final) onSnip(final);
    }}
    onPointerCancel={() => setDrag(null)}>
    <div className="capture-bar">
      <p><Scissors size={16} /><span><strong>Drag over the area to snip.</strong> It goes on the board where you clicked. Enter takes all of {label}; Esc cancels.</span></p>
      <div className="capture-bar-actions">
        <button type="button" onClick={() => onSnip(null)} title="Add the whole picture (Enter)"><Maximize2 size={16} /><span>Take all</span></button>
        <button type="button" onClick={onChangeSource} title="Choose a different window or screen"><RefreshCw size={16} /><span>Change window</span></button>
        <button type="button" onClick={onCancel} title="Cancel (Esc)" aria-label="Cancel snip"><X size={17} /></button>
      </div>
    </div>
    <div ref={stage} className="capture-stage" />
    <div ref={clip} className="capture-snip-clip" data-selecting={!!selection} style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}>
      {selection && <div className="capture-selection" style={{ left: selection.x - shown.x, top: selection.y - shown.y, width: selection.width, height: selection.height }}>
        {crop && <span>{crop.width} × {crop.height}</span>}
      </div>}
    </div>
  </div>;
}

/** An in-app viewfinder for laptop and desktop cameras. Phones use their own camera app. */
function CameraOverlay({ onCapture, onClose, onError }: { onCapture: (blob: Blob, size: Size) => void; onClose: () => void; onError: (error: unknown) => void }) {
  const overlay = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const current = useRef<string | undefined>(undefined);
  const actions = useRef({ onClose, onError, shoot: () => {} });
  async function shoot() {
    const element = video.current; if (!element || !element.videoWidth) return;
    const size = fitWithin({ width: element.videoWidth, height: element.videoHeight });
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    canvas.getContext('2d')!.drawImage(element, 0, 0, size.width, size.height);
    try { onCapture(await canvasBlob(canvas, 'image/jpeg', 0.92), size); } catch (error) { onError(error); }
  }
  actions.current = { onClose, onError, shoot: () => { void shoot(); } };
  useEffect(() => {
    let alive = true, stream: MediaStream | null = null;
    setReady(false);
    const quality = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId }, ...quality } : { facingMode: { ideal: 'environment' }, ...quality } })
      .then(async next => {
        if (!alive) { next.getTracks().forEach(track => track.stop()); return; }
        stream = next; current.current = next.getVideoTracks()[0]?.getSettings().deviceId;
        if (video.current) { video.current.srcObject = next; await video.current.play().catch(() => {}); }
        setReady(true);
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (alive) setCameras(devices.filter(device => device.kind === 'videoinput' && device.deviceId).map(device => device.deviceId));
      })
      .catch(error => { if (alive) actions.current.onError(error); });
    return () => { alive = false; stream?.getTracks().forEach(track => track.stop()); };
  }, [deviceId]);
  useEffect(() => {
    overlay.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); actions.current.onClose(); }
      else if ((event.key === 'Enter' || event.key === ' ') && !(event.target as Element)?.closest?.('button')) { event.preventDefault(); event.stopImmediatePropagation(); actions.current.shoot(); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, []);
  const switchCamera = () => { const index = cameras.indexOf(current.current || ''); setDeviceId(cameras[(index + 1) % cameras.length]); };
  return <div ref={overlay} className="capture-overlay capture-camera" role="dialog" aria-modal="true" aria-label="Take a photo" tabIndex={-1}>
    <div className="capture-bar">
      <p><Camera size={16} /><span><strong>Take a photo.</strong> It goes on the board where you clicked. Enter or Space takes it; Esc cancels.</span></p>
      <div className="capture-bar-actions"><button type="button" onClick={onClose} title="Cancel (Esc)" aria-label="Cancel photo"><X size={17} /></button></div>
    </div>
    <div className="capture-viewfinder">
      <video ref={video} muted playsInline />
      {!ready && <span className="capture-waiting"><Loader2 className="spinning" size={20} />Opening the camera…</span>}
    </div>
    <div className="capture-shutter-row">
      <span />
      <button type="button" className="capture-shutter" disabled={!ready} onClick={() => void shoot()} aria-label="Take photo" title="Take photo (Enter)"><span /></button>
      {cameras.length > 1 ? <button type="button" className="capture-switch" onClick={switchCamera} aria-label="Switch camera" title="Switch camera"><SwitchCamera size={20} /></button> : <span />}
    </div>
  </div>;
}
