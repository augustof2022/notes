import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { cleanRichDoc, RICH_FILE_PREFIX, safeTextColor, safeTextLink, type RichDoc } from './rich-text';

export interface RichTextRender { width: number; height: number; file: BinaryFileData }
const cache = new Map<string, RichTextRender>();
const xml = (text: string) => text.replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!);
const n = (value: number) => Math.round(value * 100) / 100;

function richNode(node: RichDoc): Node {
  if (node.type === 'text') {
    let child: Node = document.createTextNode(node.text || '');
    for (const mark of node.marks || []) {
      const tag = ({ bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code', link: 'a' } as Record<string, string>)[mark.type] || 'span';
      const wrapper = document.createElement(tag);
      if (mark.type === 'textStyle') for (const [key, value] of Object.entries(mark.attrs || {})) (wrapper.style as any)[key] = value;
      if (mark.type === 'link') { const href = safeTextLink(mark.attrs?.href); if (href) wrapper.setAttribute('href', href); }
      wrapper.append(child); child = wrapper;
    }
    return child;
  }
  const tags: Record<string, string> = { doc: 'div', paragraph: 'p', blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', taskList: 'ul', taskItem: 'li', codeBlock: 'pre', horizontalRule: 'hr', hardBreak: 'br', table: 'table', tableRow: 'tr', tableCell: 'td', tableHeader: 'th' };
  const element = document.createElement(node.type === 'heading' ? `h${node.attrs?.level || 1}` : tags[node.type || ''] || 'span');
  if (node.type === 'orderedList') element.setAttribute('start', String(node.attrs?.start || 1));
  if (node.type === 'taskList') element.dataset.type = 'taskList';
  if (node.type === 'taskItem') {
    element.dataset.type = 'taskItem'; element.dataset.checked = String(!!node.attrs?.checked);
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = !!node.attrs?.checked; label.append(checkbox); element.append(label);
    const body = document.createElement('div'); for (const child of node.content || []) body.append(richNode(child)); element.append(body);
    return element;
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    element.setAttribute('colspan', String(node.attrs?.colspan || 1)); element.setAttribute('rowspan', String(node.attrs?.rowspan || 1));
  }
  for (const child of node.content || []) element.append(richNode(child));
  return element;
}

function fingerprint(value: string) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}-${value.length}`;
}

/** Measure the same HTML/CSS as the editor, then emit portable SVG text, never foreignObject. */
export function renderRichText(doc: RichDoc, options: { width: number; fontSize: number; color: string; textAlign: string }): RichTextRender {
  const width = Math.max(24, Math.min(2400, options.width));
  const key = JSON.stringify([doc, width, options.fontSize, options.color, options.textAlign]);
  const previous = cache.get(key); if (previous) return previous;
  const host = richNode(cleanRichDoc(doc)) as HTMLElement;
  host.className = 'note-rich-content note-rich-measure';
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, fontSize: `${options.fontSize}px`, color: safeTextColor(options.color) || '#1b1b1f', textAlign: options.textAlign, pointerEvents: 'none', visibility: 'hidden' });
  host.setAttribute('aria-hidden', 'true'); document.body.append(host);
  try {
    const origin = host.getBoundingClientRect(), height = Math.max(options.fontSize * 1.35, Math.ceil(origin.height));
    const background: string[] = [], foreground: string[] = [];
    const rect = (box: DOMRect, attributes: string) => `<rect x="${n(box.x - origin.x)}" y="${n(box.y - origin.y)}" width="${n(box.width)}" height="${n(box.height)}" ${attributes}/>`;
    for (const element of host.querySelectorAll<HTMLElement>('pre, blockquote, td, th, hr, code')) {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (element.tagName === 'BLOCKQUOTE') background.push(`<path d="M${n(box.x - origin.x + 1.5)} ${n(box.y - origin.y)}v${n(box.height)}" stroke="#a1a1aa" stroke-width="3"/>`);
      else if (element.tagName === 'HR') background.push(`<path d="M0 ${n(box.y - origin.y)}H${width}" stroke="#a1a1aa"/>`);
      else if (['TD', 'TH'].includes(element.tagName)) background.push(rect(box, `fill="${element.tagName === 'TH' ? '#f4f4f5' : 'none'}" stroke="#a1a1aa" stroke-width="1"`));
      else if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') for (const part of element.getClientRects()) background.push(rect(part, `rx="3" fill="${xml(style.backgroundColor)}"`));
    }
    const metrics = document.createElement('canvas').getContext('2d')!;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement!, style = getComputedStyle(parent), text = textNode.textContent || '';
      if (style.display === 'none') continue;
      const fontSize = parseFloat(style.fontSize), font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      metrics.font = font;
      const measure = metrics.measureText('Mg'), ascent = measure.fontBoundingBoxAscent || fontSize * 0.9;
      let decoration = style.textDecorationLine, ancestor: HTMLElement | null = parent;
      while (ancestor && ancestor !== host) { decoration += ` ${getComputedStyle(ancestor).textDecorationLine}`; ancestor = ancestor.parentElement; }
      const draw = (start: number, end: number) => {
        const range = document.createRange(); range.setStart(textNode!, start); range.setEnd(textNode!, end);
        const box = range.getBoundingClientRect(); if (!box.width || !box.height) return;
        const slice = text.slice(start, end), x = n(box.x - origin.x), y = n(box.y - origin.y + ascent);
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') background.push(rect(box, `fill="${xml(style.backgroundColor)}"`));
        const decorations = [decoration.includes('underline') ? 'underline' : '', decoration.includes('line-through') ? 'line-through' : ''].filter(Boolean).join(' ');
        foreground.push(`<text x="${x}" y="${y}" font-family="${xml(style.fontFamily)}" font-size="${fontSize}" font-weight="${style.fontWeight}" font-style="${style.fontStyle}" fill="${xml(style.color)}"${decorations ? ` text-decoration="${decorations}"` : ''} xml:space="preserve">${xml(slice)}</text>`);
      };
      for (const match of text.matchAll(/\S+|[^\S\n]+|\n/g)) {
        const start = match.index!, end = start + match[0].length;
        if (match[0] === '\n') continue;
        const range = document.createRange(); range.setStart(textNode, start); range.setEnd(textNode, end);
        if (range.getClientRects().length <= 1) draw(start, end);
        else {
          // Long tokens may wrap anywhere. Keep surrogate pairs together.
          let offset = start; for (const character of match[0]) { draw(offset, offset + character.length); offset += character.length; }
        }
      }
    }
    for (const item of host.querySelectorAll<HTMLLIElement>('li')) {
      const first = item.querySelector<HTMLElement>('p') || item, box = first.getBoundingClientRect(), style = getComputedStyle(item), fontSize = parseFloat(style.fontSize);
      const x = box.x - origin.x - fontSize * 0.9, y = box.y - origin.y + fontSize;
      if (item.dataset.type === 'taskItem') {
        const checked = item.dataset.checked === 'true';
        foreground.push(`<rect x="${n(x - fontSize * 0.25)}" y="${n(y - fontSize * 0.8)}" width="${n(fontSize * 0.7)}" height="${n(fontSize * 0.7)}" rx="2" fill="${checked ? '#7c3aed' : 'none'}" stroke="${xml(style.color)}"/>`);
        if (checked) foreground.push(`<path d="m${n(x - fontSize * 0.15)} ${n(y - fontSize * 0.45)} ${n(fontSize * 0.16)} ${n(fontSize * 0.16)} ${n(fontSize * 0.33)} ${n(-fontSize * 0.38)}" fill="none" stroke="white" stroke-width="1.5"/>`);
      } else {
        const list = item.parentElement!, ordinal = [...list.children].indexOf(item) + (Number(list.getAttribute('start')) || 1);
        foreground.push(`<text x="${n(x)}" y="${n(y)}" text-anchor="end" font-family="Arial" font-size="${fontSize}" fill="${xml(style.color)}">${list.tagName === 'OL' ? `${ordinal}.` : '•'}</text>`);
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${background.join('')}${foreground.join('')}</svg>`;
    const bytes = new TextEncoder().encode(svg); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const file = { id: `${RICH_FILE_PREFIX}${fingerprint(svg)}`, dataURL: `data:image/svg+xml;base64,${btoa(binary)}`, mimeType: 'image/svg+xml', created: 0 } as BinaryFileData;
    const rendered = { width, height, file };
    cache.set(key, rendered); if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return rendered;
  } finally { host.remove(); }
}
