import { getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown, MarkdownManager } from '@tiptap/markdown';

export type RichDoc = JSONContent;
export interface RichTextData { version: 1; doc: RichDoc; color: string }
export const RICH_FILE_PREFIX = 'note-rich-text-';
export const isRichTextFile = (id: string) => id.startsWith(RICH_FILE_PREFIX);
export const RICH_FONTS = ['Arial', 'Georgia', 'monospace'] as const;

export function richTextExtensions() {
  return [StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
    TextStyleKit.configure({ lineHeight: false }), TableKit.configure({ table: { resizable: false } }),
    TaskList, TaskItem.configure({ nested: true }), Markdown];
}
let manager: MarkdownManager | undefined;
let schema: Schema | undefined;
function markdownManager() { return manager ||= new MarkdownManager({ extensions: richTextExtensions() }); }

export function safeTextColor(value: unknown): string | undefined {
  return typeof value === 'string' && (/^#[\da-f]{3,8}$/i.test(value) || /^rgba?\([\d.,%\s]+\)$/.test(value)) ? value : undefined;
}
export function safeTextLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return;
  return /^(https?:\/\/|mailto:|tel:)/i.test(value) ? value : undefined;
}
const blocks = new Set(['doc', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'codeBlock', 'horizontalRule', 'hardBreak', 'table', 'tableRow', 'tableHeader', 'tableCell']);
const marks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle']);

/** Only our editor schema and safe display attributes enter the persisted document. */
export function cleanRichDoc(value: unknown): RichDoc {
  let count = 0;
  function node(input: unknown, depth = 0): RichDoc | null {
    if (!input || typeof input !== 'object' || depth > 40 || ++count > 15000) return null;
    const raw = input as RichDoc, type = raw.type;
    if (type === 'text') {
      if (typeof raw.text !== 'string' || !raw.text) return null;
      const styles = (Array.isArray(raw.marks) ? raw.marks : []).flatMap(mark => {
        if (!mark || !marks.has(mark.type)) return [];
        const attrs = mark.attrs || {};
        if (mark.type === 'link') { const href = safeTextLink(attrs.href); return href ? [{ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }] : []; }
        if (mark.type === 'textStyle') {
          const clean: Record<string, string> = {};
          for (const key of ['color', 'backgroundColor']) { const color = safeTextColor(attrs[key]); if (color) clean[key] = color; }
          if (RICH_FONTS.includes(attrs.fontFamily)) clean.fontFamily = attrs.fontFamily;
          const size = typeof attrs.fontSize === 'string' && /^(\d+(?:\.\d+)?)px$/.exec(attrs.fontSize);
          if (size) clean.fontSize = `${Math.max(8, Math.min(96, Number(size[1])))}px`;
          return Object.keys(clean).length ? [{ type: 'textStyle', attrs: clean }] : [];
        }
        return [{ type: mark.type }];
      });
      return { type, text: raw.text, ...(styles.length ? { marks: styles } : {}) };
    }
    if (!type || !blocks.has(type)) return null;
    const attrs: Record<string, unknown> = {};
    if (type === 'heading') attrs.level = Math.max(1, Math.min(6, Math.round(Number(raw.attrs?.level) || 1)));
    if (type === 'orderedList') attrs.start = Math.max(1, Math.min(99999, Number(raw.attrs?.start) || 1));
    if (type === 'taskItem') attrs.checked = raw.attrs?.checked === true;
    if (type === 'codeBlock' && typeof raw.attrs?.language === 'string') attrs.language = raw.attrs.language.replace(/[^\w+-]/g, '').slice(0, 40);
    if (type === 'tableCell' || type === 'tableHeader') {
      attrs.colspan = Math.max(1, Math.min(20, Number(raw.attrs?.colspan) || 1));
      attrs.rowspan = Math.max(1, Math.min(100, Number(raw.attrs?.rowspan) || 1));
    }
    const content = (Array.isArray(raw.content) ? raw.content : []).flatMap(item => { const child = node(item, depth + 1); return child ? [child] : []; });
    return { type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) };
  }
  const result = node(value);
  const doc = result?.type === 'doc' ? { ...result, content: result.content?.length ? result.content : [{ type: 'paragraph' }] } : plainRichDoc('');
  try { (schema ||= getSchema(richTextExtensions())).nodeFromJSON(doc).check(); return doc; }
  catch { return plainRichDoc(richDocText(doc)); }
}

export function plainRichDoc(text: string): RichDoc {
  return { type: 'doc', content: text.replace(/\r\n?/g, '\n').split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) };
}
export function markdownRichDoc(markdown: string): RichDoc {
  // The schema has no scripts, embeds, or images; unknown HTML stays literal.
  // Clean attributes too, including links and styles imported from inline HTML.
  return cleanRichDoc(markdownManager().parse(markdown));
}
export function richDocMarkdown(doc: RichDoc): string { return markdownManager().serialize(cleanRichDoc(doc)); }
export function hasRichFormatting(doc: RichDoc): boolean {
  return !!doc.marks?.length || !['doc', 'paragraph', 'text', 'hardBreak'].includes(doc.type || '') || !!doc.content?.some(hasRichFormatting);
}
export function richDocText(doc: RichDoc): string {
  if (doc.type === 'text') return doc.text || '';
  if (doc.type === 'hardBreak') return '\n';
  const separator = ['doc', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table'].includes(doc.type || '') ? '\n' : doc.type === 'tableRow' ? '\t' : '';
  return (doc.content || []).map(richDocText).join(separator);
}
export function readRichText(element: { customData?: Record<string, any> | null }): RichTextData | null {
  const data = element.customData?.noteRichText;
  return data?.version === 1 && data.doc?.type === 'doc' ? { version: 1, doc: cleanRichDoc(data.doc), color: safeTextColor(data.color) || '#1b1b1f' } : null;
}
export function richTextColor(element: { strokeColor: string; customData?: Record<string, any> | null }) { return readRichText(element)?.color || element.strokeColor; }

export function withRichTextRenders<T extends { id: string; customData?: Record<string, any> | null }>(elements: readonly T[], selection: readonly T[]): T[] {
  const ids = new Set(selection.map(element => element.id));
  return elements.filter(element => ids.has(element.id) || ids.has(element.customData?.noteRichTextRender?.ownerId));
}

/** Raw mode also clears inherited marks at the insertion point. */
export function clipboardRichDoc(text: string, raw: boolean): RichDoc {
  return raw ? plainRichDoc(text) : markdownRichDoc(text);
}
