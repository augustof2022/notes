import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { findOnBoard, findSnippet } from './board-find';
import { handwritingSignature } from './handwriting-index';

const el = (patch: object) => ({ isDeleted: false, x: 0, y: 0, width: 10, height: 10, angle: 0, strokeWidth: 1, customData: {}, ...patch }) as unknown as ExcalidrawElement;

it('finds typed text, shape labels, image text, and reviewed handwriting in reading order', () => {
  const stroke = el({ id: 's1', type: 'freedraw', x: 40, y: 300, points: [[0, 0], [5, 5]] });
  const strokes = [stroke as never];
  const ink = el({ ...stroke, customData: { noteHandwriting: { text: 'buy aircon filter', strokeIds: ['s1'], signature: handwritingSignature(strokes) } } });
  const elements = [
    el({ id: 'photo', type: 'image', fileId: 'f1', x: 300, y: 100 }),
    el({ id: 'box', type: 'rectangle', x: 20, y: 200 }),
    el({ id: 'label', type: 'text', text: 'Aircon unit', originalText: 'Aircon unit', containerId: 'box', x: 30, y: 210 }),
    el({ id: 'note', type: 'text', text: 'Kitchen', originalText: 'Kitchen', x: 10, y: 50 }),
    el({ id: 'note-rich-note', type: 'image', customData: { noteRichTextRender: { ownerId: 'note' } } }),
    ink,
  ];
  const matches = findOnBoard(elements, new Map([['f1', 'FLOOR PLAN aircon 1.5HP']]), 'AIRCON');
  expect(matches.map(match => [match.kind, match.targetIds])).toEqual([['image', ['photo']], ['text', ['box']], ['handwriting', ['s1']]]);
  expect(findOnBoard(elements, new Map(), 'kitchen').map(match => match.key)).toEqual(['note']);
  expect(findOnBoard(elements, new Map(), '  ')).toEqual([]);
});

it('requires every word and highlights each in a short excerpt', () => {
  const elements = [el({ id: 't', type: 'text', text: 'window 106cm wide', originalText: 'window 106cm wide' })];
  expect(findOnBoard(elements, new Map(), 'window 106')).toHaveLength(1);
  expect(findOnBoard(elements, new Map(), 'window door')).toHaveLength(0);
  expect(findSnippet('the window is 106cm', 'window').filter(part => part.match).map(part => part.text)).toEqual(['window']);
});
