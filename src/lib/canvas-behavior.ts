import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import type { ViewLock } from '../types';

export function constantInkUpdates(element: ExcalidrawElement) {
  if (element.type !== 'freedraw' || element.isDeleted) return null;
  if (!element.simulatePressure && element.pressures.length === element.points.length && element.pressures.every(x => x === 0.5)) return null;
  // Fixed pressure also disables the editor's speed-based simulated pressure.
  return { simulatePressure: false, pressures: element.points.map(() => 0.5), width: element.width };
}
export function repairedSceneElements(elements: readonly ExcalidrawElement[], originals: ReadonlyMap<ExcalidrawElement, ExcalidrawElement>, drawingElement: AppState['newElement']) {
  return elements.map(element => {
    const original = originals.get(element);
    if (!original || original.version === element.version) return element;
    // The native drawing gesture keeps this exact object for later points.
    // Replacing it detaches the stroke from the scene and leaves only a dot.
    if (element.id === drawingElement?.id) return element;
    // Completed repairs use replacements so native history does not record
    // layout/attachment corrections as another user edit on the next gesture.
    const replacement = { ...element };
    Object.assign(element, original);
    return replacement;
  });
}
export function viewLockCorrection(state: Pick<AppState, 'zoom'>, lock: ViewLock | null) {
  // Older boards include scroll coordinates in their lock; deliberately ignore them.
  return lock && state.zoom.value !== lock.zoom.value ? { zoom: lock.zoom } : null;
}
export const DEFAULT_PEN_WIDTH = 1;
export function penWidth(value: number) { return Number.isFinite(value) ? Math.round(Math.min(12, Math.max(0.5, value)) * 2) / 2 : DEFAULT_PEN_WIDTH; }
export function stickyTextTool(tool: AppState['activeTool'], previousType: string) {
  if (tool.type === 'text' && !tool.locked) return { ...tool, locked: true };
  if (previousType === 'text' && tool.type !== 'text' && tool.type !== 'custom' && tool.locked) return { ...tool, locked: false };
  return null;
}
