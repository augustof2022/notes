import { describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';
import { anchorPoint, pointAnchor, projectAnchor, readDiagramData } from './diagram-model';
// Exercise the repair rules without loading the browser renderer in Node.
vi.mock('@excalidraw/excalidraw', () => ({
  mutateElement: (element: object, patch: object) => Object.assign(element, patch),
  newElementWith: (element: object, patch: object) => ({ ...element, ...patch }),
  convertToExcalidrawElements: vi.fn(),
  getCommonBounds: (elements: any[]) => [Math.min(...elements.map(e => e.x)), Math.min(...elements.map(e => e.y)), Math.max(...elements.map(e => e.x + e.width)), Math.max(...elements.map(e => e.y + e.height))],
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
    edge.points[1] = [350, 150];
    repairDiagramElements(elements, { selectedLinearElement: { elementId: 'edge', isDragging: true, selectedPointsIndices: [1] } } as unknown as AppState);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'top', toAnchor: [0.75, 0] });
    b.y += 100;
    repairDiagramElements(elements);
    expect(edge.endBinding).toMatchObject({ fixedPoint: [0.75, 0] });
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: [0.75, 0] });
  });
  it('tracks the child endpoint when elbow routing changes its selected point index', () => {
    const { b, edge, elements } = fixture();
    edge.elbowed = true;
    edge.endBinding = { ...edge.endBinding, fixedPoint: [0.25, 0] } as any;
    edge.points = [[0, 0], [0, 75], [160, 75], [160, 200], [200, 200]];
    repairDiagramElements(elements, { selectedLinearElement: { elementId: 'edge', isDragging: true, selectedPointsIndices: [1], pointerDownState: { lastClickedPoint: 1, lastClickedIsEndPoint: true } } } as unknown as AppState);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'left', toAnchor: [0, 0.5] });
    repairDiagramElements(elements);
    expect(edge.endBinding).toMatchObject({ fixedPoint: [0, 0.5001] });
    b.x += 300; b.y -= 150;
    edge.endBinding = { ...edge.endBinding, fixedPoint: [0.5, 0] } as any;
    repairDiagramElements(elements);
    expect(readDiagramData(edge)).toMatchObject({ toSide: 'left', toAnchor: [0, 0.5] });
    expect(edge.endBinding).toMatchObject({ fixedPoint: [0, 0.5001] });
  });
  it('rebinds to another diagram node without keeping the old node identity', () => {
    const { edge, elements } = fixture();
    edge.endBinding.elementId = 'a';
    edge.points[1] = [-150, -50];
    const editor = { elementId: 'edge', selectedPointsIndices: [1], isDragging: true };
    repairDiagramElements(elements, { editingLinearElement: editor, selectedLinearElement: null } as unknown as AppState);
    expect(readDiagramData(edge)).toMatchObject({ toId: 'a', toSide: 'top', toAnchor: [0.25, 0] });
  });
  it('follows ordinary text without converting it into a diagram node', () => {
    const { b, edge, elements } = fixture();
    Object.assign(b, { type: 'text', customData: undefined });
    Object.assign(edge.customData.noteDiagram, { universal: true });
    b.x += 150; b.y += 80; b.width = 400;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([650, 280]);
    expect(readDiagramData(b)).toBeNull();
  });
  it('anchors to the entire icon group after moving and resizing its members', () => {
    const { b, edge, elements } = fixture();
    Object.assign(b, { type: 'line', groupIds: ['stamp'], customData: undefined });
    const second = { ...b, id: 'stamp-handle', x: 620, width: 80, height: 120 };
    elements.splice(2, 0, second as unknown as ExcalidrawElement);
    edge.endBinding = null as any;
    Object.assign(edge.customData.noteDiagram, { universal: true, toCustom: true, toGroup: 'stamp', toSide: 'left', toAnchor: [0, 0.5] });
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([400, 260]);
    b.x += 100; b.y += 80; second.x += 180; second.y += 80;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([500, 340]);
    // A saved group link still resolves if its representative is deleted.
    b.isDeleted = true;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([800, 340]);
  });
  it('leaves an object connection free after dragging its endpoint off the board objects', () => {
    const { b, edge, elements } = fixture();
    Object.assign(edge.customData.noteDiagram, { universal: true });
    edge.points[1] = [800, 600];
    repairDiagramElements(elements, { selectedLinearElement: { elementId: 'edge', isDragging: true, selectedPointsIndices: [1], pointerDownState: { lastClickedPoint: 1, lastClickedIsEndPoint: true } } } as unknown as AppState);
    repairDiagramElements(elements);
    expect(edge.endBinding).toBeNull();
    const detached = end(edge);
    b.x += 300; b.y += 200;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual(detached);
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: null });
  });
  it.each(['from', 'to'] as const)('settles while the %s endpoint is held in empty space', end => {
    const { edge, elements } = fixture();
    Object.assign(edge.customData.noteDiagram, { universal: true });
    const index = end === 'from' ? 0 : edge.points.length - 1;
    edge.points[index] = end === 'from' ? [-400, -300] : [800, 600];
    const state = { selectedLinearElement: { elementId: edge.id, isDragging: true, selectedPointsIndices: [index],
      pointerDownState: { lastClickedPoint: index, lastClickedIsEndPoint: end === 'to' } } } as unknown as AppState;
    expect(repairDiagramElements(elements, state)).toBe(true);
    expect(readDiagramData(edge)).toMatchObject({ [`${end}Anchor`]: null, [`${end}Custom`]: true });
    expect(edge[end === 'from' ? 'startBinding' : 'endBinding']).toBeNull();
    const settled = JSON.stringify(elements);
    // Repeated onChange events during the same pointer hold must not schedule
    // another scene update: React otherwise loops until the editor unmounts.
    for (let frame = 0; frame < 5; frame++) expect(repairDiagramElements(elements, state)).toBe(false);
    expect(JSON.stringify(elements)).toBe(settled);
  });
  it('settles again after bringing a detached endpoint back onto an object', () => {
    const { edge, elements } = fixture();
    Object.assign(edge.customData.noteDiagram, { universal: true, toAnchor: null, toCustom: true });
    const state = { selectedLinearElement: { elementId: edge.id, isDragging: true, selectedPointsIndices: [1],
      pointerDownState: { lastClickedPoint: 1, lastClickedIsEndPoint: true } } } as unknown as AppState;
    expect(repairDiagramElements(elements, state)).toBe(true);
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: [0.25, 0], toCustom: false });
    expect(repairDiagramElements(elements, state)).toBe(false);
  });
  it('finishes reattaching when the native editor loses its endpoint index after rerouting', () => {
    const { b, edge, elements } = fixture();
    Object.assign(edge.customData.noteDiagram, { universal: true });
    const state = { selectedLinearElement: { elementId: edge.id, isDragging: true, selectedPointsIndices: [1],
      pointerDownState: { lastClickedPoint: 1, lastClickedIsEndPoint: true } } } as unknown as AppState;
    edge.points[1] = [800, 600];
    repairDiagramElements(elements, state);
    expect(edge.endBinding).toBeNull();
    edge.points[1] = [300, 150]; // Return to 50% of the target's top edge.
    repairDiagramElements(elements, state);
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: [0.5, 0], toCustom: false });
    // Model a pointerup that misses the binding because the elbow's last point
    // moved to another index. The last hovered attachment must still survive.
    repairDiagramElements(elements);
    expect(edge.endBinding).toMatchObject({ elementId: b.id });
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: [0.5, 0] });
    b.x += 100;
    repairDiagramElements(elements);
    expect(end(edge)).toEqual([600, 200]);
    expect(repairDiagramElements(elements)).toBe(false);
    // A later deliberate detach must not resurrect the prior drag's binding.
    edge.endBinding = null as any;
    repairDiagramElements(elements);
    expect(readDiagramData(edge)).toMatchObject({ toAnchor: null });
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
