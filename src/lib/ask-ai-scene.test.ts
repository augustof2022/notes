import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { answerMarkdown, askSelection, isLearnNote, objectContent, readLearnPage, threadContext, threadPath } from './ask-ai-scene';

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

it('walks a thread back to the page it started from, reading text inside shapes, and sends it as context', () => {
  const page = { title: 'Heat pumps', url: 'https://example.com/hp', text: 'Page body', selection: 'COP', at: '' };
  const elements = [
    el({ id: 'page', type: 'text', text: 'page card', customData: { noteLearnPage: page } }),
    el({ id: 'sel', type: 'rectangle', customData: { noteAi: { question: 'q', parentId: 'page', role: 'selection' } } }),
    el({ id: 'sel-label', type: 'text', text: '"COP"', originalText: '"COP"', containerId: 'sel' }),
    el({ id: 'b', type: 'text', text: 'Ratio of heat moved...', originalText: 'Ratio of heat moved...', customData: { noteAi: { question: 'Explain', parentId: 'sel', role: 'answer' } } }),
    el({ id: 'loop', type: 'text', text: 'x', customData: { noteAi: { question: 'q', parentId: 'loop' } } }),
  ];
  expect(threadPath(elements, 'b').map(item => item.id)).toEqual(['page', 'sel', 'b']);
  expect(threadPath(elements, 'loop').map(item => item.id)).toEqual(['loop']);
  const context = threadContext(elements, 'b');
  expect(context[0]).toContain('https://example.com/hp');
  expect(context[0]).toContain('They selected: COP');
  expect(context.slice(1)).toEqual(['"COP"', 'Ratio of heat moved...']);
  expect(isLearnNote(elements[1])).toBe(true);
  expect(isLearnNote(elements[0])).toBe(true);
  expect(isLearnNote(el({ id: 'plain', type: 'text', text: 'hi' }))).toBe(false);
  expect(isLearnNote(el({ id: 'bad', type: 'text', text: 'x', customData: { noteLearnPage: { ...page, url: 'javascript:alert(1)' } } }))).toBe(false);
});

it('accepts only web pages from the browser helper, trimmed', () => {
  expect(readLearnPage({ url: 'javascript:alert(1)', text: 'x' })).toBeNull();
  expect(readLearnPage({ url: 'not a url', text: 'x' })).toBeNull();
  expect(readLearnPage({ url: 'https://example.com/a', text: 5 })).toBeNull();
  const page = readLearnPage({ url: 'https://example.com/a', title: '  A   page ', text: 'y'.repeat(30000), selection: '  bit ' });
  expect(page).toMatchObject({ title: 'A page', url: 'https://example.com/a', selection: 'bit' });
  expect(page?.text.length).toBe(20000);
  expect(readLearnPage({ url: 'https://example.com/b', text: '' })?.title).toBe('example.com');
});

it('reads a whole selected object: a text box or shape label as words, a picture as is, a wordless drawing as a snapshot', () => {
  const box = el({ id: 'box', type: 'rectangle' }), label = el({ id: 'label', type: 'text', text: 'Grievance flow', originalText: 'Grievance flow', containerId: 'box' });
  const note = el({ id: 'note', type: 'text', text: 'PMT', originalText: 'PMT' }), photo = el({ id: 'photo', type: 'image', fileId: 'f' }), sketch = el({ id: 'sketch', type: 'freedraw' });
  const elements = [box, label, note, photo, sketch], files = { f: { dataURL: 'data:image/png;base64,AAAA' } } as unknown as BinaryFiles;
  expect(objectContent(elements, [box], files)).toMatchObject({ text: 'Grievance flow', images: [], snapshot: false, kind: 'text' });
  expect(objectContent(elements, [note], files)).toMatchObject({ text: 'PMT', kind: 'text' });
  expect(objectContent(elements, [photo], files)).toMatchObject({ text: '', images: [{ mimeType: 'image/png', data: 'AAAA' }], snapshot: false, kind: 'image' });
  expect(objectContent(elements, [sketch], files)).toMatchObject({ text: '', images: [], snapshot: true, kind: 'drawing' });
  expect(objectContent(elements, [note, photo], files)).toMatchObject({ text: 'PMT', images: [{ mimeType: 'image/png', data: 'AAAA' }], kind: 'text' });
});
