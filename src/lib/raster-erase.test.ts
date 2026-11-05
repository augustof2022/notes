import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({ newElementWith: (element: any, patch: object) => ({ ...element, ...patch, version: element.version + 1 }), convertToExcalidrawElements: vi.fn(), exportToCanvas: vi.fn(), getCommonBounds: vi.fn() }));
import { applyErasedObjects, eraseBounds, eraseRenderScale, intersectsErase, type RasterEraseResult } from './raster-erase';

describe('image cutout erasing', () => {
  it('bounds a swept circular brush and scales rendering within the memory budget', () => {
    const bounds = eraseBounds([{ from: [10, 20], to: [100, 40], radius: 5 }]);
    expect(bounds).toEqual([5, 15, 105, 45]); expect(intersectsErase([90, 30, 120, 60], bounds)).toBe(true); expect(intersectsErase([200, 30, 220, 60], bounds)).toBe(false);
    const scale = eraseRenderScale(10000, 5000); expect(10000 * scale).toBeLessThanOrEqual(8192); expect(10000 * 5000 * scale * scale).toBeLessThanOrEqual(8 * 1024 * 1024 + 0.01);
    expect(eraseRenderScale(100, 100)).toBe(4);
  });
  it('commits a family together and preserves unrelated objects and concurrent edits', () => {
    const a = { id: 'a', type: 'rectangle', version: 1, versionNonce: 1 }, label = { id: 'label', type: 'text', version: 2, versionNonce: 2 }, other = { id: 'other', type: 'ellipse', version: 5, versionNonce: 5 };
    const image = { ...a, type: 'image', version: 2 }, deleted = { ...label, isDeleted: true };
    const result: RasterEraseResult = { objects: [{ before: [a, label] as ExcalidrawElement[], after: new Map([['a', image], ['label', deleted]]) as unknown as Map<string, ExcalidrawElement>, converted: true }], skipped: 0 };
    const applied = applyErasedObjects([a, label, other] as ExcalidrawElement[], result);
    expect(applied.elements).toEqual([image, deleted, other]); expect(applied.converted).toBe(true); expect(applied.elements[2]).toBe(other);
    const changedLabel = { ...label, versionNonce: 99 };
    const concurrent = applyErasedObjects([a, changedLabel, other] as ExcalidrawElement[], result);
    expect(concurrent.changed).toBe(false); expect(concurrent.skipped).toBe(1); expect(concurrent.elements).toEqual([a, changedLabel, other]);
  });
  it('removes both stale connector references without overwriting other bindings', () => {
    const arrows = ['a', 'b'].map(id => ({ id, type: 'arrow', version: 1, versionNonce: 1 })), shape = { id: 'shape', type: 'rectangle', version: 2, boundElements: [{ id: 'a', type: 'arrow' }, { id: 'b', type: 'arrow' }, { id: 'keep', type: 'arrow' }] };
    const result = { objects: arrows.map(arrow => ({ before: [arrow], after: new Map([[arrow.id, { ...arrow, type: 'image', version: 2 }]]), converted: true, detachedArrow: arrow.id })), skipped: 0 } as unknown as RasterEraseResult;
    const applied = applyErasedObjects([...arrows, shape] as ExcalidrawElement[], result);
    expect(applied.elements.at(-1)?.boundElements).toEqual([{ id: 'keep', type: 'arrow' }]);
  });
});
