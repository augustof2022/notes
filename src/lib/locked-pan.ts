import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

type Point = { x: number; y: number };
// Track movement of the fingers' center, never their distance apart. Keep the
// remaining finger out of the drawing tool until every finger has been lifted.
export class LockedTouchPan {
  private points = new Map<number, Point>();
  private center: Point | null = null;
  active = false;
  private midpoint() {
    if (this.points.size < 2) return null;
    const points = [...this.points.values()];
    return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
  }
  down(id: number, point: Point) {
    this.points.set(id, point);
    if (this.points.size >= 2) this.active = true;
    this.center = this.midpoint();
  }
  move(id: number, point: Point) {
    if (!this.points.has(id)) return null;
    this.points.set(id, point);
    const next = this.midpoint(), previous = this.center;
    this.center = next;
    return previous && next ? { x: next.x - previous.x, y: next.y - previous.y } : null;
  }
  up(id: number) {
    this.points.delete(id); this.center = this.midpoint();
    if (!this.points.size) this.active = false;
  }
  reset() { this.points.clear(); this.center = null; this.active = false; }
}
export function wheelPan(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey'>, height: number) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  return event.shiftKey ? { x: -(event.deltaY || event.deltaX) * unit, y: 0 } : { x: -event.deltaX * unit, y: -event.deltaY * unit };
}
export function installLockedPan(root: HTMLElement, api: ExcalidrawImperativeAPI, locked: () => boolean) {
  const touch = new LockedTouchPan();
  const canvasTarget = (target: EventTarget | null) => target instanceof Element && root.contains(target) && !!target.closest('.excalidraw canvas, .excalidraw textarea');
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const pan = (delta: Point) => {
    if (!delta.x && !delta.y) return;
    const { scrollX, scrollY, zoom } = api.getAppState();
    api.updateScene({ appState: { scrollX: scrollX + delta.x / zoom.value, scrollY: scrollY + delta.y / zoom.value }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  let frame = 0, movement: Point = { x: 0, y: 0 };
  const flushMovement = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (locked()) pan(movement);
    movement = { x: 0, y: 0 };
  };
  const queueMovement = (delta: Point) => {
    movement.x += delta.x; movement.y += delta.y;
    if (!frame) frame = requestAnimationFrame(flushMovement);
  };
  const wheel = (event: WheelEvent) => {
    if (!locked() || !canvasTarget(event.target)) return;
    stop(event); pan(wheelPan(event, root.clientHeight));
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !locked() || !canvasTarget(event.target)) return;
    // Let the editor observe downs/ups so it cancels a provisional pen stroke
    // and cleans up its own pointer capture. Only its movement is intercepted.
    touch.down(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const move = (event: PointerEvent) => {
    if (!locked()) { touch.reset(); flushMovement(); return; }
    if (event.pointerType !== 'touch' || !touch.active) return;
    stop(event);
    const delta = touch.move(event.pointerId, { x: event.clientX, y: event.clientY });
    if (delta) queueMovement(delta);
  };
  const up = (event: PointerEvent) => { flushMovement(); touch.up(event.pointerId); };
  const gesture = (event: Event) => { if (locked() && canvasTarget(event.target)) stop(event); };
  const click = (event: MouseEvent) => {
    if (!locked() || !(event.target instanceof Element)) return;
    const name = event.target.closest('button')?.getAttribute('aria-label');
    if (name && ['Zoom in', 'Zoom out', 'Reset zoom'].includes(name)) stop(event);
  };
  const key = (event: KeyboardEvent) => {
    if (locked() && (event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key) && !(event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]'))) stop(event);
  };
  const reset = () => { touch.reset(); flushMovement(); };
  root.addEventListener('wheel', wheel, { capture: true, passive: false });
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('click', click, true);
  root.addEventListener('keydown', key, true);
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) root.addEventListener(name, gesture, { capture: true, passive: false });
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', reset);
  return () => {
    root.removeEventListener('wheel', wheel, true); root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('click', click, true); root.removeEventListener('keydown', key, true);
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) root.removeEventListener(name, gesture, true);
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true); window.removeEventListener('blur', reset);
    if (frame) cancelAnimationFrame(frame);
    touch.reset();
  };
}
