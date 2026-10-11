import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import type { ViewLock } from '../types';

export function constantInkUpdates(element: ExcalidrawElement) {
  if (element.type !== 'freedraw' || element.isDeleted) return null;
  if (!element.simulatePressure && element.pressures.length === element.points.length && element.pressures.every(x => x === 0.5)) return null;
  // Fixed pressure also disables the editor's speed-based simulated pressure.
  return { simulatePressure: false, pressures: element.points.map(() => 0.5), width: element.width };
}
export function viewLockCorrection(state: Pick<AppState, 'zoom'>, lock: ViewLock | null) {
  // Older boards include scroll coordinates in their lock; deliberately ignore them.
  return lock && state.zoom.value !== lock.zoom.value ? { zoom: lock.zoom } : null;
}
export const DEFAULT_PEN_WIDTH = 1;
export function penWidth(value: number) { return Number.isFinite(value) ? Math.round(Math.min(12, Math.max(0.5, value)) * 2) / 2 : DEFAULT_PEN_WIDTH; }
export function stickyTextTool(tool: AppState['activeTool'], previousType: string) {
  if (tool.type === 'text' && !tool.locked) return { ...tool, locked: true };
  if (previousType === 'text' && tool.type !== 'text' && tool.locked) return { ...tool, locked: false };
  return null;
}
