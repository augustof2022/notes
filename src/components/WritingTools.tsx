import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, Eraser } from 'lucide-react';
import { Modal } from './Modal';
import { inkWorldSamples, recognizeInkShape, type InkPoint, type InkShape } from '../lib/ink-geometry';
import { cleanShapeFromInk, eraseInkElements, PARTIAL_ERASER_TOOL, readWritingPreferences, storeWritingPreferences, type WritingPreferences } from '../lib/ink-scene';
import { stampScenePoint } from '../lib/stamp-placement';
import './writing-tools.css';

const HOLD_MS = 650;
const partial = (tool: { type: string; customType?: string | null }) => tool.type === 'custom' && tool.customType === PARTIAL_ERASER_TOOL;
const dialogOpen = () => [...document.querySelectorAll<HTMLElement>('.modal-backdrop,[aria-modal="true"],dialog[open]')].some(element => !element.closest('.excalidraw') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
interface EraseGesture { id: number; last: InkPoint; pending: InkPoint[]; baseline: readonly ExcalidrawElement[]; touched: Set<string>; changed: boolean }
interface HoldGesture { id: number; strokeId: string; x: number; y: number; shape: InkShape | null }

export function WritingTools({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLDivElement | null; onMessage: (message: string) => void }) {
  const [preferences, setPreferences] = useState(readWritingPreferences), [opened, setOpened] = useState(false);
  const [host, setHost] = useState<Element | null>(null), [active, setActive] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null), [suggestion, setSuggestion] = useState<InkShape | null>(null);
  const [viewport, setViewport] = useState(() => api.getAppState());
  const live = useRef({ preferences, opened, onMessage }); live.current = { preferences, opened, onMessage };
  const erasing = useRef<EraseGesture | null>(null), holding = useRef<HoldGesture | null>(null);
  const pointers = useRef(new Set<number>()), timer = useRef<ReturnType<typeof setTimeout> | null>(null), frame = useRef(0);
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-writing"]') || null); }, [root]);
  function stopHold() { if (timer.current) clearTimeout(timer.current); timer.current = null; holding.current = null; setSuggestion(null); }
  function flushErase() {
    if (frame.current) cancelAnimationFrame(frame.current); frame.current = 0;
    const gesture = erasing.current;
    if (!gesture || !gesture.pending.length) return;
    let elements: readonly ExcalidrawElement[] = api.getSceneElementsIncludingDeleted();
    let changed = false;
    const radius = live.current.preferences.eraserSize / (2 * api.getAppState().zoom.value);
    for (const to of gesture.pending.splice(0)) {
      const next = eraseInkElements(elements, gesture.last, to, radius);
      if (next) {
        const previous = new Map(elements.map(element => [element.id, element]));
        for (const element of next) if (previous.get(element.id) !== element) gesture.touched.add(element.id);
        elements = next; changed = true; gesture.changed = true;
      }
      gesture.last = to;
    }
    if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }
  function endErase(rollback = false) {
    flushErase(); const gesture = erasing.current; erasing.current = null;
    if (!gesture?.changed) return;
    if (rollback) {
      const baseline = new Map(gesture.baseline.map(element => [element.id, element]));
      const elements = api.getSceneElementsIncludingDeleted().map(element => {
        if (!gesture.touched.has(element.id)) return element;
        const original = baseline.get(element.id);
        if (original) {
          const { version: _version, versionNonce: _nonce, updated: _updated, ...rest } = original;
          return newElementWith(element as ExcalidrawElement, rest);
        }
        return element.type === 'freedraw' ? newElementWith(element, { isDeleted: true }) : element;
      });
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    } else api.updateScene({ elements: api.getSceneElementsIncludingDeleted(), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function activateEraser(mode = live.current.preferences.eraserMode) {
    if (!root || api.getAppState().viewModeEnabled) return;
    stopHold(); endErase();
    flushSync(() => {
      root.dispatchEvent(new Event('note-board-tool-activate'));
      api.updateScene({ appState: { openMenu: null, selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
      api.setActiveTool(mode === 'partial' ? { type: 'custom', customType: PARTIAL_ERASER_TOOL, locked: true } : { type: 'eraser' });
    });
    root.querySelector<HTMLElement>('.excalidraw')?.focus(); if (mode === 'partial') api.setCursor('crosshair');
  }
  function change(next: WritingPreferences) {
    live.current.preferences = next; setPreferences(next); storeWritingPreferences(next);
    if (!next.holdShapes) stopHold();
    const tool = api.getAppState().activeTool;
    if (!live.current.opened && (partial(tool) || tool.type === 'eraser')) activateEraser(next.eraserMode);
  }
  function closeSettings() {
    const tool = api.getAppState().activeTool, wasEraser = partial(tool) || tool.type === 'eraser';
    flushSync(() => setOpened(false));
    if (wasEraser) activateEraser();
  }
  function scheduleHold() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const gesture = holding.current, state = api.getAppState();
      if (!gesture || !live.current.preferences.holdShapes || state.activeTool.type !== 'freedraw' || state.cursorButton !== 'down' || state.openDialog || state.contextMenu || dialogOpen() || pointers.current.size > 1) return;
      const stroke = api.getSceneElements().find(element => element.id === gesture.strokeId);
      if (stroke?.type !== 'freedraw' || stroke.isDeleted) return;
      const shape = recognizeInkShape(inkWorldSamples(stroke).map(sample => sample.point), 16 / state.zoom.value);
      gesture.shape = shape; setSuggestion(shape); setViewport(state);
    }, HOLD_MS);
  }
  useEffect(() => {
    if (!root) return;
    const unsubscribeChange = api.onChange((_elements, state) => {
      setActive(partial(state.activeTool) || state.activeTool.type === 'eraser');
      if (!partial(state.activeTool)) { setTip(null); if (erasing.current) endErase(); }
      if (state.activeTool.type !== 'freedraw' && holding.current) stopHold();
      if (!live.current.opened && state.activeTool.type === 'eraser' && live.current.preferences.eraserMode === 'partial') queueMicrotask(() => {
        if (!live.current.opened && api.getAppState().activeTool.type === 'eraser' && live.current.preferences.eraserMode === 'partial') activateEraser('partial');
      });
    });
    const down = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLCanvasElement) || !root.contains(event.target)) return;
      pointers.current.add(event.pointerId);
      if (pointers.current.size > 1) { stopHold(); endErase(true); setTip(null); }
    };
    const move = (event: PointerEvent) => {
      if (partial(api.getAppState().activeTool)) {
        if (event.target instanceof HTMLCanvasElement && root.contains(event.target) && pointers.current.size < 2) { const bounds = root.getBoundingClientRect(); setTip({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }); }
        else if (!erasing.current) setTip(null);
      }
      const erase = erasing.current;
      if (erase?.id === event.pointerId && pointers.current.size < 2) {
        const p = stampScenePoint({ x: event.clientX, y: event.clientY }, api.getAppState()); erase.pending.push([p.x, p.y]);
        if (!frame.current) frame.current = requestAnimationFrame(flushErase);
      }
      const hold = holding.current;
      if (hold?.id === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 3) {
        hold.x = event.clientX; hold.y = event.clientY; hold.shape = null; setSuggestion(null); scheduleHold();
      }
    };
    const up = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (event.type === 'pointercancel') { stopHold(); endErase(true); setTip(null); return; }
      if (timer.current) clearTimeout(timer.current);
      const hold = holding.current;
      setTimeout(() => { if (holding.current === hold) stopHold(); }, 0);
    };
    const unsubscribeDown = api.onPointerDown((tool, _state, event) => {
      if (event.button !== 0 || !event.isPrimary || pointers.current.size > 1 || api.getAppState().viewModeEnabled || api.getAppState().openDialog || dialogOpen()) return;
      if (partial(tool)) {
        const p = stampScenePoint({ x: event.clientX, y: event.clientY }, api.getAppState());
        erasing.current = { id: event.pointerId, last: [p.x, p.y], pending: [[p.x, p.y]], baseline: structuredClone(api.getSceneElementsIncludingDeleted()), touched: new Set(), changed: false };
        flushErase(); api.setCursor('crosshair');
      } else if (tool.type === 'freedraw' && live.current.preferences.holdShapes) {
        const stroke = api.getSceneElements().filter(element => element.type === 'freedraw' && !element.isDeleted).at(-1);
        if (stroke) { holding.current = { id: event.pointerId, strokeId: stroke.id, x: event.clientX, y: event.clientY, shape: null }; scheduleHold(); }
      }
    });
    const unsubscribeUp = api.onPointerUp((_tool, _state, event) => {
      if (erasing.current?.id === event.pointerId) { flushErase(); queueMicrotask(() => endErase()); }
      const hold = holding.current;
      if (!hold || hold.id !== event.pointerId || event.type !== 'pointerup') return;
      const shape = hold.shape; stopHold();
      if (!shape || !live.current.preferences.holdShapes) return;
      queueMicrotask(() => {
        const elements = api.getSceneElementsIncludingDeleted(), stroke = elements.find(element => element.id === hold.strokeId);
        if (stroke?.type !== 'freedraw' || stroke.isDeleted) return;
        const corrected = cleanShapeFromInk(stroke, shape);
        api.updateScene({ elements: elements.flatMap(element => element.id === stroke.id ? [newElementWith(element, { isDeleted: true }), corrected] : [element]), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        live.current.onMessage(`${shape.label} corrected. Undo restores your original ink.`);
      });
    });
    const key = (event: KeyboardEvent) => {
      if (live.current.opened || dialogOpen() || api.getAppState().openDialog || api.getAppState().contextMenu || event.isComposing || event.repeat) return;
      const editor = root.querySelector('.excalidraw'), target = event.target;
      if (!editor || !(target instanceof HTMLElement) || !editor.contains(target) || (target !== editor && !(target instanceof HTMLCanvasElement))) return;
      if (event.key === 'Escape' && (erasing.current || holding.current)) { event.preventDefault(); event.stopImmediatePropagation(); stopHold(); endErase(true); return; }
      if (event.key.toLowerCase() === 'e' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.defaultPrevented && !api.getAppState().editingTextElement) {
        event.preventDefault(); event.stopImmediatePropagation(); activateEraser();
      }
    };
    const blur = () => { stopHold(); endErase(); pointers.current.clear(); setTip(null); };
    document.addEventListener('keydown', key, true); root.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true); window.addEventListener('blur', blur);
    return () => {
      unsubscribeChange(); unsubscribeDown(); unsubscribeUp();
      document.removeEventListener('keydown', key, true); root.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); window.removeEventListener('blur', blur);
      if (timer.current) clearTimeout(timer.current); if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [api, root]);
  const shape = suggestion, z = viewport.zoom.value;
  const screen = (x: number, y: number) => ({ x: (x + viewport.scrollX) * z + viewport.offsetLeft - (root?.getBoundingClientRect().left || 0), y: (y + viewport.scrollY) * z + viewport.offsetTop - (root?.getBoundingClientRect().top || 0) });
  const origin = shape && screen(shape.x, shape.y);
  return <>
    {host && createPortal(<div className="ink-tools"><button className="ink-eraser-main" aria-pressed={active} title="Eraser (E)" aria-label={`Activate ${preferences.eraserMode === 'partial' ? 'Partial' : 'Object'} eraser (E)`} onClick={() => activateEraser()}><Eraser size={16} /><span className="ink-eraser-full-label">{preferences.eraserMode === 'partial' ? 'Partial eraser' : 'Object eraser'}</span><span className="ink-eraser-short-label">{preferences.eraserMode === 'partial' ? 'Partial' : 'Object'}</span></button><button className="ink-settings-trigger" aria-label="Writing tool settings" aria-haspopup="dialog" onClick={() => { stopHold(); endErase(); setOpened(true); }}><ChevronDown size={14} /></button></div>, host)}
    {tip && active && preferences.eraserMode === 'partial' && !opened && <div className="ink-eraser-tip" style={{ left: tip.x, top: tip.y, width: preferences.eraserSize, height: preferences.eraserSize }} />}
    {shape && origin && <><svg className="ink-shape-preview" aria-hidden="true"><g transform={`translate(${origin.x} ${origin.y}) rotate(${shape.angle * 180 / Math.PI} ${shape.width * z / 2} ${shape.height * z / 2})`}>
      {shape.kind === 'ellipse' ? <ellipse cx={shape.width * z / 2} cy={shape.height * z / 2} rx={shape.width * z / 2} ry={shape.height * z / 2} /> : shape.kind === 'rectangle' ? <rect width={shape.width * z} height={shape.height * z} /> : <polyline points={shape.points!.map(([x, y]) => `${x * z},${y * z}`).join(' ')} />}
    </g></svg><div className="ink-hold-status" role="status">{shape.label} ready · lift to apply, or keep drawing</div></>}
    {opened && createPortal(<Modal title="Writing tools" onClose={closeSettings}>
      <fieldset className="ink-eraser-modes"><legend>Eraser mode</legend>{(['partial', 'object'] as const).map(mode => <label key={mode}><input type="radio" name="note-eraser-mode" value={mode} checked={preferences.eraserMode === mode} onChange={() => change({ ...preferences, eraserMode: mode })} /><span><strong>{mode === 'partial' ? 'Partial eraser' : 'Object eraser'}</strong><small>{mode === 'partial' ? 'Erase only the pen ink under the tip. Shapes, text, and images stay intact.' : 'Delete each whole stroke, shape, or image you touch.'}</small></span></label>)}</fieldset>
      <label className="ink-size">Partial eraser size <span>{preferences.eraserSize} px</span><input type="range" min="8" max="96" step="2" value={preferences.eraserSize} onChange={event => change({ ...preferences, eraserSize: Number(event.target.value) })} /></label>
      <label className="ink-hold-option"><input type="checkbox" checked={preferences.holdShapes} onChange={event => change({ ...preferences, holdShapes: event.target.checked })} /><span><strong>Draw and hold to shape</strong><small>With the pen, pause for about ⅔ second before lifting to straighten a line or clean up a circle, ellipse, square, rectangle, or triangle. Lift immediately to keep your ink. Uncertain scribbles stay unchanged.</small></span></label>
      <p className="small-note">Use Undo to restore erased ink or undo a shape correction. These preferences stay on this browser.</p>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => { flushSync(() => setOpened(false)); activateEraser(); }}>Use eraser</button><button className="primary-button" onClick={closeSettings}>Done</button></div>
    </Modal>, document.body)}
  </>;
}
