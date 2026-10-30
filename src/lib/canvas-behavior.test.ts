import { describe, expect, it } from 'vitest';
import type { ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import { constantInkUpdates, DEFAULT_PEN_WIDTH, penWidth, repairedSceneElements, stickyTextTool, viewLockCorrection } from './canvas-behavior';
import { handwritingLines, handwritingSignature, indexedHandwriting } from './handwriting-index';
import { searchBoards } from './search';
import type { Board, Folder, ViewLock } from '../types';
function stroke(id: string, x = 0, y = 0): ExcalidrawFreeDrawElement {
  return { id, type: 'freedraw', x, y, width: 30, height: 30, angle: 0, strokeWidth: 2, points: [[0, 0], [30, 30]], pressures: [0.01, 0.99], simulatePressure: false, isDeleted: false } as unknown as ExcalidrawFreeDrawElement;
}
describe('note canvas behavior', () => {
  it('keeps all pen points visible at a fixed pressure without changing geometry or selected weight', () => {
    const pen = stroke('ink'), result = { ...pen, ...constantInkUpdates(pen) };
    expect(result.pressures).toEqual([0.5, 0.5]); expect(result.simulatePressure).toBe(false);
    expect(result.points).toBe(pen.points); expect(result.strokeWidth).toBe(2);
    expect(constantInkUpdates(result)).toBeNull();
    expect(constantInkUpdates({ ...pen, simulatePressure: true, pressures: [] })?.pressures).toEqual([0.5, 0.5]);
  });
  it('keeps the active pen stroke in the scene as the native gesture appends points', () => {
    const pen = { ...stroke('drawing'), points: [[0, 0]], pressures: [], simulatePressure: true, width: 0, height: 0, version: 1 } as unknown as ExcalidrawFreeDrawElement;
    let elements = [pen];
    for (let point = 0; point < 10; point++) {
      const before = { ...pen };
      Object.assign(pen, constantInkUpdates(pen), { version: pen.version + 1 });
      elements = repairedSceneElements(elements, new Map([[pen, before]]), pen) as ExcalidrawFreeDrawElement[];
      expect(elements[0]).toBe(pen);
      expect(pen.simulatePressure).toBe(false);
      // Excalidraw appends to the object it held at pointer-down, rather than
      // looking the stroke up in the replacement scene on every pointer-move.
      Object.assign(pen, { points: [...pen.points, [(point + 1) * 10, (point + 1) * 5]], pressures: [...pen.pressures, 0.8], width: (point + 1) * 10, height: (point + 1) * 5 });
      expect(elements[0].points).toHaveLength(point + 2);
    }
    expect(elements[0]).toMatchObject({ width: 100, height: 50 });
  });
  it('finishes pen repairs immutably after release so normalization adds no extra Undo step', () => {
    const pen = { ...stroke('finished'), version: 1 }, before = { ...pen };
    Object.assign(pen, constantInkUpdates(pen), { version: 2 });
    const elements = repairedSceneElements([pen], new Map([[pen, before]]), null);
    expect(elements[0]).not.toBe(pen);
    expect(elements[0]).toMatchObject({ pressures: [0.5, 0.5], version: 2 });
    expect(elements[0].type === 'freedraw' && elements[0].points).toBe(before.points);
    expect(pen).toEqual(before);
  });
  it('locks only zoom and allows pan, including locks saved by the older app', () => {
    const lock = { zoom: { value: 1 as ViewLock['zoom']['value'] }, scrollX: 4, scrollY: 8 };
    const moved = { ...lock, scrollX: 100 };
    expect(viewLockCorrection(moved, lock)).toBeNull();
    expect(viewLockCorrection({ zoom: { value: 2 } } as ViewLock, lock)).toEqual({ zoom: lock.zoom });
    expect({ ...moved, ...viewLockCorrection({ zoom: { value: 2 } } as ViewLock, lock) }.scrollX).toBe(100);
    expect(viewLockCorrection(lock, lock)).toBeNull(); expect(viewLockCorrection(lock, null)).toBeNull();
  });
  it('accepts fractional widths and clamps the supported range with a writing default', () => {
    expect(penWidth(2.5)).toBe(2.5); expect(penWidth(0)).toBe(0.5); expect(penWidth(100)).toBe(12);
    expect(penWidth(NaN)).toBe(DEFAULT_PEN_WIDTH); expect(DEFAULT_PEN_WIDTH).toBe(1);
  });
  it('locks text mode, then releases the editor tool lock when choosing another tool', () => {
    const text = { type: 'text', locked: false } as AppState['activeTool'];
    expect(stickyTextTool(text, 'selection')?.locked).toBe(true);
    expect(stickyTextTool({ ...text, locked: true }, 'text')).toBeNull();
    expect(stickyTextTool({ type: 'selection', customType: null, lastActiveTool: null, locked: true }, 'text')?.locked).toBe(false);
  });
  it('preserves an explicitly locked custom stamp tool after leaving text mode', () => {
    const stamp = { type: 'custom', customType: 'note-icon-stamp', lastActiveTool: null, locked: true } as AppState['activeTool'];
    expect(stickyTextTool(stamp, 'text')).toBeNull();
    expect({ ...stamp, ...stickyTextTool(stamp, 'text') }).toEqual(stamp);
    expect(stickyTextTool({ ...stamp, locked: false }, 'text')).toBeNull();
  });
});
describe('handwriting search', () => {
  it('indexes reviewed words in a descendant folder and rejects changed or deleted handwriting', () => {
    const raw = stroke('a'), b = stroke('b', 40);
    const a = { ...raw, customData: { noteHandwriting: { text: 'TEST handwriting', strokeIds: ['a', 'b'], signature: handwritingSignature([raw, b]) } } };
    const board = { id: 'board', name: 'Notes', folderId: 'child', elements: [a, b], updatedAt: '2026-10-11' } as unknown as Board;
    const folders = [{ id: 'parent', parentId: null }, { id: 'child', parentId: 'parent' }] as Folder[];
    expect(searchBoards([board], folders, [], 'test', 'parent')[0]?.kind).toBe('handwriting');
    expect(indexedHandwriting(a, [a, { ...b, x: 42 }])).toBe('');
    expect(indexedHandwriting(a, [a, { ...b, isDeleted: true }])).toBe('');
    expect(indexedHandwriting(a, [a])).toBe('');
  });
  it('groups nearby strokes into rows and respects a handwriting selection', () => {
    const strokes = [stroke('a'), stroke('b', 40), stroke('c', 0, 100)];
    expect(handwritingLines(strokes).map(x => x.map(s => s.id))).toEqual([['a', 'b'], ['c']]);
    expect(handwritingLines(strokes, { b: true }).map(x => x.map(s => s.id))).toEqual([['b']]);
  });
});
