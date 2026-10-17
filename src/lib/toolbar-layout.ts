export type FloatingToolbarGroup = 'actions' | 'drawing';
export interface ToolbarLayout { width: number; x?: number; y?: number; order: string[]; labels: boolean }
export const TOOLBAR_HEIGHT = 48;
export const TOOLBAR_MIN_WIDTH = 200;
const STORAGE_PREFIX = 'note-toolbar-layout-';

export function toolbarOrder(saved: unknown, ids: readonly string[]): string[] {
  const valid = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && ids.includes(id)) : [];
  return [...new Set([...valid, ...ids])];
}
export function toolbarDefaults(group: FloatingToolbarGroup, ids: readonly string[]): ToolbarLayout {
  return { width: group === 'actions' ? 760 : 640, order: [...ids], labels: group === 'actions' };
}
export function readToolbarLayout(group: FloatingToolbarGroup, ids: readonly string[]): ToolbarLayout {
  const defaults = toolbarDefaults(group, ids);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + group) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
    return {
      width: Number.isFinite(saved.width) ? Math.max(TOOLBAR_MIN_WIDTH, Math.min(1600, saved.width)) : defaults.width,
      ...(Number.isFinite(saved.x) ? { x: Math.max(8, saved.x) } : {}),
      ...(Number.isFinite(saved.y) ? { y: Math.max(8, saved.y) } : {}),
      order: toolbarOrder(saved.order, ids), labels: typeof saved.labels === 'boolean' ? saved.labels : defaults.labels,
    };
  } catch { return defaults; }
}
export function saveToolbarLayout(group: FloatingToolbarGroup, layout: ToolbarLayout): void {
  try { localStorage.setItem(STORAGE_PREFIX + group, JSON.stringify(layout)); } catch { /* Still usable without storage. */ }
}
export function toolbarBounds(layout: ToolbarLayout, group: FloatingToolbarGroup, board: { width: number; height: number; mobile: boolean }) {
  const available = Math.max(0, board.width - 16);
  const width = Math.min(layout.width, available);
  const left = !board.mobile && board.width > 780 ? 216 : 8;
  const right = !board.mobile && board.width > 780 ? 112 : 8;
  const defaultX = Math.max(left, (board.width - width + left - right) / 2);
  return {
    width,
    x: Math.max(8, Math.min(layout.x ?? defaultX, Math.max(8, board.width - width - 8))),
    y: Math.max(8, Math.min(layout.y ?? (group === 'actions' ? 12 : 68), Math.max(8, board.height - TOOLBAR_HEIGHT - 8))),
  };
}
export function visibleToolbarItems(widths: readonly number[], available: number, gap = 3): number {
  let used = 0, count = 0;
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width;
    if (next > available) break;
    used = next; count++;
  }
  return count;
}
export function moveToolbarItem(order: readonly string[], id: string, delta: number): string[] {
  const next = [...order], index = next.indexOf(id), target = index + delta;
  if (index >= 0 && target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
}
