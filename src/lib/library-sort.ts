import type { RecordBase } from '../types';

export const SORT_OPTIONS = [
  { value: 'name-asc', label: 'Name · A–Z' },
  { value: 'name-desc', label: 'Name · Z–A' },
  { value: 'created-desc', label: 'Created · newest first' },
  { value: 'created-asc', label: 'Created · oldest first' },
  { value: 'modified-desc', label: 'Modified · newest first' },
  { value: 'modified-asc', label: 'Modified · oldest first' },
] as const;
export type LibrarySort = typeof SORT_OPTIONS[number]['value'];
export function isLibrarySort(value: unknown): value is LibrarySort {
  return SORT_OPTIONS.some(option => option.value === value);
}
export function sortRecords<T extends Pick<RecordBase, 'id' | 'name' | 'createdAt' | 'updatedAt'>>(records: readonly T[], sort: LibrarySort): T[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const timestamp = (record: T) => Date.parse((sort.startsWith('created') ? record.createdAt : undefined) || record.updatedAt) || 0;
  const direction = sort.endsWith('asc') ? 1 : -1;
  return [...records].sort((a, b) => {
    const difference = sort.startsWith('name') ? collator.compare(a.name, b.name) : timestamp(a) - timestamp(b);
    return difference * direction || collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}
