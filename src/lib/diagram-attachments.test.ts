import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import { anchorPoint, pointAnchor, projectAnchor, readDiagramData } from './diagram-model';
// Exercise the repair rules without loading the browser renderer in Node.
vi.mock('@excalidraw/excalidraw', () => ({
  mutateElement: (element: object, patch: object) => Object.assign(element, patch),
  newElementWith: (element: object, patch: object) => ({ ...element, ...patch }),
  convertToExcalidrawElements: vi.fn(),
}));
import { repairDiagramElements } from './diagram-scene';

function fixture() {
  const identity = { diagramId: 'diagram', system: 'org' };
  const a = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, angle: 0, isDeleted: false, boundElements: [{ id: 'edge', type: 'arrow' }], customData: { noteDiagram: { ...identity, kind: 'node', shapeId: 'role', parentId: null } } };
  const b = { ...a, id: 'b', x: 400, y: 200 };
  const edge = { id: 'edge', type: 'arrow', x: 200, y: 50, angle: 0, points: [[0, 0], [250, 150]], startBinding: { elementId: 'a', focus: 0, gap: 0 }, endBinding: { elementId: 'b', focus: 0, gap: 0 }, elbowed: false, isDeleted: false, customData: { noteDiagram: { ...identity, kind: 'edge', fromId: 'a', toId: 'b', fromSide: 'right', toSide: 'top', fromAnchor: [1, 0.5], toAnchor: [0.25, 0] } } };
  return { a, b, edge, elements: [a, b, edge] as unknown as ExcalidrawElement[] };
}
function end(edge: ReturnType<typeof fixture>['edge']) { const p = edge.points.at(-1)!; return [edge.x + p[0], edge.y + p[1]]; }

describe('persistent diagram attachments', () => {
  it('keeps an off-center attachment on the same part of a moved and resized shape', () => {
    const { b, edge, elements } = fixture();
    b.x += 120; b.y += 70; b.width *= 2;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([620, 270]);
    expect(repairDiagramElements(elements)).toBe(false);
  });
  it('records an intentional endpoint edit instead of restoring the old side', () => {
    const { b, edge, elements } = fixture();
    edge.points[1] = [400, 230]; // Target's right side, at 80% of its height.
    const editor = { elementId: 'edge', selectedPointsIndices: [1], isDragging: true };
    repairDiagramElements(elements, { editingLinearElement: editor, selectedLinearElement: null } as unknown as AppState);
    expect(end(edge)).toEqual([600, 280]);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'right', toAnchor: [1, 0.8] });
    b.x += 50; b.y += 20;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([650, 300]);
  });
  it('migrates an existing manually adjusted connector from its saved geometry', () => {
    const { b, edge, elements } = fixture();
    delete (edge.customData.noteDiagram as any).toAnchor;
    edge.customData.noteDiagram.toSide = 'left';
    repairDiagramElements(elements);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'top', toAnchor: [0.25, 0] });
    b.x += 100;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([550, 200]);
  });
  it('retains small endpoint adjustments instead of treating normalized fractions as pixels', () => {
    const { b, edge, elements } = fixture();
    edge.points[1] = [250.2, 150];
    const editor = { elementId: 'edge', selectedPointsIndices: [1], isDragging: true };
    repairDiagramElements(elements, { editingLinearElement: editor, selectedLinearElement: null } as unknown as AppState);
    expect((readDiagramData(edge) as any).toAnchor[0]).toBeCloseTo(0.251);
    b.x += 100;
    repairDiagramElements(elements);
    expect(end(edge)[0]).toBeCloseTo(550.2);
  });
  it('keeps a deliberately detached endpoint free when its former shape moves', () => {
    const { b, edge, elements } = fixture();
    edge.endBinding = null as any;
    repairDiagramElements(elements);
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: null });
    b.x += 100; b.y += 100;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([450, 200]);
  });
  it('adopts the native fixed attachment of a manually reattached elbow arrow', () => {
    const { b, edge, elements } = fixture();
    edge.elbowed = true;
    edge.endBinding = { ...edge.endBinding, fixedPoint: [0.75, 0] } as any;
    repairDiagramElements(elements);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'top', toAnchor: [0.75, 0] });
    b.y += 100;
    repairDiagramElements(elements);
    expect(edge.endBinding).toMatchObject({ fixedPoint: [0.75, 0] });
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: [0.75, 0] });
  });
  it('rebinds to another diagram node without keeping the old node identity', () => {
    const { edge, elements } = fixture();
    edge.endBinding.elementId = 'a';
    edge.points[1] = [-150, -50];
    const editor = { elementId: 'edge', selectedPointsIndices: [1], isDragging: true };
    repairDiagramElements(elements, { editingLinearElement: editor, selectedLinearElement: null } as unknown as AppState);
    expect(readDiagramData(edge)).toMatchObject({ toId: 'a', toSide: 'top', toAnchor: [0.25, 0] });
  });
  it('uses the same attachment fraction after rotation and translation', () => {
    const shape = { x: 100, y: 80, width: 200, height: 100, angle: Math.PI / 2 };
    const point = anchorPoint(shape, [0.25, 0]);
    expect(pointAnchor(shape, point)[0]).toBeCloseTo(0.25);
    expect(pointAnchor(shape, point)[1]).toBeCloseTo(0);
    const moved = anchorPoint({ ...shape, x: 300, y: 180 }, [0.25, 0]);
    expect(moved[0] - point[0]).toBeCloseTo(200);
    expect(moved[1] - point[1]).toBeCloseTo(100);
  });
  it('projects an existing attachment onto the new outline when changing a shape', () => {
    const ellipse = projectAnchor('ellipse', [0.25, 0]), diamond = projectAnchor('diamond', [0.25, 0]);
    expect(Math.hypot(ellipse[0] - 0.5, ellipse[1] - 0.5)).toBeCloseTo(0.5);
    expect(Math.abs(diamond[0] - 0.5) + Math.abs(diamond[1] - 0.5)).toBeCloseTo(0.5);
    expect(projectAnchor('rectangle', [0.25, 0])).toEqual([0.25, 0]);
  });
});
