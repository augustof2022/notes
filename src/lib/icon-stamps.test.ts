import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAMP, filterStampIcons, isStampShortcut, readStampPreferences, saveStampPreferences, stampPosition } from './icon-stamps';

afterEach(() => vi.unstubAllGlobals());
describe('icon stamps', () => {
  it('finds icons by symbol, intent and keywords', () => {
    expect(filterStampIcons('?').map(icon => icon.id)).toEqual(['clarify']);
    expect(filterStampIcons('!').map(icon => icon.id)).toEqual(['remember']);
    expect(filterStampIcons('magnifying glass').map(icon => icon.id)).toEqual(['research']);
    expect(filterStampIcons('task').map(icon => icon.id)).toContain('todo');
    expect(filterStampIcons('no such icon')).toEqual([]);
  });
  it('remembers the last icon, color, size and repeat mode after reload', () => {
    let saved = '';
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
    const value = { iconId: 'research', color: '#2563eb', size: 72, repeat: true };
    saveStampPreferences(value);
    expect(readStampPreferences()).toEqual(value);
    saved = JSON.stringify({ iconId: 'missing-icon', color: 'url(unsafe)', size: -300, repeat: 'true' });
    expect(readStampPreferences()).toEqual({ ...DEFAULT_STAMP, size: 24 });
    saved = 'null'; expect(readStampPreferences()).toEqual(DEFAULT_STAMP);
    saved = 'not json'; expect(readStampPreferences()).toEqual(DEFAULT_STAMP);
  });
  it('still works when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(readStampPreferences()).toEqual(DEFAULT_STAMP);
    expect(() => saveStampPreferences(DEFAULT_STAMP)).not.toThrow();
  });
  it('does not replace modified shortcuts, composition, or repeated keydown events', () => {
    const event = { key: 'i', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false };
    expect(isStampShortcut(event)).toBe(true);
    expect(isStampShortcut({ ...event, key: 'I' })).toBe(true);
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented'] as const) expect(isStampShortcut({ ...event, [flag]: true })).toBe(false);
  });
  it('centers the icon at the click after panning and zooming, including a shifted editor', () => {
    expect(stampPosition({ x: 450, y: 350 }, { offsetLeft: 250, offsetTop: 50, scrollX: -20, scrollY: 40, zoom: { value: 2 } }, 48)).toEqual({ x: 96, y: 86 });
  });
});
