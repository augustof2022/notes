const STORAGE_KEY = 'note-board-toolbars-hidden';
const LEGACY_KEY = 'note-board-toolbars';

/**
 * Whether board toolbars are hidden on this browser. Earlier versions saved
 * four separate toolbar groups; hiding all of them now means hidden.
 */
export function readToolbarsHidden(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved === 'true';
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    return !!legacy && typeof legacy === 'object' && !Array.isArray(legacy) && Object.values(legacy).length > 0 && Object.values(legacy).every(value => value === false);
  } catch { return false; }
}

export function saveToolbarsHidden(hidden: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(hidden)); }
  catch { /* The current choice still applies without persistent storage. */ }
}
