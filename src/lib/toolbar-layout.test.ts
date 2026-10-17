import { describe, expect, it, vi, afterEach } from 'vitest';
import { moveToolbarItem, readToolbarLayout, saveToolbarLayout, toolbarBounds, toolbarDefaults, toolbarOrder, visibleToolbarItems } from './toolbar-layout';

afterEach(() => vi.unstubAllGlobals());
describe('toolbar layout', () => {
  it('keeps saved order, rejects unknown and duplicate IDs, and appends new controls', () => {
    expect(toolbarOrder(['c', 'missing', 'a', 'c', 5], ['a', 'b', 'c', 'new'])).toEqual(['c', 'a', 'b', 'new']);
    expect(toolbarOrder(null, ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('fits a prefix without clipping and accounts for the gaps', () => {
    expect(visibleToolbarItems([34, 60, 34], 97)).toBe(2);
    expect(visibleToolbarItems([34, 60, 34], 96)).toBe(1);
    expect(visibleToolbarItems([160, 34], 100)).toBe(0);
    expect(visibleToolbarItems([], 300)).toBe(0);
  });
  it('keeps positions and widths reachable when changing screen sizes', () => {
    const saved = { width: 760, x: 600, y: 700, labels: true, order: ['a'] };
    expect(toolbarBounds(saved, 'actions', { width: 320, height: 400, mobile: true })).toEqual({ width: 304, x: 8, y: 344 });
    expect(saved).toEqual({ width: 760, x: 600, y: 700, labels: true, order: ['a'] });
    const desktop = toolbarBounds(saved, 'drawing', { width: 1450, height: 1000, mobile: false });
    expect(desktop).toEqual({ width: 760, x: 600, y: 700 });
  });
  it('moves a control without losing entries and respects either end', () => {
    expect(moveToolbarItem(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveToolbarItem(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(moveToolbarItem(['a', 'b'], 'missing', 1)).toEqual(['a', 'b']);
  });
  it('reads valid preferences while repairing invalid values', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ width: 9999, x: -20, y: 'no', order: ['b', 'b'], labels: false }) });
    expect(readToolbarLayout('actions', ['a', 'b'])).toEqual({ width: 1600, x: 8, order: ['b', 'a'], labels: false });
  });
  it('uses defaults for invalid or blocked storage and allows saving without storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{', setItem: () => { throw new Error('blocked'); } });
    expect(readToolbarLayout('drawing', ['a'])).toEqual(toolbarDefaults('drawing', ['a']));
    expect(() => saveToolbarLayout('drawing', toolbarDefaults('drawing', ['a']))).not.toThrow();
  });
});
