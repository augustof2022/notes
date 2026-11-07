export interface MoveViewport { scrollX: number; scrollY: number; zoom: { value: number }; offsetLeft: number; offsetTop: number; width: number; height: number }
export type SceneBounds = readonly [number, number, number, number];

export const MOVE_HANDLE_SIZE = 40;
const GAP = 22, EDGE = 8;

/** Client point of the selection's center, where a forwarded drag begins. */
export function selectionCenter(bounds: SceneBounds, view: MoveViewport) {
  const zoom = view.zoom.value;
  return { x: view.offsetLeft + ((bounds[0] + bounds[2]) / 2 + view.scrollX) * zoom, y: view.offsetTop + ((bounds[1] + bounds[3]) / 2 + view.scrollY) * zoom };
}

/**
 * Place the handle below the selection, clear of the native rotation handle
 * above it and its resize handles, flipping above when there is no room.
 * Returned coordinates are relative to the canvas container.
 */
export function moveHandlePosition(bounds: SceneBounds, view: MoveViewport, size = MOVE_HANDLE_SIZE) {
  const zoom = view.zoom.value, center = (bounds[0] + bounds[2]) / 2;
  const left = (center + view.scrollX) * zoom - size / 2;
  const below = (bounds[3] + view.scrollY) * zoom + GAP, above = (bounds[1] + view.scrollY) * zoom - GAP - size - 28;
  const top = below + size + EDGE <= view.height || above < EDGE ? below : above;
  const visible = left + size > 0 && left < view.width && top + size > 0 && top < view.height;
  return { left: Math.max(EDGE, Math.min(view.width - size - EDGE, left)), top: Math.max(EDGE, Math.min(view.height - size - EDGE, top)), visible };
}
