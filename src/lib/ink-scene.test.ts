import { afterEach, expect, it, vi } from 'vitest';
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({ newElementWith: (element: object, updates: object) => ({ ...element, ...updates }), convertToExcalidrawElements: (elements: object[]) => elements.map(element => ({ id: 'shape', ...element })) }));
import { cleanShapeFromInk, eraseInkElements, readWritingPreferences } from './ink-scene';
const stroke = { id: 'ink', type: 'freedraw', x: 0, y: 0, angle: 0, width: 100, height: 0, points: [[0, 0], [100, 0]], pressures: [0.5, 0.5], simulatePressure: false, strokeWidth: 2, strokeColor: '#123456', opacity: 70, groupIds: [], customData: { noteHandwriting: { text: 'stale' }, other: 'keep' } } as unknown as ExcalidrawFreeDrawElement;
afterEach(() => vi.unstubAllGlobals());
it('splits touched ink without changing locked ink, other objects, or original input', () => {
  const locked = { ...stroke, id: 'locked', locked: true }, text = { id: 'text', type: 'text' } as ExcalidrawElement;
  const result = eraseInkElements([stroke, locked, text], [50, -10], [50, 10], 5)!;
  expect(result).toHaveLength(4); expect(result[0].id).toBe(stroke.id); expect(result[1].id).not.toBe(stroke.id);
  expect(result[0].customData).toEqual({ other: 'keep' }); expect(result[0].strokeColor).toBe(stroke.strokeColor);
  expect(result[2]).toBe(locked); expect(result[3]).toBe(text); expect(stroke.points).toEqual([[0, 0], [100, 0]]);
  expect(eraseInkElements([locked, text], [50, 0], [50, 0], 20)).toBeNull();
});
it('preserves pen styling and group/frame membership when correcting a shape', () => {
  const result = cleanShapeFromInk({ ...stroke, groupIds: ['group'], frameId: 'frame' }, { kind: 'ellipse', label: 'Circle', x: 10, y: 20, width: 80, height: 80, angle: 0 });
  expect(result).toMatchObject({ type: 'ellipse', roughness: 0, strokeColor: '#123456', strokeWidth: 2, opacity: 70, groupIds: ['group'], frameId: 'frame', backgroundColor: 'transparent' });
  expect(result.customData).toEqual({ other: 'keep', noteHoldShape: { kind: 'ellipse' } });
});
it('loads saved writing choices safely and clamps unusable eraser sizes', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{"eraserMode":"object","eraserSize":1000,"holdShapes":false}' });
  expect(readWritingPreferences()).toEqual({ eraserMode: 'object', eraserSize: 96, holdShapes: false });
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); } });
  expect(readWritingPreferences()).toEqual({ eraserMode: 'partial', eraserSize: 24, holdShapes: true });
});
