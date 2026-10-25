import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, getCommonBounds, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, MousePointer2 } from 'lucide-react';
import { getStampIcon, readStampPreferences, storeStampPreferences, STAMP_ICONS, type StampPreferences } from '../lib/vector-stamps';
import { createIconStamp } from '../lib/vector-stamp-scene';
import { ICON_STAMP_TOOL, isStampShortcut, isStampTool, stampGridTranslation, stampScenePoint } from '../lib/stamp-placement';
import { StampPicker } from './StampPicker';
import './stamp-tools.css';

function StampGlyph({ id, size }: { id: string; size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{getStampIcon(id).geometry.map((part, index) => part.type === 'ellipse'
    ? <ellipse key={index} cx={part.x + part.width / 2} cy={part.y + part.height / 2} rx={part.width / 2} ry={part.height / 2} />
    : <polyline key={index} points={part.points.map(point => point.join(',')).join(' ')} />)}</svg>;
}

function applicationDialogOpen() {
  return [...document.querySelectorAll<HTMLElement>('.modal-backdrop,[role="dialog"][aria-modal="true"],dialog[open]')]
    .some(element => !element.closest('.excalidraw') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
}

interface StampPointer { id: number; x: number; y: number; moved: boolean; multi: boolean }

export function StampTools({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLDivElement | null; onMessage: (text: string) => void }) {
  const [preferences, setPreferences] = useState(readStampPreferences);
  const [active, setActive] = useState(() => isStampTool(api.getAppState().activeTool));
  const [opened, setOpened] = useState(false);
  const [host, setHost] = useState<Element | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(api.getAppState().zoom.value);
  const pointer = useRef<StampPointer | null>(null);
  const pointers = useRef(new Set<number>());
  const paletteColorChanged = useRef(false);
  const nativeStamp = useRef(false);
  const live = useRef({ preferences, opened, onMessage });
  live.current = { preferences, opened, onMessage };
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-stamps"]') || null); }, [root]);
  useEffect(() => api.onChange((_elements, state) => {
    const armed = isStampTool(state.activeTool);
    const leaving = nativeStamp.current && !armed;
    nativeStamp.current = armed;
    if ((armed && !state.activeTool.locked) || (leaving && state.activeTool.locked && state.activeTool.type !== 'custom' && state.activeTool.type !== 'text')) {
      api.updateScene({ appState: { activeTool: { ...state.activeTool, locked: armed } }, captureUpdate: CaptureUpdateAction.NEVER });
    }
    setActive(armed); setZoom(state.zoom.value);
    if (!armed) { pointer.current = null; setPreview(null); }
  }), [api]);

  function save(next: StampPreferences) { live.current.preferences = next; setPreferences(next); storeStampPreferences(next); }
  function finish(focus = true) {
    pointer.current = null; setPreview(null);
    if (isStampTool(api.getAppState().activeTool)) api.setActiveTool({ type: 'selection', locked: false });
    setActive(false); api.resetCursor();
    if (focus) root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  function activate() {
    if (!root || api.getAppState().viewModeEnabled) return;
    pointer.current = null;
    flushSync(() => {
      root.dispatchEvent(new Event('note-board-tool-activate'));
      setOpened(false);
      api.updateScene({ appState: { openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
      api.setActiveTool({ type: 'custom', customType: ICON_STAMP_TOOL, locked: true });
      setActive(true);
    });
    root.querySelector<HTMLElement>('.excalidraw')?.focus();
    api.setCursor('crosshair');
  }
  function choose(id: string) {
    const icon = getStampIcon(id), previous = live.current.preferences;
    save({ ...previous, iconId: icon.id, color: paletteColorChanged.current || icon.id === previous.iconId ? previous.color : icon.defaultColor });
    activate();
  }
  function openPicker() { finish(false); paletteColorChanged.current = false; setOpened(true); }

  useEffect(() => {
    if (!root) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target, editor = root.querySelector('.excalidraw');
      if (live.current.opened || applicationDialogOpen() || api.getAppState().contextMenu || api.getAppState().openDialog) return;
      if (event.key === 'Escape' && isStampTool(api.getAppState().activeTool)) { event.preventDefault(); event.stopImmediatePropagation(); finish(); return; }
      if (!isStampShortcut(event) || !editor || !(target instanceof HTMLElement) || !editor.contains(target)) return;
      if (target !== editor && !(target instanceof HTMLCanvasElement)) return;
      const state = api.getAppState();
      if (state.editingTextElement || state.openDialog || state.viewModeEnabled) return;
      event.preventDefault(); event.stopImmediatePropagation(); activate();
    };
    const down = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLCanvasElement) || !root.contains(event.target)) {
        if (event.target instanceof Element && root.contains(event.target) && event.target.closest('button,input,select,label,a,[role="button"]') && !event.target.closest('.icon-stamp-tool') && isStampTool(api.getAppState().activeTool)) finish(false);
        return;
      }
      pointers.current.add(event.pointerId);
      if (pointer.current && pointers.current.size > 1) pointer.current.multi = true;
    };
    const move = (event: PointerEvent) => {
      const current = pointer.current;
      if (current?.id === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > (event.pointerType === 'touch' ? 10 : 6)) current.moved = true;
      if (!isStampTool(api.getAppState().activeTool)) return;
      if (!(event.target instanceof HTMLCanvasElement) || !root.contains(event.target) || event.pointerType === 'touch') { setPreview(null); return; }
      const bounds = root.getBoundingClientRect();
      setPreview({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    };
    const release = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      const finished = pointer.current;
      if (event.type === 'pointercancel') { pointer.current = null; setPreview(null); return; }
      // A microtask can run between capture and native pointer-up listeners.
      // Clear abandoned candidates only after the complete event has propagated.
      setTimeout(() => { if (pointer.current === finished) pointer.current = null; }, 0);
    };
    const clear = () => { pointer.current = null; pointers.current.clear(); setPreview(null); };
    const unsubscribeDown = api.onPointerDown((tool, state, event) => {
      if (!isStampTool(tool) || !isStampTool(api.getAppState().activeTool) || event.button !== 0 || !event.isPrimary || state.resize.handleType || api.getAppState().openDialog || applicationDialogOpen() || live.current.opened) return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, multi: pointers.current.size > 1 };
      api.setCursor('crosshair');
    });
    const unsubscribeUp = api.onPointerUp((tool, state, event) => {
      const candidate = pointer.current;
      pointer.current = null;
      if (!candidate || candidate.id !== event.pointerId || candidate.moved || candidate.multi || state.resize.isResizing || !isStampTool(tool)
        || !isStampTool(api.getAppState().activeTool) || event.type !== 'pointerup' || event.button !== 0 || applicationDialogOpen() || live.current.opened) return;
      const canvas = root.querySelector('canvas.interactive'), bounds = canvas?.getBoundingClientRect();
      if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      // Native pointer-up completes before its selected-elements state is final.
      // Append after that update so Escape can keep the new group selected for resizing.
      queueMicrotask(() => {
        if (!isStampTool(api.getAppState().activeTool) || live.current.opened || !root.isConnected) return;
        try {
          const current = api.getAppState(), settings = live.current.preferences;
          const added = createIconStamp(settings.iconId, stampScenePoint({ x: event.clientX, y: event.clientY }, current), settings.size, settings.color);
          if (current.gridModeEnabled && current.gridSize) {
            const [x, y] = getCommonBounds(added);
            const offset = stampGridTranslation([{ x, y }], current.gridSize);
            for (const element of added) mutateElement(element, { x: element.x + offset.x, y: element.y + offset.y }, false);
          }
          if (!settings.repeat) { api.setActiveTool({ type: 'selection', locked: false }); setActive(false); setPreview(null); }
          api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...added], appState: {
            selectedElementIds: Object.fromEntries(added.map(element => [element.id, true])),
            selectedGroupIds: Object.fromEntries([...new Set(added.flatMap(element => element.groupIds))].map(id => [id, true])),
          }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
          if (settings.repeat) api.setCursor('crosshair'); else api.resetCursor();
        } catch (error) { live.current.onMessage(`Could not add icon: ${error instanceof Error ? error.message : 'please try again'}`); }
      });
    });
    document.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', clear);
    root.addEventListener('contextmenu', clear, true);
    return () => {
      unsubscribeDown(); unsubscribeUp();
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', clear);
      root.removeEventListener('contextmenu', clear, true);
    };
  }, [api, root]);

  const icon = getStampIcon(preferences.iconId);
  return <>
    {host && createPortal(<div className="icon-stamp-tool">
      <button className="icon-stamp-trigger" aria-pressed={active} aria-label={`Stamp ${icon.label} (I)`} title={`${icon.label}: ${icon.description}. I stamps this icon; Esc finishes.`} onClick={() => active ? finish() : activate()}>
        <span className="icon-stamp-glyph" style={{ color: preferences.color }}><StampGlyph id={icon.id} size={20} /></span><span className="icon-stamp-label">{icon.label}</span><kbd>I</kbd>
      </button>
      <button className="icon-stamp-picker-trigger" aria-label="Choose stamp icon" aria-haspopup="dialog" aria-expanded={opened} title={`Choose from ${STAMP_ICONS.length} icon stamps`} onClick={openPicker}><ChevronDown size={14} /></button>
    </div>, host)}
    {active && preview && !opened && <div className="icon-stamp-preview" style={{ left: preview.x, top: preview.y, color: preferences.color }}><StampGlyph id={icon.id} size={preferences.size * zoom} /></div>}
    {active && !opened && <div className="icon-stamp-hint" role="status"><span>Stamping {icon.label} · click or tap to place. Esc to resize.</span><button aria-label="Finish stamping and resize" title="Finish stamping and resize" onClick={() => finish()}><MousePointer2 size={17} /></button></div>}
    {opened && <StampPicker selectedId={icon.id} color={preferences.color} size={preferences.size} repeat={preferences.repeat} renderIcon={(id, size) => <StampGlyph id={id} size={size} />}
      onChoose={choose} onColorChange={color => { paletteColorChanged.current = true; save({ ...preferences, color }); }}
      onSizeChange={size => save({ ...preferences, size })} onRepeatChange={repeat => save({ ...preferences, repeat })} onClose={() => setOpened(false)} />}
  </>;
}
