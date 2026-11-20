import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { cleanSelection, learnBase, learnQuestion, placeRightOf, selectionNodeSize, selectionNodeText, LEARN_NODE } from './explain-scene';

const box = (id: string, x: number, y: number, width: number, height: number, type = 'rectangle') => ({ id, x, y, width, height, type, isDeleted: false }) as unknown as ExcalidrawElement;

it('tidies selected words into one line and caps their length', () => {
  expect(cleanSelection('  small   area\nestimation ')).toBe('small area estimation');
  const long = cleanSelection('word '.repeat(200));
  expect(long.length).toBe(400);
  expect(long.endsWith('…')).toBe(true);
});

it('writes the selection node and the prompt for Explain and Ask', () => {
  expect(selectionNodeText('proxy means test')).toBe('“proxy means test”');
  expect(selectionNodeText('proxy means test', ' how is it scored? ')).toBe('“proxy means test”\nQ: how is it scored?');
  expect(learnQuestion({ kind: 'explain', selection: 'PMT' })).toBe('Explain “PMT”, in the sense it has in my note.');
  expect(learnQuestion({ kind: 'ask', selection: 'PMT', question: 'Who uses it? ' })).toBe('Who uses it?');
  expect(learnQuestion({ kind: 'explain', selection: '' })).toBe('Explain this.');
});

it('sizes the chip to its words, wrapping long ones at base x 14', () => {
  const short = selectionNodeSize('“Gini”', 20), long = selectionNodeSize(`“${'x'.repeat(110)}”`, 20);
  expect(short.width).toBeLessThan(120);
  expect(long.width).toBe(20 * 14 + 20);
  expect(long.height).toBeGreaterThan(short.height * 2);
});

it('keeps one base font per branch, between 16 and 28, and cuts long selections in the chip', () => {
  expect(learnBase({ fontSize: 12 })).toBe(16);
  expect(learnBase({ fontSize: 40 })).toBe(28);
  expect(learnBase({ fontSize: 18, customData: { noteAi: { base: 22 } } })).toBe(22);
  expect(learnBase()).toBe(20);
  expect(selectionNodeText('w'.repeat(200)).length).toBe(LEARN_NODE.maxWords + 2);
});

it('places new nodes to the right, stacking below earlier ones instead of covering them', () => {
  const source = box('src', 0, 0, 200, 60, 'text');
  const first = placeRightOf(source, { width: 120, height: 40 }, [source]);
  expect(first).toEqual({ x: 256, y: 0 });
  const second = placeRightOf(source, { width: 120, height: 40 }, [source, box('a', first.x, first.y, 120, 40)]);
  expect(second).toEqual({ x: 256, y: 60 });
  // Lines and deleted items do not block a spot.
  const line = { ...box('l', 256, 0, 300, 300, 'arrow') } as ExcalidrawElement;
  const gone = { ...box('g', 256, 0, 120, 40), isDeleted: true } as ExcalidrawElement;
  expect(placeRightOf(source, { width: 120, height: 40 }, [source, line, gone])).toEqual({ x: 256, y: 0 });
});

it('does not treat a frame, a shape the note sits on, or labels inside shapes as obstacles', () => {
  const source = box('src', 100, 100, 200, 60, 'text');
  const frame = box('f', 0, 0, 2000, 1000, 'frame'), card = box('bg', 50, 50, 1500, 800), label = { ...box('lbl', 356, 100, 120, 40, 'text'), containerId: 'x' } as unknown as ExcalidrawElement;
  expect(placeRightOf(source, { width: 120, height: 40 }, [frame, card, label, source])).toEqual({ x: 356, y: 100 });
});
