export const ICON_STAMP_TOOL = 'note-icon-stamp';

export function isStampTool(tool: { type: string; customType?: string | null }) {
  return tool.type === 'custom' && tool.customType === ICON_STAMP_TOOL;
}

export function isStampShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean }) {
  return event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.repeat && !event.isComposing && !event.defaultPrevented;
}

export function stampScenePoint(point: { x: number; y: number }, state: { offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number; zoom: { value: number } }) {
  return { x: (point.x - state.offsetLeft) / state.zoom.value - state.scrollX,
    y: (point.y - state.offsetTop) / state.zoom.value - state.scrollY };
}

/** Snap the actual vector group's bounds, including its authored glyph padding. */
export function stampGridTranslation(elements: readonly { x: number; y: number }[], size: number) {
  if (!elements.length || !Number.isFinite(size) || size <= 0) return { x: 0, y: 0 };
  const x = Math.min(...elements.map(element => element.x)), y = Math.min(...elements.map(element => element.y));
  return { x: Math.round(x / size) * size - x, y: Math.round(y / size) * size - y };
}
