import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({ newElementWith: (element: object, patch: object) => ({ ...element, ...patch }) }));
import { colorSelection, coloredElements, displayedObjectColor, OBJECT_COLORS, parseObjectColor } from './object-colors';

const shape = { id: 'shape', type: 'rectangle', locked: false, strokeColor: '#000000', backgroundColor: '#ffffff', groupIds: [] } as unknown as ExcalidrawElement;
describe('object colors', () => {
  it('accepts custom hex and transparent values while rejecting invalid CSS', () => {
    expect(parseObjectColor(' aBc ')).toBe('#aabbcc'); expect(parseObjectColor('#A1B2C3')).toBe('#a1b2c3'); expect(parseObjectColor('none')).toBe('transparent');
    expect(parseObjectColor('#abcdef00')).toBe('transparent'); expect(parseObjectColor('#abcdef80')).toBe('#abcdef80');
    for (const value of ['red', '#12', 'url(x)', '#12345', '#gggggg']) expect(parseObjectColor(value)).toBeNull();
    expect(OBJECT_COLORS.length).toBeGreaterThan(30);
  });
  it('makes the border or fill transparent without hiding a shape label', () => {
    const label = { id: 'label', type: 'text', containerId: 'shape', strokeColor: '#112233', locked: false } as ExcalidrawElement;
    const result = coloredElements([shape, label], { shape: true, label: true }, 'stroke', 'transparent');
    expect(result[0].strokeColor).toBe('transparent'); expect(result[1]).toBe(label); expect(shape.strokeColor).toBe('#000000');
    expect(coloredElements([shape], { shape: true }, 'background', 'transparent')[0].backgroundColor).toBe('transparent');
  });
  it('protects locked objects and skips pixel images and internal text renderings', () => {
    const locked = { ...shape, id: 'locked', locked: true }, image = { ...shape, id: 'image', type: 'image' } as ExcalidrawElement;
    const render = { ...image, id: 'render', customData: { noteRichTextRender: { ownerId: 'shape' } } };
    const elements = [shape, locked, image, render], selection = { shape: true, locked: true, image: true, render: true };
    expect(colorSelection(elements, selection, 'stroke').map(e => e.id)).toEqual(['shape']);
    const result = coloredElements(elements, selection, 'stroke', '#123456');
    expect(result[0].strokeColor).toBe('#123456'); expect(result.slice(1)).toEqual(elements.slice(1));
  });
  it('recolors formatted text, including explicit word colors, and supports no text stroke', () => {
    const text = { ...shape, id: 'text', type: 'text', customData: { noteRichText: { version: 1, color: '#112233', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello', marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Georgia' } }] }] }] } } } } as ExcalidrawElement;
    const colored = coloredElements([text], { text: true }, 'stroke', '#123456')[0];
    expect(colored.customData?.noteRichText.color).toBe('#123456');
    expect(colored.customData?.noteRichText.doc.content[0].content[0].marks[0].attrs).toEqual({ color: '#123456', fontFamily: 'Georgia' });
    const invisible = coloredElements([text], { text: true }, 'stroke', 'transparent')[0];
    expect(displayedObjectColor(invisible, 'stroke')).toBe('transparent'); expect(text.customData?.noteRichText.color).toBe('#112233');
  });
});
