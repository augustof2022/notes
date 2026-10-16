import { convertToExcalidrawElements, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import type {
  Arrowhead, ExcalidrawArrowElement, ExcalidrawElement, ExcalidrawLinearElement, FixedPoint,
  PointBinding, StrokeStyle,
} from '@excalidraw/excalidraw/element/types';
import {
  readDiagramData, routePoints, sidePoint,
  type DiagramDecorationData, type DiagramEdgeData, type DiagramNodeData, type DiagramPreset,
  type DiagramRoute, type DiagramSide,
} from './diagram-model';

export interface DiagramStyle {
  fill: string;
  stroke: string;
  width: number;
  strokeStyle: StrokeStyle;
}

export interface DiagramEdgeSettings {
  fromSide: DiagramSide;
  toSide: DiagramSide;
  route: DiagramRoute;
  startArrowhead: Arrowhead | null;
  endArrowhead: Arrowhead | null;
  doubleLine: boolean;
}

type Point = [number, number];
type EdgeData = DiagramEdgeData & { doubleLine?: boolean };
const EPSILON = 0.01;
const OUTLINE_INSET = 6;

function localPoints(points: readonly Point[]): ExcalidrawLinearElement['points'] {
  return points as unknown as ExcalidrawLinearElement['points'];
}

function linear(element: ExcalidrawElement): element is ExcalidrawLinearElement | ExcalidrawArrowElement {
  return element.type === 'arrow' || element.type === 'line';
}

function close(a: number, b: number) { return Math.abs(a - b) < EPSILON; }
function samePoint(a: readonly number[], b: readonly number[]) { return close(a[0], b[0]) && close(a[1], b[1]); }
function samePoints(a: readonly (readonly number[])[], b: readonly (readonly number[])[]) {
  return a.length === b.length && a.every((point, index) => samePoint(point, b[index]));
}

function rotate(point: Point, center: Point, angle: number): Point {
  if (!angle) return point;
  const x = point[0] - center[0], y = point[1] - center[1];
  return [center[0] + x * Math.cos(angle) - y * Math.sin(angle), center[1] + x * Math.sin(angle) + y * Math.cos(angle)];
}

function connectionPoint(element: ExcalidrawElement, side: DiagramSide): Point {
  return rotate(sidePoint(element, side), [element.x + element.width / 2, element.y + element.height / 2], element.angle);
}

function worldPoints(element: ExcalidrawLinearElement): Point[] {
  const xs = element.points.map((point) => point[0]), ys = element.points.map((point) => point[1]);
  const center: Point = [element.x + (Math.min(...xs) + Math.max(...xs)) / 2, element.y + (Math.min(...ys) + Math.max(...ys)) / 2];
  return element.points.map((point) => rotate([element.x + point[0], element.y + point[1]], center, element.angle));
}

function binding(id: string, side: DiagramSide, elbowed: boolean): PointBinding & { fixedPoint?: FixedPoint } {
  const fixed: Record<DiagramSide, FixedPoint> = { top: [0.5001, 0], right: [1, 0.5001], bottom: [0.5001, 1], left: [0, 0.5001] };
  return { elementId: id, focus: 0, gap: 0, ...(elbowed ? { fixedPoint: fixed[side] } : {}) };
}

function decorationData(data: DiagramNodeData | DiagramEdgeData, nodeId: string): DiagramDecorationData {
  return { kind: 'decoration', diagramId: data.diagramId, system: data.system, nodeId };
}

export function createDiagramNode(
  preset: DiagramPreset,
  position: { x: number; y: number; parentId: string | null },
  diagramId: string,
  style: DiagramStyle,
  textColor = style.stroke,
): ExcalidrawElement[] {
  const id = crypto.randomUUID();
  const data: DiagramNodeData = { kind: 'node', diagramId, system: preset.system, shapeId: preset.id, parentId: position.parentId };
  const groupIds = preset.doubleOutline ? [crypto.randomUUID()] : [];
  const created = convertToExcalidrawElements([{
    id, type: preset.type, x: position.x, y: position.y, width: preset.width, height: preset.height,
    strokeColor: style.stroke, backgroundColor: style.fill, fillStyle: 'solid', strokeWidth: style.width,
    strokeStyle: style.strokeStyle, roughness: 0, roundness: null, groupIds,
    customData: { noteDiagram: data },
    label: { text: preset.defaultText, fontSize: 18, fontFamily: 2, strokeColor: textColor, textAlign: 'center', verticalAlign: 'middle' },
  }], { regenerateIds: false });
  const shape = created.find((element) => element.id === id)!;
  const labels = created.filter((element) => element.id !== id);
  for (const label of labels) mutateElement(label, { groupIds, customData: { ...label.customData, noteDiagram: decorationData(data, id) } }, false);
  if (!preset.doubleOutline) return [shape, ...labels];
  const [outline] = convertToExcalidrawElements([{
    id: crypto.randomUUID(), type: preset.type, x: shape.x + OUTLINE_INSET, y: shape.y + OUTLINE_INSET,
    width: Math.max(1, shape.width - OUTLINE_INSET * 2), height: Math.max(1, shape.height - OUTLINE_INSET * 2),
    strokeColor: style.stroke, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: style.width,
    strokeStyle: style.strokeStyle, roughness: 0, roundness: null, groupIds,
    customData: { noteDiagram: decorationData(data, id) },
  }], { regenerateIds: false });
  return [shape, outline, ...labels];
}

/** Offset each segment and intersect adjacent offsets to keep double lines parallel around bends. */
function parallelPoints(points: Point[], distance = 4): Point[] {
  const normals = points.slice(1).map((point, index): Point => {
    const dx = point[0] - points[index][0], dy = point[1] - points[index][1];
    const length = Math.hypot(dx, dy) || 1;
    return [-dy / length, dx / length];
  });
  return points.map((point, index): Point => {
    const before = normals[Math.max(0, index - 1)] ?? [0, 1];
    const after = normals[Math.min(normals.length - 1, index)] ?? before;
    const sum: Point = [before[0] + after[0], before[1] + after[1]];
    const denominator = 1 + before[0] * after[0] + before[1] * after[1];
    const scale = denominator > 0.1 ? distance / denominator : distance / 2;
    return [point[0] + sum[0] * scale, point[1] + sum[1] * scale];
  });
}

export function createDiagramEdge(
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  settings: DiagramEdgeSettings,
  style: DiagramStyle,
): ExcalidrawElement[] {
  const fromData = readDiagramData(from), toData = readDiagramData(to);
  if (fromData?.kind !== 'node' || toData?.kind !== 'node') throw new Error('Connections need two diagram shapes.');
  if (fromData.diagramId !== toData.diagramId) throw new Error('Connect shapes in the same diagram.');
  const points = routePoints(from, to, settings.fromSide, settings.toSide, settings.route);
  points[0] = connectionPoint(from, settings.fromSide);
  points[points.length - 1] = connectionPoint(to, settings.toSide);
  const [x, y] = points[0];
  const relative = points.map((point): Point => [point[0] - x, point[1] - y]);
  const id = crypto.randomUUID(), groupIds = settings.doubleLine ? [crypto.randomUUID()] : [];
  const data: EdgeData = {
    kind: 'edge', diagramId: fromData.diagramId, system: fromData.system, fromId: from.id, toId: to.id,
    fromSide: settings.fromSide, toSide: settings.toSide, doubleLine: settings.doubleLine,
  };
  const skeleton = {
    id, type: 'arrow', x, y, points: localPoints(relative), elbowed: settings.route === 'elbow',
    strokeColor: style.stroke, backgroundColor: 'transparent', strokeWidth: style.width, strokeStyle: style.strokeStyle,
    roughness: 0, roundness: settings.route === 'curved' ? { type: 2 } : null,
    startArrowhead: settings.startArrowhead, endArrowhead: settings.endArrowhead,
    groupIds, customData: { noteDiagram: data },
  } as ExcalidrawElementSkeleton;
  const [created] = convertToExcalidrawElements([skeleton], { regenerateIds: false });
  const arrow = created as ExcalidrawArrowElement;
  // Conversion initializes arrows without bindings and can nudge the endpoints by half a pixel.
  mutateElement(arrow, {
    points: localPoints(relative),
    startBinding: binding(from.id, settings.fromSide, arrow.elbowed),
    endBinding: binding(to.id, settings.toSide, arrow.elbowed),
    startArrowhead: settings.startArrowhead, endArrowhead: settings.endArrowhead,
  }, false);
  if (!settings.doubleLine) return [arrow];
  const offset = parallelPoints(worldPoints(arrow)), [offsetX, offsetY] = offset[0];
  const [parallel] = convertToExcalidrawElements([{
    id: crypto.randomUUID(), type: 'line', x: offsetX, y: offsetY,
    points: localPoints(offset.map((point): Point => [point[0] - offsetX, point[1] - offsetY])),
    strokeColor: style.stroke, backgroundColor: 'transparent', strokeWidth: style.width, strokeStyle: style.strokeStyle,
    roughness: 0, roundness: arrow.roundness, groupIds, customData: { noteDiagram: decorationData(data, id) },
  }], { regenerateIds: false });
  return [arrow, parallel];
}

/** Keep Excalidraw's reciprocal shape bindings so moving a node also moves its connectors. */
export function attachDiagramEdge(elements: readonly ExcalidrawElement[], addedEdges: readonly ExcalidrawElement[]): void {
  const byId = new Map([...elements, ...addedEdges].map((element) => [element.id, element]));
  for (const edge of addedEdges) {
    const data = readDiagramData(edge);
    if (data?.kind !== 'edge' || edge.type !== 'arrow' || edge.isDeleted) continue;
    for (const id of new Set([data.fromId, data.toId])) {
      const node = byId.get(id);
      if (!node || node.isDeleted || node.boundElements?.some((bound) => bound.id === edge.id && bound.type === 'arrow')) continue;
      mutateElement(node, { boundElements: [...(node.boundElements ?? []).filter((bound) => bound.id !== edge.id), { id: edge.id, type: 'arrow' }] }, false);
    }
  }
}

function updateLineGeometry(element: ExcalidrawLinearElement, points: Point[]): boolean {
  if (samePoints(worldPoints(element), points)) return false;
  const [x, y] = points[0];
  mutateElement(element, {
    x, y, angle: 0 as ExcalidrawElement['angle'],
    points: localPoints(points.map((point): Point => [point[0] - x, point[1] - y])),
  }, false);
  return true;
}

/** Repair selected side attachments and dependent decorations without replacing user-edited bends. */
export function repairDiagramElements(elements: readonly ExcalidrawElement[]): boolean {
  const byId = new Map(elements.map((element) => [element.id, element]));
  let changed = false;
  for (const element of elements) {
    if (element.isDeleted || element.type !== 'arrow' || ('elbowed' in element && element.elbowed)) continue;
    const data = readDiagramData(element);
    if (data?.kind !== 'edge') continue;
    const from = byId.get(data.fromId), to = byId.get(data.toId);
    if (!from || !to || from.isDeleted || to.isDeleted || element.points.length < 2) continue;
    const points = worldPoints(element);
    points[0] = connectionPoint(from, data.fromSide);
    points[points.length - 1] = connectionPoint(to, data.toSide);
    if (updateLineGeometry(element, points)) changed = true;
    if (element.startBinding?.elementId !== from.id || element.endBinding?.elementId !== to.id) {
      mutateElement(element, { startBinding: binding(from.id, data.fromSide, false), endBinding: binding(to.id, data.toSide, false) }, false);
      changed = true;
    }
  }
  for (const element of elements) {
    if (element.isDeleted) continue;
    const data = readDiagramData(element);
    if (data?.kind !== 'decoration' || element.type === 'text') continue;
    const owner = byId.get(data.nodeId);
    if (!owner || owner.isDeleted) {
      mutateElement(element, { isDeleted: true }, false);
      changed = true;
      continue;
    }
    if (linear(element) && linear(owner)) {
      if (owner.points.length < 2) continue;
      if (updateLineGeometry(element, parallelPoints(worldPoints(owner)))) changed = true;
      if (element.strokeColor !== owner.strokeColor || element.strokeStyle !== owner.strokeStyle || element.strokeWidth !== owner.strokeWidth
        || element.roundness?.type !== owner.roundness?.type) {
        mutateElement(element, { strokeColor: owner.strokeColor, strokeStyle: owner.strokeStyle, strokeWidth: owner.strokeWidth, roundness: owner.roundness }, false);
        changed = true;
      }
    } else if ((element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') && element.type === owner.type) {
      const inset = Math.min(OUTLINE_INSET, owner.width / 4, owner.height / 4);
      const x = owner.x + inset, y = owner.y + inset;
      const width = Math.max(1, owner.width - inset * 2), height = Math.max(1, owner.height - inset * 2);
      if (!close(element.x, x) || !close(element.y, y) || !close(element.width, width) || !close(element.height, height)
        || !close(element.angle, owner.angle) || element.strokeColor !== owner.strokeColor
        || element.strokeWidth !== owner.strokeWidth || element.strokeStyle !== owner.strokeStyle) {
        mutateElement(element, { x, y, width, height, angle: owner.angle, strokeColor: owner.strokeColor, strokeWidth: owner.strokeWidth, strokeStyle: owner.strokeStyle }, false);
        changed = true;
      }
    }
  }
  return changed;
}
