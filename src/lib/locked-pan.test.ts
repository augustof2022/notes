import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
vi.mock('@excalidraw/excalidraw', () => ({ CaptureUpdateAction: { NEVER: 'NEVER' } }));
import { installLockedPan, LockedTouchPan, wheelPan } from './locked-pan';

describe('locked touch panning', () => {
  it('moves by the fingers center, without distance-based zoom or a multiplier', () => {
    const touch = new LockedTouchPan(); touch.down(1, { x: 100, y: 100 }); touch.down(2, { x: 200, y: 100 });
    const first = touch.move(1, { x: 120, y: 130 })!, second = touch.move(2, { x: 220, y: 130 })!;
    expect({ x: first.x + second.x, y: first.y + second.y }).toEqual({ x: 20, y: 30 });
  });
  it('spreading fingers around a fixed center produces no net pan', () => {
    const touch = new LockedTouchPan(); touch.down(1, { x: 100, y: 100 }); touch.down(2, { x: 200, y: 100 });
    const first = touch.move(1, { x: 70, y: 100 })!, second = touch.move(2, { x: 230, y: 100 })!;
    expect(first.x + second.x).toBe(0); expect(first.y + second.y).toBe(0);
  });
  it('suppresses remaining finger drawing and rebases when another finger joins', () => {
    const touch = new LockedTouchPan(); touch.down(1, { x: 0, y: 0 }); expect(touch.active).toBe(false);
    touch.down(2, { x: 100, y: 0 }); touch.up(2); expect(touch.active).toBe(true);
    expect(touch.move(1, { x: 30, y: 0 })).toBeNull(); touch.down(3, { x: 130, y: 0 });
    expect(touch.move(3, { x: 140, y: 0 })).toEqual({ x: 5, y: 0 });
    touch.up(3); touch.up(1); expect(touch.active).toBe(false);
    touch.down(4, { x: 0, y: 0 }); expect(touch.active).toBe(false);
  });
  it('normalizes mouse and trackpad wheel units and horizontal scrolling', () => {
    expect(wheelPan({ deltaX: 3, deltaY: 4, deltaMode: 0, shiftKey: false }, 800)).toEqual({ x: -3, y: -4 });
    expect(wheelPan({ deltaX: 0, deltaY: -2, deltaMode: 1, shiftKey: false }, 800)).toEqual({ x: -0, y: 32 });
    expect(wheelPan({ deltaX: 0, deltaY: 1, deltaMode: 2, shiftKey: true }, 800)).toEqual({ x: -800, y: 0 });
  });
});

class Surface extends EventTarget {
  clientHeight = 800;
  contains(target: unknown) { return target === this; }
  closest(selector: string) { return selector.includes('canvas') ? this : null; }
}
function input(type: string, properties: Record<string, unknown>) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
  return event;
}
afterEach(() => vi.unstubAllGlobals());
it('intercepts Ctrl-wheel before native zoom, scales pan by current zoom, and leaves unlocked events alone', () => {
  const root = new Surface(), win = new EventTarget(); vi.stubGlobal('Element', Surface); vi.stubGlobal('window', win);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { scrollX: 10, scrollY: 20, zoom: { value: 2 } };
  const update = vi.fn(({ appState }) => Object.assign(state, appState));
  let locked = true;
  const cleanup = installLockedPan(root as unknown as HTMLElement, { getAppState: () => state, updateScene: update } as unknown as ExcalidrawImperativeAPI, () => locked);
  const native = vi.fn(); root.addEventListener('wheel', native);
  const event = input('wheel', { deltaX: 40, deltaY: 80, deltaMode: 0, shiftKey: false, ctrlKey: true });
  root.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); expect(native).not.toHaveBeenCalled();
  expect(state).toEqual({ scrollX: -10, scrollY: -20, zoom: { value: 2 } });
  locked = false; root.dispatchEvent(input('wheel', { ctrlKey: true })); expect(native).toHaveBeenCalledOnce();
  cleanup(); locked = true; root.dispatchEvent(input('wheel', {})); expect(update).toHaveBeenCalledOnce();
});
it('batches touch pan per frame and blocks native movement until all fingers lift', () => {
  const root = new Surface(), win = new EventTarget(); vi.stubGlobal('Element', Surface); vi.stubGlobal('window', win);
  let nextFrame: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, update = vi.fn(({ appState }) => Object.assign(state, appState));
  const cleanup = installLockedPan(root as unknown as HTMLElement, { getAppState: () => state, updateScene: update } as unknown as ExcalidrawImperativeAPI, () => true);
  const native = vi.fn(); win.addEventListener('pointermove', native);
  const pointer = (target: EventTarget, type: string, id: number, x: number) => target.dispatchEvent(input(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: 100 }));
  pointer(root, 'pointerdown', 1, 100); pointer(root, 'pointerdown', 2, 200);
  pointer(win, 'pointermove', 1, 70); pointer(win, 'pointermove', 2, 230);
  (nextFrame as FrameRequestCallback | null)?.(0); expect(update).not.toHaveBeenCalled();
  pointer(win, 'pointermove', 1, 90); pointer(win, 'pointermove', 2, 250);
  (nextFrame as FrameRequestCallback | null)?.(0); expect(state.scrollX).toBe(20); expect(update).toHaveBeenCalledOnce();
  pointer(win, 'pointerup', 2, 250); pointer(win, 'pointermove', 1, 150); expect(native).not.toHaveBeenCalled();
  pointer(win, 'pointerup', 1, 150); pointer(win, 'pointermove', 1, 160); expect(native).toHaveBeenCalledOnce();
  cleanup();
});
