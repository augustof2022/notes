export type DiagramSystemId = 'chen' | 'crowfoot' | 'relational' | 'process' | 'org' | 'mindmap';
export type DiagramSide = 'top' | 'right' | 'bottom' | 'left';
export type DiagramRoute = 'straight' | 'elbow' | 'curved';
export type DiagramAnchor = [number, number];

export interface DiagramPreset {
  id: string;
  label: string;
  type: 'rectangle' | 'ellipse' | 'diamond';
  width: number;
  height: number;
  defaultText: string;
  system: DiagramSystemId;
  doubleOutline?: boolean;
}

export interface DiagramSystem {
  id: DiagramSystemId;
  label: string;
  description: string;
  presets: readonly DiagramPreset[];
}

export const DIAGRAM_SYSTEMS: readonly DiagramSystem[] = [
  {
    id: 'chen', label: 'Chen ER', description: 'Entities, relationships, and attributes with Chen notation.',
    presets: [
      { id: 'entity', label: 'Entity', type: 'rectangle', width: 180, height: 90, defaultText: 'Entity', system: 'chen' },
      { id: 'weak-entity', label: 'Weak entity', type: 'rectangle', width: 180, height: 90, defaultText: 'Weak entity', system: 'chen', doubleOutline: true },
      { id: 'relationship', label: 'Relationship', type: 'diamond', width: 180, height: 110, defaultText: 'Relationship', system: 'chen' },
      { id: 'identifying-relationship', label: 'Identifying relationship', type: 'diamond', width: 180, height: 110, defaultText: 'Identifies', system: 'chen', doubleOutline: true },
      { id: 'attribute', label: 'Attribute', type: 'ellipse', width: 160, height: 80, defaultText: 'Attribute', system: 'chen' },
      { id: 'multivalued-attribute', label: 'Multivalued attribute', type: 'ellipse', width: 160, height: 80, defaultText: 'Attribute', system: 'chen', doubleOutline: true },
    ],
  },
  {
    id: 'crowfoot', label: 'Crow’s foot ER', description: 'Database entities with relationship cardinality endpoints.',
    presets: [{ id: 'entity', label: 'Entity', type: 'rectangle', width: 220, height: 150, defaultText: 'Entity\n────────────\nid (PK)\nname', system: 'crowfoot' }],
  },
  {
    id: 'relational', label: 'Relational database', description: 'Tables, columns, and links between keys.',
    presets: [{ id: 'table', label: 'Table', type: 'rectangle', width: 230, height: 170, defaultText: 'Table\n────────────\nid (PK)\nparent_id (FK)\nname', system: 'relational' }],
  },
  {
    id: 'process', label: 'Business process', description: 'Tasks, decisions, and start or end events.',
    presets: [
      { id: 'task', label: 'Task', type: 'rectangle', width: 180, height: 90, defaultText: 'Task', system: 'process' },
      { id: 'decision', label: 'Decision', type: 'diamond', width: 180, height: 120, defaultText: 'Decision?', system: 'process' },
      { id: 'start-end', label: 'Start / end', type: 'ellipse', width: 150, height: 70, defaultText: 'Start / end', system: 'process' },
      { id: 'data', label: 'Data / document', type: 'rectangle', width: 180, height: 110, defaultText: 'Data / document', system: 'process' },
    ],
  },
  {
    id: 'org', label: 'Organization chart', description: 'Roles connected by reporting relationships.',
    presets: [{ id: 'role', label: 'Role', type: 'rectangle', width: 200, height: 100, defaultText: 'Name\nRole', system: 'org' }],
  },
  {
    id: 'mindmap', label: 'Mind map', description: 'Topics and branches for organizing ideas.',
    presets: [{ id: 'topic', label: 'Topic', type: 'ellipse', width: 180, height: 90, defaultText: 'Topic', system: 'mindmap' }],
  },
];

export interface DiagramTheme {
  id: string;
  label: string;
  fill: string;
  stroke: string;
  text: string;
}

export const DIAGRAM_THEMES: readonly DiagramTheme[] = [
  { id: 'blue', label: 'Ocean', fill: '#dbeafe', stroke: '#2563eb', text: '#172554' },
  { id: 'green', label: 'Forest', fill: '#dcfce7', stroke: '#15803d', text: '#14532d' },
  { id: 'purple', label: 'Violet', fill: '#ede9fe', stroke: '#7c3aed', text: '#3b0764' },
  { id: 'amber', label: 'Amber', fill: '#fef3c7', stroke: '#b45309', text: '#451a03' },
  { id: 'neutral', label: 'Monochrome', fill: '#f1f5f9', stroke: '#475569', text: '#0f172a' },
];

interface DiagramIdentity {
  diagramId: string;
  system: DiagramSystemId;
}

export interface DiagramNodeData extends DiagramIdentity {
  kind: 'node';
  shapeId: string;
  parentId: string | null;
}

export interface DiagramEdgeData extends DiagramIdentity {
  kind: 'edge';
  fromId: string;
  toId: string;
  fromSide: DiagramSide;
  toSide: DiagramSide;
  fromAnchor?: DiagramAnchor | null;
  toAnchor?: DiagramAnchor | null;
}

export interface DiagramDecorationData extends DiagramIdentity {
  kind: 'decoration';
  nodeId: string;
}

export type DiagramData = DiagramNodeData | DiagramEdgeData | DiagramDecorationData;

export interface DiagramElementLike {
  customData?: Record<string, unknown> | null;
  isDeleted?: boolean;
}

export interface DiagramRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isDiagramAnchor(value: unknown): value is DiagramAnchor {
  return Array.isArray(value) && value.length === 2 && value.every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1);
}
export function sideAnchor(side: DiagramSide): DiagramAnchor {
  return side === 'top' ? [0.5, 0] : side === 'right' ? [1, 0.5] : side === 'bottom' ? [0.5, 1] : [0, 0.5];
}
export function anchorSide(anchor: DiagramAnchor): DiagramSide {
  const distances: [DiagramSide, number][] = [['top', anchor[1]], ['right', 1 - anchor[0]], ['bottom', 1 - anchor[1]], ['left', anchor[0]]];
  return distances.sort((a, b) => a[1] - b[1])[0][0];
}
export function anchorPoint(shape: DiagramRect & { angle?: number }, anchor: DiagramAnchor): [number, number] {
  const dx = (anchor[0] - 0.5) * shape.width, dy = (anchor[1] - 0.5) * shape.height, angle = shape.angle || 0;
  return [shape.x + shape.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), shape.y + shape.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle)];
}
export function pointAnchor(shape: DiagramRect & { angle?: number }, point: readonly number[]): DiagramAnchor {
  const dx = point[0] - shape.x - shape.width / 2, dy = point[1] - shape.y - shape.height / 2, angle = -(shape.angle || 0);
  const clamp = (number: number) => Math.max(0, Math.min(1, number));
  return [clamp((dx * Math.cos(angle) - dy * Math.sin(angle)) / Math.max(1, shape.width) + 0.5), clamp((dx * Math.sin(angle) + dy * Math.cos(angle)) / Math.max(1, shape.height) + 0.5)];
}
/** Keep the same attachment direction on the outline after changing shape type. */
export function projectAnchor(type: string, anchor: DiagramAnchor): DiagramAnchor {
  const dx = anchor[0] - 0.5, dy = anchor[1] - 0.5;
  const radius = type === 'ellipse' ? Math.hypot(dx, dy) : type === 'diamond' ? Math.abs(dx) + Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
  return radius < 0.000001 ? [0.5, 0] : [0.5 + dx * 0.5 / radius, 0.5 + dy * 0.5 / radius];
}

export interface DiagramNodeLike extends DiagramElementLike, DiagramRect {
  id: string;
}

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];
const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isSide = (value: unknown): value is DiagramSide => typeof value === 'string' && SIDES.includes(value);

/** Read only recognized, complete metadata; ordinary board elements remain ordinary elements. */
export function readDiagramData(element: DiagramElementLike): DiagramData | null {
  const value = element.customData?.noteDiagram;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const system = DIAGRAM_SYSTEMS.find((entry) => entry.id === data.system);
  if (!system || !nonemptyString(data.diagramId)) return null;
  if (data.kind === 'node') {
    if (!system.presets.some((preset) => preset.id === data.shapeId)) return null;
    if (data.parentId !== null && !nonemptyString(data.parentId)) return null;
    return data as unknown as DiagramNodeData;
  }
  if (data.kind === 'edge' && nonemptyString(data.fromId) && nonemptyString(data.toId) && isSide(data.fromSide) && isSide(data.toSide)) {
    return data as unknown as DiagramEdgeData;
  }
  if (data.kind === 'decoration' && nonemptyString(data.nodeId)) return data as unknown as DiagramDecorationData;
  return null;
}

export function getDiagramNodes<T extends DiagramElementLike>(elements: readonly T[], diagramId?: string): T[] {
  return elements.filter((element) => {
    const data = readDiagramData(element);
    return !element.isDeleted && data?.kind === 'node' && (diagramId === undefined || data.diagramId === diagramId);
  });
}

const HORIZONTAL_GAP = 56;
const VERTICAL_GAP = 72;

function overlaps(a: DiagramRect, b: DiagramRect): boolean {
  return a.x < b.x + b.width + 16 && a.x + a.width + 16 > b.x && a.y < b.y + b.height + 16 && a.y + a.height + 16 > b.y;
}

/** Children belong to the selected node; siblings retain the selected node's parent. */
export function nextNodePosition(
  nodes: readonly DiagramNodeLike[],
  parent: DiagramNodeLike,
  relation: 'child' | 'sibling',
  size: Pick<DiagramRect, 'width' | 'height'>,
): { x: number; y: number; parentId: string | null } {
  const selectedData = readDiagramData(parent);
  if (selectedData?.kind !== 'node') throw new Error('Select a diagram node before adding a child or sibling.');
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 180;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 90;
  const parentId = relation === 'child' ? parent.id : selectedData.parentId;
  let x = relation === 'child' ? parent.x + (parent.width - width) / 2 : parent.x + parent.width + HORIZONTAL_GAP;
  const y = relation === 'child' ? parent.y + parent.height + VERTICAL_GAP : parent.y;
  const obstacles = nodes.filter((node) => !node.isDeleted);
  // Advance past each blocker rather than relying on a fixed retry limit on large diagrams.
  for (;;) {
    const blocker = obstacles.find((node) => overlaps({ x, y, width, height }, node));
    if (!blocker) break;
    x = blocker.x + blocker.width + HORIZONTAL_GAP;
  }
  return { x, y, parentId };
}

export function sidePoint(rect: DiagramRect, side: DiagramSide): [number, number] {
  switch (side) {
    case 'top': return [rect.x + rect.width / 2, rect.y];
    case 'right': return [rect.x + rect.width, rect.y + rect.height / 2];
    case 'bottom': return [rect.x + rect.width / 2, rect.y + rect.height];
    case 'left': return [rect.x, rect.y + rect.height / 2];
  }
}

function normal(side: DiagramSide): [number, number] {
  switch (side) {
    case 'top': return [0, -1];
    case 'right': return [1, 0];
    case 'bottom': return [0, 1];
    case 'left': return [-1, 0];
  }
}

function compactPoints(points: [number, number][]): [number, number][] {
  return points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
}

/** World-space editable points. Apply rounded corners to the curved route when rendering. */
export function routePoints(
  from: DiagramRect,
  to: DiagramRect,
  fromSide: DiagramSide,
  toSide: DiagramSide,
  route: DiagramRoute,
): [number, number][] {
  const start = sidePoint(from, fromSide), end = sidePoint(to, toSide);
  if (route === 'straight') return [start, end];
  const sourceNormal = normal(fromSide), targetNormal = normal(toSide);
  const lead = 40;
  const sourceLead: [number, number] = [start[0] + sourceNormal[0] * lead, start[1] + sourceNormal[1] * lead];
  const targetLead: [number, number] = [end[0] + targetNormal[0] * lead, end[1] + targetNormal[1] * lead];
  const horizontalSource = sourceNormal[0] !== 0, horizontalTarget = targetNormal[0] !== 0;
  if (horizontalSource !== horizontalTarget) {
    const corner: [number, number] = horizontalSource ? [sourceLead[0], targetLead[1]] : [targetLead[0], sourceLead[1]];
    return compactPoints([start, sourceLead, corner, targetLead, end]);
  }
  if (horizontalSource) {
    const alignedOutward = sourceNormal[0] === targetNormal[0];
    const forward = (end[0] - start[0]) * sourceNormal[0] >= 0;
    if (alignedOutward || forward) {
      const x = alignedOutward
        ? (sourceNormal[0] > 0 ? Math.max(sourceLead[0], targetLead[0]) : Math.min(sourceLead[0], targetLead[0]))
        : (sourceLead[0] + targetLead[0]) / 2;
      return compactPoints([start, [x, start[1]], [x, end[1]], end]);
    }
    const y = Math.min(from.y, to.y) - lead;
    return compactPoints([start, sourceLead, [sourceLead[0], y], [targetLead[0], y], targetLead, end]);
  }
  const alignedOutward = sourceNormal[1] === targetNormal[1];
  const forward = (end[1] - start[1]) * sourceNormal[1] >= 0;
  if (alignedOutward || forward) {
    const y = alignedOutward
      ? (sourceNormal[1] > 0 ? Math.max(sourceLead[1], targetLead[1]) : Math.min(sourceLead[1], targetLead[1]))
      : (sourceLead[1] + targetLead[1]) / 2;
    return compactPoints([start, [start[0], y], [end[0], y], end]);
  }
  const x = Math.max(from.x + from.width, to.x + to.width) + lead;
  return compactPoints([start, sourceLead, [x, sourceLead[1]], [x, targetLead[1]], targetLead, end]);
}
