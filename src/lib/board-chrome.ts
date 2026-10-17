export type BoardChromeGroup = 'actions' | 'drawing' | 'navigation' | 'editing';
export type BoardChromeVisibility = Record<BoardChromeGroup, boolean>;

const STORAGE_KEY = 'note-board-toolbars';
export const BOARD_CHROME_DEFAULTS: BoardChromeVisibility = { actions: true, drawing: true, navigation: true, editing: true };

export function readBoardChrome(): BoardChromeVisibility {
  const next = { ...BOARD_CHROME_DEFAULTS };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const group of Object.keys(next) as BoardChromeGroup[]) {
        const value = (saved as Record<string, unknown>)[group];
        if (typeof value === 'boolean') next[group] = value;
      }
    }
  } catch { /* Toolbars remain usable when browser storage is unavailable. */ }
  return next;
}

export function saveBoardChrome(visibility: BoardChromeVisibility): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility)); }
  catch { /* The current layout still applies without persistent storage. */ }
}
