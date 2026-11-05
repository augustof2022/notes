import { newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { objectOwner } from './board-objects';
import { readDiagramData } from './diagram-model';

export type ObjectColorRole = 'stroke' | 'background';
export const OBJECT_COLORS = ['#000000', '#343a40', '#868e96', '#ced4da', '#ffffff', '#7f1d1d', '#dc2626', '#f87171', '#fce7f3', '#db2777', '#9d174d', '#9a3412', '#ea580c', '#fb923c', '#fef3c7', '#f59e0b', '#ca8a04', '#713f12', '#166534', '#16a34a', '#86efac', '#d1fae5', '#0d9488', '#115e59', '#155e75', '#0891b2', '#67e8f9', '#dbeafe', '#2563eb', '#1e3a8a', '#4f46e5', '#7c3aed', '#c4b5fd', '#f3e8ff', '#c026d3', '#701a75'];
export function parseObjectColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (color === 'transparent' || color === 'none') return 'transparent';
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (!hex) return null;
  if (hex.length === 8 && hex.endsWith('00')) return 'transparent';
  return `#${hex.length === 3 ? [...hex].map(c => c + c).join('') : hex}`;
}
export function supportsObjectColor(element: ExcalidrawElement, role: ObjectColorRole) {
  return role === 'background' ? ['rectangle', 'ellipse', 'diamond', 'line', 'freedraw', 'iframe', 'embeddable'].includes(element.type)
    : !['image', 'frame', 'magicframe'].includes(element.type);
}
export function colorSelection(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, boolean>>, role: ObjectColorRole) {
  const byId = new Map(elements.filter(e => !e.isDeleted).map(e => [e.id, e]));
  const owners = new Set(elements.filter(e => selected[e.id] && !e.isDeleted && !e.locked && !e.customData?.noteRichTextRender).map(e => objectOwner(e, byId).id));
  return elements.filter(e => {
    if (e.isDeleted || e.locked || e.customData?.noteRichTextRender || !supportsObjectColor(e, role)) return false;
    const owner = objectOwner(e, byId), decoration = readDiagramData(e)?.kind === 'decoration';
    return !owner.locked && owners.has(owner.id) && (e.id === owner.id || (role === 'stroke' && decoration && e.type !== 'text'));
  });
}
export function displayedObjectColor(element: ExcalidrawElement, role: ObjectColorRole) {
  const value = role === 'stroke' && element.type === 'text' && element.customData?.noteRichText?.version === 1 ? element.customData.noteRichText.color : role === 'stroke' ? element.strokeColor : element.backgroundColor;
  return value === '#00000000' ? 'transparent' : value;
}
export function coloredElements(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, boolean>>, role: ObjectColorRole, color: string) {
  const targets = new Set(colorSelection(elements, selected, role).map(e => e.id));
  return elements.map(element => {
    if (!targets.has(element.id)) return element;
    const rich = role === 'stroke' && element.type === 'text' && element.customData?.noteRichText;
    if (rich?.version === 1) {
      const doc = structuredClone(rich.doc), value = color === 'transparent' ? '#00000000' : color;
      const recolor = (node: any) => { for (const mark of node.marks || []) if (mark.type === 'textStyle' && mark.attrs?.color) mark.attrs.color = value; for (const child of node.content || []) recolor(child); };
      recolor(doc);
      return newElementWith(element, { customData: { ...element.customData, noteRichText: { ...rich, color: value, doc } } });
    }
    return newElementWith(element, role === 'stroke' ? { strokeColor: color } : { backgroundColor: color });
  });
}
