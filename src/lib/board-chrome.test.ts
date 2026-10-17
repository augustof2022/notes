import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_CHROME_DEFAULTS, readBoardChrome, saveBoardChrome } from './board-chrome';

afterEach(() => vi.unstubAllGlobals());

describe('board toolbar preferences', () => {
  it('remembers hidden groups while treating invalid or new preferences as visible', () => {
    let saved = JSON.stringify({ actions: false, drawing: false, navigation: 'false', unrelated: true });
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
    expect(readBoardChrome()).toEqual({ actions: false, drawing: false, navigation: true, editing: true });
    const hidden = { actions: false, drawing: false, navigation: false, editing: false };
    saveBoardChrome(hidden);
    expect(readBoardChrome()).toEqual(hidden);
    saved = 'not valid JSON';
    expect(readBoardChrome()).toEqual(BOARD_CHROME_DEFAULTS);
  });

  it('keeps controls usable when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readBoardChrome()).toEqual(BOARD_CHROME_DEFAULTS);
    expect(() => saveBoardChrome({ ...BOARD_CHROME_DEFAULTS, editing: false })).not.toThrow();
  });
});
