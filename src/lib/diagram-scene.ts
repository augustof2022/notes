import { convertToExcalidrawElements, mutateElement, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import type { AppState } from '@excalidraw/excalidraw/types';
import type {
  Arrowhead, ExcalidrawArrowElement, ExcalidrawElement, ExcalidrawLinearElement, FixedPoint,
  PointBinding, StrokeStyle,
} from '@excalidraw/excalidraw/element/types';
import {
  readDiagramData, routePoints, anchorPoint, pointAnchor, anchorSide, sideAnchor, isDiagramAnchor, projectAnchor,
  type DiagramDecorationData, type DiagramEdgeData, type DiagramNodeData, type DiagramPreset,
  type DiagramRoute, type DiagramSide, type DiagramAnchor,
} from './diagram-model';
import { connectionTarget, connectionTargetAt } from './connection-targets';

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
  fromAnchor?: DiagramAnchor | null;
  toAnchor?: DiagramAnchor | null;
}

type Point = [number, number];
type EdgeData = DiagramEdgeData & { doubleLine?: boolean };
const EPSILON = 0.01;
const OUTLINE_INSET = 6;
const attachmentGeometry = new WeakMap<object, string>();

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

function worldPoints(element: ExcalidrawLinearElement): Point[] {
  const xs = element.points.map((point) => point[0]), ys = element.points.map((point) => point[1]);
  const center: Point = [element.x + (Math.min(...xs) + Math.max(...xs)) / 2, element.y + (Math.min(...ys) + Math.max(...ys)) / 2];
  return element.points.map((point) => rotate([element.x + point[0], element.y + point[1]], center, element.angle));
}

function binding(id: string, side: DiagramSide, elbowed: boolean, anchor = sideAnchor(side)): PointBinding & { fixedPoint?: FixedPoint } {
  const fixed = anchor.map(value => Math.abs(value - 0.5) < 0.0001 ? 0.5001 : value) as FixedPoint;
  return { elementId: id, focus: 0, gap: 0, ...(elbowed ? { fixedPoint: fixed } : {}) };
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

/** Keep the node identity, labels, hierarchy and arrow bindings during a shape change. */
export function changeDiagramNodeShape(elements: readonly ExcalidrawElement[], nodeId: string, preset: DiagramPreset): ExcalidrawElement[] {
  const node = elements.find(element => element.id === nodeId && !element.isDeleted);
  const data = node && readDiagramData(node);
  if (!node || data?.kind !== 'node' || data.system !== preset.system) return [...elements];
  if (data.shapeId === preset.id) return [...elements];
  const text = elements.find(element => !element.isDeleted && element.type === 'text' && element.containerId === node.id);
  const groupIds = node.groupIds.length ? node.groupIds : preset.doubleOutline ? [crypto.randomUUID()] : [];
  const nextData: DiagramNodeData = { ...data, shapeId: preset.id };
  // Let Excalidraw calculate the label's available area for the new geometry.
  const measured = convertToExcalidrawElements([{
    type: preset.type, x: node.x, y: node.y, width: node.width, height: node.height,
    ...(text?.type === 'text' ? { label: { text: text.originalText, fontSize: text.fontSize, fontFamily: text.fontFamily, textAlign: text.textAlign, verticalAlign: text.verticalAlign } } : {}),
  }], { regenerateIds: false });
  const shape = measured[0];
  const measuredText = measured.find(element => element.type === 'text');
  const replacement = newElementWith(node, {
    type: preset.type, width: shape.width, height: shape.height, roundness: null, groupIds,
    customData: { ...node.customData, noteDiagram: nextData },
  });
  const result = elements.map(element => {
    if (element.id === node.id) return replacement;
    const meta = readDiagramData(element);
    if (node.type !== preset.type && !element.isDeleted && element.type === 'arrow' && meta?.kind === 'edge' && (meta.fromId === node.id || meta.toId === node.id)) {
      const next = { ...meta };
      let startBinding = element.startBinding, endBinding = element.endBinding;
      for (const end of ['from', 'to'] as const) {
        const id = end === 'from' ? 'fromId' : 'toId', key = end === 'from' ? 'fromAnchor' : 'toAnchor', side = end === 'from' ? 'fromSide' : 'toSide';
        if (meta[id] !== node.id || meta[key] === null) continue;
        const anchor = projectAnchor(preset.type, isDiagramAnchor(meta[key]) ? meta[key] as DiagramAnchor : sideAnchor(meta[side]));
        next[key] = anchor; next[side] = anchorSide(anchor);
        if ('elbowed' in element && element.elbowed) {
          const bound = binding(node.id, next[side], true, anchor);
          if (end === 'from') startBinding = bound; else endBinding = bound;
        }
      }
      return newElementWith(element, { startBinding, endBinding, customData: { ...element.customData, noteDiagram: next } });
    }
    if (element.id === text?.id && element.type === 'text' && measuredText?.type === 'text') {
      return newElementWith(element, { x: measuredText.x, y: measuredText.y, width: measuredText.width, height: measuredText.height, text: measuredText.text, groupIds });
    }
    if (!element.isDeleted && meta?.kind === 'decoration' && meta.nodeId === node.id && element.type !== 'text') return newElementWith(element, { isDeleted: true });
    return element;
  });
  if (preset.doubleOutline) {
    const [outline] = convertToExcalidrawElements([{
      type: preset.type, x: node.x + OUTLINE_INSET, y: node.y + OUTLINE_INSET,
      width: Math.max(1, shape.width - OUTLINE_INSET * 2), height: Math.max(1, shape.height - OUTLINE_INSET * 2),
      angle: node.angle, strokeColor: node.strokeColor, backgroundColor: 'transparent',
      strokeWidth: node.strokeWidth, strokeStyle: node.strokeStyle, roughness: node.roughness, roundness: null, groupIds,
      customData: { noteDiagram: decorationData(nextData, node.id) },
    }], { regenerateIds: false });
    result.splice(result.findIndex(element => element.id === node.id) + 1, 0, outline);
  }
  repairDiagramElements(result);
  return result;
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
  const fromAnchor = isDiagramAnchor(settings.fromAnchor) ? settings.fromAnchor : sideAnchor(settings.fromSide);
  const toAnchor = isDiagramAnchor(settings.toAnchor) ? settings.toAnchor : sideAnchor(settings.toSide);
  points[0] = anchorPoint(from, fromAnchor);
  points[points.length - 1] = anchorPoint(to, toAnchor);
  if (points.length > 2) {
    if (settings.fromSide === 'top' || settings.fromSide === 'bottom') points[1][0] = points[0][0]; else points[1][1] = points[0][1];
    const last = points.length - 1;
    if (settings.toSide === 'top' || settings.toSide === 'bottom') points[last - 1][0] = points[last][0]; else points[last - 1][1] = points[last][1];
  }
  const [x, y] = points[0];
  const relative = points.map((point): Point => [point[0] - x, point[1] - y]);
  const id = crypto.randomUUID(), groupIds = settings.doubleLine ? [crypto.randomUUID()] : [];
  const data: EdgeData = {
    kind: 'edge', diagramId: fromData.diagramId, system: fromData.system, fromId: from.id, toId: to.id,
    fromSide: settings.fromSide, toSide: settings.toSide, fromAnchor, toAnchor, doubleLine: settings.doubleLine,
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
    startBinding: binding(from.id, settings.fromSide, arrow.elbowed, fromAnchor),
    endBinding: binding(to.id, settings.toSide, arrow.elbowed, toAnchor),
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

/** Ordinary objects keep their own identity; only the connection gets diagram metadata. */
export function createObjectConnection(elements: readonly ExcalidrawElement[], fromId: string, toId: string, settings: DiagramEdgeSettings, style: DiagramStyle): ExcalidrawElement[] {
  const from = connectionTarget(elements, fromId), to = connectionTarget(elements, toId);
  if (!from || !to) throw new Error('Select two board objects to connect.');
  const diagramId = crypto.randomUUID();
  const proxy = (target: typeof from) => ({ ...target.element, ...target.geometry, customData: { noteDiagram: { kind: 'node', diagramId, system: 'org', shapeId: 'role', parentId: null } } }) as ExcalidrawElement;
  const added = createDiagramEdge(proxy(from), proxy(to), settings, style);
  for (const edge of added) if (edge.type === 'arrow') {
    const data = readDiagramData(edge)!;
    mutateElement(edge, { startBinding: from.native ? edge.startBinding : null, endBinding: to.native ? edge.endBinding : null,
      customData: { ...edge.customData, noteDiagram: { ...data, universal: true, fromGroup: from.groupId, toGroup: to.groupId, fromCustom: !from.native, toCustom: !to.native } } }, false);
  }
  return added;
}

/** Keep Excalidraw's reciprocal shape bindings so moving a node also moves its connectors. */
export function attachDiagramEdge(elements: readonly ExcalidrawElement[], addedEdges: readonly ExcalidrawElement[]): void {
  const byId = new Map([...elements, ...addedEdges].map((element) => [element.id, element]));
  for (const edge of addedEdges) {
    const data = readDiagramData(edge);
    if (data?.kind !== 'edge' || edge.type !== 'arrow' || edge.isDeleted) continue;
    for (const id of new Set([data.fromId, data.toId])) {
      if ((id === data.fromId && data.fromCustom) || (id === data.toId && data.toCustom)) continue;
      const node = byId.get(id);
      if (!node || node.isDeleted || node.boundElements?.some((bound) => bound.id === edge.id && bound.type === 'arrow')) continue;
      mutateElement(node, { boundElements: [...(node.boundElements ?? []).filter((bound) => bound.id !== edge.id), { id: edge.id, type: 'arrow' }] }, false);
    }
  }
}

function updateLineGeometry(element: ExcalidrawLinearElement, points: Point[], mutate = mutateElement): boolean {
  const before = worldPoints(element);
  if (samePoints(before, points)) return false;
  if (element.type === 'arrow' && 'elbowed' in element && element.elbowed) {
    mutate(element, { points: localPoints(points.map(point => [point[0] - element.x, point[1] - element.y])), angle: 0 as ExcalidrawElement['angle'] }, false);
    // The native elbow router may keep an already-valid route instead of a
    // suggested adjacent segment. Report the actual result so repairs settle.
    return !samePoints(before, worldPoints(element));
  }
  const [x, y] = points[0];
  mutate(element, {
    x, y, angle: 0 as ExcalidrawElement['angle'],
    points: localPoints(points.map((point): Point => [point[0] - x, point[1] - y])),
  }, false);
  return true;
}

/** Repair selected side attachments and dependent decorations without replacing user-edited bends. */
export function repairDiagramElements(elements: readonly ExcalidrawElement[], state?: Pick<AppState, 'editingLinearElement' | 'selectedLinearElement'>, mutate = mutateElement): boolean {
  const byId = new Map(elements.map((element) => [element.id, element]));
  let changed = false;
  for (const element of elements) {
    if (element.isDeleted || element.type !== 'arrow' || element.points.length < 2) continue;
    const elbowed = 'elbowed' in element && element.elbowed;
    const data = readDiagramData(element);
    if (data?.kind !== 'edge') continue;
    const points = worldPoints(element);
    const editor = [state?.editingLinearElement, state?.selectedLinearElement].find(editor => editor?.elementId === element.id);
    const next = { ...data };
    const geometry: unknown[] = [];
    let metadataChanged = false;
    const ends = [
      { id: 'fromId', side: 'fromSide', anchor: 'fromAnchor', binding: 'startBinding', group: 'fromGroup', custom: 'fromCustom', index: 0 },
      { id: 'toId', side: 'toSide', anchor: 'toAnchor', binding: 'endBinding', group: 'toGroup', custom: 'toCustom', index: points.length - 1 },
    ] as const;
    for (const end of ends) {
      const bound = element[end.binding];
      // Elbow routing adds/removes points during a drag. The end's original
      // selected index can therefore become a middle point; its identity stays
      // in pointerDownState even as the point count changes.
      const selectedEndpoint = !!editor?.isDragging && (end.index === 0
        ? editor.pointerDownState?.lastClickedPoint === 0 || !!editor.selectedPointsIndices?.includes(0)
        : !!editor.pointerDownState?.lastClickedIsEndPoint || !!editor.selectedPointsIndices?.includes(end.index));
      let target = (bound && connectionTarget(elements, bound.elementId, bound.elementId === data[end.id] ? data[end.group] : undefined)) || connectionTarget(elements, data[end.id], data[end.group]);
      if (selectedEndpoint && data.universal) {
        const hovered = connectionTargetAt(elements, points[end.index], 12);
        if (hovered) {
          target = hovered;
          if (next[end.group] !== hovered.groupId || next[end.custom] !== !hovered.native) metadataChanged = true;
          next[end.group] = hovered.groupId; next[end.custom] = !hovered.native;
        } else {
          next[end.anchor] = null; next[end.custom] = true; metadataChanged = true;
          continue;
        }
      }
      if (!target) continue;
      geometry.push([end.id, target.geometry.id, target.geometry.x, target.geometry.y, target.geometry.width, target.geometry.height, target.geometry.angle, data[end.anchor]]);
      let anchor = data[end.anchor];
      const fixed = bound && 'fixedPoint' in bound && Array.isArray(bound.fixedPoint) && bound.fixedPoint.length === 2 && bound.fixedPoint.every(Number.isFinite)
        ? bound.fixedPoint.map(value => Math.abs(value - 0.5) < 0.00011 ? 0.5 : Math.max(0, Math.min(1, value))) as DiagramAnchor : null;
      if (selectedEndpoint) {
        anchor = pointAnchor(target.geometry, points[end.index]);
      } else if (bound && target.element.id === bound.elementId && !data[end.custom] && (target.element.id !== data[end.id] || anchor === null)) {
        anchor = fixed || pointAnchor(target.geometry, points[end.index]);
      } else if (anchor === undefined || (anchor !== null && !isDiagramAnchor(anchor))) {
        // Preserve the saved geometry when upgrading an existing connector.
        anchor = fixed || (bound?.elementId === target.element.id ? pointAnchor(target.geometry, points[end.index]) : sideAnchor(data[end.side]));
      } else if (!bound && !editor?.isDragging && !data[end.custom]) {
        // A user can deliberately detach an endpoint. Do not snap it back.
        anchor = null;
      }
      if (isDiagramAnchor(anchor)) {
        const side = anchorSide(anchor);
        if (next[end.id] !== target.element.id || next[end.side] !== side || !isDiagramAnchor(data[end.anchor]) || !anchor.every((value, index) => Math.abs(value - (data[end.anchor] as DiagramAnchor)[index]) < 0.000001)) metadataChanged = true;
        next[end.id] = target.element.id; next[end.side] = side; next[end.anchor] = anchor;
        if (!editor?.isDragging && !elbowed) points[end.index] = anchorPoint(target.geometry, anchor);
        if (!target.native && !next[end.custom]) { next[end.custom] = true; next[end.group] = target.groupId; metadataChanged = true; }
        if (!editor?.isDragging && next[end.custom]) {
          if (bound) { mutate(element, { [end.binding]: null }, false); changed = true; }
        } else if (!editor?.isDragging && (bound?.elementId !== target.element.id || (elbowed && (!fixed || !anchor.every((value, index) => Math.abs(value - fixed[index]) < 0.000001))))) {
          mutate(element, { [end.binding]: binding(target.element.id, side, !!elbowed, anchor) }, false); changed = true;
        }
        if (!next[end.custom] && !target.element.boundElements?.some(bound => bound.type === 'arrow' && bound.id === element.id)) {
          mutate(target.element, { boundElements: [...(target.element.boundElements || []), { id: element.id, type: 'arrow' }] }, false); changed = true;
        }
      } else if (anchor === null) {
        if (data[end.anchor] !== null) { next[end.anchor] = null; metadataChanged = true; }
        if (!editor?.isDragging && bound) { mutate(element, { [end.binding]: null }, false); changed = true; }
      }
    }
    if (state && elbowed && !editor?.isDragging) {
      const signature = JSON.stringify([geometry, next.fromAnchor, next.toAnchor]);
      // Immutable scene updates replace elements but retain their metadata.
      // Cache against that shared identity so an unchanged route settles.
      const identity = element.customData!;
      if (attachmentGeometry.get(identity) !== signature) {
        const before = JSON.stringify([element.x, element.y, element.points]);
        // Native routing preserves fixed segments and recalculates the elbows
        // when a bound object's geometry changes, including text auto-sizing.
        mutate(element, {}, false);
        if (JSON.stringify([element.x, element.y, element.points]) !== before) changed = true;
        attachmentGeometry.set(identity, signature);
      }
    }
    if (!editor?.isDragging && elbowed && (next.fromCustom || next.toCustom)) {
      const routed = worldPoints(element);
      for (const end of ends) {
        if (!next[end.custom] || !isDiagramAnchor(next[end.anchor])) continue;
        const target = connectionTarget(elements, next[end.id], next[end.group]); if (!target) continue;
        const index = end.index === 0 ? 0 : routed.length - 1;
        routed[index] = anchorPoint(target.geometry, next[end.anchor] as DiagramAnchor);
        if (routed.length > 2 && !('fixedSegments' in element && Array.isArray(element.fixedSegments) && element.fixedSegments.length)) {
          const neighbor = routed[index === 0 ? 1 : index - 1];
          if (next[end.side] === 'top' || next[end.side] === 'bottom') neighbor[0] = routed[index][0]; else neighbor[1] = routed[index][1];
        }
      }
      if (updateLineGeometry(element, routed, mutate)) changed = true;
    }
    if (!editor?.isDragging && !elbowed && updateLineGeometry(element, points, mutate)) changed = true;
    if (metadataChanged) { mutate(element, { customData: { ...element.customData, noteDiagram: next } }, false); changed = true; }
  }
  for (const element of elements) {
    if (element.isDeleted) continue;
    const data = readDiagramData(element);
    if (data?.kind !== 'decoration' || element.type === 'text') continue;
    const owner = byId.get(data.nodeId);
    if (!owner || owner.isDeleted) {
      mutate(element, { isDeleted: true }, false);
      changed = true;
      continue;
    }
    if (linear(element) && linear(owner)) {
      if (owner.points.length < 2) continue;
      if (updateLineGeometry(element, parallelPoints(worldPoints(owner)), mutate)) changed = true;
      if (element.strokeColor !== owner.strokeColor || element.strokeStyle !== owner.strokeStyle || element.strokeWidth !== owner.strokeWidth
        || element.roundness?.type !== owner.roundness?.type) {
        mutate(element, { strokeColor: owner.strokeColor, strokeStyle: owner.strokeStyle, strokeWidth: owner.strokeWidth, roundness: owner.roundness }, false);
        changed = true;
      }
    } else if ((element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') && element.type === owner.type) {
      const inset = Math.min(OUTLINE_INSET, owner.width / 4, owner.height / 4);
      const x = owner.x + inset, y = owner.y + inset;
      const width = Math.max(1, owner.width - inset * 2), height = Math.max(1, owner.height - inset * 2);
      if (!close(element.x, x) || !close(element.y, y) || !close(element.width, width) || !close(element.height, height)
        || !close(element.angle, owner.angle) || element.strokeColor !== owner.strokeColor
        || element.strokeWidth !== owner.strokeWidth || element.strokeStyle !== owner.strokeStyle) {
        mutate(element, { x, y, width, height, angle: owner.angle, strokeColor: owner.strokeColor, strokeWidth: owner.strokeWidth, strokeStyle: owner.strokeStyle }, false);
        changed = true;
      }
    }
  }
  return changed;
}
