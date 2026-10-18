import type { Board, Folder } from '../types';

export type SyncData = Record<string, unknown>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function recordData(record: Board | Folder): SyncData {
  return 'elements' in record
    ? { name: record.name, folder_id: record.folderId, elements: record.elements, app_state: record.appState, asset_ids: record.assetIds, deleted: record.deleted }
    : { name: record.name, parent_id: record.parentId, color: record.color, deleted: record.deleted };
}
function elementContent(element: unknown) {
  if (!element || typeof element !== 'object') return element;
  const { version: _version, versionNonce: _nonce, updated: _updated, index: _index, ...content } = element as Record<string, unknown>;
  // Restoration generates fractional indices for older scenes. The elements
  // array already records stacking order, so index generation is bookkeeping.
  // Restoring a scene changes older null/absent empty binding lists to [].
  // Those representations all mean that no elements are attached.
  if (content.boundElements == null || (Array.isArray(content.boundElements) && !content.boundElements.length)) content.boundElements = [];
  // Excalidraw changes image status when a cached/downloaded file is attached.
  // This is a file-loading detail, not a change to the drawing.
  if (content.type === 'image') delete content.status;
  return content;
}
function sharedState(value: unknown) {
  const state = value as Board['appState'] | undefined;
  return { viewBackgroundColor: state?.viewBackgroundColor };
}
function content(data: SyncData): SyncData {
  if (!('elements' in data)) return data;
  return { ...data, elements: (data.elements as unknown[]).map(elementContent), app_state: sharedState(data.app_state), asset_ids: [...data.asset_ids as string[]].sort() };
}
export function sameSyncedContent(a: Board | Folder, b: Board | Folder) {
  return equal(content(recordData(a)), content(recordData(b)));
}
export function boardContentChanged(before: Pick<Board, 'elements' | 'appState'>, after: Pick<Board, 'elements' | 'appState'>) {
  return !equal(before.elements.map(elementContent), after.elements.map(elementContent)) || !equal(sharedState(before.appState), sharedState(after.appState));
}
export function withLocalView<T extends Board | Folder>(remote: T, local?: T): T {
  if (!('elements' in remote) || !local || !('elements' in local)) return remote;
  return { ...remote, appState: { ...remote.appState, ...local.appState, viewBackgroundColor: remote.appState.viewBackgroundColor } };
}

function mergeValue(base: unknown, local: unknown, cloud: unknown, compare = equal): { value?: unknown; conflict: boolean } {
  if (compare(local, cloud)) return { value: local, conflict: false };
  if (compare(base, local)) return { value: cloud, conflict: false };
  if (compare(base, cloud)) return { value: local, conflict: false };
  return { conflict: true };
}
function mergeElements(base: unknown[], local: unknown[], cloud: unknown[]) {
  const id = (element: unknown) => (element as { id: string }).id;
  const maps = [base, local, cloud].map(elements => new Map(elements.map(element => [id(element), element])));
  const ids = [...new Set([...base, ...local, ...cloud].map(id))];
  const merged = new Map<string, unknown>();
  for (const key of ids) {
    const result = mergeValue(maps[0].get(key), maps[1].get(key), maps[2].get(key), (a, b) => equal(elementContent(a), elementContent(b)));
    if (result.conflict) return null;
    if (result.value !== undefined) merged.set(key, result.value);
  }
  // Existing elements retain their order; independently added elements follow
  // their source order. Explicit concurrent reorderings need review.
  const existingOrder = (elements: unknown[]) => elements.map(id).filter(key => maps[0].has(key) && merged.has(key));
  const order = mergeValue(existingOrder(base), existingOrder(local), existingOrder(cloud));
  if (order.conflict) return null;
  const keys = [...new Set([...(order.value as string[]), ...local.map(id), ...cloud.map(id)])];
  return keys.filter(key => merged.has(key)).map(key => merged.get(key));
}

// A checkpoint allows three-way merging without guessing which device's clock
// is newer. An overlapping edit remains on its original ID for explicit review.
export function reconcileSyncData(local: Board | Folder, cloud: Board | Folder): SyncData | null {
  const left = recordData(local), right = recordData(cloud);
  if (sameSyncedContent(local, cloud)) return right;
  const base = local.syncBase?.data;
  if (!base) return null;
  const merged: SyncData = {};
  for (const key of Object.keys(right)) {
    if (key === 'elements' || key === 'asset_ids') continue;
    const result = key === 'app_state'
      ? mergeValue(sharedState(base[key]), sharedState(left[key]), sharedState(right[key]))
      : mergeValue(base[key], left[key], right[key]);
    if (result.conflict) return null;
    merged[key] = key === 'app_state' ? { ...right[key] as object, ...left[key] as object, ...result.value as object } : result.value;
  }
  if ('elements' in right) {
    const elements = mergeElements(base.elements as unknown[], left.elements as unknown[], right.elements as unknown[]);
    if (!elements) return null;
    merged.elements = elements;
    const referenced = new Set(elements.filter(element => (element as any).type === 'image' && !(element as any).isDeleted).map(element => (element as any).fileId));
    merged.asset_ids = [...new Set([...left.asset_ids as string[], ...right.asset_ids as string[]])].filter(id => referenced.has(id));
  }
  return merged;
}

export function applySyncData<T extends Board | Folder>(record: T, data: SyncData): T {
  return { ...record, name: data.name, deleted: data.deleted,
    ...('elements' in record ? { folderId: data.folder_id, elements: data.elements, appState: data.app_state, assetIds: data.asset_ids }
      : { parentId: data.parent_id, color: data.color }) } as T;
}

// IndexedDB may receive a cloud scene just before React paints it. Compare the
// pending canvas snapshot with the scene the canvas actually applied, rather
// than assuming that the latest database revision was its editing baseline.
export function reconcileCanvasSave(anchor: Board, snapshot: Pick<Board, 'elements' | 'appState' | 'assetIds'>, current: Board): Board {
  if (current.purged) return current;
  const scene = { elements: snapshot.elements, appState: snapshot.appState, assetIds: snapshot.assetIds };
  const local = { ...anchor, ...scene };
  let next: Board;
  if (!boardContentChanged(anchor, snapshot)) {
    next = withLocalView(current, local);
    if (!boardContentChanged(anchor, current)) next = { ...next, elements: snapshot.elements };
  } else if (sameSyncedContent(anchor, current)) {
    // A save acknowledgement only advanced the revision. Local edits descend
    // from this same scene and can retain the acknowledged checkpoint.
    next = { ...current, ...scene };
  } else {
    const merged = reconcileSyncData({ ...local, syncBase: { revision: anchor.remoteRevision, data: recordData(anchor) } }, current);
    next = merged ? withLocalView(applySyncData(current, merged), local)
      : { ...current, ...scene, remoteRevision: anchor.remoteRevision, syncBase: anchor.syncBase };
  }
  return boardContentChanged(current, next) ? { ...next, dirty: true, updatedAt: new Date().toISOString() } : next;
}

export function canvasSaveAnchor(previous: Board, result: Board, snapshot: Pick<Board, 'elements' | 'appState' | 'assetIds'>): Board {
  if (!boardContentChanged(result, snapshot)) return result;
  // Merged remote elements have reached IndexedDB but are not on the canvas
  // yet. Keep the revision of what the person actually saw, so a subsequent
  // overlapping edit cannot silently overwrite that unseen remote content.
  return { ...result, elements: snapshot.elements, appState: snapshot.appState, assetIds: snapshot.assetIds, remoteRevision: previous.remoteRevision, syncBase: previous.syncBase };
}
