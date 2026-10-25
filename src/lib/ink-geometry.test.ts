import { expect, it } from 'vitest';
import { eraseInkPath, inkWorldSamples, recognizeInkShape, type InkPoint, type InkSample } from './ink-geometry';
const samples = (...points: InkPoint[]): InkSample[] => points.map((point, i) => ({ point, pressure: i / Math.max(1, points.length - 1) }));
it('cuts only the touched middle of a sparse stroke and interpolates new endpoints/pressure', () => {
  const result = eraseInkPath(samples([0, 0], [100, 0]), [50, 0], [50, 0], 10)!;
  expect(result).toHaveLength(2); expect(result[0].at(-1)!.point[0]).toBeCloseTo(40); expect(result[1][0].point[0]).toBeCloseTo(60);
  expect(result[0].at(-1)!.pressure).toBeCloseTo(0.4); expect(result[1][0].pressure).toBeCloseTo(0.6);
});
it('erases the entire swept area without gaps at fast pointer speeds', () => {
  const result = eraseInkPath(samples([0, 0], [100, 0]), [20, -30], [80, 30], 5)!;
  expect(result).toHaveLength(2); expect(result[0].at(-1)!.point[0]).toBeLessThan(45); expect(result[1][0].point[0]).toBeGreaterThan(55);
});
it('preserves untouched strokes, removes covered dots and whole strokes, and never joins across a hole', () => {
  expect(eraseInkPath(samples([0, 0], [100, 0]), [30, 50], [60, 50], 5)).toBeNull();
  expect(eraseInkPath(samples([0, 0]), [0, 0], [0, 0], 5)).toEqual([]);
  expect(eraseInkPath(samples([0, 0], [1, 1]), [0, 0], [0, 0], 5)).toEqual([]);
  const result = eraseInkPath(samples([0, 0], [50, 0], [100, 0]), [50, 0], [50, 0], 5)!;
  expect(result).toHaveLength(2); expect(result[0].at(-1)!.point[0]).toBeCloseTo(45); expect(result[1][0].point[0]).toBeCloseTo(55);
});
it('maps rotated strokes with negative local points to their displayed coordinates', () => {
  const result = inkWorldSamples({ x: 100, y: 100, angle: Math.PI / 2, points: [[-20, 0], [20, 0]], pressures: [0.2, 0.8] });
  expect(result[0].point[0]).toBeCloseTo(100); expect(result[0].point[1]).toBeCloseTo(80); expect(result[1].point[1]).toBeCloseTo(120);
  expect(result[1].pressure).toBe(0.8);
});
const circle = (rx = 60, ry = 60): InkPoint[] => Array.from({ length: 81 }, (_, i) => { const a = i / 80 * Math.PI * 2, jitter = 1 + Math.sin(i * 1.7) * 0.015; return [120 + Math.cos(a) * rx * jitter, 100 + Math.sin(a) * ry * jitter]; });
const polygon = (vertices: InkPoint[]): InkPoint[] => vertices.flatMap((a, i) => { const b = vertices[(i + 1) % vertices.length]; return Array.from({ length: 20 }, (_, n): InkPoint => [a[0] + (b[0] - a[0]) * n / 20 + Math.sin(n) * 0.5, a[1] + (b[1] - a[1]) * n / 20]); }).concat([vertices[0]]);
it('recognizes a wobbly circle/ellipse and straightens a nearly horizontal stroke', () => {
  expect(recognizeInkShape(circle())?.label).toBe('Circle');
  expect(recognizeInkShape(circle(90, 45))?.label).toBe('Ellipse');
  const line = recognizeInkShape(Array.from({ length: 30 }, (_, i): InkPoint => [i * 4, 30 + Math.sin(i) * 1.5]))!;
  expect(line.kind).toBe('line'); expect(line.points![1][1]).toBeCloseTo(0);
});
it('recognizes hand-drawn squares, rectangles and triangles', () => {
  expect(recognizeInkShape(polygon([[0, 0], [100, 2], [102, 100], [0, 98]]))?.label).toBe('Square');
  expect(recognizeInkShape(polygon([[0, 0], [160, 0], [160, 80], [0, 80]]))?.label).toBe('Rectangle');
  expect(recognizeInkShape(polygon([[50, 0], [110, 100], [0, 100]]))?.label).toBe('Triangle');
});
it('leaves tiny marks, open arcs, backtracking scribbles and letters alone', () => {
  expect(recognizeInkShape([[0, 0], [2, 2], [0, 0]])).toBeNull();
  expect(recognizeInkShape(circle().slice(0, 50))).toBeNull();
  expect(recognizeInkShape([[0, 0], [80, 90], [0, 90], [80, 0], [0, 0], [80, 90], [0, 0]])).toBeNull();
  expect(recognizeInkShape(polygon([[0, 100], [30, 0], [60, 100], [90, 0], [120, 100]]).slice(0, -10))).toBeNull();
});
