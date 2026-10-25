import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import { eraseInkPath, inkWorldSamples, type InkPoint, type InkShape } from './ink-geometry';

export const PARTIAL_ERASER_TOOL = 'note-partial-eraser';
export interface WritingPreferences { eraserMode: 'partial' | 'object'; eraserSize: number; holdShapes: boolean }
export const DEFAULT_WRITING_PREFERENCES: WritingPreferences = { eraserMode: 'partial', eraserSize: 24, holdShapes: true };
export function readWritingPreferences(): WritingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('note-writing-tools') || '{}');
    return { eraserMode: value?.eraserMode === 'object' ? 'object' : 'partial',
      eraserSize: typeof value?.eraserSize === 'number' && Number.isFinite(value.eraserSize) ? Math.min(96, Math.max(8, value.eraserSize)) : 24,
      holdShapes: typeof value?.holdShapes === 'boolean' ? value.holdShapes : true };
  } catch { return { ...DEFAULT_WRITING_PREFERENCES }; }
}
export function storeWritingPreferences(value: WritingPreferences) { try { localStorage.setItem('note-writing-tools', JSON.stringify(value)); } catch { /* Tools still work without persistent preferences. */ } }
function withoutHandwriting(customData: ExcalidrawElement['customData']) {
  if (!customData) return undefined;
  const next = { ...customData }; delete next.noteHandwriting; return next;
}

/** Preserve untouched objects and original ids; only split the ink intersected by the eraser. */
export function eraseInkElements(elements: readonly ExcalidrawElement[], from: InkPoint, to: InkPoint, radius: number): ExcalidrawElement[] | null {
  let changed = false;
  const next = elements.flatMap(element => {
    if (element.type !== 'freedraw' || element.isDeleted || element.locked || !element.points.length) return [element];
    const samples = inkWorldSamples(element), padding = radius + element.strokeWidth / 2;
    const xs = samples.map(p => p.point[0]), ys = samples.map(p => p.point[1]);
    if (Math.max(...xs) < Math.min(from[0], to[0]) - padding || Math.min(...xs) > Math.max(from[0], to[0]) + padding
      || Math.max(...ys) < Math.min(from[1], to[1]) - padding || Math.min(...ys) > Math.max(from[1], to[1]) + padding) return [element];
    const pieces = eraseInkPath(samples, from, to, padding);
    if (!pieces) return [element];
    changed = true;
    if (!pieces.length) return [newElementWith(element, { isDeleted: true })];
    return pieces.map((piece, index) => {
      const x = Math.min(...piece.map(p => p.point[0])), y = Math.min(...piece.map(p => p.point[1]));
      return newElementWith(element, {
        ...(index ? { id: crypto.randomUUID(), index: null } : {}), x, y,
        width: Math.max(...piece.map(p => p.point[0])) - x, height: Math.max(...piece.map(p => p.point[1])) - y,
        angle: 0 as ExcalidrawFreeDrawElement['angle'], points: piece.map(p => [p.point[0] - x, p.point[1] - y]) as ExcalidrawFreeDrawElement['points'],
        pressures: piece.map(() => 0.5), simulatePressure: false, lastCommittedPoint: null,
        customData: withoutHandwriting(element.customData),
      });
    });
  });
  return changed ? next : null;
}

export function cleanShapeFromInk(stroke: ExcalidrawFreeDrawElement, shape: InkShape): ExcalidrawElement {
  const [result] = convertToExcalidrawElements([{
    type: shape.kind === 'triangle' ? 'line' : shape.kind,
    x: shape.x, y: shape.y, width: shape.width, height: shape.height,
    ...(shape.points ? { points: shape.points, startArrowhead: null, endArrowhead: null } : {}),
    strokeColor: stroke.strokeColor, strokeWidth: stroke.strokeWidth, strokeStyle: stroke.strokeStyle,
    backgroundColor: 'transparent', fillStyle: 'solid', opacity: stroke.opacity, roughness: 0, roundness: null,
    customData: { ...withoutHandwriting(stroke.customData), noteHoldShape: { kind: shape.kind } },
  } as ExcalidrawElementSkeleton]);
  return newElementWith(result, { angle: shape.angle as ExcalidrawElement['angle'], groupIds: stroke.groupIds, frameId: stroke.frameId });
}
