import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAMP_ICONS as LEGACY_STAMP_ICONS } from './icon-stamps';
import {
  DEFAULT_STAMP_PREFERENCES, filterVectorStampIcons, getStampIcon, normalizeStampPreferences, readIconStampData,
  readStampPreferences, STAMP_CATEGORIES, STAMP_ICONS, STAMP_STORAGE_KEY, storeStampPreferences,
} from './vector-stamps';

afterEach(() => vi.unstubAllGlobals());

describe('semantic icon stamp catalog', () => {
  it('provides distinct reusable meanings with complete, finite native geometry', () => {
    expect(STAMP_ICONS.length).toBeGreaterThanOrEqual(32);
    expect(new Set(STAMP_ICONS.map(icon => icon.id)).size).toBe(STAMP_ICONS.length);
    expect(new Set(STAMP_ICONS.map(icon => icon.label)).size).toBe(STAMP_ICONS.length);
    expect(STAMP_ICONS.map(icon => icon.id)).toEqual(expect.arrayContaining(['clarify', 'remember', 'research', 'done', 'priority', 'experiment', 'team', 'follow-up']));
    for (const icon of STAMP_ICONS) {
      expect(icon.label.length).toBeGreaterThan(1);
      expect(icon.description.length).toBeGreaterThan(10);
      expect(STAMP_CATEGORIES).toContain(icon.category);
      expect(icon.defaultColor).toMatch(/^#[\da-f]{6}$/i);
      expect(icon.geometry.length).toBeGreaterThan(0);
      for (const geometry of icon.geometry) {
        const points = geometry.type === 'line' ? geometry.points : [[geometry.x, geometry.y], [geometry.x + geometry.width, geometry.y + geometry.height]];
        if (geometry.type === 'line') expect(points.length).toBeGreaterThanOrEqual(2);
        else { expect(geometry.width).toBeGreaterThan(0); expect(geometry.height).toBeGreaterThan(0); }
        for (const point of points) for (const coordinate of point) {
          expect(Number.isFinite(coordinate), `${icon.id} has a non-finite coordinate`).toBe(true);
          expect(coordinate, `${icon.id} exceeds the shared viewBox`).toBeGreaterThanOrEqual(0);
          expect(coordinate, `${icon.id} exceeds the shared viewBox`).toBeLessThanOrEqual(24);
        }
      }
    }
    expect(getStampIcon('unknown').id).toBe('clarify');
  });

  it('recognizes stamp metadata and rejects ordinary, incomplete and malformed objects', () => {
    const stamp = { id: 'stamp-instance', iconId: 'research', label: 'Research' };
    expect(readIconStampData({ customData: { noteIconStamp: stamp } })).toBe(stamp);
    for (const value of [null, undefined, [], 'research', {}, { ...stamp, id: '' }, { ...stamp, iconId: 'missing' }, { ...stamp, label: '' }]) {
      expect(readIconStampData({ customData: { noteIconStamp: value } })).toBeNull();
    }
    expect(readIconStampData({})).toBeNull();
  });
});

describe('last-used icon stamp preferences', () => {
  it('retains every legacy icon choice and its single-stamp preference', () => {
    for (const icon of LEGACY_STAMP_ICONS) {
      const restored = normalizeStampPreferences({ iconId: icon.id, color: '#123456', size: 72, repeat: false });
      expect(restored).toMatchObject({ color: '#123456', size: 72, repeat: false });
      if (icon.id !== 'clarify') expect(restored.iconId).not.toBe('clarify');
    }
    expect(filterVectorStampIcons('magnifying glass').map(icon => icon.id)).toContain('research');
    expect(filterVectorStampIcons('?').map(icon => icon.id)).toContain('clarify');
  });
  it('restores a valid last-used icon, color and size while normalizing unsafe values', () => {
    expect(normalizeStampPreferences(null)).toEqual(DEFAULT_STAMP_PREFERENCES);
    expect(normalizeStampPreferences({ iconId: 'research', color: '#abc', size: 72 })).toEqual({ iconId: 'research', color: '#abc', size: 72, repeat: true });
    expect(normalizeStampPreferences({ iconId: 'unknown', color: 'url(javascript:bad)', size: Number.NaN })).toEqual(DEFAULT_STAMP_PREFERENCES);
    expect(normalizeStampPreferences({ iconId: 'research', color: 'transparent', size: -1 })).toEqual({ iconId: 'research', color: '#1971c2', size: 24, repeat: true });
    expect(normalizeStampPreferences({ size: 10000 }).size).toBe(160);
    expect(normalizeStampPreferences({ size: Number.POSITIVE_INFINITY }).size).toBe(48);
    expect(normalizeStampPreferences({ size: '96' }).size).toBe(48);
  });

  it('persists a normalized copy and returns independent default objects when storage is blocked', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    const preferences = { iconId: 'research', color: '#123456', size: 96, repeat: false };
    storeStampPreferences(preferences);
    preferences.iconId = 'idea';
    expect(readStampPreferences()).toEqual({ iconId: 'research', color: '#123456', size: 96, repeat: false });
    storage.set(STAMP_STORAGE_KEY, '{broken');
    expect(readStampPreferences()).toEqual(DEFAULT_STAMP_PREFERENCES);
    storage.set(STAMP_STORAGE_KEY, '[]');
    expect(readStampPreferences()).toEqual(DEFAULT_STAMP_PREFERENCES);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(() => storeStampPreferences(preferences)).not.toThrow();
    const a = readStampPreferences(), b = readStampPreferences();
    a.iconId = 'idea';
    expect(b).toEqual(DEFAULT_STAMP_PREFERENCES);
  });
});
