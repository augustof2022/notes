import { expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({
  mutateElement: (element: object, patch: object) => Object.assign(element, patch),
  convertToExcalidrawElements: (elements: object[]) => elements,
}));
vi.mock('./rich-text-render', () => ({ renderRichText: () => ({ width: 100, height: 24, file: { id: 'rich-file' } }) }));
import { repairRichTextElements } from './rich-text-scene';

it('keeps a formatted label above its owner after native grouping changes their stack order', () => {
  const shape = { id: 'shape', type: 'rectangle', x: 10, y: 20, width: 180, height: 100, angle: 0, groupIds: ['g'] };
  const source = { id: 'label', type: 'text', containerId: 'shape', x: 50, y: 58, width: 100, height: 24, fontSize: 18, angle: 0, groupIds: ['g'], frameId: null, opacity: 100, textAlign: 'center', verticalAlign: 'middle', strokeColor: 'transparent', customData: { noteRichText: { version: 1, color: '#000000', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Customer', marks: [{ type: 'bold' }] }] }] } } } };
  const image = { id: 'note-rich-label', type: 'image', x: 50, y: 58, width: 100, height: 24, locked: true, groupIds: [], customData: { noteRichTextRender: { ownerId: 'label' } } };
  const input = [image, { id: 'other', type: 'ellipse' }, shape, source] as unknown as ExcalidrawElement[];
  const result = repairRichTextElements(input);
  expect(result.elements.map(element => element.id)).toEqual(['other', 'shape', 'label', 'note-rich-label']);
  expect(result.changed).toBe(true);
  expect(result.elements.at(-1)).toMatchObject({ locked: true, groupIds: ['g'] });
  expect(repairRichTextElements(result.elements).changed).toBe(false);
});
