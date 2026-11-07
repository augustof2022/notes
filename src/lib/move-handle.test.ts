import { expect, it } from 'vitest';
import { moveHandlePosition, selectionCenter } from './move-handle';

const view = { scrollX: 0, scrollY: 0, zoom: { value: 2 }, offsetLeft: 10, offsetTop: 100, width: 400, height: 800 };

it('starts a forwarded drag at the selection center in client coordinates', () => {
  expect(selectionCenter([100, 50, 140, 70], view)).toEqual({ x: 10 + 120 * 2, y: 100 + 60 * 2 });
});

it('places the handle below the selection, or above it near the bottom edge', () => {
  expect(moveHandlePosition([50, 50, 90, 70], view)).toEqual({ left: 140 - 20, top: 140 + 22, visible: true });
  const low = moveHandlePosition([50, 370, 90, 390], view);
  expect(low.top).toBeLessThan(740);
  expect(low.visible).toBe(true);
});

it('hides the handle when the selection is scrolled away', () => {
  expect(moveHandlePosition([1000, 50, 1040, 70], view).visible).toBe(false);
});
