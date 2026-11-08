import { useEffect, useRef, useState } from 'react';
import { getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Move } from 'lucide-react';
import { moveHandlePosition, selectionCenter, type SceneBounds } from '../lib/move-handle';
import './move-handle.css';

const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const forwarded = new WeakSet<Event>();

/**
 * Touch selections are mostly covered by large resize handles, so a drag on a
 * small object often resizes it. This handle only moves: it starts the
 * editor's own drag at the selection's center (where no handle is hit-tested
 * for a mouse-sized pointer) and replays the finger's movement from there, so
 * snapping, groups, frames, bound connections, and Undo behave as usual.
 */
export function MoveHandle({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [enabled, setEnabled] = useState(coarsePointer);
  const dragging = useRef<{ id: number; dx: number; dy: number; canvas: HTMLCanvasElement } | null>(null);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(pointer: coarse)'), update = () => setEnabled(query.matches);
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  function bounds(): SceneBounds | null {
    const state = api.getAppState();
    if (state.activeTool.type !== 'selection' || state.editingTextElement || state.viewModeEnabled || state.newElement || state.openDialog || state.editingLinearElement) return null;
    const ids = Object.keys(state.selectedElementIds);
    if (!ids.length) return null; // Nothing selected: skip scanning a large board on every frame.
    const wanted = new Set(ids), selected = api.getSceneElements().filter(element => wanted.has(element.id));
    if (!selected.length || selected.every(element => element.locked)) return null;
    return getCommonBounds(selected);
  }
  useEffect(() => {
    if (!enabled || !root) { setPlace(null); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = bounds(), state = api.getAppState();
      if (!box || (state.cursorButton === 'down' && !dragging.current)) { setPlace(null); return; }
      const position = moveHandlePosition(box, state), origin = root.getBoundingClientRect();
      const next = position.visible ? { left: position.left + state.offsetLeft - origin.left, top: position.top + state.offsetTop - origin.top } : null;
      setPlace(previous => previous && next && Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5 ? previous : next);
    };
    update();
    const unsubscribe = api.onChange(() => { if (!frame) frame = requestAnimationFrame(update); });
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [api, root, enabled]);
  useEffect(() => {
    const relay = (event: PointerEvent) => {
      const drag = dragging.current;
      if (!drag || event.pointerId !== drag.id || forwarded.has(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const copy = new PointerEvent(event.type, { bubbles: true, cancelable: true, composed: true, pointerId: event.pointerId, pointerType: 'mouse', isPrimary: true,
        button: event.type === 'pointermove' ? -1 : 0, buttons: event.type === 'pointermove' ? 1 : 0, clientX: event.clientX + drag.dx, clientY: event.clientY + drag.dy,
        screenX: event.screenX + drag.dx, screenY: event.screenY + drag.dy, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey });
      forwarded.add(copy);
      if (event.type !== 'pointermove') dragging.current = null;
      drag.canvas.dispatchEvent(copy);
    };
    for (const name of ['pointermove', 'pointerup', 'pointercancel']) window.addEventListener(name, relay as EventListener, true);
    return () => { for (const name of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(name, relay as EventListener, true); };
  }, []);
  function start(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || dragging.current) return;
    const box = bounds(), canvas = root?.querySelector<HTMLCanvasElement>('.excalidraw canvas.interactive');
    if (!box || !canvas) return;
    event.preventDefault(); event.stopPropagation();
    const center = selectionCenter(box, api.getAppState());
    dragging.current = { id: event.pointerId, dx: center.x - event.clientX, dy: center.y - event.clientY, canvas };
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: event.pointerId, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX: center.x, clientY: center.y, screenX: event.screenX + center.x - event.clientX, screenY: event.screenY + center.y - event.clientY });
    forwarded.add(down);
    canvas.dispatchEvent(down);
  }
  if (!place) return null;
  return <button type="button" className="note-move-handle" style={{ left: place.left, top: place.top }} aria-label="Move selection" title="Drag to move without resizing"
    onPointerDown={start} onContextMenu={event => event.preventDefault()}><Move size={18} /></button>;
}
