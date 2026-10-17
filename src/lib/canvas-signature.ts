import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export function sceneSignature(elements: readonly Pick<ExcalidrawElement, 'id' | 'version' | 'versionNonce' | 'isDeleted'>[], state: unknown) {
  // Postgres JSONB reorders object keys. Equal persisted settings must not turn
  // into a new local edit merely because they came back from the cloud.
  const settings = JSON.stringify(state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  // Independent devices can produce equal version numbers with different edits.
  return `${elements.map(element => `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted}`).join('|')}:${settings}`;
}
