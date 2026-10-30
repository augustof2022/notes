import { getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { readDiagramData } from './diagram-model';

export interface ConnectionTarget {
  element: ExcalidrawElement;
  groupId?: string;
  native: boolean;
  geometry: { id: string; type: string; x: number; y: number; width: number; height: number; angle: number };
  bounds: readonly number[];
}
export function connectionPrimary(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]): ExcalidrawElement {
  if (element.type === 'text' && element.containerId) return elements.find(item => item.id === element.containerId) || element;
  const data = readDiagramData(element);
  if (data?.kind === 'decoration') return elements.find(item => item.id === data.nodeId) || element;
  const owner = element.customData?.noteRichTextRender?.ownerId;
  return owner ? elements.find(item => item.id === owner) || element : element;
}
function content(element: ExcalidrawElement) {
  const meta = readDiagramData(element);
  return !element.isDeleted && !element.customData?.noteRichTextRender && meta?.kind !== 'edge' && meta?.kind !== 'decoration' && !(element.type === 'text' && element.containerId);
}
export function connectionTarget(elements: readonly ExcalidrawElement[], id: string, savedGroup?: string): ConnectionTarget | null {
  const original = elements.find(element => element.id === id);
  let primary = original && connectionPrimary(original, elements);
  const groupId = savedGroup || primary?.groupIds?.at(-1);
  let members = groupId ? elements.filter(element => element.groupIds?.includes(groupId) && content(element)) : [];
  if (!primary || primary.isDeleted) primary = members[0];
  if (!primary || !content(primary)) return null;
  if (!members.length || members.length === 1) members = [primary];
  const grouped = members.length > 1;
  const native = !grouped && ['rectangle', 'diamond', 'ellipse', 'image', 'iframe', 'embeddable', 'frame', 'magicframe', 'text'].includes(primary.type);
  const bounds = native && !primary.angle ? [primary.x, primary.y, primary.x + primary.width, primary.y + primary.height] : getCommonBounds(members);
  const geometry = native ? primary : { id: primary.id, type: 'rectangle', x: bounds[0], y: bounds[1], width: Math.max(1, bounds[2] - bounds[0]), height: Math.max(1, bounds[3] - bounds[1]), angle: 0 };
  return { element: primary, ...(grouped ? { groupId } : {}), native, geometry, bounds };
}
export function selectedConnectionTargets(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, boolean>>): ConnectionTarget[] {
  const targets = new Map<string, ConnectionTarget>();
  for (const element of elements) {
    if (!selected[element.id] || element.locked || element.isDeleted) continue;
    const target = connectionTarget(elements, element.id);
    if (target && !target.element.locked) targets.set(target.groupId || target.element.id, target);
  }
  return [...targets.values()];
}
export function connectionTargetAt(elements: readonly ExcalidrawElement[], point: readonly number[], padding = 0): ConnectionTarget | null {
  for (const element of [...elements].reverse()) {
    if (!content(element)) continue;
    const target = connectionTarget(elements, element.id); if (!target) continue;
    const [left, top, right, bottom] = target.bounds;
    if (point[0] >= left - padding && point[0] <= right + padding && point[1] >= top - padding && point[1] <= bottom + padding) return target;
  }
  return null;
}
