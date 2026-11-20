import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { DiagramEdgeSettings, DiagramStyle } from './diagram-scene';

/** What Explain or Ask was started with: the selected words in a note, and the person's own question for Ask. */
export interface LearnSelection { kind: 'explain' | 'ask'; sourceId: string; selection: string; question?: string }

/** Dispatched on the board by the text editor's Explain and Ask buttons; Ask AI answers it. */
export const LEARN_EVENT = 'note-learn-ask';

export const MAX_SELECTION = 400;

/** Selected words, tidied for a node and a prompt: one line of spaces, at most 400 characters. */
export function cleanSelection(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SELECTION ? `${flat.slice(0, MAX_SELECTION - 1)}…` : flat;
}

/** The node that holds what was selected (and the question asked about it). */
export function selectionNodeText(selection: string, question?: string) {
  return question?.trim() ? `“${chipWords(selection)}”\nQ: ${question.trim()}` : `“${chipWords(selection)}”`;
}

/** The prompt sent to Gemini for each kind. */
export function learnQuestion({ kind, selection, question }: Pick<LearnSelection, 'kind' | 'selection' | 'question'>) {
  return kind === 'explain' ? `Explain “${selection}”.` : `About “${selection}”: ${(question || '').trim()}`;
}

/**
 * Look of Explain/Ask nodes (ui-designer spec, 2026-11-20): the Diagram
 * tool's Violet theme, so they look native. Colours are stored in light
 * values; Excalidraw's dark mode inverts the canvas. Sizes scale with the
 * base font (k = base / 20).
 */
export const LEARN_NODE = { stroke: '#7c3aed', fill: '#ede9fe', text: '#3b0764', chipStrokeWidth: 2, lineWidth: 2, roundness: { type: 3 as const, value: 12 },
  baseMin: 16, baseMax: 28, answerFontFactor: 0.9, answerChars: 24, chipChars: 14, maxWords: 120, padding: 10, gapSource: 64, gapAnswer: 40, gapStack: 24 };

/** The base font of a branch: the source's size, kept between 16 and 28, and stored so deeper levels do not shrink. */
export function learnBase(source?: { fontSize?: number; customData?: Record<string, any> | null }) {
  const stored = Number(source?.customData?.noteAi?.base);
  const size = Number.isFinite(stored) && stored > 0 ? stored : source?.fontSize || 20;
  return Math.min(LEARN_NODE.baseMax, Math.max(LEARN_NODE.baseMin, Math.round(size)));
}

/** Chip words: cut at 120 characters so a long selection stays a small node (the full words still go to Gemini). */
export function chipWords(selection: string) {
  return selection.length > LEARN_NODE.maxWords ? `${selection.slice(0, LEARN_NODE.maxWords - 1).trimEnd()}…` : selection;
}

/** A size for the selection chip that fits its text, wrapping at base × 14. */
export function selectionNodeSize(text: string, fontSize: number) {
  const k = fontSize / 20, pad = LEARN_NODE.padding * k, charWidth = fontSize * 0.56, lineHeight = fontSize * 1.25, inner = fontSize * LEARN_NODE.chipChars;
  const longest = Math.max(...text.split('\n').map(line => line.length));
  const width = Math.round(Math.min(inner, Math.max(fontSize * 3, longest * charWidth)) + pad * 2);
  const lines = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length * charWidth / inner)), 0);
  return { width, height: Math.round(lines * lineHeight + pad * 2) };
}

/** Source to chip: a plain elbow line. Chip to answer: an elbow line with an arrowhead. */
export const LEARN_SOURCE_LINE: DiagramEdgeSettings = { fromSide: 'right', toSide: 'left', route: 'elbow', startArrowhead: null, endArrowhead: null, doubleLine: false };
export const LEARN_EDGE: DiagramEdgeSettings = { ...LEARN_SOURCE_LINE, endArrowhead: 'arrow' };
export const learnEdgeStyle = (stroke = LEARN_NODE.stroke): DiagramStyle => ({ fill: 'transparent', stroke, width: LEARN_NODE.lineWidth, strokeStyle: 'solid' });
type Box = Pick<ExcalidrawElement, 'id' | 'x' | 'y' | 'width' | 'height' | 'isDeleted' | 'type'>;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: Box, gap: number) =>
  a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

/**
 * Where a new node goes to the right of `from`: level with its top, moved
 * down past anything already there (earlier Explain/Ask nodes included), so
 * repeated questions stack in a column instead of covering each other.
 * Lines (arrows) are ignored; they reroute when nodes move.
 */
export function placeRightOf(from: Pick<Box, 'x' | 'y' | 'width'>, size: { width: number; height: number }, elements: readonly Box[], gap = 56, spacing = 20) {
  const x = from.x + from.width + gap;
  const others = elements.filter(element => !element.isDeleted && element.type !== 'arrow' && element.type !== 'line');
  let y = from.y;
  for (let guard = 0; guard < 400; guard++) {
    const hit = others.filter(element => overlaps({ x, y, ...size }, element, spacing));
    if (!hit.length) break;
    y = Math.max(...hit.map(element => element.y + element.height)) + spacing;
  }
  return { x, y };
}
