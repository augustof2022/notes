import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { AskAnswer, AskImage } from './gemini';

export const ASK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMAGES = 3, MAX_IMAGE_BASE64 = 6 * 1024 * 1024;

export interface AskSelection { texts: string[]; images: AskImage[]; skippedImages: number; anchor: ExcalidrawElement | null }

/**
 * The selected notes become the question (in reading order) and selected
 * pictures are sent along so "what is this?" can refer to them. Labels count
 * through their shape; derived formatted-text previews are ignored.
 */
export function askSelection(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, boolean>>, files: BinaryFiles): AskSelection {
  const visible = elements.filter(element => !element.isDeleted && !element.customData?.noteRichTextRender);
  const chosen = visible.filter(element => selected[element.id] || (element.type === 'text' && element.containerId && selected[element.containerId]));
  const ordered = [...chosen].sort((a, b) => a.y - b.y || a.x - b.x);
  const texts = ordered.flatMap(element => element.type === 'text' && (element.originalText || element.text).trim() ? [(element.originalText || element.text).trim()] : []);
  const images: AskImage[] = []; let skippedImages = 0;
  for (const element of ordered) {
    if (element.type !== 'image' || !element.fileId) continue;
    const match = /^data:([^;,]+);base64,(.*)$/.exec(files[element.fileId]?.dataURL || '');
    if (!match || !ASK_IMAGE_TYPES.includes(match[1]) || match[2].length > MAX_IMAGE_BASE64 || images.length >= MAX_IMAGES) { skippedImages++; continue; }
    images.push({ mimeType: match[1], data: match[2] });
  }
  const anchor = [...chosen].filter(element => !(element.type === 'text' && element.containerId)).sort((a, b) => (b.y + b.height) - (a.y + a.height))[0] || null;
  return { texts, images, skippedImages, anchor };
}

const TERM = /\[\[([^\][\n]{1,60})\]\]/g;

/** The [[marked]] terms of an answer, first appearance first, without repeats (case-insensitive). */
export function answerTerms(text: string, limit = 8): string[] {
  const seen = new Set<string>(), terms: string[] = [];
  for (const [, raw] of text.matchAll(TERM)) {
    const term = raw.replace(/\s+/g, ' ').trim(), key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key); terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Marked terms show in bold on the board; the brackets are only a signal for the app. */
export const boldTerms = (text: string) => text.replace(TERM, (_, term: string) => `**${term.trim()}**`);

/**
 * Markdown for the answer note, with up to five linked sources from Google
 * Search. A clicked term gets its name as a heading; a question typed in the
 * Learn panel (not written on the board) is shown above its answer.
 */
export function answerMarkdown(answer: AskAnswer, header: { term?: string; question?: string } = {}) {
  const sources = answer.sources.map(source => `[${source.title.replace(/[[\]]/g, '')}](${source.url})`);
  const top = header.term ? `### ${header.term.replace(/[#*[\]]/g, '')}\n\n` : header.question ? `**Q:** ${header.question.replace(/\n+/g, ' ').trim()}\n\n` : '';
  return `${top}${boldTerms(answer.text.trim())}${sources.length ? `\n\n*Sources:* ${sources.join(' · ')}` : ''}`;
}

/** What the Learn panel records on an AI note to rebuild its thread. */
export interface LearnData { provider: string; model: string; question: string; at: string; terms?: string[]; parentId?: string; term?: string }
/** A page sent from the browser by the Note Learn helper. */
export interface LearnPage { title: string; url: string; text: string; selection?: string; at: string }

/** Check a page sent by the browser helper and trim it before it goes on the board (only http/https pages). */
export function readLearnPage(value: any): LearnPage | null {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || typeof value.text !== 'string') return null;
  let url: URL;
  try { url = new URL(value.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const title = (typeof value.title === 'string' && value.title.trim() ? value.title : url.hostname).replace(/\s+/g, ' ').trim().slice(0, 160);
  const selection = typeof value.selection === 'string' ? value.selection.trim().slice(0, 4000) : '';
  return { title, url: url.href.slice(0, 2000), text: value.text.slice(0, 20000), ...(selection ? { selection } : {}), at: new Date().toISOString() };
}

const learnData = (element: ExcalidrawElement | undefined): LearnData | null => element?.customData?.noteAi && typeof element.customData.noteAi === 'object' ? element.customData.noteAi as LearnData : null;
export const learnPage = (element: ExcalidrawElement | undefined): LearnPage | null => {
  const page = element?.customData?.noteLearnPage;
  return page && typeof page.url === 'string' && typeof page.text === 'string' ? page as LearnPage : null;
};
export const isLearnNote = (element: ExcalidrawElement | undefined) => !!element && element.type === 'text' && !element.isDeleted && !!(learnData(element) || learnPage(element));
const noteText = (element: ExcalidrawElement) => element.type === 'text' ? (element.originalText || element.text).trim() : '';

/** The notes from the thread's start down to this one (at most 8, guarding against loops). */
export function threadPath(elements: readonly ExcalidrawElement[], id: string): ExcalidrawElement[] {
  const byId = new Map(elements.filter(element => !element.isDeleted).map(element => [element.id, element]));
  const path: ExcalidrawElement[] = [];
  for (let current = byId.get(id); current && path.length < 8 && !path.includes(current); current = byId.get(learnData(current)?.parentId || '')) path.unshift(current);
  return path;
}

/** A short name for a note in the thread trail. */
export function threadLabel(element: ExcalidrawElement) {
  const page = learnPage(element), data = learnData(element);
  const label = page?.title || data?.term || data?.question || noteText(element).split('\n')[0] || 'Note';
  return label.replace(/^#+\s*|\*\*/g, '').trim().slice(0, 40);
}

/**
 * Context for a question asked inside a thread: the page it started from (if
 * any) and the earlier notes on the way down, so a term is explained in the
 * sense of the topic it came from. Long texts are trimmed to keep requests quick.
 */
export function threadContext(elements: readonly ExcalidrawElement[], id: string): string[] {
  const path = threadPath(elements, id), context: string[] = [];
  const page = path.map(learnPage).find(Boolean);
  if (page) context.push(`The page the person is reading: ${page.title} (${page.url})${page.selection ? `\nThey selected: ${page.selection.slice(0, 1500)}` : ''}\n\n${page.text.slice(0, 12000)}`);
  for (const element of path) if (!learnPage(element)) context.push(noteText(element).slice(0, 1500));
  return context.filter(Boolean);
}
