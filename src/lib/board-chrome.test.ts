import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolbarsHidden, saveToolbarsHidden } from './board-chrome';

afterEach(() => vi.unstubAllGlobals());
const storage = (values: Record<string, string>) => vi.stubGlobal('localStorage', { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } });

describe('hidden board toolbars', () => {
  it('remembers the choice and carries over a fully hidden layout from older versions', () => {
    const values: Record<string, string> = {}; storage(values);
    expect(readToolbarsHidden()).toBe(false);
    saveToolbarsHidden(true); expect(readToolbarsHidden()).toBe(true);
    storage({ 'note-board-toolbars': JSON.stringify({ actions: false, drawing: false, navigation: false, editing: false }) });
    expect(readToolbarsHidden()).toBe(true);
    storage({ 'note-board-toolbars': JSON.stringify({ actions: false, drawing: true }) });
    expect(readToolbarsHidden()).toBe(false);
  });

  it('keeps toolbars visible when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readToolbarsHidden()).toBe(false);
    expect(() => saveToolbarsHidden(true)).not.toThrow();
  });
});
