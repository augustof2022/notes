import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/**
 * Elements the first finger changed before a second finger turned the touch
 * into a pinch. Returns the restored scene, or null when nothing moved.
 */
export function revertFirstFingerEdits(current: readonly ExcalidrawElement[], snapshot: ReadonlyMap<string, ExcalidrawElement>) {
  let changed = false;
  const elements = current.map(element => {
    const original = snapshot.get(element.id);
    if (!original || (original.version === element.version && original.versionNonce === element.versionNonce)) return element;
    changed = true;
    const { version: _version, versionNonce: _nonce, updated: _updated, ...rest } = original;
    return newElementWith(element, rest);
  });
  return changed ? elements : null;
}

/**
 * On touch screens the editor treats the first finger of a pinch as a normal
 * one-finger action until the second finger lands. When that first finger is
 * on a selection or one of its (large, touch-sized) resize handles, the
 * selection is dragged or scaled toward the opposite corner and keeps being
 * transformed by both fingers during the zoom. Undo that accidental edit and
 * release the selection so the gesture is only a pan/zoom.
 */
export function installTouchGestureGuard(root: HTMLElement, api: ExcalidrawImperativeAPI) {
  const touches = new Set<number>();
  let snapshot: Map<string, ExcalidrawElement> | null = null;
  const onCanvas = (target: EventTarget | null) => target instanceof Element && root.contains(target) && !!target.closest('.excalidraw canvas');
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !onCanvas(event.target)) return;
    touches.add(event.pointerId);
    if (touches.size === 1) {
      // Element objects are mutated in place during a drag or resize, so keep copies.
      snapshot = new Map(api.getSceneElementsIncludingDeleted().map(element => [element.id, { ...element } as ExcalidrawElement]));
      return;
    }
    if (touches.size !== 2 || !snapshot) return;
    const state = api.getAppState();
    const restored = revertFirstFingerEdits(api.getSceneElementsIncludingDeleted(), snapshot);
    const selected = Object.keys(state.selectedElementIds).length > 0;
    if (!restored && !selected) return;
    // The editor reads the live selection on every move, so clearing it stops
    // the transform for the rest of the pinch without interrupting the zoom.
    api.updateScene({ ...(restored ? { elements: restored } : {}), appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  const up = (event: PointerEvent) => {
    if (!touches.delete(event.pointerId)) return;
    if (!touches.size) snapshot = null;
  };
  root.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  return () => {
    root.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  };
}
