import { expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({
  mutateElement: (element: object, patch: object) => Object.assign(element, patch),
  convertToExcalidrawElements: (elements: object[]) => elements,
}));
vi.mock('./rich-text-render', () => ({ renderRichText: () => ({ width: 100, height: 24, file: { id: 'rich-file' } }) }));
import { repairRichTextElements, richTextWidth, syncRichTextFit } from './rich-text-scene';

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

const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kitchen' }] }] };
const fitted = (patch: object = {}) => ({ id: 'kitchen', type: 'text', containerId: null, x: 0, y: 0, width: 320, height: 27, fontSize: 20, angle: 0, groupIds: [], frameId: null, opacity: 100, textAlign: 'left', verticalAlign: 'top', strokeColor: 'transparent',
  customData: { noteRichText: { version: 1, color: '#000000', doc, fit: { wrap: 320, width: 320, fontSize: 20 } } }, ...patch }) as unknown as ExcalidrawElement;

it('shrinks a fitted text box to its content and keeps the wrap width', () => {
  const result = repairRichTextElements([fitted()]);
  const text = result.elements.find(element => element.id === 'kitchen')!;
  expect(text.width).toBe(100);
  expect(text.customData?.noteRichText.fit).toEqual({ wrap: 320, width: 100, fontSize: 20 });
  expect(repairRichTextElements(result.elements).changed).toBe(false);
});

it('scales the wrap width with corner resizing and stops fitting after a manual width change', () => {
  const fit = { wrap: 320, width: 100, fontSize: 20 };
  expect(syncRichTextFit({ width: 50, fontSize: 10, containerId: null }, fit)).toEqual({ wrap: 160, width: 50, fontSize: 10 });
  expect(syncRichTextFit({ width: 100, fontSize: 20, containerId: null }, fit)).toBe(fit);
  expect(syncRichTextFit({ width: 180, fontSize: 20, containerId: null }, fit)).toBeUndefined();
});

it('keeps small standalone labels at their own width instead of a 360px default', () => {
  const small = { type: 'text', width: 22, fontSize: 9.5, containerId: null, customData: {} } as unknown as Parameters<typeof richTextWidth>[0];
  expect(richTextWidth(small, [])).toBe(22);
  expect(richTextWidth({ ...small, width: 0 } as typeof small, [])).toBe(360);
});

const label = (patch: object = {}) => ({ id: 'label', type: 'text', containerId: 'node', x: 50, y: 58.3, width: 100, height: 24, fontSize: 18, angle: 0, groupIds: [], frameId: null, opacity: 100, textAlign: 'center', verticalAlign: 'middle', strokeColor: 'transparent', autoResize: false,
  customData: { noteRichText: { version: 1, color: '#000000', doc } }, ...patch }) as unknown as ExcalidrawElement;
const node = { id: 'node', type: 'rectangle', x: 0, y: 0, width: 200, height: 140, angle: 0, groupIds: [] } as unknown as ExcalidrawElement;

it('does not fight the editor over sub-pixel label positions', () => {
  // Centered y is (140 - 24) / 2 = 58; 58.3 is the same layout.
  const first = repairRichTextElements([node, label()]);
  expect(repairRichTextElements(first.elements).changed).toBe(false);
  expect(first.elements.find(element => element.id === 'label')!.y).toBe(58.3);
});

it('leaves a label being edited where the editor put it, then centers it afterwards', () => {
  const editing = repairRichTextElements([node, label({ y: 30 })], 'label');
  expect(editing.elements.find(element => element.id === 'label')!.y).toBe(30);
  const done = repairRichTextElements(editing.elements);
  expect(done.elements.find(element => element.id === 'label')!.y).toBe(58);
});
