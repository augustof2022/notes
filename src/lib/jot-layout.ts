export type JotRelation = 'child' | 'sibling';
export interface JotLevel { level: number; step: number }
interface JotBox { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; customData?: Record<string, any> | null }
interface JotText extends JotBox { fontSize: number }

/** Outline level and indent step of a standalone text; ordinary text is level 0. */
export function jotLevel(text: Pick<JotText, 'fontSize' | 'customData'>): JotLevel {
  const data = text.customData?.noteJot, step = Math.max(12, Math.round(text.fontSize * 1.5));
  return data && Number.isInteger(data.level) && data.level >= 0 && Number.isFinite(data.step) && data.step > 0 ? { level: data.level, step: data.step } : { level: 0, step };
}

/**
 * Where Tab (child) or Shift+Tab (sibling) puts the next note: directly below
 * the current one, indented one step for a child, skipping past other text
 * already in that spot. Each note stays a separate object; only its level
 * is remembered so later notes and indent changes line up.
 */
export function jotPlacement(source: JotText, relation: JotRelation, elements: readonly JotBox[]) {
  const { level, step } = jotLevel(source), nextLevel = relation === 'child' ? level + 1 : level;
  const x = source.x + (nextLevel - level) * step, gap = Math.round(source.fontSize * 0.45), lineHeight = source.fontSize * 1.35;
  let y = source.y + source.height + gap;
  const others = elements.filter(element => !element.isDeleted && element.id !== source.id && (element.type === 'text' || element.customData?.noteRichTextRender));
  for (let guard = 0; guard < 200; guard++) {
    const blocking = others.filter(element => element.y < y + lineHeight && element.y + element.height > y && element.x < x + 200 && element.x + element.width > x);
    if (!blocking.length) break;
    y = Math.max(...blocking.map(element => element.y + element.height)) + gap;
  }
  return { x, y, jot: { level: nextLevel, step } };
}

/** Move a note one level in (1) or out (-1); null when it is already at the left edge. */
export function jotIndent(text: Pick<JotText, 'x' | 'fontSize' | 'customData'>, delta: 1 | -1) {
  const { level, step } = jotLevel(text), next = level + delta;
  if (next < 0) return null;
  return { x: text.x + delta * step, jot: { level: next, step } };
}
