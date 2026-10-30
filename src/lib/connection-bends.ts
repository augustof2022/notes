export type BendPoint = readonly [number, number];
interface LinearGeometry {
  x: number; y: number; angle: number;
  points: readonly BendPoint[];
  roundness?: unknown;
}
export type BendHit = { kind: 'add' | 'remove' | 'endpoint'; index: number; point: BendPoint };
const distance = (a: BendPoint, b: BendPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function bendWorldPoints(element: LinearGeometry, center?: BendPoint): BendPoint[] {
  const xs = element.points.map(p => p[0]), ys = element.points.map(p => p[1]);
  const [cx, cy] = center || [element.x + (Math.min(...xs) + Math.max(...xs)) / 2, element.y + (Math.min(...ys) + Math.max(...ys)) / 2];
  const c = Math.cos(element.angle), s = Math.sin(element.angle);
  return element.points.map(([x, y]) => {
    const dx = element.x + x - cx, dy = element.y + y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
}

function project(point: BendPoint, a: BendPoint, b: BendPoint): BendPoint {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Match the smooth curve used by the canvas, rather than its invisible chords. */
function curveSegment(points: readonly BendPoint[], index: number, tolerance: number): BendPoint[] {
  const a = points[index], b = points[index + 1], before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 2)];
  const c = [a[0] + (b[0] - before[0]) / 6, a[1] + (b[1] - before[1]) / 6];
  const d = [b[0] - (after[0] - a[0]) / 6, b[1] - (after[1] - a[1]) / 6];
  const steps = Math.min(128, Math.max(16, Math.ceil(distance(a, b) / Math.max(1, tolerance))));
  return Array.from({ length: steps + 1 }, (_, i): BendPoint => {
    const t = i / steps, u = 1 - t;
    return [u ** 3 * a[0] + 3 * u * u * t * c[0] + 3 * u * t * t * d[0] + t ** 3 * b[0], u ** 3 * a[1] + 3 * u * u * t * c[1] + 3 * u * t * t * d[1] + t ** 3 * b[1]];
  });
}

/** Tolerance is in scene units, so callers divide the screen hit size by zoom. */
export function connectionBendHit(element: LinearGeometry, point: BendPoint, tolerance: number, center?: BendPoint): BendHit | null {
  if (element.points.length < 2 || !Number.isFinite(tolerance) || tolerance <= 0) return null;
  const points = bendWorldPoints(element, center);
  let nearest = -1, closest = tolerance;
  for (let i = 0; i < points.length; i++) {
    const d = distance(point, points[i]);
    if (d <= closest) { closest = d; nearest = i; }
  }
  if (nearest >= 0) return { kind: nearest === 0 || nearest === points.length - 1 ? 'endpoint' : 'remove', index: nearest, point: points[nearest] };
  let hit: BendHit | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const samples = element.roundness && points.length > 2 ? curveSegment(points, i, tolerance) : [points[i], points[i + 1]];
    for (let j = 1; j < samples.length; j++) {
      const projected = project(point, samples[j - 1], samples[j]), d = distance(point, projected);
      if (d <= closest) { closest = d; hit = { kind: 'add', index: i + 1, point: projected }; }
    }
  }
  return hit;
}

/** Normalize to world coordinates so changing bounds cannot rotate other points. */
export function editConnectionBend(element: LinearGeometry, hit: BendHit, center?: BendPoint) {
  if (hit.kind === 'endpoint') return null;
  const points = bendWorldPoints(element, center);
  if (hit.kind === 'remove') {
    if (hit.index <= 0 || hit.index >= points.length - 1) return null;
    points.splice(hit.index, 1);
  } else {
    if (hit.index <= 0 || hit.index >= points.length) return null;
    points.splice(hit.index, 0, hit.point);
  }
  const [x, y] = points[0], xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return { x, y, angle: 0, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    points: points.map(([px, py]): BendPoint => [px - x, py - y]) };
}

interface Tap { point: BendPoint; time: number; connectionId: string | null; moved: boolean; multi: boolean }
/** Only two short, stationary taps on the same connection constitute an edit. */
export class ConnectionDoubleTap {
  private pointers = new Map<number, Tap>();
  private previous: Tap | null = null;
  down(id: number, point: BendPoint, time: number, connectionId: string | null) {
    const multi = this.pointers.size > 0;
    if (multi) { this.previous = null; for (const tap of this.pointers.values()) tap.multi = true; }
    this.pointers.set(id, { point, time, connectionId, moved: false, multi });
  }
  move(id: number, point: BendPoint) {
    const tap = this.pointers.get(id);
    if (tap && distance(tap.point, point) > 8) { tap.moved = true; this.previous = null; }
  }
  up(id: number, point: BendPoint, time: number) {
    const tap = this.pointers.get(id); this.pointers.delete(id);
    if (!tap || tap.multi || tap.moved || !tap.connectionId || time - tap.time > 300 || distance(tap.point, point) > 8) { this.previous = null; return false; }
    const previous = this.previous;
    const twice = !!previous && previous.connectionId === tap.connectionId && time - previous.time <= 350 && distance(previous.point, point) <= 20;
    this.previous = twice ? null : { ...tap, point, time };
    return twice;
  }
  reset() { this.previous = null; this.pointers.clear(); }
}
