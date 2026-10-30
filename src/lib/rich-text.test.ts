import { describe, expect, it } from 'vitest';
import { cleanRichDoc, clipboardRichDoc, hasRichFormatting, markdownRichDoc, plainRichDoc, readRichText, richDocMarkdown, richDocText, safeTextLink, withRichTextRenders } from './rich-text';

describe('rich text and Markdown', () => {
  it('keeps derived text with a selection export without including unrelated text', () => {
    const elements = [{ id: 'text' }, { id: 'render', customData: { noteRichTextRender: { ownerId: 'text' } } }, { id: 'other' }, { id: 'other-render', customData: { noteRichTextRender: { ownerId: 'other' } } }];
    expect(withRichTextRenders(elements, [elements[0]])).toEqual(elements.slice(0, 2));
    expect(withRichTextRenders(elements, elements.slice(0, 2))).toEqual(elements.slice(0, 2));
  });
  it('interprets headings, mixed inline styles, links, and nested lists', () => {
    const doc = markdownRichDoc('# Plan\n\n**Remember** and *check* [the guide](https://example.com).\n\n- Parent\n  - Child\n\n1. First\n2. Second');
    expect(doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(doc.content?.[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Remember', marks: [{ type: 'bold' }] }),
      expect.objectContaining({ text: 'check', marks: [{ type: 'italic' }] }),
      expect.objectContaining({ text: 'the guide', marks: [expect.objectContaining({ type: 'link', attrs: expect.objectContaining({ href: 'https://example.com' }) })] }),
    ]));
    expect(doc.content?.some(node => node.type === 'bulletList')).toBe(true);
    expect(doc.content?.some(node => node.type === 'orderedList')).toBe(true);
    expect(richDocText(doc)).toContain('Parent\nChild');
  });
  it('preserves literal Markdown and line breaks for raw paste', () => {
    const text = '# Literal\n**still literal**\n\n<Widget> and `code`';
    const raw = clipboardRichDoc(text, true);
    expect(richDocText(raw)).toBe(text); expect(hasRichFormatting(raw)).toBe(false);
    expect(hasRichFormatting(clipboardRichDoc(text, false))).toBe(true);
  });
  it('keeps code characters, whitespace, and escaped Markdown intact', () => {
    const doc = markdownRichDoc('```html\n<div x="a & b">\n  hello\n</div>\n```\n\nUse `a < b && c > d` and \\*literal\\*.');
    expect(doc.content?.[0]).toMatchObject({ type: 'codeBlock', content: [{ type: 'text', text: '<div x="a & b">\n  hello\n</div>' }] });
    expect(richDocText(doc)).toContain('a < b && c > d');
    expect(richDocText(doc)).toContain('*literal*');
  });
  it('imports GFM tables, checklists, block quotes and strikethrough', () => {
    const doc = markdownRichDoc('- [x] Done\n- [ ] Next\n\n> Quote\n\n~~old~~\n\n| Name | Type |\n| --- | --- |\n| id | int |');
    const types = doc.content?.map(node => node.type);
    expect(types).toContain('taskList'); expect(types).toContain('blockquote'); expect(types).toContain('table');
    expect(doc.content?.[0].content?.[0]).toMatchObject({ type: 'taskItem', attrs: { checked: true } });
    expect(richDocText(doc)).toContain('Name\tType\nid\tint');
  });
  it('round-trips supported Markdown without flattening formatting', () => {
    const input = '# Heading\n\n**bold** and *italic* with `code`\n\n- First\n- Second';
    const doc = markdownRichDoc(input);
    const second = markdownRichDoc(richDocMarkdown(doc));
    expect(richDocText(second)).toBe(richDocText(doc)); expect(second).toEqual(doc);
  });
  it('removes unsafe links, CSS, and unsupported nodes from stored or pasted documents', () => {
    const doc = cleanRichDoc({ type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'bad' }, content: [{ type: 'text', text: 'Safe', marks: [
      { type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'textStyle', attrs: { color: 'url(https://bad)', backgroundColor: '#ffff00', fontFamily: 'evil', fontSize: '500px', backgroundImage: 'url(https://bad)' } },
    ] }] }, { type: 'image', attrs: { src: 'https://bad/image.png' } }] });
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0].content?.[0].marks).toEqual([{ type: 'textStyle', attrs: { backgroundColor: '#ffff00', fontSize: '96px' } }]);
    expect(safeTextLink('java\nscript:alert(1)')).toBeUndefined(); expect(safeTextLink('data:text/html,bad')).toBeUndefined();
    expect(safeTextLink('https://example.com/page?q=yes')).toBe('https://example.com/page?q=yes');
    expect(safeTextLink('mailto:user@example.com')).toBe('mailto:user@example.com');
  });
  it('reads old plain text without forcing a conversion, and rejects unknown document versions', () => {
    expect(readRichText({})).toBeNull(); expect(readRichText({ customData: { noteRichText: { version: 2, doc: plainRichDoc('old') } } })).toBeNull();
    expect(hasRichFormatting(plainRichDoc('a\n\nb'))).toBe(false);
    expect(richDocText(plainRichDoc('a\r\nb'))).toBe('a\nb');
  });
  it('retains unknown image markup as text without loading remote Markdown images', () => {
    const doc = markdownRichDoc('![Diagram](https://example.com/image.png)');
    expect(richDocText(doc)).toContain('Diagram');
    expect(JSON.stringify(doc)).not.toContain('"type":"image"');
  });
  it('falls back to readable text for malformed stored structure', () => {
    const doc = cleanRichDoc({ type: 'doc', content: [{ type: 'text', text: 'Recover this', marks: null }, { type: 'table', content: [] }] });
    expect(richDocText(doc)).toContain('Recover this');
    expect(() => cleanRichDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Safe', marks: [null, {}] }] }] })).not.toThrow();
  });
});
