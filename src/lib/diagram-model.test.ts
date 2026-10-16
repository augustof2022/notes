import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_SYSTEMS, DIAGRAM_THEMES, getDiagramNodes, nextNodePosition, readDiagramData, routePoints, sidePoint,
  type DiagramNodeData, type DiagramNodeLike, type DiagramSide,
} from './diagram-model';

function node(id: string, x = 0, y = 0, parentId: string | null = null, diagramId = 'diagram-a'): DiagramNodeLike {
  const data: DiagramNodeData = { kind: 'node', diagramId, system: 'org', shapeId: 'role', parentId };
  return { id, x, y, width: 200, height: 100, customData: { noteDiagram: data } };
}

const size = { width: 200, height: 100 };
function intersects(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('diagram catalog and metadata', () => {
  it('provides distinct systems and complete native shape presets, including Chen double outlines', () => {
    expect(DIAGRAM_SYSTEMS.map((system) => system.id)).toEqual(['chen', 'crowfoot', 'relational', 'process', 'org', 'mindmap']);
    for (const system of DIAGRAM_SYSTEMS) {
      expect(new Set(system.presets.map((preset) => preset.id)).size).toBe(system.presets.length);
      for (const preset of system.presets) {
        expect(preset.system).toBe(system.id);
        expect(preset.width).toBeGreaterThan(0);
        expect(preset.height).toBeGreaterThan(0);
        expect(preset.defaultText).toBeTruthy();
        expect(['rectangle', 'ellipse', 'diamond']).toContain(preset.type);
      }
    }
    expect(DIAGRAM_SYSTEMS[0].presets.filter((preset) => preset.doubleOutline).map((preset) => preset.id))
      .toEqual(['weak-entity', 'identifying-relationship', 'multivalued-attribute']);
    expect(DIAGRAM_THEMES.length).toBeGreaterThan(1);
  });

  it('preserves valid metadata identity and rejects incomplete or unrelated saved objects', () => {
    const element = node('a');
    expect(readDiagramData(element)).toBe(element.customData!.noteDiagram);
    const valid = element.customData!.noteDiagram as DiagramNodeData;
    for (const value of [undefined, null, [], 'node', {}, { ...valid, system: 'unknown' }, { ...valid, diagramId: '' },
      { ...valid, parentId: undefined }, { ...valid, shapeId: 'topic' }, { ...valid, kind: 'unknown' }]) {
      expect(readDiagramData({ customData: { noteDiagram: value } })).toBeNull();
    }
    const edge = { kind: 'edge', diagramId: 'diagram-a', system: 'org', fromId: 'a', toId: 'b', fromSide: 'bottom', toSide: 'top' };
    expect(readDiagramData({ customData: { noteDiagram: edge } })).toBe(edge);
    expect(readDiagramData({ customData: { noteDiagram: { ...edge, toSide: 'middle' } } })).toBeNull();
    const decoration = { kind: 'decoration', diagramId: 'diagram-a', system: 'chen', nodeId: 'a' };
    expect(readDiagramData({ customData: { noteDiagram: decoration } })).toBe(decoration);
  });

  it('keeps diagrams isolated and excludes deleted nodes, decorations, and ordinary board objects', () => {
    const a = node('a'), b = node('b', 400, 0, null, 'diagram-b'), deleted = { ...node('deleted'), isDeleted: true };
    const ordinary = { ...node('ordinary'), customData: {} };
    const decoration = { ...node('outline'), customData: { noteDiagram: { kind: 'decoration', system: 'org', diagramId: 'diagram-a', nodeId: 'a' } } };
    expect(getDiagramNodes([a, b, deleted, ordinary, decoration])).toEqual([a, b]);
    expect(getDiagramNodes([a, b, deleted, ordinary, decoration], 'diagram-a')).toEqual([a]);
  });
});

describe('child and sibling placement', () => {
  it('adds a child under the selection, grandchildren under that child, and siblings under the same parent', () => {
    const parent = node('parent');
    const firstPosition = nextNodePosition([parent], parent, 'child', size);
    expect(firstPosition).toEqual({ x: 0, y: 172, parentId: 'parent' });
    const child = node('child', firstPosition.x, firstPosition.y, firstPosition.parentId);
    const grandchild = nextNodePosition([parent, child], child, 'child', size);
    expect(grandchild).toEqual({ x: 0, y: 344, parentId: 'child' });
    const sibling = nextNodePosition([parent, child], child, 'sibling', size);
    expect(sibling.parentId).toBe('parent');
    expect(sibling.y).toBe(child.y);
    expect(sibling.x).toBeGreaterThan(child.x + child.width);
  });

  it('adds root siblings as independent roots and supports diagrams at negative coordinates', () => {
    const parent = node('root', -700, -400);
    expect(nextNodePosition([parent], parent, 'child', { width: 100, height: 60 }))
      .toEqual({ x: -650, y: -228, parentId: 'root' });
    expect(nextNodePosition([parent], parent, 'sibling', size))
      .toEqual({ x: -444, y: -400, parentId: null });
  });

  it('places many siblings without collisions and ignores deleted obstacles', () => {
    const parent = node('parent');
    const nodes = [parent];
    for (let i = 0; i < 80; i++) {
      const position = nextNodePosition(nodes, parent, 'child', size);
      const child = node(`child-${i}`, position.x, position.y, position.parentId);
      expect(nodes.some((other) => intersects(child, other))).toBe(false);
      nodes.push(child);
    }
    const deleted = { ...node('deleted', 0, 172, 'parent'), isDeleted: true };
    expect(nextNodePosition([parent, deleted], parent, 'child', size)).toEqual({ x: 0, y: 172, parentId: 'parent' });
  });

  it('avoids other visible diagrams without borrowing their hierarchy or changing existing nodes', () => {
    const parent = node('parent');
    const blocker = node('other-root', 0, 172, null, 'diagram-b');
    const before = JSON.stringify([parent, blocker]);
    expect(nextNodePosition([parent, blocker], parent, 'child', size)).toEqual({ x: 256, y: 172, parentId: 'parent' });
    expect(JSON.stringify([parent, blocker])).toBe(before);
  });
});

describe('connection endpoints and routing', () => {
  const from = { x: -100, y: -80, width: 200, height: 100 };
  const to = { x: 350, y: 240, width: 180, height: 90 };
  const sides: DiagramSide[] = ['top', 'right', 'bottom', 'left'];

  it('finds exact centers on each requested side, including negative coordinates', () => {
    expect(sidePoint(from, 'top')).toEqual([0, -80]);
    expect(sidePoint(from, 'right')).toEqual([100, -30]);
    expect(sidePoint(from, 'bottom')).toEqual([0, 20]);
    expect(sidePoint(from, 'left')).toEqual([-100, -30]);
  });

  it('preserves selected endpoints for every side combination and gives elbow routes only right-angle segments', () => {
    for (const fromSide of sides) for (const toSide of sides) {
      for (const route of ['straight', 'elbow', 'curved'] as const) {
        const points = routePoints(from, to, fromSide, toSide, route);
        expect(points[0]).toEqual(sidePoint(from, fromSide));
        expect(points.at(-1)).toEqual(sidePoint(to, toSide));
        expect(points.every((point) => point.every(Number.isFinite))).toBe(true);
        if (route === 'straight') expect(points).toHaveLength(2);
        if (route === 'elbow') points.slice(1).forEach((point, i) => {
          expect(point[0] === points[i][0] || point[1] === points[i][1]).toBe(true);
        });
        if (route !== 'straight') {
          const [x, y] = points[0], [nextX, nextY] = points[1];
          const [endX, endY] = points.at(-1)!, [beforeX, beforeY] = points.at(-2)!;
          expect(fromSide === 'top' ? nextY < y : fromSide === 'bottom' ? nextY > y : fromSide === 'left' ? nextX < x : nextX > x).toBe(true);
          expect(toSide === 'top' ? beforeY < endY : toSide === 'bottom' ? beforeY > endY : toSide === 'left' ? beforeX < endX : beforeX > endX).toBe(true);
        }
      }
    }
  });

  it('routes matching sides outside the shapes and supports connections back to earlier nodes', () => {
    const points = routePoints(from, to, 'right', 'right', 'elbow');
    expect(points[1][0]).toBeGreaterThan(to.x + to.width);
    const back = routePoints(to, from, 'bottom', 'top', 'elbow');
    expect(back[0]).toEqual(sidePoint(to, 'bottom'));
    expect(back.at(-1)).toEqual(sidePoint(from, 'top'));
    expect(back[1][1]).toBeGreaterThan(to.y + to.height);
    expect(back.at(-2)![1]).toBeLessThan(from.y);
  });

  it('routes short child gaps directly instead of looping around the shapes when 40px leads overlap', () => {
    const parent = { x: 0, y: 0, width: 200, height: 100 };
    const child = { x: 0, y: 172, width: 200, height: 100 };
    const neighbor = { x: 256, y: 0, width: 200, height: 100 };
    for (const route of ['elbow', 'curved'] as const) {
      const down = routePoints(parent, child, 'bottom', 'top', route);
      expect(down.every(([x, y]) => x === 100 && y >= 100 && y <= 172)).toBe(true);
      expect(down.map(([, y]) => y)).toEqual([...down.map(([, y]) => y)].sort((a, b) => a - b));
      const right = routePoints(parent, neighbor, 'right', 'left', route);
      expect(right.every(([x, y]) => y === 50 && x >= 200 && x <= 256)).toBe(true);
      expect(right.map(([x]) => x)).toEqual([...right.map(([x]) => x)].sort((a, b) => a - b));
    }
  });
});
