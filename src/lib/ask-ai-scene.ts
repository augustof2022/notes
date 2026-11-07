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

/** Markdown for the answer note, with up to five linked sources from Google Search. */
export function answerMarkdown(answer: AskAnswer) {
  const sources = answer.sources.map(source => `[${source.title.replace(/[[\]]/g, '')}](${source.url})`);
  return `${answer.text.trim()}${sources.length ? `\n\n*Sources:* ${sources.join(' · ')}` : ''}`;
}
