import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { lockedObjects } from './object-locks';

it('groups a locked diagram shape, label and outline without unlocking its connections', () => {
  const elements = [
    { id: 'shape', type: 'rectangle', locked: true, groupIds: ['group'], customData: { noteDiagram: { kind: 'node', system: 'chen', diagramId: 'd', shapeId: 'weak-entity', parentId: null } } },
    { id: 'label', type: 'text', locked: true, groupIds: ['group'], containerId: 'shape', text: 'Customers' },
    { id: 'outline', type: 'rectangle', locked: true, groupIds: ['group'], customData: { noteDiagram: { kind: 'decoration', system: 'chen', diagramId: 'd', nodeId: 'shape' } } },
    { id: 'edge', type: 'arrow', locked: true, groupIds: [] },
    { id: 'deleted', type: 'rectangle', locked: true, isDeleted: true, groupIds: [] },
  ] as unknown as ExcalidrawElement[];
  expect(lockedObjects(elements)).toEqual([
    { id: 'group', label: 'Shape: Customers', elementIds: ['shape', 'label', 'outline'] },
    { id: 'edge', label: 'Connection', elementIds: ['edge'] },
  ]);
});

it('keeps unrelated locks independent and ignores unlocked objects', () => {
  const elements = [
    { id: 'one', type: 'text', text: 'First note', groupIds: [], locked: true },
    { id: 'two', type: 'image', groupIds: [], locked: true },
    { id: 'three', type: 'rectangle', groupIds: [], locked: false },
  ] as unknown as ExcalidrawElement[];
  expect(lockedObjects(elements).map(item => item.elementIds)).toEqual([['one'], ['two']]);
});

it('does not offer to unlock the derived rendering of editable rich text', () => {
  const elements = [
    { id: 'text', type: 'text', text: 'Formatted', groupIds: [], locked: false },
    { id: 'render', type: 'image', groupIds: [], locked: true, customData: { noteRichTextRender: { ownerId: 'text' } } },
    { id: 'real-image', type: 'image', groupIds: [], locked: true },
  ] as unknown as ExcalidrawElement[];
  expect(lockedObjects(elements)).toEqual([{ id: 'real-image', label: 'Image', elementIds: ['real-image'] }]);
});
