import { CaptureUpdateAction, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ConnectionDoubleTap, connectionBendHit, editConnectionBend, type BendPoint } from './connection-bends';
import { readDiagramData } from './diagram-model';

/** A fresh point-editing state avoids stale endpoint indices after adding/removing a bend. */
function pointEditor(element: ExcalidrawLinearElement, index: number): NonNullable<AppState['editingLinearElement']> {
  return { elementId: element.id as NonNullable<AppState['editingLinearElement']>['elementId'],
    selectedPointsIndices: [Math.min(index, element.points.length - 1)], isDragging: false, lastUncommittedPoint: null,
    pointerOffset: { x: 0, y: 0 }, startBindingElement: 'keep', endBindingElement: 'keep', hoverPointIndex: -1,
    segmentMidPointHoveredCoords: null, elbowed: false,
    pointerDownState: { prevSelectedPointsIndices: null, lastClickedPoint: -1, lastClickedIsEndPoint: false, origin: null,
      segmentMidpoint: { value: null, index: null, added: false } } };
}

export function installConnectionBendEditing(root: HTMLElement, api: ExcalidrawImperativeAPI, options: {
  enabled: () => boolean;
  commit: (apply: () => void) => void;
  onMessage: (message: string) => void;
}) {
  const taps = new ConnectionDoubleTap();
  let suppressDoubleClickUntil = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const canvas = (target: EventTarget | null) => target instanceof HTMLCanvasElement && root.contains(target);
  const available = () => {
    const state = api.getAppState();
    return options.enabled() && state.activeTool.type === 'selection' && !state.viewModeEnabled && !state.openDialog && !state.contextMenu && !state.editingTextElement && !root.hasAttribute('data-inline-editing');
  };
  function find(clientX: number, clientY: number, touch = false) {
    if (!available()) return null;
    const state = api.getAppState(), elements = api.getSceneElements(), zoom = state.zoom.value;
    const point: BendPoint = [(clientX - state.offsetLeft) / zoom - state.scrollX, (clientY - state.offsetTop) / zoom - state.scrollY];
    // Text on a connection retains its normal double-click/tap label editor.
    for (const element of elements) if (element.type === 'text' || element.customData?.noteRichTextRender) {
      const [left, top, right, bottom] = getCommonBounds([element]);
      if (point[0] >= left && point[0] <= right && point[1] >= top && point[1] <= bottom) return null;
    }
    for (const element of [...elements].reverse()) {
      const data = readDiagramData(element);
      if ((element.type !== 'arrow' && element.type !== 'line') || element.locked || element.isDeleted || data?.kind === 'decoration' || (element.groupIds.length && data?.kind !== 'edge')) continue;
      // The renderer rotates curved lines about their rendered bounds.
      const bounds = element.angle ? getCommonBounds([{ ...element, angle: 0 as ExcalidrawElement['angle'] }]) : null;
      const center: BendPoint | undefined = bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : undefined;
      const hit = connectionBendHit(element, point, (touch ? 14 : 9) / zoom, center);
      if (hit) return { element, hit, center };
    }
    return null;
  }
  function edit(clientX: number, clientY: number, touch = false, connectionId?: string) {
    const found = find(clientX, clientY, touch);
    if (!found || (connectionId && found.element.id !== connectionId)) return false;
    const { element, hit, center } = found, patch = editConnectionBend(element, hit, center);
    if (!patch) return true; // Attachment endpoints are deliberately protected.
    const elbowed = element.type === 'arrow' && 'elbowed' in element && element.elbowed;
    const next = newElementWith(element, { ...patch, angle: 0 as ExcalidrawElement['angle'], points: patch.points as ExcalidrawLinearElement['points'],
      ...(elbowed ? { elbowed: false, fixedSegments: null, startIsSpecial: null, endIsSpecial: null } : {}) });
    const editor = pointEditor(next, hit.index);
    options.commit(() => api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(item => item.id === element.id ? next : item),
      appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {}, openMenu: null, editingLinearElement: editor, selectedLinearElement: editor },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY }));
    root.querySelector<HTMLElement>('.excalidraw')?.focus();
    options.onMessage(`${hit.kind === 'add' ? 'Bend added. Drag its handle to reshape the connection.' : 'Bend removed.'}${elbowed ? ' This connection now uses a manual route.' : ''}`);
    return true;
  }
  const doubleClick = (event: MouseEvent) => {
    if (!canvas(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (performance.now() < suppressDoubleClickUntil || edit(event.clientX, event.clientY)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') { taps.reset(); return; }
    const found = canvas(event.target) && event.button === 0 ? find(event.clientX, event.clientY, true) : null;
    taps.down(event.pointerId, [event.clientX, event.clientY], performance.now(), found ? found.element.id : null);
  };
  const move = (event: PointerEvent) => taps.move(event.pointerId, [event.clientX, event.clientY]);
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    const twice = taps.up(event.pointerId, [event.clientX, event.clientY], performance.now());
    if (!twice || !canvas(event.target)) return;
    const found = find(event.clientX, event.clientY, true); if (!found) return;
    suppressDoubleClickUntil = performance.now() + 600;
    // Native pointer-up must finish releasing capture and saving its selection
    // before a single undoable point edit is committed on the next event turn.
    const timer = setTimeout(() => { timers.delete(timer); edit(event.clientX, event.clientY, true, found.element.id); }, 0);
    timers.add(timer);
  };
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1 || !canvas(event.target)) return;
    const touch = event.touches[0];
    if (find(touch.clientX, touch.clientY, true)) {
      // Excalidraw double-taps on touchstart to edit labels/release elbow
      // segments. Let pointer events finish normally; recognize taps on release.
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const reset = () => taps.reset();
  root.addEventListener('dblclick', doubleClick, true);
  root.addEventListener('touchstart', touchStart, { capture: true, passive: false });
  window.addEventListener('pointerdown', down, true); window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', reset, true); window.addEventListener('blur', reset);
  return () => {
    root.removeEventListener('dblclick', doubleClick, true); root.removeEventListener('touchstart', touchStart, true);
    window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', reset, true); window.removeEventListener('blur', reset);
    for (const timer of timers) clearTimeout(timer); taps.reset();
  };
}
