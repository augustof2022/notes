import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

type SignedElement = Pick<ExcalidrawElement, 'id' | 'version' | 'versionNonce' | 'isDeleted'>;

/** Independent devices can produce equal version numbers with different edits. */
export function elementsSignature(elements: readonly SignedElement[]) {
  return elements.map(element => `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted}`).join('|');
}

/** Postgres JSONB reorders object keys. Equal persisted settings must not turn into a new local edit. */
export function stateSignature(state: unknown) {
  return JSON.stringify(state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export function sceneSignature(elements: readonly SignedElement[], state: unknown, elementsPart = elementsSignature(elements)) {
  return `${elementsPart}:${stateSignature(state)}`;
}

/**
 * A cheap fingerprint of the scene's content. Pan and zoom leave every
 * element object untouched, so the fingerprint stays equal and per-object
 * repair, cloning, and signature work can be skipped for those frames.
 */
export function contentFingerprint(elements: readonly Pick<ExcalidrawElement, 'versionNonce' | 'version'>[]) {
  // Not cached per array: the editor mutates elements in place while dragging.
  let hash = 5381, versions = 0;
  for (let i = 0; i < elements.length; i++) { hash = ((hash << 5) + hash + elements[i].versionNonce) | 0; versions = (versions + elements[i].version) | 0; }
  return `${elements.length}:${hash >>> 0}:${versions >>> 0}`;
}
