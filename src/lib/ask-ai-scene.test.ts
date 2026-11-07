import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { answerMarkdown, askSelection } from './ask-ai-scene';

const el = (patch: object) => ({ isDeleted: false, x: 0, y: 0, width: 10, height: 10, customData: {}, ...patch }) as unknown as ExcalidrawElement;

it('uses selected notes in reading order and sends selected pictures', () => {
  const elements = [
    el({ id: 'q', type: 'text', text: 'what is this?', originalText: 'what is this?', y: 200 }),
    el({ id: 'photo', type: 'image', fileId: 'f', y: 50, height: 120 }),
    el({ id: 'svg', type: 'image', fileId: 's', y: 60 }),
    el({ id: 'ctx', type: 'text', text: 'Living room', originalText: 'Living room', y: 10 }),
    el({ id: 'note-rich-q', type: 'image', fileId: 'r', customData: { noteRichTextRender: { ownerId: 'q' } } }),
    el({ id: 'other', type: 'text', text: 'not selected', originalText: 'not selected' }),
  ];
  const files = { f: { dataURL: 'data:image/png;base64,AAAA' }, s: { dataURL: 'data:image/svg+xml;base64,BBBB' } } as unknown as BinaryFiles;
  const picked = askSelection(elements, { q: true, photo: true, svg: true, ctx: true }, files);
  expect(picked.texts).toEqual(['Living room', 'what is this?']);
  expect(picked.images).toEqual([{ mimeType: 'image/png', data: 'AAAA' }]);
  expect(picked.skippedImages).toBe(1);
  expect(picked.anchor?.id).toBe('q');
});

it('adds linked sources under the answer', () => {
  expect(answerMarkdown({ text: 'Answer', sources: [{ title: 'A [b]', url: 'https://a.example' }], searched: true })).toBe('Answer\n\n*Sources:* [A b](https://a.example)');
});
