import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { readDiagramData } from './diagram-model';

export type LockedObject = { id: string; label: string; elementIds: string[] };

/** Treat a shape's label and decorations, and native groups, as one unlockable object. */
export function lockedObjects(elements: readonly ExcalidrawElement[]): LockedObject[] {
  const visible = elements.filter(element => !element.isDeleted);
  const byId = new Map(visible.map(element => [element.id, element]));
  const groups = new Map<string, { owner: ExcalidrawElement; ids: string[] }>();
  for (const element of visible) {
    if (!element.locked) continue;
    const meta = readDiagramData(element);
    const ownerId = element.type === 'text' && element.containerId ? element.containerId : meta?.kind === 'decoration' ? meta.nodeId : element.id;
    const owner = byId.get(ownerId) || element;
    const id = owner.groupIds.at(-1) || owner.id;
    const group = groups.get(id) || { owner, ids: [] };
    group.ids.push(element.id); groups.set(id, group);
  }
  return [...groups].map(([id, { owner, ids }]) => {
    const text = owner.type === 'text' ? owner.text : visible.find(element => element.type === 'text' && element.containerId === owner.id);
    const words = (typeof text === 'string' ? text : text?.type === 'text' ? text.text : '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const kind = owner.type === 'image' ? 'Image' : owner.type === 'arrow' || owner.type === 'line' ? 'Connection' : owner.type === 'freedraw' ? 'Drawing' : owner.type === 'text' ? 'Text' : 'Shape';
    return { id, label: words ? `${kind}: ${words}` : kind, elementIds: ids };
  });
}
