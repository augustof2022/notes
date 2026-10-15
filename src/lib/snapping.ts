import type { AppState } from '@excalidraw/excalidraw/types';

export type SnapMode = 'off' | 'elements' | 'grid';
export type SnapState = Pick<AppState, 'gridModeEnabled' | 'objectsSnapModeEnabled' | 'gridSize'>;
export const DEFAULT_GRID_SIZE = 20;

export function gridSize(value: number) {
  return Number.isFinite(value) ? Math.round(Math.min(100, Math.max(1, value))) : DEFAULT_GRID_SIZE;
}
export function snapMode(state: Partial<SnapState>): SnapMode {
  return state.gridModeEnabled ? 'grid' : state.objectsSnapModeEnabled ? 'elements' : 'off';
}
export function nextSnapMode(mode: SnapMode): SnapMode {
  return mode === 'off' ? 'elements' : mode === 'elements' ? 'grid' : 'off';
}
export function snapState(mode: SnapMode, size = DEFAULT_GRID_SIZE): SnapState {
  return { gridModeEnabled: mode === 'grid', objectsSnapModeEnabled: mode === 'elements', gridSize: gridSize(size) };
}
// Give older boards an explicit Off state, and keep the two modes exclusive.
export function restoreSnapping(state: Partial<SnapState>): SnapState {
  return snapState(snapMode(state), state.gridSize);
}
