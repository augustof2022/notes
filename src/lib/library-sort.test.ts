import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIBRARY_SORTS, readLibrarySorts, sortLibraryRecords, storeLibrarySorts } from './library-sort';

const records = [
  { id: 'a', name: 'Board 10', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
  { id: 'b', name: 'alpha', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
  { id: 'c', name: 'Board 2', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];
afterEach(() => vi.unstubAllGlobals());
describe('folder and board sorting', () => {
  it('sorts names naturally in both directions without changing source order', () => {
    expect(sortLibraryRecords(records, 'name-asc').map(x => x.id)).toEqual(['b', 'c', 'a']);
    expect(sortLibraryRecords(records, 'name-desc').map(x => x.id)).toEqual(['a', 'c', 'b']);
    expect(records.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('keeps creation order independent from edits and supports both date directions', () => {
    expect(sortLibraryRecords(records, 'created-asc').map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(sortLibraryRecords(records, 'created-desc').map(x => x.id)).toEqual(['c', 'b', 'a']);
    expect(sortLibraryRecords(records, 'modified-asc').map(x => x.id)).toEqual(['c', 'b', 'a']);
    expect(sortLibraryRecords(records, 'modified-desc').map(x => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('handles legacy dates, timezone offsets, and unknown dates consistently', () => {
    const items = [
      { id: 'z', name: 'Zulu', updatedAt: '2026-01-01T08:00:00+08:00' },
      { id: 'b', name: 'Beta', createdAt: 'invalid', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'u', name: 'Unknown', updatedAt: 'invalid' },
    ];
    for (const sort of ['created-asc', 'created-desc', 'modified-desc'] as const) expect(sortLibraryRecords(items, sort).map(x => x.id)).toEqual(['b', 'z', 'u']);
  });
  it('persists independent choices and falls back safely for malformed or blocked storage', () => {
    let saved: string | null = null;
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
    expect(readLibrarySorts()).toEqual(DEFAULT_LIBRARY_SORTS);
    storeLibrarySorts({ folders: 'created-asc', boards: 'name-desc' });
    expect(readLibrarySorts()).toEqual({ folders: 'created-asc', boards: 'name-desc' });
    saved = '{"folders":"invalid","boards":"name-asc"}';
    expect(readLibrarySorts()).toEqual({ folders: 'name-asc', boards: 'name-asc' });
    saved = 'null'; expect(readLibrarySorts()).toEqual(DEFAULT_LIBRARY_SORTS);
    saved = '{'; expect(readLibrarySorts()).toEqual(DEFAULT_LIBRARY_SORTS);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readLibrarySorts()).toEqual(DEFAULT_LIBRARY_SORTS);
    expect(() => storeLibrarySorts(DEFAULT_LIBRARY_SORTS)).not.toThrow();
  });
  it('retains sort choices saved by earlier releases', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'note-library-sorting' ? '{"folders":"created-asc","boards":"name-desc"}' : null });
    expect(readLibrarySorts()).toEqual({ folders: 'created-asc', boards: 'name-desc' });
  });
});
