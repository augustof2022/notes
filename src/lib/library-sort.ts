export const LIBRARY_SORT_OPTIONS = [
  { value: 'name-asc', label: 'Name · A–Z' },
  { value: 'name-desc', label: 'Name · Z–A' },
  { value: 'created-desc', label: 'Created · newest first' },
  { value: 'created-asc', label: 'Created · oldest first' },
  { value: 'modified-desc', label: 'Modified · newest first' },
  { value: 'modified-asc', label: 'Modified · oldest first' },
] as const;
export type LibrarySort = typeof LIBRARY_SORT_OPTIONS[number]['value'];
export type LibrarySorts = { folders: LibrarySort; boards: LibrarySort };
export const DEFAULT_LIBRARY_SORTS: LibrarySorts = { folders: 'name-asc', boards: 'modified-desc' };
const STORAGE_KEY = 'note-library-sorts';
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function isLibrarySort(value: unknown): value is LibrarySort {
  return LIBRARY_SORT_OPTIONS.some(option => option.value === value);
}
export function readLibrarySorts(): LibrarySorts {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('note-library-sorting') || '{}');
    return { folders: isLibrarySort(value?.folders) ? value.folders : DEFAULT_LIBRARY_SORTS.folders, boards: isLibrarySort(value?.boards) ? value.boards : DEFAULT_LIBRARY_SORTS.boards };
  } catch { return { ...DEFAULT_LIBRARY_SORTS }; }
}
export function storeLibrarySorts(value: LibrarySorts) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Sorting still works when browser storage is unavailable. */ }
}
type SortableRecord = { id: string; name: string; updatedAt: string; createdAt?: string };
function timestamp(value: string | undefined) {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : null;
}
export function sortLibraryRecords<T extends SortableRecord>(records: readonly T[], sort: LibrarySort): T[] {
  const direction = sort.endsWith('asc') ? 1 : -1;
  return [...records].sort((a, b) => {
    const byName = names.compare(a.name, b.name);
    if (sort.startsWith('name')) return direction * byName || a.id.localeCompare(b.id);
    const aTime = sort.startsWith('created') ? timestamp(a.createdAt) ?? timestamp(a.updatedAt) : timestamp(a.updatedAt);
    const bTime = sort.startsWith('created') ? timestamp(b.createdAt) ?? timestamp(b.updatedAt) : timestamp(b.updatedAt);
    if (aTime === null || bTime === null) {
      if (aTime !== bTime) return aTime === null ? 1 : -1;
    } else if (aTime !== bTime) return direction * (aTime - bTime);
    return byName || a.id.localeCompare(b.id);
  });
}
