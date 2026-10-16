import { describe, expect, it } from 'vitest';
import { sortRecords } from './library-sort';

const records = [
  { id: 'c', name: 'zebra', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
  { id: 'b', name: 'Board 10', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'a', name: 'board 2', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
];
describe('library sorting', () => {
  it('sorts names naturally in both directions without mutating the library', () => {
    expect(sortRecords(records, 'name-asc').map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(sortRecords(records, 'name-desc').map(x => x.id)).toEqual(['c', 'b', 'a']);
    expect(records.map(x => x.id)).toEqual(['c', 'b', 'a']);
  });
  it('keeps creation order separate from modification order in either direction', () => {
    expect(sortRecords(records, 'created-asc').map(x => x.id)).toEqual(['c', 'b', 'a']);
    expect(sortRecords(records, 'created-desc').map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(sortRecords(records, 'modified-asc').map(x => x.id)).toEqual(['b', 'a', 'c']);
    expect(sortRecords(records, 'modified-desc').map(x => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('uses the earliest known date for legacy records and breaks ties consistently', () => {
    const legacy = { id: 'legacy', name: 'Legacy', updatedAt: '2025-01-01T00:00:00Z' };
    expect(sortRecords([...records, legacy], 'created-asc')[0]).toBe(legacy);
    const ties = [{ ...records[0], id: 'b' }, { ...records[0], id: 'a' }];
    expect(sortRecords(ties, 'modified-desc').map(x => x.id)).toEqual(['a', 'b']);
  });
});
