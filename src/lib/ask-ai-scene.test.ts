import { expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { answerMarkdown, answerTerms, askSelection, isLearnNote, readLearnPage, threadContext, threadLabel, threadPath } from './ask-ai-scene';

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

it('reads marked terms once each and shows them in bold on the board', () => {
  const text = 'A [[heat pump]] moves heat using a [[refrigerant]]. The [[Heat  Pump]] is not a [[]] fan.';
  expect(answerTerms(text)).toEqual(['heat pump', 'refrigerant']);
  expect(answerMarkdown({ text, sources: [], searched: false }, { term: 'Coolant [x]' })).toBe('### Coolant x\n\nA **heat pump** moves heat using a **refrigerant**. The **Heat  Pump** is not a [[]] fan.');
  expect(answerMarkdown({ text: 'Yes.', sources: [], searched: false }, { question: 'Why\nnot?' })).toBe('**Q:** Why not?\n\nYes.');
});

it('walks a thread back to the page it started from and sends it as context', () => {
  const page = { title: 'Heat pumps', url: 'https://example.com/hp', text: 'Page body', selection: 'COP', at: '' };
  const elements = [
    el({ id: 'page', type: 'text', text: 'page card', customData: { noteLearnPage: page } }),
    el({ id: 'a', type: 'text', text: 'A heat pump…', originalText: 'A heat pump…', customData: { noteAi: { question: 'What is it?', parentId: 'page' } } }),
    el({ id: 'b', type: 'text', text: '### COP\n\nRatio…', originalText: '### COP\n\nRatio…', customData: { noteAi: { question: 'Explain', term: 'COP', parentId: 'a' } } }),
    el({ id: 'loop', type: 'text', text: 'x', customData: { noteAi: { question: 'q', parentId: 'loop' } } }),
  ];
  expect(threadPath(elements, 'b').map(item => item.id)).toEqual(['page', 'a', 'b']);
  expect(threadPath(elements, 'loop').map(item => item.id)).toEqual(['loop']);
  expect(threadPath(elements, 'b').map(threadLabel)).toEqual(['Heat pumps', 'What is it?', 'COP']);
  const context = threadContext(elements, 'b');
  expect(context[0]).toContain('https://example.com/hp');
  expect(context[0]).toContain('They selected: COP');
  expect(context.slice(1)).toEqual(['A heat pump…', '### COP\n\nRatio…']);
  expect(isLearnNote(elements[0])).toBe(true);
  expect(isLearnNote(el({ id: 'plain', type: 'text', text: 'hi' }))).toBe(false);
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
