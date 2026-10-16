import { SORT_OPTIONS, type LibrarySort as Sort } from '../lib/library-sort';

export function LibrarySort({ kind, value, onChange }: { kind: 'folders' | 'boards'; value: Sort; onChange: (value: Sort) => void }) {
  return <label className="library-sort"><span>Sort {kind}</span><select aria-label={`Sort ${kind}`} value={value} onChange={event => onChange(event.target.value as Sort)}>
    {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}
