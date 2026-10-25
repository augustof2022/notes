export type InkPoint = readonly [number, number];
export interface InkSample { point: InkPoint; pressure: number }
const EPS = 1e-7;
const distance = (a: InkPoint, b: InkPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: InkSample, b: InkSample, t: number): InkSample => ({ point: [a.point[0] + (b.point[0] - a.point[0]) * t, a.point[1] + (b.point[1] - a.point[1]) * t], pressure: a.pressure + (b.pressure - a.pressure) * t });
type Interval = [number, number];

function circleInterval(a: InkPoint, b: InkPoint, center: InkPoint, radius: number): Interval | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], x = a[0] - center[0], y = a[1] - center[1];
  const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), cc = x * x + y * y - radius * radius;
  if (aa < EPS) return cc < 0 ? [0, 1] : null;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant <= EPS) return null;
  const root = Math.sqrt(discriminant), lo = Math.max(0, (-bb - root) / (2 * aa)), hi = Math.min(1, (-bb + root) / (2 * aa));
  return hi - lo > EPS ? [lo, hi] : null;
}
function constrain(interval: Interval, start: number, delta: number, min: number, max: number): Interval | null {
  if (Math.abs(delta) < EPS) return start >= min && start <= max ? interval : null;
  const a = (min - start) / delta, b = (max - start) / delta;
  const next: Interval = [Math.max(interval[0], Math.min(a, b)), Math.min(interval[1], Math.max(a, b))];
  return next[1] - next[0] > EPS ? next : null;
}
/** Exact intersections with a swept circular eraser, including long sparse ink segments. */
function capsuleIntervals(a: InkPoint, b: InkPoint, from: InkPoint, to: InkPoint, radius: number): Interval[] {
  const intervals: Interval[] = [];
  for (const center of [from, to]) { const hit = circleInterval(a, b, center, radius); if (hit) intervals.push(hit); }
  const vx = to[0] - from[0], vy = to[1] - from[1], length = Math.hypot(vx, vy);
  if (length > EPS) {
    const ux = vx / length, uy = vy / length, x = a[0] - from[0], y = a[1] - from[1], dx = b[0] - a[0], dy = b[1] - a[1];
    let strip = constrain([0, 1], x * ux + y * uy, dx * ux + dy * uy, 0, length);
    if (strip) strip = constrain(strip, -x * uy + y * ux, -dx * uy + dy * ux, -radius, radius);
    if (strip) intervals.push(strip);
  }
  const merged: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + EPS) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function eraseInkPath(samples: readonly InkSample[], from: InkPoint, to: InkPoint, radius: number): InkSample[][] | null {
  if (!samples.length || !Number.isFinite(radius) || radius <= 0) return null;
  if (samples.length === 1) return capsuleIntervals(samples[0].point, samples[0].point, from, to, radius).length ? [] : null;
  const fragments: InkSample[][] = [];
  let current: InkSample[] = [], changed = false;
  const end = () => { if (current.length) fragments.push(current); current = []; };
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1], b = samples[index], hits = capsuleIntervals(a.point, b.point, from, to, radius);
    if (hits.length) changed = true;
    const keep: Interval[] = [];
    let start = 0;
    for (const [lo, hi] of hits) { if (lo - start > EPS) keep.push([start, lo]); start = Math.max(start, hi); }
    if (1 - start > EPS) keep.push([start, 1]);
    if (!keep.length) { end(); continue; }
    for (let part = 0; part < keep.length; part++) {
      const [lo, hi] = keep[part], first = lerp(a, b, lo), last = lerp(a, b, hi);
      if (lo > EPS || (current.length && distance(current.at(-1)!.point, first.point) > EPS)) end();
      if (!current.length) current.push(first);
      if (distance(current.at(-1)!.point, last.point) > EPS) current.push(last);
      if (hi < 1 - EPS) end();
    }
  }
  end();
  return changed ? fragments : null;
}

/** Freehand rotation is about the bounds of its points, not necessarily its x/y origin. */
export function inkWorldSamples(element: { x: number; y: number; angle: number; points: readonly InkPoint[]; pressures: readonly number[] }): InkSample[] {
  if (!element.points.length) return [];
  const xs = element.points.map(p => p[0]), ys = element.points.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const c = Math.cos(element.angle), s = Math.sin(element.angle);
  return element.points.map(([x, y], index) => ({ point: [element.x + cx + (x - cx) * c - (y - cy) * s, element.y + cy + (x - cx) * s + (y - cy) * c], pressure: element.pressures[index] ?? 0.5 }));
}

export interface InkShape {
  kind: 'line' | 'rectangle' | 'ellipse' | 'triangle';
  label: string;
  x: number; y: number; width: number; height: number; angle: number;
  points?: InkPoint[];
}
function segmentDistance(p: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length > EPS ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return distance(p, [a[0] + t * dx, a[1] + t * dy]);
}
function simplify(points: readonly InkPoint[], tolerance: number): InkPoint[] {
  if (points.length < 3) return [...points];
  let best = tolerance, split = -1;
  for (let i = 1; i < points.length - 1; i++) { const d = segmentDistance(points[i], points[0], points.at(-1)!); if (d > best) { best = d; split = i; } }
  return split < 0 ? [points[0], points.at(-1)!] : [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify(points.slice(split), tolerance)];
}
function resample(points: readonly InkPoint[], length: number): InkPoint[] {
  const result: InkPoint[] = [points[0]], spacing = length / 80;
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = distance(a, b);
    if (d < EPS) continue;
    for (let offset = spacing - carry; offset <= d + EPS; offset += spacing) result.push([a[0] + (b[0] - a[0]) * offset / d, a[1] + (b[1] - a[1]) * offset / d]);
    carry = (carry + d) % spacing;
  }
  result.push(points.at(-1)!); return result;
}
/** Conservative single-stroke recognition: uncertain handwriting stays as ink. */
export function recognizeInkShape(raw: readonly InkPoint[], minimum = 16): InkShape | null {
  const clean = raw.filter((p, i) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!i || distance(p, raw[i - 1]) > 0.01));
  if (clean.length < 3) return null;
  const length = clean.slice(1).reduce((sum, p, i) => sum + distance(clean[i], p), 0);
  if (length < minimum * 1.5) return null;
  const points = resample(clean, length), xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top, diagonal = Math.hypot(width, height);
  if (diagonal < minimum) return null;
  const first = points[0], last = points.at(-1)!, chord = distance(first, last);
  if (chord > minimum && length / chord < 1.2 && Math.max(...points.map(p => segmentDistance(p, first, last))) < Math.max(minimum * 0.2, chord * 0.055)) {
    let [x2, y2] = last, angle = Math.atan2(y2 - first[1], x2 - first[0]);
    const snapped = Math.round(angle / (Math.PI / 4)) * Math.PI / 4;
    if (Math.abs(angle - snapped) < Math.PI / 25) { angle = snapped; x2 = first[0] + chord * Math.cos(angle); y2 = first[1] + chord * Math.sin(angle); }
    return { kind: 'line', label: 'Line', x: first[0], y: first[1], width: Math.abs(x2 - first[0]), height: Math.abs(y2 - first[1]), angle: 0, points: [[0, 0], [x2 - first[0], y2 - first[1]]] };
  }
  if (Math.min(width, height) < minimum || chord > diagonal * 0.26 || length < diagonal * 2.2 || length > (width + height) * 2.1) return null;
  const center: InkPoint = [left + width / 2, top + height / 2];
  let start = 0;
  points.forEach((p, i) => { if (distance(p, center) > distance(points[start], center)) start = i; });
  const loop = [...points.slice(start), ...points.slice(0, start)]; loop.push(loop[0]);
  let polygon = simplify(loop, diagonal * 0.055).slice(0, -1);
  // Remove tiny/jitter corners from a closed simplified path.
  for (let pass = 0; pass < 2; pass++) polygon = polygon.filter((p, i) => segmentDistance(p, polygon[(i + polygon.length - 1) % polygon.length], polygon[(i + 1) % polygon.length]) > diagonal * 0.04);
  if (polygon.length === 3 || polygon.length === 4) {
    const error = points.reduce((sum, p) => sum + Math.min(...polygon.map((a, i) => segmentDistance(p, a, polygon[(i + 1) % polygon.length]))), 0) / points.length;
    if (error < diagonal * 0.025 && polygon.length === 3) {
      const area = Math.abs(polygon.reduce((sum, p, i) => sum + p[0] * polygon[(i + 1) % 3][1] - p[1] * polygon[(i + 1) % 3][0], 0)) / 2;
      if (area > width * height * 0.25) return { kind: 'triangle', label: 'Triangle', x: left, y: top, width, height, angle: 0, points: [...polygon, polygon[0]].map(p => [p[0] - left, p[1] - top]) };
    }
    if (error < diagonal * 0.025 && polygon.length === 4) {
      const right = polygon.every((p, i) => {
        const a = polygon[(i + 3) % 4], b = polygon[(i + 1) % 4], ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1];
        return Math.abs((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))) < 0.35;
      });
      if (right) {
        let angle = Math.atan2(polygon[1][1] - polygon[0][1], polygon[1][0] - polygon[0][0]);
        angle = ((angle + Math.PI * 5 / 4) % (Math.PI / 2)) - Math.PI / 4;
        if (Math.abs(angle) < Math.PI / 15) angle = 0;
        const c = Math.cos(angle), s = Math.sin(angle), projected = points.map(([x, y]) => [(x - center[0]) * c + (y - center[1]) * s, -(x - center[0]) * s + (y - center[1]) * c]);
        let w = Math.max(...projected.map(p => p[0])) - Math.min(...projected.map(p => p[0])), h = Math.max(...projected.map(p => p[1])) - Math.min(...projected.map(p => p[1]));
        const square = Math.min(w, h) / Math.max(w, h) > 0.82;
        if (square) w = h = (w + h) / 2;
        return { kind: 'rectangle', label: square ? 'Square' : 'Rectangle', x: center[0] - w / 2, y: center[1] - h / 2, width: w, height: h, angle };
      }
    }
  }
  const normalized = points.map(([x, y]): InkPoint => [(x - center[0]) / (width / 2), (y - center[1]) / (height / 2)]);
  const radial = normalized.map(p => Math.abs(Math.hypot(...p) - 1));
  let winding = 0, travel = 0;
  for (let i = 1; i < normalized.length; i++) {
    let angle = Math.atan2(normalized[i][1], normalized[i][0]) - Math.atan2(normalized[i - 1][1], normalized[i - 1][0]);
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    winding += angle; travel += Math.abs(angle);
  }
  if (radial.reduce((a, b) => a + b, 0) / radial.length < 0.10 && Math.max(...radial) < 0.27 && Math.abs(winding) > 5.1 && Math.abs(winding) < 7.4 && travel < Math.abs(winding) * 1.18) {
    const circle = Math.min(width, height) / Math.max(width, height) > 0.83, w = circle ? (width + height) / 2 : width, h = circle ? w : height;
    return { kind: 'ellipse', label: circle ? 'Circle' : 'Ellipse', x: center[0] - w / 2, y: center[1] - h / 2, width: w, height: h, angle: 0 };
  }
  return null;
}
