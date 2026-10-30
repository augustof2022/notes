import { describe, expect, it } from 'vitest';
import { slashMatch, textCommands, textPopupPosition } from './text-commands';

describe('inline text commands', () => {
  it('finds the slash range without removing preceding text', () => {
    expect(slashMatch('/h2', 4)).toEqual({ from: 1, to: 4, query: 'h2' });
    expect(slashMatch('A thought /heading 2', 20)).toEqual({ from: 10, to: 20, query: 'heading 2' });
    expect(slashMatch('/', 1)).toEqual({ from: 0, to: 1, query: '' });
  });
  it('leaves URLs, paths, prose and code alone', () => {
    for (const text of ['https://example.com', '/usr/bin', 'a/b', '2026/10/30', 'No slash here']) expect(slashMatch(text, text.length)).toBeNull();
    expect(slashMatch('/h2', 4, true)).toBeNull();
  });
  it('searches by heading shorthand and ordinary formatting names', () => {
    expect(textCommands('h2').map(command => command.id)).toEqual(['h2']);
    expect(textCommands('heading 2').map(command => command.id)).toEqual(['h2']);
    expect(textCommands('bullet').map(command => command.id)).toEqual(['bullet']);
    expect(textCommands('UNDERLINE').map(command => command.id)).toEqual(['underline']);
    expect(textCommands('check list').map(command => command.id)).toEqual(['check']);
    expect(textCommands('no such command')).toEqual([]);
  });
  it('offers the requested styles without an editor window', () => {
    expect(textCommands('').map(command => command.id)).toEqual(expect.arrayContaining(['h1', 'h2', 'h3', 'bullet', 'number', 'bold', 'italic', 'underline']));
  });
  it('places a caret menu below text when it fits', () => {
    expect(textPopupPosition({ left: 50, top: 100, bottom: 120 }, { width: 270, height: 300 }, { width: 800, height: 600 })).toEqual({ left: 50, top: 126 });
  });
  it('keeps menus visible at the edge of a phone keyboard viewport', () => {
    const p = textPopupPosition({ left: 300, top: 450, bottom: 475 }, { width: 270, height: 300 }, { width: 320, height: 500 });
    expect(p).toEqual({ left: 42, top: 144 });
    const shifted = textPopupPosition({ left: 0, top: 30, bottom: 50 }, { width: 270, height: 42 }, { width: 320, height: 400, top: 20 }, true);
    expect(shifted).toEqual({ left: 8, top: 56 });
  });
});
