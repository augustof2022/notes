import { describe, expect, it } from 'vitest';
import { clearDriveLease, readDriveLease, writeDriveLease, type DriveAccessLease } from './drive-cache';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const now = Date.parse('2026-10-23T12:00:00Z');
const lease: DriveAccessLease = { owner: 'note-a', subject: 'google-a', token: 'test-short-lived-access', expiresAt: now + 3600000, renewable: true };

describe('short-lived Drive access cache', () => {
  it('preserves the absolute expiry across reloads without extending access', () => {
    const disk = storage();
    writeDriveLease('drive', lease, disk);
    expect(readDriveLease('drive', 'note-a', 'google-a', disk, now + 1800000)).toEqual(lease);
    expect(readDriveLease('drive', 'note-a', 'google-a', disk, lease.expiresAt)).toBeNull();
    expect(disk.getItem('drive')).toBeNull();
  });
  it.each([['note-b', 'google-a'], ['note-a', 'google-b']])('rejects a lease belonging to %s / %s', (owner, subject) => {
    const disk = storage(); writeDriveLease('drive', lease, disk);
    expect(readDriveLease('drive', owner, subject, disk, now)).toBeNull();
    expect(disk.getItem('drive')).toBeNull();
  });
  it('rejects corrupt or implausibly long cached access windows', () => {
    const disk = storage(); disk.setItem('drive', '{broken');
    expect(readDriveLease('drive', 'note-a', 'google-a', disk, now)).toBeNull();
    writeDriveLease('drive', { ...lease, expiresAt: now + 86400000 }, disk);
    expect(readDriveLease('drive', 'note-a', 'google-a', disk, now)).toBeNull();
  });
  it('can forget credentials and tolerates unavailable browser storage', () => {
    const disk = storage(); writeDriveLease('drive', lease, disk); clearDriveLease('drive', disk);
    expect(disk.getItem('drive')).toBeNull();
    const blocked = { getItem: () => { throw new Error('Storage disabled'); }, setItem: () => { throw new Error('Storage disabled'); }, removeItem: () => { throw new Error('Storage disabled'); } };
    expect(() => writeDriveLease('drive', lease, blocked)).not.toThrow();
    expect(() => clearDriveLease('drive', blocked)).not.toThrow();
    expect(readDriveLease('drive', 'note-a', 'google-a', blocked, now)).toBeNull();
  });
});
