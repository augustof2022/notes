import { LIBRARY_SORT_OPTIONS, type LibrarySort as SortValue } from '../lib/library-sort';

export function LibrarySort({ label, value, onChange }: { label: string; value: SortValue; onChange: (value: SortValue) => void }) {
  return <select className="library-sort" aria-label={label} value={value} onChange={event => onChange(event.target.value as SortValue)}>
    {LIBRARY_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
