import { describe, expect, it } from 'vitest';
import { diagramShortcutNode, diagramShortcutRelation } from './diagram-shortcuts';

const node = (id: string) => ({
  id, type: 'rectangle',
  customData: { noteDiagram: { kind: 'node', diagramId: 'diagram', system: 'org', shapeId: 'role', parentId: null } },
});
const parent = node('parent'), other = node('other');
const label = { id: 'label', type: 'text', containerId: parent.id };
const outline = { id: 'outline', type: 'rectangle', customData: { noteDiagram: { kind: 'decoration', diagramId: 'diagram', system: 'org', nodeId: parent.id } } };
const arrow = { id: 'arrow', type: 'arrow', customData: { noteDiagram: { kind: 'edge', diagramId: 'diagram', system: 'org', fromId: 'parent', toId: 'other', fromSide: 'bottom', toSide: 'top' } } };
const arrowLabel = { id: 'arrow-label', type: 'text', containerId: arrow.id };
const ordinary = { id: 'ordinary', type: 'rectangle' };
const elements = [parent, other, label, outline, arrow, arrowLabel, ordinary];

describe('diagram keyboard commands', () => {
  it('maps Tab to child and Shift+Tab to sibling', () => {
    expect(diagramShortcutRelation({ key: 'Tab' })).toBe('child');
    expect(diagramShortcutRelation({ key: 'Tab', shiftKey: true })).toBe('sibling');
  });

  it('preserves browser shortcuts, composition, repeat, and already handled events', () => {
    for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'isComposing', 'repeat', 'defaultPrevented']) {
      expect(diagramShortcutRelation({ key: 'Tab', [flag]: true })).toBeNull();
    }
    expect(diagramShortcutRelation({ key: 'Enter' })).toBeNull();
  });

  it('treats a grouped outline and its bound text as the same selected shape', () => {
    expect(diagramShortcutNode(elements, { selectedElementIds: { parent: true } })).toBe(parent);
    expect(diagramShortcutNode(elements, { selectedElementIds: { parent: true, outline: true, label: true } })).toBe(parent);
    expect(diagramShortcutNode(elements, { selectedElementIds: { label: true, other: false } })).toBe(parent);
  });

  it('resolves the shape while its native text editor has cleared selection', () => {
    expect(diagramShortcutNode(elements, { selectedElementIds: {}, editingTextElement: label })).toBe(parent);
  });

  it('rejects multiple shapes, mixed selections, ordinary objects, arrow labels, and deleted owners', () => {
    const selections: Record<string, boolean>[] = [{ parent: true, other: true }, { parent: true, ordinary: true },
      { parent: true, arrow: true }, { ordinary: true }, { arrow: true }, {}];
    for (const selectedElementIds of selections) {
      expect(diagramShortcutNode(elements, { selectedElementIds })).toBeNull();
    }
    expect(diagramShortcutNode(elements, { selectedElementIds: {}, editingTextElement: arrowLabel })).toBeNull();
    expect(diagramShortcutNode(elements, { selectedElementIds: { other: true }, editingTextElement: label })).toBeNull();
    expect(diagramShortcutNode([{ ...parent, isDeleted: true }, label], { selectedElementIds: {}, editingTextElement: label })).toBeNull();
  });
});
