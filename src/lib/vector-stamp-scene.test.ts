import { describe, expect, it, vi } from 'vitest';
// Inspect the real native skeletons without booting Excalidraw's browser renderer in Node.
vi.mock('@excalidraw/excalidraw', () => ({ convertToExcalidrawElements: (skeletons: object[]) => skeletons.map(skeleton => ({ ...skeleton })), mutateElement: (element: object, updates: object) => Object.assign(element, updates) }));
import { buildIconStampSkeletons, createIconStamp } from './vector-stamp-scene';
import { readIconStampData, STAMP_ICONS } from './vector-stamps';

describe('native icon stamp vectors', () => {
  it('creates one selectable group per stamp with meaningful metadata on every editable native piece', () => {
    for (const icon of STAMP_ICONS) {
      const pieces = createIconStamp(icon.id, { x: -120, y: 75 }, 72, '#123456');
      expect(pieces.length).toBe(icon.geometry.length);
      const instance = readIconStampData(pieces[0])!;
      expect(instance).toMatchObject({ iconId: icon.id, label: icon.label });
      expect(new Set(pieces.map(piece => piece.id)).size).toBe(pieces.length);
      for (const piece of pieces) {
        expect(['line', 'ellipse']).toContain(piece.type);
        expect(piece.groupIds).toEqual([instance.id]);
        expect(piece.customData).toEqual({ noteIconStamp: instance });
        expect(piece.strokeColor).toBe('#123456');
        expect(piece.backgroundColor).toBe('transparent');
        expect(piece.roughness).toBe(0);
        expect(piece).not.toHaveProperty('fileId');
        if (piece.type === 'line') {
          const xs = piece.points.map(point => point[0]), ys = piece.points.map(point => point[1]);
          expect(piece.width).toBeCloseTo(Math.max(...xs) - Math.min(...xs));
          expect(piece.height).toBeCloseTo(Math.max(...ys) - Math.min(...ys));
        }
      }
    }
  });

  it('centers authored geometry at any scene coordinate and scales every point without changing the catalog', () => {
    const before = JSON.stringify(STAMP_ICONS);
    const a = buildIconStampSkeletons('research', { x: 100, y: -200 }, 48);
    const b = buildIconStampSkeletons('research', { x: 100, y: -200 }, 96);
    const circleA = a[0], circleB = b[0];
    expect(circleA).toMatchObject({ type: 'ellipse', x: 82, y: -218, width: 26, height: 26 });
    expect(circleB).toMatchObject({ type: 'ellipse', x: 64, y: -236, width: 52, height: 52 });
    expect(b[1]).toMatchObject({ type: 'line', x: 110, y: -190, points: [[0, 0], [26, 26]] });
    expect(JSON.stringify(STAMP_ICONS)).toBe(before);
    expect(a[0].groupIds).not.toEqual(b[0].groupIds);
    (a[0].groupIds as string[]).push('modified');
    (a[0].customData!.noteIconStamp as { label: string }).label = 'Changed';
    expect(b[0].groupIds).toHaveLength(1);
    expect(readIconStampData(b[0])!.label).toBe('Research');
    expect(readIconStampData(a[1])!.label).toBe('Research');
  });

  it('uses usable defaults for unknown icons and invalid size/color and rejects non-finite positions', () => {
    const pieces = buildIconStampSkeletons('missing', { x: 0, y: 0 }, Number.NaN, 'transparent');
    expect(readIconStampData(pieces[0])!.iconId).toBe('clarify');
    expect(pieces[0].strokeColor).toBe('#9c36b5');
    expect(pieces[0].strokeWidth).toBeCloseTo(3.2);
    expect(() => createIconStamp('clarify', { x: Number.POSITIVE_INFINITY, y: 0 })).toThrow(RangeError);
  });
});
