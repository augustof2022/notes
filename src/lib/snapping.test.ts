import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db, newBoard } from './db';
import { DEFAULT_GRID_SIZE, gridSize, nextSnapMode, restoreSnapping, snapMode, snapState } from './snapping';

afterEach(async () => { await db.boards.clear(); });

describe('board snapping preferences', () => {
  it('cycles Off → Elements → Grid → Off, preserving size with exclusive modes', () => {
    let state = snapState('off', 12);
    for (const mode of ['elements', 'grid', 'off'] as const) {
      state = snapState(nextSnapMode(snapMode(state)), state.gridSize);
      expect(state).toEqual({ objectsSnapModeEnabled: mode === 'elements', gridModeEnabled: mode === 'grid', gridSize: 12 });
    }
  });
  it('restores legacy boards without inheriting another board’s mode', () => {
    expect(restoreSnapping({})).toEqual(snapState('off'));
    expect(restoreSnapping({ gridModeEnabled: true, gridSize: 8 })).toEqual(snapState('grid', 8));
    expect(restoreSnapping({ objectsSnapModeEnabled: true })).toEqual(snapState('elements'));
    expect(restoreSnapping({ objectsSnapModeEnabled: true, gridModeEnabled: true })).toEqual(snapState('grid'));
  });
  it('uses supported integer grid sizes and safely handles malformed saved values', () => {
    expect(gridSize(0)).toBe(1); expect(gridSize(101)).toBe(100); expect(gridSize(7.6)).toBe(8);
    expect(gridSize(NaN)).toBe(DEFAULT_GRID_SIZE); expect(gridSize(Infinity)).toBe(DEFAULT_GRID_SIZE);
    expect(restoreSnapping({ gridSize: -5 }).gridSize).toBe(1);
  });
  it('stores mode and grid size separately for each board without changing its elements', async () => {
    const first = await newBoard('local', 'First', null), second = await newBoard('local', 'Second', null);
    expect(first.appState).toMatchObject(snapState('off'));
    await db.boards.update(first.key, { appState: { ...first.appState, ...snapState('elements', 8) } });
    await db.boards.update(second.key, { appState: { ...second.appState, ...snapState('grid', 40) } });
    expect(restoreSnapping((await db.boards.get(first.key))!.appState)).toEqual(snapState('elements', 8));
    expect(restoreSnapping((await db.boards.get(second.key))!.appState)).toEqual(snapState('grid', 40));
    expect((await db.boards.get(first.key))!.elements).toEqual(first.elements);
  });
});
