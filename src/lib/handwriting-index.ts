import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types';

export interface HandwritingIndex { text: string; strokeIds: string[]; signature: string }
export function handwritingSignature(strokes: readonly ExcalidrawFreeDrawElement[]) {
  return JSON.stringify(strokes.map(x => [x.id, x.x, x.y, x.width, x.height, x.angle, x.strokeWidth, x.points]));
}
export function indexedHandwriting(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  const value = element.customData?.noteHandwriting as HandwritingIndex | undefined;
  if (element.type !== 'freedraw' || !value || typeof value.text !== 'string' || !Array.isArray(value.strokeIds)) return '';
  const byId = new Map(elements.map(x => [x.id, x]));
  const strokes = value.strokeIds.map(id => byId.get(id));
  if (!strokes.length || strokes.some(x => !x || x.type !== 'freedraw' || x.isDeleted)) return '';
  return handwritingSignature(strokes as ExcalidrawFreeDrawElement[]) === value.signature ? value.text : '';
}
function bounds(stroke: ExcalidrawFreeDrawElement) {
  const cx = stroke.x + stroke.width / 2, cy = stroke.y + stroke.height / 2;
  const corners = [[stroke.x, stroke.y], [stroke.x + stroke.width, stroke.y], [stroke.x, stroke.y + stroke.height], [stroke.x + stroke.width, stroke.y + stroke.height]].map(([x, y]) => [cx + (x - cx) * Math.cos(stroke.angle) - (y - cy) * Math.sin(stroke.angle), cy + (x - cx) * Math.sin(stroke.angle) + (y - cy) * Math.cos(stroke.angle)]);
  return { left: Math.min(...corners.map(x => x[0])) - 2, right: Math.max(...corners.map(x => x[0])) + 2, top: Math.min(...corners.map(x => x[1])) - 2, bottom: Math.max(...corners.map(x => x[1])) + 2 };
}
export function handwritingLines(elements: readonly ExcalidrawElement[], selected?: Record<string, boolean>) {
  const strokes = elements.filter((x): x is ExcalidrawFreeDrawElement => x.type === 'freedraw' && !x.isDeleted);
  const selectedStrokes = strokes.filter(x => selected?.[x.id]);
  const remaining = new Set(selectedStrokes.length ? selectedStrokes : strokes);
  const result: ExcalidrawFreeDrawElement[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!; remaining.delete(first);
    const line = [first];
    for (let i = 0; i < line.length; i++) {
      const a = bounds(line[i]);
      for (const stroke of remaining) {
        const b = bounds(stroke), height = Math.max(a.bottom - a.top, b.bottom - b.top);
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const nearRow = overlap > Math.min(a.bottom - a.top, b.bottom - b.top) * 0.25;
        const gap = Math.max(0, a.left - b.right, b.left - a.right);
        if (nearRow && gap < height * 2) { line.push(stroke); remaining.delete(stroke); }
      }
    }
    result.push(line.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id)));
  }
  return result.sort((a, b) => Math.min(...a.map(x => x.y)) - Math.min(...b.map(x => x.y)));
}
