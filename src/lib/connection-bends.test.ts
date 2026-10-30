import { describe, expect, it } from 'vitest';
import { bendWorldPoints, ConnectionDoubleTap, connectionBendHit, editConnectionBend, type BendPoint } from './connection-bends';

const line = { x: 100, y: 200, angle: 0, points: [[0, 0], [100, 0], [100, 100], [200, 100]] as BendPoint[] };

describe('connection bend editing', () => {
  it('removes the clicked interior point while retaining both endpoints and other bends', () => {
    const hit = connectionBendHit(line, [202, 201], 9)!;
    expect(hit).toMatchObject({ kind: 'remove', index: 1 });
    const edited = editConnectionBend(line, hit)!;
    expect(bendWorldPoints(edited)).toEqual([[100, 200], [200, 300], [300, 300]]);
    expect(line.points).toHaveLength(4);
  });
  it('adds a handle at the nearest point on the clicked segment without shifting the route', () => {
    const hit = connectionBendHit(line, [200 + 4, 240], 9)!;
    expect(hit).toEqual({ kind: 'add', index: 2, point: [200, 240] });
    const edited = editConnectionBend(line, hit)!;
    expect(bendWorldPoints(edited)).toEqual([[100, 200], [200, 200], [200, 240], [200, 300], [300, 300]]);
    expect(connectionBendHit(edited, [200, 240], 9)).toMatchObject({ kind: 'remove', index: 2 });
  });
  it.each(([[100, 200], [300, 300]] as BendPoint[]).map(point => [point]))('protects the attachment endpoint at %j', point => {
    const hit = connectionBendHit(line, point, 9)!;
    expect(hit.kind).toBe('endpoint');
    expect(editConnectionBend(line, hit)).toBeNull();
  });
  it('can remove the final bend without deleting the connection', () => {
    const bent = { ...line, points: line.points.slice(0, 3) };
    const edited = editConnectionBend(bent, connectionBendHit(bent, [200, 200], 9)!)!;
    expect(bendWorldPoints(edited)).toEqual([[100, 200], [200, 300]]);
  });
  it('keeps tolerance proportional to screen size at different zoom levels', () => {
    const point: BendPoint = [150, 206];
    expect(connectionBendHit(line, point, 9 / 2)).toBeNull();
    expect(connectionBendHit(line, point, 9 / 0.5)?.kind).toBe('add');
    expect(connectionBendHit(line, [150, 230], 9)).toBeNull();
  });
  it('preserves visible coordinates when a rotated connection loses a bend', () => {
    const rotated = { ...line, angle: Math.PI / 2 };
    const before = bendWorldPoints(rotated), hit = connectionBendHit(rotated, before[1], 9)!;
    const after = bendWorldPoints(editConnectionBend(rotated, hit)!);
    expect(after).toHaveLength(before.length - 1);
    [before[0], before[2], before[3]].forEach((point, index) => {
      expect(after[index][0]).toBeCloseTo(point[0]); expect(after[index][1]).toBeCloseTo(point[1]);
    });
  });
  it('uses the renderer rotation center when a curved route has asymmetric bounds', () => {
    const rotated = { ...line, angle: Math.PI / 3 }, center: BendPoint = [180, 270];
    const before = bendWorldPoints(rotated, center), hit = connectionBendHit(rotated, before[2], 9, center)!;
    const after = bendWorldPoints(editConnectionBend(rotated, hit, center)!);
    expect(after[0][0]).toBeCloseTo(before[0][0]); expect(after[0][1]).toBeCloseTo(before[0][1]);
    expect(after.at(-1)![0]).toBeCloseTo(before.at(-1)![0]); expect(after.at(-1)![1]).toBeCloseTo(before.at(-1)![1]);
  });
  it('hits the rendered curved segment instead of the invisible chord', () => {
    const curved = { ...line, roundness: { type: 2 } };
    // Catmull-Rom midpoint between the first two controls bows upward.
    const hit = connectionBendHit(curved, [150, 193.75], 2)!;
    expect(hit).toMatchObject({ kind: 'add', index: 1 });
    expect(hit.point[0]).toBeCloseTo(150); expect(hit.point[1]).toBeCloseTo(193.75);
    expect(connectionBendHit(curved, [150, 200], 2)).toBeNull();
  });
  it('handles duplicate points and ignores malformed paths and invalid edits', () => {
    expect(connectionBendHit({ ...line, points: [[0, 0]] }, [100, 200], 9)).toBeNull();
    expect(connectionBendHit(line, [150, 200], NaN)).toBeNull();
    expect(connectionBendHit({ ...line, points: [[0, 0], [0, 0], [100, 0]] }, [150, 200], 9)).toMatchObject({ kind: 'add', index: 2 });
    expect(editConnectionBend(line, { kind: 'remove', index: 0, point: [100, 200] })).toBeNull();
  });
});

describe('connection double taps', () => {
  const point: BendPoint = [100, 200];
  function tap(gesture: ConnectionDoubleTap, time: number, connectionId: string | null = 'edge', at = point) {
    gesture.down(1, at, time, connectionId);
    return gesture.up(1, at, time + 50);
  }
  it('recognizes a pair on the same connection, and consumes each pair once', () => {
    const gesture = new ConnectionDoubleTap();
    expect(tap(gesture, 0)).toBe(false); expect(tap(gesture, 150)).toBe(true);
    expect(tap(gesture, 300)).toBe(false); expect(tap(gesture, 450)).toBe(true);
  });
  it('does not combine taps on different connections, blank space, or distant parts of a line', () => {
    const gesture = new ConnectionDoubleTap();
    tap(gesture, 0); expect(tap(gesture, 150, 'other')).toBe(false);
    expect(tap(gesture, 300, null)).toBe(false); expect(tap(gesture, 450)).toBe(false);
    expect(tap(gesture, 600, 'edge', [140, 200])).toBe(false);
  });
  it('rejects slow taps, holds, and drags even after returning to the starting point', () => {
    const gesture = new ConnectionDoubleTap();
    tap(gesture, 0); expect(tap(gesture, 600)).toBe(false);
    gesture.down(1, point, 700, 'edge'); expect(gesture.up(1, point, 1100)).toBe(false);
    gesture.down(1, point, 1200, 'edge'); gesture.move(1, [130, 200]); gesture.move(1, point);
    expect(gesture.up(1, point, 1250)).toBe(false); expect(tap(gesture, 1350)).toBe(false);
  });
  it('leaves two-finger pan/pinch and canceled gestures out of double-tap editing', () => {
    const gesture = new ConnectionDoubleTap(); tap(gesture, 0);
    gesture.down(1, point, 150, 'edge'); gesture.down(2, [200, 200], 160, 'edge');
    expect(gesture.up(1, point, 200)).toBe(false); expect(gesture.up(2, [200, 200], 210)).toBe(false);
    expect(tap(gesture, 300)).toBe(false); gesture.reset(); expect(tap(gesture, 450)).toBe(false);
  });
});
