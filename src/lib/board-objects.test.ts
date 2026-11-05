import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { boardObjects, chosenObjects, flattenObjects, layerPreferences, lockTargets, objectLockIds, objectSelection, selectedObjectKeys, toggleObjectKey } from './board-objects';

const element = (id: string, type = 'rectangle', extra: object = {}) => ({ id, type, isDeleted: false, groupIds: [], locked: false, ...extra }) as unknown as ExcalidrawElement;

describe('board layer objects', () => {
  it('lists front to back, includes locked objects, and excludes trash', () => {
    const rows = boardObjects([element('back'), element('deleted', 'image', { isDeleted: true }), element('front', 'freedraw', { locked: true })]);
    expect(rows.map(row => [row.key, row.kind, row.locked])).toEqual([['object:front', 'Drawing', true], ['object:back', 'Rectangle', false]]);
  });
  it('keeps a shape, its label, rich rendering, and diagram outlines in one row', () => {
    const rows = boardObjects([
      element('shape', 'rectangle', { groupIds: ['outline'], customData: { noteDiagram: { kind: 'node', diagramId: 'd', system: 'chen', shapeId: 'weak-entity' } } }),
      element('label', 'text', { containerId: 'shape', text: 'Customer', originalText: 'Customer' }),
      element('render', 'image', { locked: true, customData: { noteRichTextRender: { ownerId: 'label' } } }),
      element('border', 'rectangle', { groupIds: ['outline'], customData: { noteDiagram: { kind: 'decoration', diagramId: 'd', system: 'chen', nodeId: 'shape' } } }),
    ]);
    expect(rows).toHaveLength(1); expect(rows[0].label).toBe('Customer'); expect(rows[0].locked).toBe(false); expect(rows[0].partlyLocked).toBe(false);
    expect(rows[0].elementIds).toEqual(['shape', 'label', 'render', 'border']); expect(rows[0].selectableIds).not.toContain('render');
  });
  it('preserves nested groups and aggregates their descendants and lock states', () => {
    const rows = boardObjects([element('a', 'rectangle', { groupIds: ['inner', 'outer'], locked: true }), element('b', 'ellipse', { groupIds: ['inner', 'outer'], locked: true }), element('c', 'image', { groupIds: ['outer'] })]);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ groupId: 'outer', locked: false, partlyLocked: true });
    expect(rows[0].children.map(row => row.key)).toEqual(['object:c', 'group:inner']);
    expect(rows[0].children[1]).toMatchObject({ groupId: 'inner', locked: true, parentGroupId: 'outer' });
    expect(new Set(rows[0].elementIds)).toEqual(new Set(['a', 'b', 'c']));
  });
  it('resolves canvas selection to objects, treats group descendants once, and supports individual members', () => {
    const rows = boardObjects([element('a', 'rectangle', { groupIds: ['g'] }), element('b', 'ellipse', { groupIds: ['g'] }), element('c')]);
    expect(selectedObjectKeys(rows, { a: true, b: true }, { g: true })).toEqual(['group:g']);
    expect(selectedObjectKeys(rows, { a: true })).toEqual(['object:a']);
    expect(chosenObjects(rows, new Set(['group:g', 'object:a', 'object:c'])).map(row => row.key)).toEqual(['object:c', 'group:g']);
    const selected = objectSelection([element('a'), element('b')], [flattenObjects(rows).find(row => row.key === 'object:a')!]);
    expect(selected).toMatchObject({ selectedElementIds: { a: true }, selectedGroupIds: {}, editingGroupId: 'g' });
  });
  it('lets locked rows be inspected without granting canvas editing handles', () => {
    const elements = [element('a', 'rectangle', { locked: true }), element('b', 'text', { text: 'Editable', locked: false })];
    const rows = boardObjects(elements), selection = objectSelection(elements, rows);
    expect(selection.selectedElementIds).toEqual({ b: true }); expect(selection.selectedElementIds).not.toHaveProperty('a');
  });
  it('can deselect one group member while keeping the other members selected', () => {
    const rows = boardObjects([element('a', 'rectangle', { groupIds: ['g'] }), element('b', 'ellipse', { groupIds: ['g'] }), element('c', 'text', { groupIds: ['g'] })]);
    const keys = toggleObjectKey(rows, new Set(['group:g']), 'object:a');
    expect(keys).toEqual(new Set(['object:c', 'object:b']));
    const selection = objectSelection([element('a'), element('b'), element('c')], chosenObjects(rows, keys));
    expect(selection).toMatchObject({ selectedElementIds: { b: true, c: true }, editingGroupId: 'g' });
  });
  it('unlocks the containing locked group rather than bypassing its lock through a child', () => {
    const rows = boardObjects([element('a', 'rectangle', { groupIds: ['g'], locked: true }), element('b', 'ellipse', { groupIds: ['g'], locked: true })]);
    const child = flattenObjects(rows).find(row => row.key === 'object:a')!;
    expect(lockTargets(rows, [child], false).map(row => row.key)).toEqual(['group:g']);
    expect(lockTargets(rows, [child], true).map(row => row.key)).toEqual(['object:a']);
  });
  it('expands lock membership to labels and derived renderings without following connections', () => {
    const elements = [element('shape'), element('label', 'text', { containerId: 'shape' }), element('render', 'image', { customData: { noteRichTextRender: { ownerId: 'label' } } }), element('edge', 'arrow')];
    expect(objectLockIds(elements, new Set(['shape']))).toEqual(new Set(['shape', 'label', 'render']));
    expect(objectLockIds(elements, new Set(['label']))).toEqual(new Set(['shape', 'label', 'render']));
  });
  it('sanitizes saved panel sizes and works with corrupted preferences', () => {
    expect(layerPreferences(null)).toEqual({ open: false, width: 300, tileSize: 48 });
    expect(layerPreferences({ open: true, width: 9000, tileSize: -10 })).toEqual({ open: true, width: 520, tileSize: 32 });
    expect(layerPreferences({ width: '500', tileSize: Infinity })).toEqual({ open: false, width: 300, tileSize: 48 });
  });
});
