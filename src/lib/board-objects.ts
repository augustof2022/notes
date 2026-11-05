import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { readDiagramData } from './diagram-model';

export interface BoardObject {
  key: string; label: string; kind: string; elementIds: string[]; selectableIds: string[];
  children: BoardObject[]; groupId?: string; parentGroupId?: string;
  locked: boolean; partlyLocked: boolean; order: number;
}

export function objectOwner(element: ExcalidrawElement, byId: ReadonlyMap<string, ExcalidrawElement>): ExcalidrawElement {
  const visited = new Set<string>();
  while (!visited.has(element.id)) {
    visited.add(element.id);
    const data = readDiagramData(element);
    const id = element.customData?.noteRichTextRender?.ownerId || (element.type === 'text' && element.containerId) || (data?.kind === 'decoration' && data.nodeId);
    const owner = id && byId.get(id);
    if (!owner || owner.isDeleted) break;
    element = owner;
  }
  return element;
}

export function objectKind(element: ExcalidrawElement) {
  return ({ rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', freedraw: 'Drawing', image: 'Image', text: 'Text', arrow: 'Connection', line: 'Line', frame: 'Frame', magicframe: 'Frame', embeddable: 'Embed', iframe: 'Embed' } as Record<string, string>)[element.type] || 'Object';
}

/** Labels, diagram outlines, and formatted-text SVGs belong to their actual object. */
export function boardObjects(elements: readonly ExcalidrawElement[]): BoardObject[] {
  const visible = elements.filter(element => !element.isDeleted), byId = new Map(visible.map(element => [element.id, element]));
  const members = new Map<string, ExcalidrawElement[]>(), owners = new Map<string, ExcalidrawElement>();
  const order = new Map(visible.map((element, index) => [element.id, index]));
  for (const element of visible) {
    const owner = objectOwner(element, byId);
    if (owner.customData?.noteRichTextRender) continue;
    owners.set(owner.id, owner);
    const items = members.get(owner.id) || []; items.push(element); members.set(owner.id, items);
  }
  const roots: BoardObject[] = [], groups = new Map<string, BoardObject>();
  for (const [id, items] of members) {
    const owner = owners.get(id)!, text = owner.type === 'text' ? owner : items.find(element => element.type === 'text');
    const cutout = typeof owner.customData?.noteErasedFrom?.label === 'string' ? `${owner.customData.noteErasedFrom.label} · cutout` : '';
    const words = (cutout || (text?.type === 'text' ? text.originalText || text.text || '' : '')).replace(/\s+/g, ' ').trim().slice(0, 120);
    const kind = objectKind(owner), actual = items.filter(element => !element.customData?.noteRichTextRender);
    const node: BoardObject = { key: `object:${id}`, label: words || kind, kind, elementIds: items.map(element => element.id), selectableIds: actual.map(element => element.id), children: [],
      locked: actual.length > 0 && actual.every(element => element.locked), partlyLocked: actual.some(element => element.locked), order: Math.max(...items.map(element => order.get(element.id) || 0)) };
    let siblings = roots, parent: string | undefined;
    for (const groupId of [...(owner.groupIds || [])].reverse()) {
      let group = groups.get(groupId);
      if (!group) { group = { key: `group:${groupId}`, label: 'Group', kind: 'Group', groupId, parentGroupId: parent, elementIds: [], selectableIds: [], children: [], locked: false, partlyLocked: false, order: 0 }; groups.set(groupId, group); siblings.push(group); }
      siblings = group.children; parent = groupId;
    }
    node.parentGroupId = parent; siblings.push(node);
  }
  function finish(nodes: BoardObject[]): BoardObject[] {
    return nodes.map(node => {
      if (node.children.length) {
        node.children = finish(node.children);
        node.elementIds = node.children.flatMap(child => child.elementIds); node.selectableIds = node.children.flatMap(child => child.selectableIds);
        node.order = Math.max(...node.children.map(child => child.order));
        node.locked = node.children.every(child => child.locked); node.partlyLocked = node.children.some(child => child.partlyLocked);
        // A diagram's internal double outline is one object, not an extra user group.
        if (node.children.length === 1) return { ...node.children[0], parentGroupId: node.parentGroupId };
      }
      return node;
    }).sort((a, b) => b.order - a.order);
  }
  return finish(roots);
}

export function flattenObjects(objects: readonly BoardObject[]): BoardObject[] {
  return objects.flatMap(object => [object, ...flattenObjects(object.children)]);
}

export function selectedObjectKeys(objects: readonly BoardObject[], selected: Readonly<Record<string, boolean>>, groups: Readonly<Record<string, boolean>> = {}): string[] {
  return objects.flatMap(object => {
    if ((object.groupId && groups[object.groupId]) || (object.selectableIds.length > 0 && object.selectableIds.every(id => selected[id]))) return [object.key];
    return object.children.length ? selectedObjectKeys(object.children, selected, groups) : object.selectableIds.some(id => selected[id]) ? [object.key] : [];
  });
}

/** Selecting a group and a child together still operates on the group only. */
export function chosenObjects(objects: readonly BoardObject[], keys: ReadonlySet<string>): BoardObject[] {
  return objects.flatMap(object => keys.has(object.key) ? [object] : chosenObjects(object.children, keys));
}

export function toggleObjectKey(objects: readonly BoardObject[], keys: ReadonlySet<string>, key: string): Set<string> {
  const chosen = chosenObjects(objects, keys);
  const contains = (object: BoardObject): boolean => object.key === key || object.children.some(contains);
  if (!chosen.some(contains)) return new Set([...keys, key]);
  const without = (object: BoardObject): string[] => object.key === key ? [] : contains(object) ? object.children.flatMap(without) : [object.key];
  return new Set(chosen.flatMap(without));
}

export function objectSelection(elements: readonly ExcalidrawElement[], objects: readonly BoardObject[]) {
  const ids = new Set(objects.filter(object => !object.locked).flatMap(object => object.selectableIds));
  const selectedElementIds = Object.fromEntries(elements.filter(element => ids.has(element.id) && !element.isDeleted && !element.locked && !element.customData?.noteRichTextRender).map(element => [element.id, true as const]));
  const selectedGroupIds = Object.fromEntries(objects.filter(object => object.groupId && !object.partlyLocked).map(object => [object.groupId!, true as const]));
  return { selectedElementIds, selectedGroupIds, editingGroupId: objects.length > 0 && objects.every(object => object.parentGroupId === objects[0].parentGroupId) ? objects[0].parentGroupId || null : null };
}

export function lockTargets(objects: readonly BoardObject[], chosen: readonly BoardObject[], locking: boolean): BoardObject[] {
  if (locking) return [...chosen];
  const groups = new Map(flattenObjects(objects).filter(object => object.groupId).map(object => [object.groupId!, object]));
  const keys = new Set(chosen.map(object => {
    let target = object, parent = object.parentGroupId && groups.get(object.parentGroupId);
    while (parent) { if (parent.locked) target = parent; parent = parent.parentGroupId && groups.get(parent.parentGroupId); }
    return target.key;
  }));
  return chosenObjects(objects, keys);
}

export function objectLockIds(elements: readonly ExcalidrawElement[], ids: ReadonlySet<string>): Set<string> {
  const visible = elements.filter(element => !element.isDeleted), byId = new Map(visible.map(element => [element.id, element]));
  const owners = new Set(visible.filter(element => ids.has(element.id)).map(element => objectOwner(element, byId).id));
  return new Set(visible.filter(element => owners.has(objectOwner(element, byId).id)).map(element => element.id));
}

export interface LayerPreferences { open: boolean; width: number; tileSize: number }
export function layerPreferences(value: unknown): LayerPreferences {
  const saved = value && typeof value === 'object' ? value as Partial<LayerPreferences> : {};
  return { open: saved.open === true, width: Number.isFinite(saved.width) ? Math.max(240, Math.min(520, Number(saved.width))) : 300,
    tileSize: Number.isFinite(saved.tileSize) ? Math.max(32, Math.min(112, Number(saved.tileSize))) : 48 };
}
export function readLayerPreferences(): LayerPreferences { try { return layerPreferences(JSON.parse(localStorage.getItem('note-layers') || '{}')); } catch { return layerPreferences(null); } }
export function saveLayerPreferences(preferences: LayerPreferences) { try { localStorage.setItem('note-layers', JSON.stringify(preferences)); } catch { /* Layout still works without storage. */ } }
