import { readDiagramData, type DiagramElementLike } from './diagram-model';

export type DiagramShortcutRelation = 'child' | 'sibling';

/** Tab is a diagram command only without browser shortcuts, composition, or auto-repeat. */
export function diagramShortcutRelation(event: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}): DiagramShortcutRelation | null {
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey
    || event.isComposing || event.repeat || event.defaultPrevented) return null;
  return event.shiftKey ? 'sibling' : 'child';
}

interface ShortcutElement extends DiagramElementLike {
  id: string;
  type: string;
  containerId?: string | null;
}

/** Resolve one shape, including its grouped outline/label, without ignoring other selections. */
export function diagramShortcutNode<T extends ShortcutElement>(elements: readonly T[], state: {
  selectedElementIds: Readonly<Record<string, boolean>>;
  editingTextElement?: ShortcutElement | null;
}): T | null {
  const byId = new Map(elements.filter(element => !element.isDeleted).map(element => [element.id, element]));
  function owner(element: T): T | null {
    let primary = element;
    if (primary.type === 'text') {
      const container = primary.containerId && byId.get(primary.containerId);
      if (!container) return null;
      primary = container;
    }
    const data = readDiagramData(primary);
    if (data?.kind === 'decoration') {
      const decorated = byId.get(data.nodeId);
      if (!decorated) return null;
      primary = decorated;
    }
    return readDiagramData(primary)?.kind === 'node' ? primary : null;
  }

  let node: T | null = null;
  for (const [id, selected] of Object.entries(state.selectedElementIds)) {
    if (!selected) continue;
    const element = byId.get(id), candidate = element && owner(element);
    if (!candidate || (node && node.id !== candidate.id)) return null;
    node = candidate;
  }
  if (state.editingTextElement) {
    const text = byId.get(state.editingTextElement.id);
    if (!text || text.type !== 'text') return null;
    const editingNode = owner(text);
    if (!editingNode || (node && node.id !== editingNode.id)) return null;
    return editingNode;
  }
  return node;
}
