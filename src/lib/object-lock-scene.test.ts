import { expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({ newElementWith: (element: any, patch: object) => ({ ...element, ...patch, version: element.version + 1 }) }));
import { setObjectsLocked } from './object-lock-scene';

it('locks all members in one update, protects editable labels, and keeps rich previews locked after unlock', () => {
  const elements = [
    { id: 'a', type: 'rectangle', locked: false, version: 1, groupIds: ['g'], x: 12, y: 24 },
    { id: 'label', type: 'text', containerId: 'a', locked: false, version: 1, groupIds: ['g'], text: 'Hello' },
    { id: 'render', type: 'image', locked: true, version: 1, groupIds: ['g'], customData: { noteRichTextRender: { ownerId: 'label' } } },
    { id: 'b', type: 'ellipse', locked: false, version: 1, groupIds: ['g'] },
    { id: 'other', type: 'rectangle', locked: false, version: 1, groupIds: [] },
  ] as unknown as ExcalidrawElement[];
  const locked = setObjectsLocked(elements, new Set(['a', 'label', 'b']), true);
  expect(locked.slice(0, 4).every(element => element.locked)).toBe(true);
  expect(locked[0]).toMatchObject({ x: 12, y: 24, version: 2 }); expect(elements[0].locked).toBe(false); expect(locked[4]).toBe(elements[4]);
  const unlocked = setObjectsLocked(locked, new Set(['a', 'b']), false);
  expect(unlocked.map(element => element.locked)).toEqual([false, false, true, false, false]);
  expect(unlocked[0]).toMatchObject({ x: 12, y: 24 });
});

it('does not alter deleted objects or make redundant scene replacements', () => {
  const deleted = { id: 'gone', type: 'rectangle', locked: true, isDeleted: true } as ExcalidrawElement;
  const locked = { id: 'a', type: 'rectangle', locked: true, isDeleted: false } as ExcalidrawElement;
  const result = setObjectsLocked([deleted, locked], new Set(['gone', 'a']), true);
  expect(result[0]).toBe(deleted); expect(result[1]).toBe(locked);
});
