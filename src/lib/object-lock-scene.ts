import { newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { objectLockIds } from './board-objects';

export function setObjectsLocked(elements: readonly ExcalidrawElement[], ids: ReadonlySet<string>, locked: boolean) {
  const members = objectLockIds(elements, ids);
  return elements.map(element => {
    // Derived rich-text previews always remain internally locked, even when
    // their editable source or containing group is unlocked.
    const next = element.customData?.noteRichTextRender ? true : locked;
    return members.has(element.id) && element.locked !== next ? newElementWith(element, { locked: next }) : element;
  });
}
