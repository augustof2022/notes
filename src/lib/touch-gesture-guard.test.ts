import { expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'NEVER' },
  newElementWith: (element: object, patch: object) => ({ ...element, ...patch, version: (element as { version: number }).version + 1 }),
}));
import { revertFirstFingerEdits } from './touch-gesture-guard';

const label = (patch: object = {}) => ({ id: 'label', type: 'text', x: 321, y: 307, width: 38, height: 22, fontSize: 13.3, version: 4, versionNonce: 1, ...patch }) as unknown as ExcalidrawElement;

it('restores objects a pinch’s first finger resized before the zoom began', () => {
  const before = label(), snapshot = new Map([[before.id, { ...before }]]);
  const resized = label({ x: 330, y: 289, width: 26, fontSize: 10.7, version: 9, versionNonce: 7 });
  const [restored] = revertFirstFingerEdits([resized], snapshot)!;
  expect(restored).toMatchObject({ x: 321, y: 307, width: 38, fontSize: 13.3 });
  // A fresh version keeps the editor and sync treating the restore as newest.
  expect(restored.version).toBeGreaterThan(resized.version);
});

it('leaves an untouched scene and newly drawn elements alone', () => {
  const before = label(), snapshot = new Map([[before.id, { ...before }]]);
  expect(revertFirstFingerEdits([before], snapshot)).toBeNull();
  const stroke = { id: 'stroke', type: 'freedraw', version: 1, versionNonce: 2 } as unknown as ExcalidrawElement;
  expect(revertFirstFingerEdits([before, stroke], snapshot)).toBeNull();
});
